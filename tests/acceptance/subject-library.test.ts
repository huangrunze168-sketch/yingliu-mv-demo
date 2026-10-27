/* ============================================================
  ASSET-003 / 005 / 006 的量化验收。

  矩阵的原文要求：
    · ASSET-003：视频主体库（多图 / 单视频创建可复用主体）
    · ASSET-005：主体绑定音色（5–30s，支持视频格式）
    · ASSET-006：主体描述一键生成并拼接进 prompt

  音色 5–30 秒 + mp3/wav/mp4/mov、描述 100 字），所以这里的"拒绝矩阵"
  同时也是**话术验收**：断言里带上了原文。
   ============================================================ */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { promptWithSubjectReference } from '@qiyin/contracts';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { recordAcceptance } from './_acceptance.js';

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:acceptance', type, payload, ...extras };
}

const IMG1 = `sha256:${'1'.repeat(64)}`;
const IMG2 = `sha256:${'2'.repeat(64)}`;
const IMG3 = `sha256:${'3'.repeat(64)}`;
const IMG4 = `sha256:${'4'.repeat(64)}`;
const IMG5 = `sha256:${'5'.repeat(64)}`;
const AUDIO = `sha256:${'a'.repeat(64)}`;
const VIDEO = `sha256:${'b'.repeat(64)}`;

function setup() {
  const db = openDatabase(':memory:');
  const service = new ProjectService(db);
  const publish = (artifactId: string, mediaType: string) => service.execute(command('artifact.publish', {
    artifact_id: artifactId, media_type: mediaType, bytes: 4096,
  }));
  for (const id of [IMG1, IMG2, IMG3, IMG4, IMG5]) publish(id, 'image/png');
  publish(AUDIO, 'audio/mpeg');
  publish(VIDEO, 'video/mp4');
  return { service, db };
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    subject_ref: 'character:lin',
    display_name: '林医生',
    kind: 'person' as const,
    description: '三十岁女性，白大褂，短发',
    tags: ['主角', '医生'],
    images: [{ artifact_id: IMG1, frontal: true }, { artifact_id: IMG2, frontal: false }],
    video: null,
    voice: null,
    ...overrides,
  };
}

const VOICE = {
  artifact_id: AUDIO,
  label: '林医生音色',
  duration_seconds: 12,
  authorization_confirmed: true as const,
  extension: 'mp3',
};

/** 一组"该被拦下"的输入：每一条都对应一句词条原文。 */
const REJECTIONS: Array<{ name: string; patch: Record<string, unknown>; expect: RegExp }> = [
  { name: '只给 1 张参考图', patch: { images: [{ artifact_id: IMG1, frontal: true }] }, expect: /2-4张，第一张图必须为清晰正脸的图片/ },
  { name: '第一张不是正脸', patch: { images: [{ artifact_id: IMG1, frontal: false }, { artifact_id: IMG2, frontal: false }] }, expect: /第一张图必须为清晰正脸的图片/ },
  {
    name: '5 张参考图',
    patch: {
      images: [IMG1, IMG2, IMG3, IMG4, IMG5].map((artifact_id, index) => ({ artifact_id, frontal: index === 0 })),
    },
    expect: /最多可添加 4 张图片/,
  },
  { name: '没有图也没有视频', patch: { images: [] }, expect: /请选择图片素材，或上传一段视频素材/ },
  { name: '描述超过 100 字', patch: { description: '描'.repeat(101) }, expect: /主体描述不超过 100 字/ },
  { name: '名称为空', patch: { display_name: '   ' }, expect: /请输入主体名称/ },
  { name: '非人物主体用视频创建', patch: { kind: 'other', video: { artifact_id: VIDEO, duration_seconds: 12 } }, expect: /目前视频仅支持人物主体/ },
  { name: '视频只有 3 秒', patch: { video: { artifact_id: VIDEO, duration_seconds: 3 } }, expect: /请上传时长在 5~30 秒之间的视频/ },
  { name: '视频 45 秒', patch: { video: { artifact_id: VIDEO, duration_seconds: 45 } }, expect: /请上传时长在 5~30 秒之间的视频/ },
  { name: '非人物主体绑音色', patch: { kind: 'other', voice: VOICE }, expect: /仅主体为人物时支持音色绑定和使用/ },
  { name: '音色格式是 aac', patch: { voice: { ...VOICE, extension: 'aac' } }, expect: /请上传 mp3、wav、mp4 或 mov 格式文件/ },
  { name: '音色名 21 个字', patch: { voice: { ...VOICE, label: '音'.repeat(21) } }, expect: /音频文件名需在 1~20 个字之间/ },
  { name: '音色只有 2 秒', patch: { voice: { ...VOICE, duration_seconds: 2 } }, expect: /音频时长需在 5~30 秒之间/ },
  { name: '音色 61 秒', patch: { voice: { ...VOICE, duration_seconds: 61 } }, expect: /音频时长需在 5~30 秒之间/ },
  { name: '没勾音色授权', patch: { voice: { ...VOICE, authorization_confirmed: false } }, expect: /克隆音色前，我已获得声音权利人的明确授权/ },
  { name: '参考图指向不存在的产物', patch: { images: [{ artifact_id: `sha256:${'f'.repeat(64)}`, frontal: true }, { artifact_id: IMG2, frontal: false }] }, expect: /参考图指向的素材不存在/ },
  { name: '参考图指向一段音频', patch: { images: [{ artifact_id: AUDIO, frontal: true }, { artifact_id: IMG2, frontal: false }] }, expect: /参考图的素材类型不对/ },
  { name: '拿音频当角色视频', patch: { video: { artifact_id: AUDIO, duration_seconds: 12 } }, expect: /视频素材的素材类型不对/ },
];

