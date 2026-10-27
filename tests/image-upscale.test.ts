import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { GenerationService } from '@qiyin/generation-service';
import { UnsupportedCapabilityError, type BackendMedia, type GenerationBackend } from '@qiyin/generation-backend';

/* ============================================================

  实现依据是**真实的命令帮助**：`imagegen image_upscale -h` 写明
  `--image` 是本地图片路径、`--resolution_type` 必填且只认 `2k|4k|8k`。

  这份测试盯四件事：
   ① 走的是**图片生成那条账**（G1 + 预算预留 + 结清），且不登记候选；
   ② 产物 metadata 记下"从哪张图放大来的"与档位；
   ③ 后端不支持时明确拒绝，而不是把原图复制一份返回；
   ④ 中途失败要把意图结清为 FAILED（否则预留永远挂着）。
   ============================================================ */

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

function setup(options: { approveG1?: boolean } = {}) {
  const projects = new ProjectService(openDatabase(':memory:'));
  const created = projects.execute(command('project.create', {
    name: '高清项目', max_budget_cents: 5000, rights_confirmed: true,
  }));
  const projectId = created.project_id!;
  projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  projects.execute(command('shot-fields.seed', {
    breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 5000 }],
  }, { project_id: projectId, expected_revision: 2 }));
  if (options.approveG1 !== false) {
    projects.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
  }
  const workspace = mkdtempSync(join(tmpdir(), 'qiyin-upscale-'));
  mkdirSync(join(workspace, 'frames'), { recursive: true });
  /* 待放大的图得真实存在：后端读的是磁盘文件 */
  writeFileSync(join(workspace, 'frames', 'shot-01.png'), Buffer.from('PNG:small'), 'utf8');
  return {
    projects, projectId, workspace,
    revision: () => (projects.getProject(projectId) as { revision: number }).revision,
  };
}

/** 一个只会放大的假后端：写一个内容不同的文件，让内容哈希走真实路径。 */
function upscaleBackend(options: { fail?: string } = {}): { backend: GenerationBackend; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const backend: GenerationBackend = {
    id: 'fake-upscale',
    label: '假放大后端',
    capabilities: {
      image: false, videoFromImage: false, videoEdit: false,
      imageShortcut: false, imageUpscale: true,
      audioSpeech: false, audioMusic: false,
    },
    async generateAudio(): Promise<BackendMedia> { throw new Error('用不到'); },
    async generateImage(): Promise<BackendMedia> { throw new Error('用不到'); },
    async generateVideoFromImage(): Promise<BackendMedia> { throw new Error('用不到'); },
    async editVideo(): Promise<BackendMedia> { throw new Error('用不到'); },
    async applyImageShortcut(): Promise<BackendMedia> { throw new Error('用不到'); },
    async upscaleImage(request): Promise<BackendMedia> {
      calls.push(request as unknown as Record<string, unknown>);
      if (options.fail !== undefined) throw new Error(options.fail);
      const file = join(request.outputDir, `${request.label}-${request.resolution}.png`);
      writeFileSync(file, Buffer.from(`PNG:big-${request.resolution}`), 'utf8');
      return {
        files: [file],
        source_url: 'https://example.test/up.png',
        task_ref: 'task-upscale-1',
        cost: { unit: 'credit', amount: 3 },
        /* 这个假后端不做参数收敛，如实报"没有调整"（空数组，不是 undefined） */
        notes: [],
      };
    },
  };
  return { backend, calls };
}

function upscaleInput(projectId: string, workspace: string, revision: number, overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    expectedRevision: revision,
    workspaceDir: workspace,
    shotId: 'shot-01',
    sourcePathRelative: 'frames/shot-01.png',
    sourceArtifactId: `sha256:${'a'.repeat(64)}`,
    resolution: '4k',
    estimatedCostCents: 50,
    actualCostCents: 50,
    ...overrides,
  };
}

