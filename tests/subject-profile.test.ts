/* ============================================================
  主体档案（ASSET-003 / 005 / 006）。

  这一组用例分两半：

      视频仅人物、音色时长/格式/授权、描述 100 字），所以断言里连**文案**都一起验——
      文案漂了等于验收口径漂了；
    · **落库**：档案写进领域库、顺手登记、删除时登记一起撤、下游引用要能数出来。
   ============================================================ */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SUBJECT_IMAGE_MAX, validateSubjectProfile, promptWithSubjectReference,
  type SubjectVoiceRef,
} from '@qiyin/contracts';
import { openDatabase, ProjectService } from '@qiyin/domain';

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const C = `sha256:${'c'.repeat(64)}`;
const D = `sha256:${'d'.repeat(64)}`;

/**
 * 先发布产物，再写档案。

 * 顺序不能反：档案里的 artifact_id 会被逐个回查（存在性 + 类型），
 * 这正是"引用了不存在的素材"这件事在真实使用里最早能暴露的地方。
 */
function publishArtifacts(service: ProjectService): void {
  const publish = (artifactId: string, mediaType: string) => service.execute(command('artifact.publish', {
    artifact_id: artifactId, media_type: mediaType, bytes: 1024,
  }));
  publish(A, 'image/png');
  publish(B, 'image/jpeg');
  publish(C, 'audio/mpeg');
  publish(D, 'video/mp4');
}

function voice(overrides: Partial<SubjectVoiceRef> = {}): SubjectVoiceRef {
  return {
    artifact_id: C,
    label: '低沉男声',
    duration_seconds: 12,
    authorization_confirmed: true,
    extension: 'mp3',
    ...overrides,
  };
}

/** 一份合法的最小主体：两张图（第一张正脸）。 */
function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    subject_ref: 'character:xiaoq',
    display_name: '小Q',
    kind: 'person' as const,
    description: '现代东亚年轻女性，短发',
    tags: ['主角'],
    images: [{ artifact_id: A, frontal: true }, { artifact_id: B, frontal: false }],
    video: null,
    voice: null,
    ...overrides,
  };
}

