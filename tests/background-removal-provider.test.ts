import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_REMOVAL_CAPABILITY, BackgroundRemovalProvider,
  assertBackgroundRemovalSource, isTransparentPng, type BackgroundRemovalRunner,
} from '../packages/background-removal-provider/src/index.js';

const roots: string[] = [];
async function root() { const value = join(tmpdir(), `qiyin-remove-bg-${randomUUID()}`); roots.push(value); await mkdir(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });
function png(colorType = 6) { const bytes = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes[25] = colorType; return bytes; }

describe('独立 Background Removal Provider', () => {
  it('保持 Frontkernel capability 的稳定标识并拒绝非图片 Blob', () => {
    expect(BACKGROUND_REMOVAL_CAPABILITY).toBe('@frontkernel/background-removal@1#remove-background');
    expect(() => assertBackgroundRemovalSource({ kind: 'blob', resource: 'sha256:x', size: 1, mediaType: 'video/mp4', filePath: 'x' })).toThrow('Background Removal source must be an image Blob Artifact.');
  });

  it('Provider 拥有 queued → running → completed 生命周期并验证透明 PNG', async () => {
    const dir = await root(), source = join(dir, 'source.png'), output = join(dir, 'output.png'); await writeFile(source, png());
    const runner: BackgroundRemovalRunner = { probe: async () => ({ available: true, detail: 'fake' }), remove: async (_input, target) => { await writeFile(target, png(6)); } };
    const phases: string[] = [];
    const result = await new BackgroundRemovalProvider(runner).remove({ source: { kind: 'blob', resource: 'sha256:source', size: 33, mediaType: 'image/png', filePath: source }, outputPath: output, onTask: (event) => phases.push(event.phase) });
    expect(phases).toEqual(['queued', 'running', 'completed']);
    expect(result.output.mediaType).toBe('image/png');
    expect(isTransparentPng(await readFile(output))).toBe(true);
  });

  it('不可用时明确失败，不复制原图冒充抠图', async () => {
    const dir = await root(), source = join(dir, 'source.png'); await writeFile(source, png());
    const phases: string[] = [];
    const provider = new BackgroundRemovalProvider({ probe: async () => ({ available: false, detail: 'rembg not found' }), remove: async () => { throw new Error('不应执行'); } });
    await expect(provider.remove({ source: { kind: 'blob', resource: 'sha256:source', size: 33, mediaType: 'image/png', filePath: source }, outputPath: join(dir, 'out.png'), onTask: (event) => phases.push(event.phase) })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(phases).toEqual(['queued', 'failed']);
  });

  it('拒绝没有 Alpha 通道的 PNG 输出', async () => {
    expect(isTransparentPng(png(2))).toBe(false);
  });
});