describe('图片高清放大', () => {
  it('放大 → 产物入库（记下从哪张图来、哪一档），并如实记下花的是积分', async () => {
    const { projects, projectId, workspace, revision } = setup();
    const { backend, calls } = upscaleBackend();
    const outcome = await new GenerationService(projects, backend)
      .upscaleImage(upscaleInput(projectId, workspace, revision()));

    expect(outcome.shot_id).toBe('shot-01');
    expect(outcome.resolution).toBe('4k');
    expect(outcome.artifact_id.startsWith('sha256:')).toBe(true);
    expect(outcome.frame_path_relative).toContain('frames/upscale-');
    /* 后端拿到的是**磁盘上的绝对路径**与档位 */
    expect(calls[0]?.imageFile).toBe(join(workspace, 'frames', 'shot-01.png'));
    expect(calls[0]?.resolution).toBe('4k');

    const project = projects.getProject(projectId) as {
      derived_artifacts?: Array<{ artifact_id: string; metadata?: Record<string, unknown> | null }>;
    };
    const artifact = (project.derived_artifacts ?? []).find((item) => item.artifact_id === outcome.artifact_id);
    expect(artifact?.metadata?.source).toBe('image-upscale');
    expect(artifact?.metadata?.resolution).toBe('4k');
    expect(artifact?.metadata?.from_artifact).toBe(`sha256:${'a'.repeat(64)}`);
    expect(artifact?.metadata?.shot_id).toBe('shot-01');
    /* 积分原样记，不折算成钱 */
    expect(artifact?.metadata?.provider_cost).toEqual({ unit: 'credit', amount: 3 });
  });

  it('**不登记为候选**：放大的图不是"这一镜的首帧"的备选', async () => {
    const { projects, projectId, workspace, revision } = setup();
    const { backend } = upscaleBackend();
    await new GenerationService(projects, backend)
      .upscaleImage(upscaleInput(projectId, workspace, revision()));

    const project = projects.getProject(projectId) as { candidates?: unknown[] };
    expect(project.candidates ?? []).toHaveLength(0);
  });

  it('G1 未批准时被拦下：后端一次都没被调用', async () => {
    const { projects, projectId, workspace, revision } = setup({ approveG1: false });
    const { backend, calls } = upscaleBackend();
    await expect(new GenerationService(projects, backend)
      .upscaleImage(upscaleInput(projectId, workspace, revision())))
      .rejects.toMatchObject({ code: 'G1_REQUIRED' });
    expect(calls).toHaveLength(0);
  });

  it('后端不支持时抛 UnsupportedCapabilityError，而不是把原图复制一份返回', async () => {
    const { projects, projectId, workspace, revision } = setup();
    const { backend } = upscaleBackend();
    const noUpscale: GenerationBackend = {
      ...backend,
      capabilities: {
        image: true, videoFromImage: false, videoEdit: false,
        imageShortcut: false, imageUpscale: false,
        audioSpeech: false, audioMusic: false,
      },
    };
    await expect(new GenerationService(projects, noUpscale)
      .upscaleImage(upscaleInput(projectId, workspace, revision())))
      .rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('中途失败：意图结清为 FAILED，不留一条挂着预留的 PENDING', async () => {
    const { projects, projectId, workspace, revision } = setup();
    const { backend } = upscaleBackend({ fail: '上游返回 500：任务已受理但没出图' });
    await expect(new GenerationService(projects, backend)
      .upscaleImage(upscaleInput(projectId, workspace, revision())))
      .rejects.toThrow(/上游返回 500/);

    const project = projects.getProject(projectId) as {
      image_generations?: Array<{ status: string; failure?: string | null }>;
    };
    const intents = project.image_generations ?? [];
    expect(intents).toHaveLength(1);
    expect(intents[0]?.status).toBe('FAILED');
    expect(intents[0]?.failure).toContain('上游返回 500');
  });
});
