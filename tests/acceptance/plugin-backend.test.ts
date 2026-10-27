/* ============================================================
  插件 Provider → 生成后端（把签名插件接到真实生成链路上）。

  这一层要验的是**端口适配有没有说谎**：

    · 能力位来自清单声明（不执行插件代码就能知道）；
    · 没声明的能力被调用时，抛的是 `UnsupportedCapabilityError`（界面据此说"这家不支持"），
      而不是"调用失败"；
    · 插件报成功但产物不存在 → 必须报错并点名是哪个插件（这是这条链路上最贵的错误）；
    · **懒加载**：登记时不许执行第三方代码。

  最后一条集成用例走的是**真实生成链路**：注册一个真插件 → 选中 `plugin:<id>` →
  `GenerationService` 出图 → 候选登记进领域。那一步才算"接上了"。
   ============================================================ */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { GenerationService } from '@qiyin/generation-service';
import {
  createGenerationBackend, labelForBackend, parseBackendId, pluginBackendEntries,
  registerPluginBackends, type PluginBackendSource,
} from '@qiyin/generation-backends';
import { UnsupportedCapabilityError } from '@qiyin/generation-backend';
import type { PluginProviderDescriptor } from '@qiyin/plugin-host';
import { recordAcceptance } from './_acceptance.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  /* 注册表是模块级状态：每个用例之后清干净，免得互相影响 */
  registerPluginBackends([]);
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qiyin-plugin-backend-'));
  roots.push(dir);
  return dir;
}

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

/** 造一个"插件 Provider"：`generate` 的行为由调用方给。 */
function source(
  providerId: string,
  capabilities: string[],
  generate: (request: Record<string, unknown>) => Promise<unknown>,
  onResolve?: () => void,
): PluginBackendSource {
  return {
    pluginId: 'com.example.provider',
    providerId,
    label: `示例插件 · ${providerId}`,
    capabilities,
    /* 这个示例插件自己搞定凭据，不向宿主索取——清单里就是 `['none']`。 */
    authMethods: ['none'],
    resolve: async () => {
      onResolve?.();
      return { provider_id: providerId, label: providerId, capabilities, generate } as PluginProviderDescriptor;
    },
  };
}

