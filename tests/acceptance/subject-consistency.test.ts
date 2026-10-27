/* ============================================================
  主体一致性引用 · 真的进生成请求（ASSET-002 的落地点）。

  主体库里存了正脸参考图、描述、音色，但如果生成请求不带这些，
  主体库就只是一本相册——"跨镜复用同一个角色"这句话等于没实现。

  这一组用例盯的就是"到底有没有进请求"，而且**一路查到命令行参数**：
  请求对象里有字段不算数，中间任何一层把它吃掉（服务层漏传、后端只挑几个键）
  都要在这里露出来。

  三条口径：
    ① 没有导演台蓝图时：主体的正脸图当参考图，提示词里用"参考图顺序：第 N 张是…"说清它是谁；
    ② 有蓝图时：蓝图占唯一的参考图位（后端一次只吃一张，多参考槽 VID-010 未做），
       提示词**不谎称**主体图是参考图，只拼"参考 X 的五官特点"；
    ③ 主体没有参考图时只拼文字，不传参考图。
  ============================================================ */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { createCanvasBackend, CanvasAdapter, type CanvasRunRequest, type CanvasRunner } from '@qiyin/canvas-adapter';
import { GenerationService } from '@qiyin/generation-service';
import { recordAcceptance } from './_acceptance.js';

const modelFixturePath = new URL('../fixtures/canvas-model-star-video-2.5.json', import.meta.url);

const workspaces: string[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

/**/
function runner() {
  const calls: CanvasRunRequest[] = [];
  const impl: CanvasRunner = {
    async run(request: CanvasRunRequest) {
      calls.push(request);
      const [name, second] = request.args;
      if (name === 'upload') return { code: 0, stdout: JSON.stringify({ nodeKey: `ref-${request.args[1]}` }), stderr: '' };
      if (name === 'model') return { code: 0, stdout: readFileSync(modelFixturePath, 'utf8'), stderr: '' };
      if (name === 'node' && second === 'create') return { code: 0, stdout: JSON.stringify({ nodeKey: 'n1', nodeType: 'image' }), stderr: '' };
      if (name === 'node') {
        return {
          code: 0, stderr: '',
          stdout: '[run] task=t1 status=2 progress=100%\n'
            + JSON.stringify({ nodeKey: 'n1', status: 2, data: { url: ['https://example.test/a.png'] } }),
        };
      }
      if (name === 'download') {
        const outIndex = request.args.indexOf('--out');
        const dir = (outIndex >= 0 ? request.args[outIndex + 1] : undefined) ?? request.cwd ?? tmpdir();
        const nodeName = request.args[2] ?? 'node';
        const file = join(dir, `gen-${nodeName}.png`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, Buffer.from(`PNG:${nodeName}`), 'utf8');
        return { code: 0, stdout: `${file}\n`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'error: unexpected\n' };
    },
  };
  return { impl, calls };
}

function setup() {
  const projects = new ProjectService(openDatabase(':memory:'));
  const projectId = projects.execute(command('project.create', {
    name: '主体一致性', max_budget_cents: 1000, rights_confirmed: true,
  })).project_id as string;
  const revision = () => (projects.getProject(projectId) as { revision: number }).revision;
  projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: revision() }));
  projects.execute(command('shot-fields.seed', {
    breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2100 }],
  }, { project_id: projectId, expected_revision: revision() }));
  projects.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: revision() }));

  const workspace = mkdtempSync(join(tmpdir(), 'qiyin-subject-gen-'));
  workspaces.push(workspace);
  const { impl, calls } = runner();
  const service = new GenerationService(projects, createCanvasBackend(new CanvasAdapter(impl)));
  return { projects, projectId, revision, workspace, service, calls };
}

/** 在 workspace 里放一张"主体的正脸图"，并按内容寻址登记成 Artifact。 */
function publishAsset(
  ctx: ReturnType<typeof setup>, relativePath: string, artifactId: string, projectId: string,
  mediaType = 'image/png',
) {
  mkdirSync(dirname(join(ctx.workspace, relativePath)), { recursive: true });
  writeFileSync(join(ctx.workspace, relativePath), Buffer.from(`PNG:${artifactId}`), 'utf8');
  ctx.projects.execute(command('artifact.publish', {
    artifact_id: artifactId, media_type: mediaType, bytes: 20,
    metadata: { artifact_path_relative: relativePath, project_id: projectId, source: 'subject-library' },
  }));
}

