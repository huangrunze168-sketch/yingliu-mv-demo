import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { createCanvasBackend, CanvasAdapter, type CanvasRunRequest, type CanvasRunner } from '@qiyin/canvas-adapter';
import { createImageGenBackend, createImageGenAdapter } from '@qiyin/imagegen-adapter';
import { GenerationService } from '@qiyin/generation-service';
import type { GenerationBackend, BackendMedia } from '@qiyin/generation-backend';

/* ============================================================

   schema 里，`properties.modeType.items` 有 `videoEdit2video`，
   而 `config.settings.videoEdit2video = [ratio_auto, resolution, duration_auto, enableSound]`。

   所以这里要钉死的是三件事：
     ① 提交时用的模式名是 `videoEdit2video`；
     ② **不传 duration / ratio**（该模式用的是 duration_auto / ratio_auto，
        传了会被静默忽略，用户看到的是"我明明设了却没生效"）；
     ③ 重拍**走与整批生成同一条闸门链**——G2 未批准时必须被拦下，
        而且一次 CLI 调用都不能发生（那才是"拦住"的证据）。

   真实付费调用不能在测试里发生，所以后端是假的；
   但**领域层是真的**（真 SQLite、真闸门、真预算），失败模式才有意义。
   ============================================================ */

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

/**/
function canvasRunner() {
  const calls: CanvasRunRequest[] = [];
  const runner: CanvasRunner = {
    async run(request: CanvasRunRequest) {
      calls.push(request);
      const [name, second] = request.args;
      if (name === 'upload') {
        return { code: 0, stdout: JSON.stringify({ nodeKey: 'res-1', nodeType: 'video' }), stderr: '' };
      }
      if (name === 'node' && second === 'create') {
        const nodeName = request.args[2] ?? '';
        return { code: 0, stdout: JSON.stringify({ nodeKey: 'v-1', nodeType: 'video', data: { name: nodeName } }), stderr: '' };
      }
      if (name === 'node') {
        return {
          code: 0,
          stderr: '',
          stdout: '[run] task=t9 status=2 progress=100%\n'
            + JSON.stringify({ nodeKey: 'v-1', status: 2, data: { url: ['https://example.test/retake.mp4'] } }),
        };
      }
      if (name === 'download') {
        const outIndex = request.args.indexOf('--out');
        const dir = (outIndex >= 0 ? request.args[outIndex + 1] : undefined) ?? request.cwd ?? tmpdir();
        const nodeName = request.args[2] ?? 'node';
        const file = join(dir, `${nodeName}.mp4`);
        /* 内容里带上节点名：两次重拍产出不同内容，才能验内容寻址没把它们混成一份 */
        writeFileSync(file, Buffer.from(`MP4:${nodeName}`), 'utf8');
        return { code: 0, stdout: `${file}\n`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'error: unexpected\n' };
    },
  };
  return { runner, calls };
}

function setup(options: { approveG2?: boolean } = {}) {
  const projects = new ProjectService(openDatabase(':memory:'));
  const created = projects.execute(command('project.create', { name: '重拍项目', max_budget_cents: 5000, rights_confirmed: true }));
  const projectId = created.project_id!;
  projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  projects.execute(command('shot-fields.seed', {
    breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 5000 }],
  }, { project_id: projectId, expected_revision: 2 }));
  projects.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
  projects.execute(command('image-candidate.add', {
    shot_id: 'shot-01', candidate_id: 'cand-01', artifact_id: `sha256:${'a'.repeat(64)}`,
  }, { project_id: projectId, expected_revision: 4 }));
  projects.execute(command('image-candidate.select', {
    shot_id: 'shot-01', candidate_id: 'cand-01', expected_selection_revision: 0,
  }, { project_id: projectId, expected_revision: 5 }));
  if (options.approveG2 !== false) {
    projects.execute(command('gate.approve', { gate: 'G2', approved_budget_cents: 3000 }, {
      project_id: projectId, expected_revision: 6,
    }));
  }

  const { runner, calls } = canvasRunner();
  const backend = createCanvasBackend(new CanvasAdapter(runner));
  const service = new GenerationService(projects, backend);
  const workspace = mkdtempSync(join(tmpdir(), 'qiyin-retake-'));
  mkdirSync(join(workspace, 'clips'), { recursive: true });
  /* 待重拍的片段得真实存在：上传读的是磁盘文件 */
  writeFileSync(join(workspace, 'clips', 'shot-01.mp4'), Buffer.from('MP4:source'), 'utf8');

  return {
    projects, projectId, service, calls, workspace,
    revision: () => (projects.getProject(projectId) as { revision: number }).revision,
  };
}