describe('插件后端 · 端口适配', () => {
  it('能力位来自清单声明；登记时**不执行**插件代码（懒加载）', () => {
    let resolved = 0;
    registerPluginBackends([source('image-x', ['image.generate', 'video.fromImage'], async () => ({ files: [] }), () => { resolved += 1; })]);

    const backend = createGenerationBackend('plugin:image-x', { canvasCwd: scratch() });
    expect(backend.capabilities).toEqual({
      image: true, videoFromImage: true, videoEdit: false, imageShortcut: false, imageUpscale: false,
      /* 清单里没声明 audio.tts / audio.music → 两位都是 false */
      audioSpeech: false, audioMusic: false,
    });
    /* 只是拿 capabilities，不该把插件跑起来 */
    expect(resolved).toBe(0);
    expect(pluginBackendEntries()).toEqual([{
      id: 'plugin:image-x',
      label: '示例插件 · image-x',
      capabilities: ['image.generate', 'video.fromImage'],
      authMethods: ['none'],
    }]);
    expect(labelForBackend('plugin:image-x')).toBe('示例插件 · image-x');
  });

  it('没声明的能力被调用时抛 UnsupportedCapabilityError（不是"调用失败"）', async () => {
    registerPluginBackends([source('image-only', ['image.generate'], async () => ({ files: [] }))]);
    const backend = createGenerationBackend('plugin:image-only', { canvasCwd: scratch() });

    await expect(backend.editVideo({ videoFile: 'a.mp4', prompt: 'x', model: 'm', outputDir: scratch(), label: 'l' }))
      .rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(backend.generateVideoFromImage({
      imageFile: 'a.png', model: 'm', durationSeconds: 5, outputDir: scratch(), label: 'l',
    })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('插件报成功但没有产物、或者产物不存在 → 报错并点名是哪个插件', async () => {
    const dir = scratch();
    registerPluginBackends([
      source('empty', ['image.generate'], async () => ({ files: [] })),
      source('ghost', ['image.generate'], async () => ({ files: [join(dir, '不存在的文件.png')] })),
    ]);
    const empty = createGenerationBackend('plugin:empty', { canvasCwd: dir });
    const ghost = createGenerationBackend('plugin:ghost', { canvasCwd: dir });
    const request = { prompt: '一只猫', model: 'm', outputDir: dir, label: 'shot-01' };

    await expect(empty.generateImage(request)).rejects.toThrow(/没有给出任何产物文件/);
    await expect(ghost.generateImage(request)).rejects.toThrow(/产物文件不存在/);
  });

  it('正常返回时把产物、花费、备注原样带回（备注是"插件改了什么"）', async () => {
    const dir = scratch();
    const file = join(dir, 'out.png');
    writeFileSync(file, 'PNG', 'utf8');
    registerPluginBackends([
      source('ok', ['image.generate'], async () => ({
        files: [file], notes: ['插件把 4K 降成了 1080p'], cost: { unit: 'credit', amount: 3 }, task_ref: 'task-1',
      })),
    ]);
    const backend = createGenerationBackend('plugin:ok', { canvasCwd: dir });
    const media = await backend.generateImage({ prompt: '一只猫', model: 'm', outputDir: dir, label: 'shot-01' });

    recordAcceptance('BYOK-003.backend-bridge', {
      criterion: '插件 Provider 被包装成生成后端：产物/花费/备注如实带回，未声明的能力不可用',
      filesReturned: media.files.length,
      notesReturned: media.notes,
      cost: media.cost,
      taskRef: media.task_ref,
      declaredCapabilities: backend.capabilities,
    });

    expect(media.files).toEqual([file]);
    expect(media.notes).toEqual(['插件把 4K 降成了 1080p']);
    expect(media.cost).toEqual({ unit: 'credit', amount: 3 });
    expect(media.task_ref).toBe('task-1');
    /* 第二次调用不会重复加载插件（宿主的 resolve 只跑一次） */
    await backend.generateImage({ prompt: '再一张', model: 'm', outputDir: dir, label: 'shot-02' });
  });

  it('parseBackendId 认已登记的插件后端；没登记的说清去哪儿看', () => {
    registerPluginBackends([source('known', ['image.generate'], async () => ({ files: [] }))]);
    expect(parseBackendId('plugin:known')).toBe('plugin:known');
    expect(() => parseBackendId('plugin:nope')).toThrowError(/没有登记/);
    expect(() => parseBackendId('plugin:nope')).toThrowError(/插件列表/);
    /* 插件没登记时，错误信息里不会出现一个用不了的选项 */
    expect(() => parseBackendId('某个不存在的后端')).toThrowError(/未知的生成后端/);
  });

  it('两个插件注册同一个 Provider id → 登记时就拒绝（不静默覆盖）', () => {
    expect(() => registerPluginBackends([
      source('dup', ['image.generate'], async () => ({ files: [] })),
      source('dup', ['image.generate'], async () => ({ files: [] })),
    ])).toThrowError(/同一个 Provider id/);
  });
});

describe('插件后端 · 接进真实生成链路', () => {
  it('选中 plugin:<id> 后，GenerationService 真的用它出图并登记候选', async () => {
    const workspace = scratch();
    const projects = new ProjectService(openDatabase(':memory:'));
    const projectId = projects.execute(command('project.create', {
      name: '插件出图', max_budget_cents: 1000, rights_confirmed: true,
    })).project_id as string;
    const revision = () => (projects.getProject(projectId) as { revision: number }).revision;
    projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: revision() }));
    projects.execute(command('shot-fields.seed', {
      breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2100 }],
    }, { project_id: projectId, expected_revision: revision() }));
    projects.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: revision() }));

    /* 插件把图写进 outputDir，再把绝对路径交回来——这就是插件契约 */
    registerPluginBackends([source('fake-image', ['image.generate'], async (request) => {
      const outputDir = String(request.outputDir);
      mkdirSync(outputDir, { recursive: true });
      const file = join(outputDir, 'plugin-shot-01.png');
      writeFileSync(file, `PNG:${String(request.label)}`, 'utf8');
      return { files: [file], notes: [], cost: { unit: 'cent', amount: 0 } };
    })]);

    const backend = createGenerationBackend('plugin:fake-image', { canvasCwd: workspace });
    const service = new GenerationService(projects, backend);
    const outcome = await service.generateShotImages({
      projectId,
      expectedRevision: revision(),
      canvasCwd: workspace,
      workspaceDir: workspace,
      shots: [{ shot_id: 'shot-01', prompt: '插件出图' }],
      model: 'plugin-model',
      estimatedCostCents: 5,
      actualCostCents: 5,
    });

    expect(outcome.generated).toHaveLength(1);
    expect(outcome.generated[0]?.shot_id).toBe('shot-01');
    /* 候选真的登记进领域了（这是"接上生成链路"的判据） */
    const project = projects.getProject(projectId) as { candidates?: Array<{ shot_id: string; artifact_id: string }> };

    recordAcceptance('BYOK-003.generation-path', {
      criterion: '选中 plugin:<id> 后走真实生成链路：出图并登记候选',
      backendId: backend.id,
      backendLabel: labelForBackend(backend.id),
      generated: outcome.generated.length,
      candidateRegistered: project.candidates?.some((candidate) => candidate.shot_id === 'shot-01') ?? false,
      artifactId: String(outcome.generated[0]?.artifact_id ?? ''),
    });

    expect(project.candidates?.some((candidate) => candidate.shot_id === 'shot-01')).toBe(true);
    expect(String(outcome.generated[0]?.artifact_id ?? '')).toMatch(/^sha256:[a-f0-9]{64}$/);
  }, 120_000);
});