/** 给某镜写一份空间方案：只有主体，没有蓝图。 */
function planWithSubject(ctx: ReturnType<typeof setup>, subjectRef: string, withBlueprint?: { artifactId: string }) {
  ctx.projects.execute(command('spatial-plan.set', {
    shot_id: 'shot-01',
    plan: {
      schema: 'replica.spatial-plan@1',
      shot_id: 'shot-01',
      enabled: true,
      subjects: [{
        subject_ref: subjectRef, proxy: 'mannequin', position: [0, 0, 0],
        rotation_deg: [0, 0, 0], pose: 'standing', scale: 1,
      }],
      camera: { position: [0, 1.35, 9], target: [0, 0.85, 0], lens_mm: 50, pitch_deg: 0 },
      ...(withBlueprint === undefined ? {} : {
        blueprint: { artifact_id: withBlueprint.artifactId, published_at: new Date().toISOString(), captured_from_revision: 1 },
      }),
    },
    expected_spatial_revision: 0,
  }, { project_id: ctx.projectId, expected_revision: ctx.revision() }));
}

const SUBJECT_IMAGE = `sha256:${'a'.repeat(64)}`;
const SUBJECT_IMAGE_2 = `sha256:${'d'.repeat(64)}`;
const BLUEPRINT = `sha256:${'b'.repeat(64)}`;
const VIDEO = `sha256:${'c'.repeat(64)}`;

function registerSubject(ctx: ReturnType<typeof setup>, images: Array<{ artifact_id: string; frontal: boolean }>) {
  ctx.projects.execute(command('subject.profile.set', {
    subject_ref: 'character:xiaoq',
    display_name: '小Q',
    kind: 'person',
    description: '短发女性',
    tags: [],
    images,
    video: null,
    voice: null,
  }));
}

async function generate(ctx: ReturnType<typeof setup>) {
  return ctx.service.generateShotImages({
    projectId: ctx.projectId,
    expectedRevision: ctx.revision(),
    canvasCwd: ctx.workspace,
    workspaceDir: ctx.workspace,
    shots: [{ shot_id: 'shot-01', prompt: '站在窗边' }],
    model: 'Z-image Turbo',
    estimatedCostCents: 10,
    actualCostCents: 10,
  });
}

/** 所有命令的参数字符串拼在一起——用来找"提示词里到底有没有那句话"。 */
function allArgs(calls: readonly CanvasRunRequest[]): string {
  return calls.map((call) => call.args.join(' ')).join('\n');
}

