/* ============================================================
  VID-010「受控多参考槽位顺序」的量化验收。

  矩阵要的核心是**顺序即语义**：第 1 张是首要身份参考，后面依次是补充。
  所以这一组量三件事：

    ① 顺序真的传到后端（插件那条路收到的是有序数组，不是集合）；
    ② 顺序参与执行摘要——对调两张就是另一次生成（不然会误命中缓存）；
    ③ **只支持一张的后端如实降级**：只送第 1 张，并在 notes 里说明，
       而不是装作另外几张也生效了。
   ============================================================ */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCanvasBackend, CanvasAdapter, type CanvasRunRequest } from '@qiyin/canvas-adapter';
import { createVideogenBackend, VideogenAdapter } from '@qiyin/videogen-adapter';
import { createGenerationBackend, registerPluginBackends } from '@qiyin/generation-backends';
import { imageExecutionDigest } from '@qiyin/generation-service';
import { recordAcceptance } from './_acceptance.js';

const root = mkdtempSync(join(tmpdir(), 'qiyin-acceptance-multiref-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  registerPluginBackends([]);
});

function touch(name: string): string {
  const file = join(root, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(file, `PNG:${name}`, 'utf8');
  return file;
}

describe('[VID-010] 多参考槽位与顺序', () => {
  it('插件那条路收到的是**有序数组**（顺序不丢）', async () => {
    const received: unknown[] = [];
    registerPluginBackends([{
      pluginId: 'com.acceptance.multiref',
      providerId: 'multiref',
      label: '验收插件 · 多参考',
      capabilities: ['image.generate'],
      authMethods: ['none'],
      resolve: async () => ({
        provider_id: 'multiref',
        label: '多参考',
        capabilities: ['image.generate'],
        generate: async (request: unknown) => {
          received.push((request as { referenceImageFiles?: unknown }).referenceImageFiles);
          const dir = String((request as { outputDir?: unknown }).outputDir);
          mkdirSync(dir, { recursive: true });
          const file = join(dir, 'out.png');
          writeFileSync(file, 'PNG', 'utf8');
          return { files: [file], notes: [], cost: null };
        },
      }),
    }]);
    const backend = createGenerationBackend('plugin:multiref', { canvasCwd: root });
    const first = touch('a.png');
    const second = touch('b.png');
    await backend.generateImage({
      prompt: '两张参考',
      model: 'm',
      outputDir: root,
      label: 'shot-01',
      referenceImageFiles: [first, second],
    });

    recordAcceptance('VID-010.plugin-order', {
      criterion: '多张参考图按顺序交给插件',
      received: received[0],
      filesExist: [first, second].map((file) => existsSync(file)),
    });

    expect(received[0]).toEqual([first, second]);
  });

  it('顺序参与执行摘要：对调两张就是另一次生成', () => {
    const base = { backendId: 'plugin:multiref', model: 'm', prompt: '两张参考' };
    const forward = imageExecutionDigest({ ...base, referenceArtifactIds: ['sha256:aa', 'sha256:bb'] });
    const backward = imageExecutionDigest({ ...base, referenceArtifactIds: ['sha256:bb', 'sha256:aa'] });
    const single = imageExecutionDigest({ ...base, referenceArtifactId: 'sha256:aa' });

    recordAcceptance('VID-010.digest-order', {
      criterion: '顺序变了摘要就变（不会误命中缓存）',
      forward,
      backward,
      differsWhenSwapped: forward !== backward,
      singleDiffersFromMulti: single !== forward,
    });

    expect(forward).not.toBe(backward);
    expect(single).not.toBe(forward);
  });

  it('只支持一张的后端如实降级：Canvas 只连第 1 张并写进 notes', async () => {
    const calls: CanvasRunRequest[] = [];
    const runner = {
      run: async (request: CanvasRunRequest) => {
        calls.push(request);
        const [name, second] = request.args;
        if (name === 'upload') return { code: 0, stdout: JSON.stringify({ nodeKey: 'ref-1' }), stderr: '' };
        if (name === 'model') return { code: 0, stdout: '{}', stderr: '' };
        if (name === 'node' && second === 'create') return { code: 0, stdout: JSON.stringify({ nodeKey: 'n1' }), stderr: '' };
        if (name === 'node') {
          return { code: 0, stderr: '', stdout: '[run] task=t1 status=2 progress=100%\n' + JSON.stringify({ nodeKey: 'n1', status: 2, data: { url: ['https://example.test/a.png'] } }) };
        }
        if (name === 'download') {
          const outIndex = request.args.indexOf('--out');
          const dir = (outIndex >= 0 ? request.args[outIndex + 1] : undefined) ?? root;
          mkdirSync(dir, { recursive: true });
          const file = join(dir, 'gen.png');
          writeFileSync(file, 'PNG:gen', 'utf8');
          return { code: 0, stdout: `${file}\n`, stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'unexpected' };
      },
    };
    const backend = createCanvasBackend(new CanvasAdapter(runner));
    const first = touch('canvas-a.png');
    const second = touch('canvas-b.png');
    const media = await backend.generateImage({
      prompt: '两张参考', model: 'Z-image Turbo', outputDir: root, label: 'shot-02',
      referenceImageFiles: [first, second],
    });

    const uploads = calls.filter((call) => call.args[0] === 'upload');
    recordAcceptance('VID-010.honest-degradation', {
      criterion: '只吃一张的后端只送第 1 张，并说明降级（不假装另外几张生效）',
      uploads: uploads.length,
      uploadedFirstOnly: uploads[0]?.args.join(' ').includes('canvas-a.png') ?? false,
      notes: media.notes,
      mentionsDegradation: media.notes.some((note) => note.includes('只用了第 1 张')),
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.args.join(' ')).toContain('canvas-a.png');
    expect(media.notes.some((note) => note.includes('只用了第 1 张'))).toBe(true);
  });

  it('Videogen 那条路**真的能收多张**：attachments 按顺序给出去', async () => {
    const seen: string[][] = [];
    const produced = join(root, 'out', 'videogen_ab.png');
    const adapter = {
      chat: async (request: { attachments?: readonly string[] }) => {
        seen.push([...(request.attachments ?? [])]);
        return {
          threadId: 'th-1',
          artifacts: [{ type: 'image', url: 'https://x/a.png', localPath: produced }],
          warning: null,
          agentMessage: null,
        };
      },
      probe: async () => ({ scriptRunnable: true, credentialPresent: true, detail: '' }),
    } as unknown as VideogenAdapter;
    const backend = createVideogenBackend(adapter);
    const first = touch('videogen-a.png');
    const second = touch('videogen-b.png');
    /* 产物目录里放一张图，让后端能"下载"到东西 */
    mkdirSync(join(root, 'out'), { recursive: true });
    writeFileSync(produced, 'PNG', 'utf8');

    await backend.generateImage({
      prompt: '两张参考', model: 'seedream', outputDir: join(root, 'out'), label: 'shot-03',
      referenceImageFiles: [first, second],
    });

    recordAcceptance('VID-010.videogen-multi', {
      criterion: '支持多张的后端按顺序全部传下去',
      attachments: seen[0] ?? [],
      count: (seen[0] ?? []).length,
    });

    expect(seen[0]).toEqual([first, second]);
  });
});
