/* ============================================================
  AUD-001 / AUD-002 的**后端那条路**（配音与音乐走 Provider，而不是本机 TTS）。

  状态要说清楚：本机那条路（Windows 系统语音）已经能用；**后端这条路是"路径已通、等 Provider"**：

    · 插件声明 `audio.tts` / `audio.music` 后，能力位亮起来、请求能被转发、产物能被核对；
    · 音频生成走**项目级生成意图**：先预留预算、结清按实际退回（与主体补全同一条规矩）。

  所以这一组量的是"路修好了没有"，不是"有没有音乐听"——本机没有任何可离线使用的音乐模型，
  这一点写在这里，免得以后有人把这两件事混起来看。
   ============================================================ */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { UnsupportedCapabilityError } from '@qiyin/generation-backend';
import { createGenerationBackend, registerPluginBackends } from '@qiyin/generation-backends';
import { createCanvasBackend, CanvasAdapter } from '@qiyin/canvas-adapter';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { recordAcceptance } from './_acceptance.js';

const root = mkdtempSync(join(tmpdir(), 'qiyin-acceptance-audio-backend-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  registerPluginBackends([]);
});

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:acceptance', type, payload, ...extras };
}

describe('[AUD-001/002] 音频生成的后端路径', () => {
  it('内置后端如实声明不支持音频：4 家都是 false，调用时抛 UnsupportedCapabilityError', async () => {
    const runner = { run: async () => ({ code: 0, stdout: '{}', stderr: '' }) };
    const canvas = createCanvasBackend(new CanvasAdapter(runner));
    const backends = [{ label: canvas.label, capabilities: canvas.capabilities, backend: canvas }];
    /*
      Videogen 那条路要机器上装了官方 skill 脚本才能构造（找不到会明确报错）。
      所以这里**构造得起来就验、构造不起来就如实记下**——
      为了凑"4 家"去伪造一个 adapter，验的就不是真实情况了。
    */
    const unbuildable: string[] = [];
    for (const id of ['imagegen', 'videogen', 'stub'] as const) {
      try {
        const built = createGenerationBackend(id, { canvasCwd: root });
        backends.push({ label: built.label, capabilities: built.capabilities, backend: built });
      } catch (error) {
        unbuildable.push(`${id}：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    }
    const declaredOff = backends.filter((item) => !item.capabilities.audioSpeech && !item.capabilities.audioMusic);
    const refused: string[] = [];
    for (const item of backends) {
      try {
        await item.backend.generateAudio({
          kind: 'music', prompt: '轻快的电子乐', model: 'm', durationSeconds: 10, outputDir: root, label: 'x',
        });
        refused.push(`${item.label}:未被拒`);
      } catch (error) {
        refused.push(error instanceof UnsupportedCapabilityError ? `${item.label}:已拒` : `${item.label}:别的错`);
      }
    }

    recordAcceptance('AUD-002.path', {
      criterion: '音频能力位如实声明；不支持的后端拒绝而不是返回静音',
      backendsChecked: backends.length,
      unbuildableOnThisMachine: unbuildable,
      declaredUnsupported: declaredOff.length,
      refusalResults: refused,
      note: '本机没有可离线使用的音乐模型，所以这一条是"路径已通、等 Provider"，不是"能生成音乐了"',
    });

    expect(declaredOff).toHaveLength(backends.length);
    expect(backends.length).toBeGreaterThanOrEqual(3);
    expect(refused.every((line) => line.endsWith('已拒'))).toBe(true);
  });

  it('插件声明 audio.music 之后：能力位亮起，音频产物能被核对并进账本', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    registerPluginBackends([{
      pluginId: 'com.acceptance.music',
      providerId: 'music-maker',
      label: '验收插件 · 音乐',
      capabilities: ['audio.music'],
      authMethods: ['none'],
      resolve: async () => ({
        provider_id: 'music-maker',
        label: '音乐生成',
        capabilities: ['audio.music'],
        generate: async (request: unknown) => {
          const payload = request as { outputDir?: unknown; label?: unknown; kind?: unknown };
          const dir = String(payload.outputDir);
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${String(payload.label)}.wav`);
          writeFileSync(file, Buffer.from('RIFF____WAVEfmt '), 'binary');
          return { files: [file], notes: ['分辨率被后端降级'], cost: { unit: 'credit', amount: 5 } };
        },
      }),
    }]);

    const backend = createGenerationBackend('plugin:music-maker', { canvasCwd: workspace });
    expect(backend.capabilities.audioMusic).toBe(true);
    expect(backend.capabilities.audioSpeech).toBe(false);
    /* 只声明了音乐：配音请求要被拒（不是"顺手也做了"） */
    const speechRefusal = await backend.generateAudio({
      kind: 'speech', prompt: '台词', model: 'm', durationSeconds: 5, outputDir: workspace, label: 's',
    }).then(() => '(未被拒)').catch((error: Error) => error.message);

    /* 走账本：先预留、结清按实际 */
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = service.execute(command('project.create', {
      name: '音乐生成', max_budget_cents: 500, rights_confirmed: true,
    })).project_id as string;
    const revision = () => (service.getProject(projectId) as { revision: number }).revision;
    const intent = service.execute(command('asset-generation.request', {
      kind: 'audio', purpose: 'audio:music', model: 'plugin-model', prompt: '轻快的电子乐',
      estimated_cost_cents: 30,
    }, { project_id: projectId, expected_revision: revision() }));
    const media = await backend.generateAudio({
      kind: 'music', prompt: '轻快的电子乐', model: 'plugin-model',
      durationSeconds: 12, outputDir: join(workspace, 'derived'), label: 'bgm-1',
    });
    const artifactId = `sha256:${'b'.repeat(64)}`;
    service.execute(command('artifact.publish', {
      artifact_id: artifactId, media_type: 'audio/wav', bytes: 16,
      metadata: { artifact_path_relative: 'derived/bgm-1.wav', project_id: projectId, source: 'backend-music' },
    }));
    const settled = service.execute(command('asset-generation.settle', {
      intent_id: (intent.payload as { intent_id: string }).intent_id,
      status: 'COMPLETED', artifact_id: artifactId, provider_cost: media.cost ?? undefined,
    }, { project_id: projectId, expected_revision: revision() }));

    recordAcceptance('AUD-002.plugin-path', {
      criterion: '插件声明 audio.music 后：能力位亮、产物可核对、走项目账本结清',
      capabilities: backend.capabilities,
      files: media.files.length,
      notes: media.notes,
      cost: media.cost,
      speechRefusal,
      releasedCents: (settled.payload as { released_cents: number }).released_cents,
      reservedAfterSettle: (service.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents,
      settleNote: '插件只报了积分（credit）、没报人民币金额 → 预留继续占着（证不了省了钱就不退）',
    });

    expect(media.files).toHaveLength(1);
    expect(media.cost).toEqual({ unit: 'credit', amount: 5 });
    expect(speechRefusal).toContain('不支持');
    /* 只报积分不报金额 → 预留不动（与既有账本口径一致） */
    expect((settled.payload as { released_cents: number }).released_cents).toBe(0);
    expect((service.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(30);
  });
});
