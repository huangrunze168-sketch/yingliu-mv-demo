/* ============================================================
  EXPORT-001「1080P、4K、多比例」的量化验收。

  矩阵要的组合是"多种输入 × 多套规格"。这里跑 3 种源（横、竖、方）
  × 6 套规格（1080p 五种画幅 + 4K 横屏），每一种都真导一遍，再用 ffprobe 复核
  宽高与帧率**逐项相等**。

  为什么不只看"导出成功"：`scale`/`pad` 写错时 ffmpeg 会自己挑一个
  它能接受的尺寸，命令照样成功——于是用户要 9:16 拿到的是 16:9。
  代码里那句"导出规格不符"的复核只有真跑一次才算验过。
   ============================================================ */

import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  exportFilm, planFilmExport, resolveFilmExportSpec,
  type ExportAspectRatio, type ExportQuality,
} from '@qiyin/kernel-service';
import { recordAcceptance } from './_acceptance.js';
import { acceptanceTempDir, makeColorClip, removeDir } from './_ffmpeg.js';

const dir = acceptanceTempDir('qiyin-acceptance-export-');
afterAll(() => removeDir(dir));

/** 3 种输入源：横屏、竖屏、正方。 */
const SOURCES = [
  { id: 'landscape', size: '320x180' },
  { id: 'portrait', size: '180x320' },
  { id: 'square', size: '240x240' },
] as const;

/** 6 套规格：1080P 五种画幅 + 4K 横屏。 */
const SPECS: Array<{ quality: ExportQuality; aspectRatio: ExportAspectRatio }> = [
  { quality: '1080p', aspectRatio: '16:9' },
  { quality: '1080p', aspectRatio: '9:16' },
  { quality: '1080p', aspectRatio: '1:1' },
  { quality: '1080p', aspectRatio: '4:5' },
  { quality: '1080p', aspectRatio: '3:4' },
  { quality: '4k', aspectRatio: '16:9' },
];

describe('[EXPORT-001] 导出规格矩阵', () => {
  it('3 种输入 × 6 套规格：宽高与帧率逐项相符', async () => {
    const results: Array<{
      source: string; quality: string; aspectRatio: string; fit: string;
      ok: boolean;
      width: number | undefined;
      height: number | undefined;
      fps: number | undefined;
      error: string | undefined;
    }> = [];

    for (const [sourceIndex, source] of SOURCES.entries()) {
      const inputPath = join(dir, `${source.id}.mp4`);
      makeColorClip(inputPath, 'white', source.size, 0.4);
      for (const [specIndex, spec] of SPECS.entries()) {
        /* 两种适配方式都要走到：一半 contain、一半 cover */
        const fit = (sourceIndex + specIndex) % 2 === 0 ? 'contain' : 'cover';
        const outputPath = join(dir, `${source.id}-${spec.quality}-${spec.aspectRatio.replace(':', 'x')}-${fit}.mp4`);
        const plan = planFilmExport(inputPath, outputPath, { ...spec, fit, fps: 24 });
        const expected = resolveFilmExportSpec({ ...spec, fit, fps: 24 });
        const done = await exportFilm(plan);
        results.push({
          source: source.id, quality: spec.quality, aspectRatio: spec.aspectRatio, fit,
          ok: done.ok, width: done.width, height: done.height, fps: done.fps, error: done.error,
        });
        expect(done.ok, `${source.id} ${spec.quality} ${spec.aspectRatio} ${fit}：${done.error ?? ''}`).toBe(true);
        expect(done.width).toBe(expected.width);
        expect(done.height).toBe(expected.height);
        expect(Math.abs((done.fps ?? 0) - expected.fps)).toBeLessThanOrEqual(0.01);
      }
    }

    recordAcceptance('EXPORT-001', {
      criterion: '导出宽高与帧率逐项相符（3 输入 × 6 规格）',
      exports: results.length,
      succeeded: results.filter((row) => row.ok).length,
      mismatch: results.filter((row) => !row.ok).map((row) => row.error),
      results,
    });

    expect(results.length).toBe(SOURCES.length * SPECS.length);
    expect(results.every((row) => row.ok)).toBe(true);
    /* 18 次真实编码：并行跑全量测试时机器被其它 FFmpeg 用例占着，给足时限 */
  }, 180_000);

  it('目标文件已存在时拒绝覆盖（不静默毁掉上一版成片）', async () => {
    const inputPath = join(dir, 'exists-source.mp4');
    makeColorClip(inputPath, 'white', '320x180', 0.3);
    const outputPath = join(dir, 'exists-output.mp4');
    const spec = { quality: '1080p', aspectRatio: '16:9', fit: 'contain', fps: 24 } as const;

    const first = await exportFilm(planFilmExport(inputPath, outputPath, spec));
    const second = await exportFilm(planFilmExport(inputPath, outputPath, spec));

    recordAcceptance('EXPORT-001.no-overwrite', {
      firstOk: first.ok,
      secondOk: second.ok,
      secondError: second.error ?? null,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error ?? '').toContain('已存在');
  }, 60_000);
});