describe('主体档案 · 规则（文案与词条逐字对齐）', () => {
  it('合法输入通过', () => {
    expect(validateSubjectProfile(baseInput())).toBeNull();
  });

  it('图片只给 1 张 → 拦下并说明"2-4张，第一张图必须为清晰正脸"', () => {
    const problem = validateSubjectProfile(baseInput({ images: [{ artifact_id: A, frontal: true }] }));
    expect(problem).toBe('2-4张，第一张图必须为清晰正脸的图片');
  });

  it('第一张不是正脸 → 拦下', () => {
    const problem = validateSubjectProfile(baseInput({
      images: [{ artifact_id: A, frontal: false }, { artifact_id: B, frontal: false }],
    }));
    expect(problem).toBe('第一张图必须为清晰正脸的图片');
  });

  it(`超过 ${SUBJECT_IMAGE_MAX} 张 → 用词条原文"最多可添加"`, () => {
    const images = [A, B, C, `sha256:${'d'.repeat(64)}`, `sha256:${'e'.repeat(64)}`]
      .map((artifact_id, index) => ({ artifact_id, frontal: index === 0 }));
    const problem = validateSubjectProfile(baseInput({ images }));
    expect(problem).toBe(`最多可添加 ${SUBJECT_IMAGE_MAX} 张图片`);
  });

  it('非人物主体不允许用视频创建（词条：目前视频仅支持人物主体）', () => {
    const problem = validateSubjectProfile(baseInput({
      kind: 'other', video: { artifact_id: C, duration_seconds: 12 },
    }));
    expect(problem).toBe('目前视频仅支持人物主体');
  });

  it('视频时长不在 5~30 秒 → 报出具体区间', () => {
    const problem = validateSubjectProfile(baseInput({ video: { artifact_id: C, duration_seconds: 3 } }));
    expect(problem).toBe('请上传时长在 5~30 秒之间的视频');
  });

  it('非人物主体不允许绑音色（词条：仅主体为人物时支持音色绑定和使用）', () => {
    const problem = validateSubjectProfile(baseInput({ kind: 'other', voice: voice() }));
    expect(problem).toBe('仅主体为人物时支持音色绑定和使用');
  });

  it('音色格式不在 mp3/wav/mp4/mov 里 → 拦下', () => {
    const problem = validateSubjectProfile(baseInput({ voice: voice({ extension: 'aac' }) }));
    expect(problem).toBe('请上传 mp3、wav、mp4 或 mov 格式文件');
  });

  it('音色名超过 20 个字 → 拦下', () => {
    const problem = validateSubjectProfile(baseInput({ voice: voice({ label: '声'.repeat(21) }) }));
    expect(problem).toBe('音频文件名需在 1~20 个字之间');
  });

  it('音色时长不在 5~30 秒 → 拦下', () => {
    const problem = validateSubjectProfile(baseInput({ voice: voice({ duration_seconds: 45 }) }));
    expect(problem).toBe('音频时长需在 5~30 秒之间');
  });

  it('没勾授权 → 拦下（词条：克隆音色前，我已获得声音权利人的明确授权）', () => {
    const problem = validateSubjectProfile(baseInput({
      voice: { ...voice(), authorization_confirmed: false } as unknown as SubjectVoiceRef,
    }));
    expect(problem).toBe('克隆音色前，我已获得声音权利人的明确授权');
  });

  it('描述超过 100 字 → 拦下', () => {
    const problem = validateSubjectProfile(baseInput({ description: '描'.repeat(101) }));
    expect(problem).toBe('主体描述不超过 100 字');
  });

  it('既没有图也没有视频 → 拦下', () => {
    const problem = validateSubjectProfile(baseInput({ images: [] }));
    expect(problem).toBe('请选择图片素材，或上传一段视频素材');
  });

  it('拼进提示词：逐字对齐词条 {prompt}；参考 {name} 的五官特点。', () => {
    expect(promptWithSubjectReference('一位少女站在雨中', { display_name: '小Q', kind: 'person' }))
      .toBe('一位少女站在雨中；参考 小Q 的五官特点。');
    /* 没有基础提示词时不要以分号开头 */
    expect(promptWithSubjectReference('  ', { display_name: '小Q', kind: 'person' }))
      .toBe('参考 小Q 的五官特点。');
    /* 非人物没有对应词条，用"外观特征"这一版并在文档里注明是我们补的 */
    expect(promptWithSubjectReference('一辆车', { display_name: '老爷车', kind: 'other' }))
      .toBe('一辆车；参考 老爷车 的外观特征。');
    expect(promptWithSubjectReference('一辆车', { display_name: '白色轿车', kind: 'product' }))
      .toBe('一辆车；参考产品「白色轿车」的外观与材质特征。');
    expect(promptWithSubjectReference('街景', { display_name: '雨夜街道', kind: 'scene' }))
      .toBe('街景；参考场景「雨夜街道」的空间与光线特征。');
  });
});