describe('[ASSET-003/005/006] 主体库', () => {
  it('多图创建可复用主体：落库、顺手登记、引用计数可读', () => {
    const { service, db } = setup();
    const created = service.execute(command('subject.profile.set', base()));
    const profile = (created.payload as { profile: { subject_ref: string; images: unknown[] } }).profile;

    /* 下游引用：直接落一条空间方案（这里验的是计数，不是空间方案本身的校验） */
    const projectId = service.execute(command('project.create', {
      name: '引用主体', max_budget_cents: 100, rights_confirmed: true,
    })).project_id as string;
    db.prepare(`INSERT INTO spatial_plans(project_id, shot_id, spatial_revision, plan_json, digest_input, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      projectId, 'shot-01', 1,
      JSON.stringify({ subjects: [{ subject_ref: 'character:lin' }, { subject_ref: 'character:lin' }, { subject_ref: 'character:lin' }] }),
      null, new Date().toISOString(),
    );

    const listed = service.listSubjectProfiles() as Array<{ subject_ref: string; references: number; profile: { voice: unknown } }>;

    recordAcceptance('ASSET-003', {
      criterion: '多图/单视频创建可复用主体，规则 100% 生效',
      createdRef: profile.subject_ref,
      imageCount: profile.images.length,
      registeredSubjects: service.listSubjects().length,
      listedProfiles: listed.length,
      references: listed[0]?.references ?? 0,
    });

    expect(profile.subject_ref).toBe('character:lin');
    expect(profile.images).toHaveLength(2);
    expect(service.listSubjects()).toHaveLength(1);
    expect(listed[0]?.references).toBe(3);
  });

  it(`拒绝矩阵：${REJECTIONS.length} 条不合规输入全部被拒，且理由就是词条原话`, () => {
    const outcomes: Array<{ name: string; rejected: boolean; message: string }> = [];
    for (const item of REJECTIONS) {
      const { service } = setup();
      let message = '';
      let rejected = false;
      try {
        service.execute(command('subject.profile.set', base(item.patch)));
      } catch (error) {
        rejected = true;
        message = error instanceof Error ? error.message : String(error);
      }
      outcomes.push({ name: item.name, rejected: rejected && item.expect.test(message), message });
    }
    const passed = outcomes.filter((row) => row.rejected).length;

    recordAcceptance('ASSET-003.rules', {
      criterion: '不合规输入拒绝率 100%，且提示文案与线上词条一致',
      cases: REJECTIONS.length,
      rejected: passed,
      failedCases: outcomes.filter((row) => !row.rejected).map((row) => ({ name: row.name, message: row.message })),
    });

    expect(passed).toBe(REJECTIONS.length);
  });

  it('绑定音色：5–30 秒的 mp3 能绑上；视频格式（mp4）同样允许', () => {
    const { service } = setup();
    service.execute(command('subject.profile.set', base({ voice: VOICE })));
    const listed = service.listSubjectProfiles() as Array<{ profile: { voice: { label: string; duration_seconds: number; extension: string } | null } }>;

    /* 词条里音色素材也接受 mp4/mov，所以用视频片段当音色同样合法 */
    service.execute(command('subject.profile.set', base({
      voice: { ...VOICE, artifact_id: VIDEO, extension: 'mp4', label: '视频音色', duration_seconds: 18 },
    })));
    const afterVideo = service.listSubjectProfiles() as Array<{ profile: { voice: { extension: string; duration_seconds: number } | null } }>;

    recordAcceptance('ASSET-005', {
      criterion: '主体绑定音色（5–30s，支持 mp4/mov 视频格式）',
      mp3Bound: listed[0]?.profile.voice !== null,
      mp3Seconds: listed[0]?.profile.voice?.duration_seconds ?? 0,
      videoExtensionAccepted: afterVideo[0]?.profile.voice?.extension ?? '',
      videoSeconds: afterVideo[0]?.profile.voice?.duration_seconds ?? 0,
    });

    expect(listed[0]?.profile.voice?.duration_seconds).toBe(12);
    expect(afterVideo[0]?.profile.voice?.extension).toBe('mp4');
  });

  it('主体描述拼进 prompt：逐字对齐词条 {prompt}；参考 {name} 的五官特点。', () => {
    const prompts = {
      人物: promptWithSubjectReference('林医生站在手术台前', { display_name: '林医生', kind: 'person' }),
      非人物: promptWithSubjectReference('一辆老爷车驶过', { display_name: '老爷车', kind: 'other' }),
      空提示词: promptWithSubjectReference('   ', { display_name: '林医生', kind: 'person' }),
    };

    recordAcceptance('ASSET-006', {
      criterion: '主体引用按词条格式拼进提示词',
      ...prompts,
    });

    expect(prompts.人物).toBe('林医生站在手术台前；参考 林医生 的五官特点。');
    expect(prompts.非人物).toBe('一辆老爷车驶过；参考 老爷车 的外观特征。');
    expect(prompts.空提示词).toBe('参考 林医生 的五官特点。');
  });
});