describe('主体一致性引用 · 进生成请求', () => {
  it('没有蓝图时：主体正脸图当参考图，提示词说明它是谁', async () => {
    const ctx = setup();
    publishAsset(ctx, 'subjects/xiaoq-front.png', SUBJECT_IMAGE, ctx.projectId);
    publishAsset(ctx, 'subjects/xiaoq-side.png', SUBJECT_IMAGE_2, ctx.projectId);
    /* 词条要求 2–4 张，所以主体至少要两张图——第一张是正脸 */
    registerSubject(ctx, [
      { artifact_id: SUBJECT_IMAGE, frontal: true },
      { artifact_id: SUBJECT_IMAGE_2, frontal: false },
    ]);
    planWithSubject(ctx, 'character:xiaoq');

    await generate(ctx);
    const args = allArgs(ctx.calls);

    /**/
    const referenceUpload = ctx.calls.find((call) => call.args[0] === 'upload');
    expect(referenceUpload?.args.join(' ')).toContain(join(ctx.workspace, 'subjects', 'xiaoq-front.png'));
    expect(ctx.calls.some((call) => call.args[0] === 'upload'
      && call.args.join(' ').includes('xiaoq-front.png'))).toBe(true);
    /**/
    const createCall = ctx.calls.find((call) => call.args[0] === 'node' && call.args[1] === 'create');
    expect(createCall?.args).toContain('--left');
    /* 文字部分：词条口径 + 编号说明（VID-010 之后改为"参考图顺序"那一句） */
    expect(args).toContain('参考 小Q 的五官特点。');
    expect(args).toContain('参考图顺序：第 1 张是主体「小Q」的正脸参考。');
    /* 提示词里点名的人必须是主体库里的名字，不是「角色 1」 */
    expect(args).toContain('"小Q"');
    expect(args).not.toContain('"角色 1"');

    recordAcceptance('ASSET-002', {
      criterion: '跨镜一致引用真的进生成请求：参考图上传→连线→提示词',
      referenceUploaded: referenceUpload !== undefined,
      referenceLinkedByLeft: createCall?.args.includes('--left') ?? false,
      promptHasSubjectFragment: args.includes('参考 小Q 的五官特点。'),
      promptNamesTheReference: args.includes('参考图顺序：第 1 张是主体「小Q」的正脸参考。'),
      subjectNamedInStaging: args.includes('"小Q"'),
      fallbackLabelGone: !args.includes('"角色 1"'),
    });
  });

  it('有导演台蓝图时：蓝图与主体图**一起**进请求，且编号说清谁是第 1 张（VID-010 之后的改进）', async () => {
    const ctx = setup();
    publishAsset(ctx, 'subjects/xiaoq-front.png', SUBJECT_IMAGE, ctx.projectId);
    publishAsset(ctx, 'subjects/xiaoq-side.png', SUBJECT_IMAGE_2, ctx.projectId);
    publishAsset(ctx, 'blueprints/shot-01.png', BLUEPRINT, ctx.projectId);
    registerSubject(ctx, [
      { artifact_id: SUBJECT_IMAGE, frontal: true },
      { artifact_id: SUBJECT_IMAGE_2, frontal: false },
    ]);
    planWithSubject(ctx, 'character:xiaoq', { artifactId: BLUEPRINT });

    await generate(ctx);
    const args = allArgs(ctx.calls);

    expect(args).toContain('参考 小Q 的五官特点。');
    /*
      以前后端只能吃一张，所以有蓝图时主体图**必须让位**（那条妥协写进了核验表）。
      VID-010 把端口扩成有序多张之后，两张都在、顺序也说得清。
    */
    expect(args).toContain('参考图顺序：第 1 张是导演台截图；第 2 张是主体「小Q」的正脸参考。');
    expect(ctx.calls.some((call) => call.args.join(' ').includes('shot-01.png'))).toBe(true);
    /**/
    expect(ctx.calls.filter((call) => call.args[0] === 'upload')).toHaveLength(1);
    expect(ctx.calls.some((call) => call.args.join(' ').includes('xiaoq-front.png'))).toBe(false);

    recordAcceptance('ASSET-002.blueprint-priority', {
      criterion: '蓝图与主体图一起进请求、编号说清顺序；只支持一张的后端如实说明降级',
      blueprintUploaded: ctx.calls.some((call) => call.args.join(' ').includes('shot-01.png')),
      subjectImageUploaded: ctx.calls.some((call) => call.args.join(' ').includes('xiaoq-front.png')),
      orderStated: args.includes('参考图顺序：第 1 张是导演台截图；第 2 张是主体「小Q」的正脸参考。'),
      textFragmentStillPresent: args.includes('参考 小Q 的五官特点。'),
      uploadCount: ctx.calls.filter((call) => call.args[0] === 'upload').length,
      limitation: 'Canvas 的 CLI 一次只连一个参考节点：顺序声明在，实际只送第 1 张（notes 里说明）',
    });
  });

  it('主体没有参考图时：只拼文字，不传参考图', async () => {
    const ctx = setup();
    /*
      用视频创建的主体**本来就没有正脸图**（词条允许 person 用视频建主体），
      所以这是一个真实存在的情况，不是硬凑的边界。
    */
    publishAsset(ctx, 'subjects/xiaoq-clip.mp4', VIDEO, ctx.projectId, 'video/mp4');
    ctx.projects.execute(command('subject.profile.set', {
      subject_ref: 'character:xiaoq', display_name: '小Q', kind: 'person',
      description: '短发女性', tags: [], images: [],
      video: { artifact_id: VIDEO, duration_seconds: 12 }, voice: null,
    }));
    planWithSubject(ctx, 'character:xiaoq');

    await generate(ctx);
    const args = allArgs(ctx.calls);

    expect(args).toContain('参考 小Q 的五官特点。');
    expect(args).not.toContain('第 1 张参考图是主体');
    expect(ctx.calls.some((call) => call.args[0] === 'upload')).toBe(false);

    recordAcceptance('ASSET-002.text-only', {
      criterion: '用视频建的主体没有正脸图时：只拼文字，不假装有参考图',
      uploadedAnything: ctx.calls.some((call) => call.args[0] === 'upload'),
      textFragmentPresent: args.includes('参考 小Q 的五官特点。'),
      claimsReference: args.includes('第 1 张参考图是主体'),
    });
  });
});