function retakeInput(projectId: string, workspace: string, revision: number) {
  return {
    projectId,
    expectedRevision: revision,
    workspaceDir: workspace,
    shotId: 'shot-01',
    sourcePathRelative: 'clips/shot-01.mp4',
    sourceArtifactId: `sha256:${'b'.repeat(64)}`,
    durationSeconds: 5,
    model: 'Seedance 2.5',
    prompt: '把背景换成夜晚的街道',
    estimatedCostCents: 200,
    actualCostCents: 200,
  };
}

describe('片段重拍', () => {
  it('以片段为输入、用 videoEdit2video 提交，产出替换用的新片段', async () => {
    const { projects, projectId, service, calls, workspace, revision } = setup();
    const outcome = await service.retakeShotVideo(retakeInput(projectId, workspace, revision()));

    expect(outcome.shot_id).toBe('shot-01');
    expect(outcome.artifact_id.startsWith('sha256:')).toBe(true);
    expect(outcome.replaced_artifact_id).toBe(`sha256:${'b'.repeat(64)}`);
    expect(outcome.frame_path_relative).toContain('clips/retake-');

    /* 上传的是**视频**节点，不是图片 */
    const uploaded = calls.find((call) => call.args[0] === 'upload');
    expect(uploaded?.args).toContain('-t');
    expect(uploaded?.args[uploaded.args.indexOf('-t') + 1]).toBe('video');

    const created = calls.find((call) => call.args[0] === 'node' && call.args[1] === 'create');
    expect(created?.args.join(' ')).toContain('modeType=videoEdit2video');
    expect(created?.args).toContain('--left');

    /* 这一镜的当前片段被换成新片段 */
    const snapshot = projects.getProject(projectId) as {
      video_generations?: Array<{ status: string; clip_artifact_id?: string | null }>;
    };
    const completed = (snapshot.video_generations ?? []).filter((item) => item.status === 'COMPLETED');
    expect(completed.at(-1)?.clip_artifact_id).toBe(outcome.artifact_id);
  });

  it('**不传** duration 与 ratio：这个模式下它们分别是 duration_auto / ratio_auto', async () => {
    const { projectId, service, calls, workspace, revision } = setup();
    await service.retakeShotVideo(retakeInput(projectId, workspace, revision()));

    const created = calls.find((call) => call.args[0] === 'node' && call.args[1] === 'create');
    const sets = (created?.args ?? []).filter((_arg, index, all) => all[index - 1] === '-s');
    expect(sets.some((pair) => pair.startsWith('duration='))).toBe(false);
    expect(sets.some((pair) => pair.startsWith('ratio='))).toBe(false);
    /* 但要传的还得传：模型与模式 */
    expect(sets.some((pair) => pair.startsWith('model='))).toBe(true);
    expect(sets.some((pair) => pair.startsWith('modeType='))).toBe(true);
  });

  it('空提示词直接拒绝，而且**一次意图都不登记**（没有花钱的可能）', async () => {
    const { projects, projectId, service, calls, workspace, revision } = setup();
    const before = revision();
    await expect(service.retakeShotVideo({ ...retakeInput(projectId, workspace, before), prompt: '   ' }))
      .rejects.toThrow(/要改什么|提示词/);
    expect(revision()).toBe(before);
    expect(calls).toHaveLength(0);
    void projects;
  });

  it('片段短于 4 秒时拒绝——Canvas 的重拍门槛，而且不留 PENDING 意图', async () => {
    /*
      这条检查必须在**登记意图之前**：登记之后被挡下的每一次都会在账上留一条
      永远结不清的 PENDING 意图，预算里预留下来的那部分再也放不出去。
    */
    const { projects, projectId, service, calls, workspace, revision } = setup();
    const before = revision();
    await expect(service.retakeShotVideo({
      ...retakeInput(projectId, workspace, before),
      durationSeconds: 3,
    })).rejects.toThrow(/不少于 4 秒/);
    expect(revision()).toBe(before);
    expect(calls).toHaveLength(0);
    const snapshot = projects.getProject(projectId) as {
      video_generations?: Array<{ status: string }>;
    };
    expect((snapshot.video_generations ?? []).filter((item) => item.status === 'PENDING')).toHaveLength(0);
  });

  it('G2 未批准时被领域层拦下，且一次 CLI 调用都没发生', async () => {
    const { projectId, service, calls, workspace, revision } = setup({ approveG2: false });
    await expect(service.retakeShotVideo(retakeInput(projectId, workspace, revision())))
      .rejects.toThrow(/G2/);
    /* 「拦住」的证据不是报错，而是**根本没调后端** */
    expect(calls).toHaveLength(0);
  });

  it('后端不支持重拍时明确报出来，而不是退化成像图生视频', async () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute(command('project.create', { name: '即梦项目', max_budget_cents: 1000, rights_confirmed: true }));
    const imagegen = createImageGenBackend(createImageGenAdapter({ executable: 'no-such-binary' }));
    /* 能力声明本身就是 false——界面据此让按钮不可用，不用等调用失败 */
    expect(imagegen.capabilities.videoEdit).toBe(false);
    const service = new GenerationService(projects, imagegen);
    await expect(service.retakeShotVideo({
      ...retakeInput(created.project_id!, tmpdir(), 1),
    })).rejects.toThrow(/不支持这项能力/);
  });

  it('后端不报花费时记预估，不记 0（0 与"不知道"是两件事）', async () => {
    const { projects, projectId, workspace, revision } = setup();
    /**/
    const silent: GenerationBackend = {
      id: 'silent',
      label: '静默后端',
      capabilities: {
        image: false, videoFromImage: false, videoEdit: true,
        imageShortcut: false, imageUpscale: false,
        audioSpeech: false, audioMusic: false,
      },
      async generateAudio(): Promise<BackendMedia> { throw new Error('用不到'); },
      async generateImage(): Promise<BackendMedia> {
        throw new Error('用不到');
      },
      async generateVideoFromImage(): Promise<BackendMedia> {
        throw new Error('用不到');
      },
      async editVideo(request): Promise<BackendMedia> {
        const file = join(request.outputDir, 'retake.mp4');
        writeFileSync(file, Buffer.from('MP4:silent'), 'utf8');
        return { files: [file], source_url: null, task_ref: 'silent-1', cost: null, notes: [] };
      },
      async applyImageShortcut(): Promise<BackendMedia> {
        throw new Error('用不到');
      },
      async upscaleImage(): Promise<BackendMedia> {
        throw new Error('用不到');
      },
    };
    const service = new GenerationService(projects, silent);
    const outcome = await service.retakeShotVideo(retakeInput(projectId, workspace, revision()));
    expect(outcome.provider_cost).toBeNull();
    /* 记在账上的是我们提交时的预估（300），而不是 0 */
    const snapshot = projects.getProject(projectId) as {
      video_generations?: Array<{ status: string; actual_cost_cents?: number | null }>;
    };
    expect((snapshot.video_generations ?? []).at(-1)?.actual_cost_cents).toBe(200);
  });
});