describe('主体档案 · 落库与引用', () => {
  it('写入后能读回，并且顺手完成了登记', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    publishArtifacts(service);
    const created = service.execute(command('subject.profile.set', baseInput()));
    const payload = created.payload as { created: boolean; profile: { subject_ref: string; kind: string } };

    expect(payload.created).toBe(true);
    expect(payload.profile.subject_ref).toBe('character:xiaoq');
    const listed = service.listSubjectProfiles() as Array<{ subject_ref: string; references: number; profile: { description: string } }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.references).toBe(0);
    expect(listed[0]?.profile.description).toBe('现代东亚年轻女性，短发');
    /* 登记表里也有了：空间方案的 subject_ref 校验靠它 */
    expect(service.listSubjects()).toHaveLength(1);
  });

  it('第二次写入是同一条档案的更新，不是新建', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    publishArtifacts(service);
    service.execute(command('subject.profile.set', baseInput()));
    const updated = service.execute(command('subject.profile.set', baseInput({ display_name: '小Q（新版）' })));
    expect((updated.payload as { created: boolean }).created).toBe(false);
    const listed = service.listSubjectProfiles() as Array<{ display_name: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.display_name).toBe('小Q（新版）');
  });

  it('不合规的档案被领域层拒绝（不信界面），并给出可读原因', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    publishArtifacts(service);
    expect(() => service.execute(command('subject.profile.set', baseInput({ voice: voice({ duration_seconds: 2 }) }))))
      .toThrowError('音频时长需在 5~30 秒之间');
    expect(service.listSubjectProfiles()).toHaveLength(0);
  });

  it('下游引用数按空间方案统计（跨项目）', () => {
    const db = openDatabase(':memory:');
    const service = new ProjectService(db);
    publishArtifacts(service);
    service.execute(command('subject.profile.set', baseInput()));
    const projectId = service.execute(command('project.create', {
      name: '引用主体', max_budget_cents: 100, rights_confirmed: true,
    })).project_id as string;
    /* 直接落一条空间方案：这里验的是"引用数怎么数"，不是空间方案本身的校验 */
    db.prepare(`INSERT INTO spatial_plans(project_id, shot_id, spatial_revision, plan_json, digest_input, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      projectId, 'shot-01', 1,
      JSON.stringify({ subjects: [{ subject_ref: 'character:xiaoq' }, { subject_ref: 'character:xiaoq' }] }),
      null, new Date().toISOString(),
    );

    const listed = service.listSubjectProfiles() as Array<{ references: number }>;
    expect(listed[0]?.references).toBe(2);
  });

  it('删除档案时登记一起撤掉（不留半个主体）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    publishArtifacts(service);
    service.execute(command('subject.profile.set', baseInput()));
    const removed = service.execute(command('subject.profile.remove', { subject_ref: 'character:xiaoq' }));
    expect((removed.payload as { removed: boolean }).removed).toBe(true);
    expect(service.listSubjectProfiles()).toHaveLength(0);
    expect(service.listSubjects()).toHaveLength(0);
    /* 再删一次要说"没有这个主体档案"，而不是静默成功 */
    expect(() => service.execute(command('subject.profile.remove', { subject_ref: 'character:xiaoq' })))
      .toThrowError(/没有这个主体档案/);
  });

  it('引用不存在的产物 → 拒绝（档案里不留悬空引用）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    publishArtifacts(service);
    expect(() => service.execute(command('subject.profile.set', baseInput({
      images: [{ artifact_id: `sha256:${'f'.repeat(64)}`, frontal: true }, { artifact_id: B, frontal: false }],
    })))).toThrowError(/参考图指向的素材不存在/);
  });

  it('参考图指向一段音频 → 拒绝（类型对不上）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    publishArtifacts(service);
    expect(() => service.execute(command('subject.profile.set', baseInput({
      images: [{ artifact_id: C, frontal: true }, { artifact_id: B, frontal: false }],
    })))).toThrowError(/参考图的素材类型不对/);
  });

  it('视频素材必须是视频、音色素材可以是音频或视频', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    publishArtifacts(service);
    /* 拿音频当"角色视频" → 拒绝 */
    expect(() => service.execute(command('subject.profile.set', baseInput({
      video: { artifact_id: C, duration_seconds: 12 },
    })))).toThrowError(/视频素材的素材类型不对/);
    /* 用视频片段当音色素材 → 允许（词条里音色也支持 mp4/mov） */
    const ok = service.execute(command('subject.profile.set', baseInput({
      voice: { ...voice(), artifact_id: D, extension: 'mp4', label: '视频音色' },
    })));
    expect((ok.payload as { profile: { voice: { extension: string } } }).profile.voice.extension).toBe('mp4');
  });
});

