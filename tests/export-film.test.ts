import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  exportFilm, planFilmExport, resolveFilmExportSpec,
  type ExportAspectRatio, type ExportQuality,
} from '@qiyin/kernel-service';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const dimensions: Record<ExportQuality, Record<ExportAspectRatio, [number, number]>> = {
  '1080p': { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '3:4': [1080, 1440] },
  '4k': { '16:9': [3840, 2160], '9:16': [2160, 3840], '1:1': [2160, 2160], '4:5': [2160, 2700], '3:4': [2160, 2880] },
};

describe('ExportSpec@1', () => {
  it('1080P/4K × 五种画幅都解析成精确偶数像素', () => {
    for (const quality of ['1080p', '4k'] as const) {
      for (const aspectRatio of ['16:9', '9:16', '1:1', '4:5', '3:4'] as const) {
        const resolved = resolveFilmExportSpec({ quality, aspectRatio, fit: 'contain' });
        expect([resolved.width, resolved.height]).toEqual(dimensions[quality][aspectRatio]);
        expect(resolved.width % 2).toBe(0);
        expect(resolved.height % 2).toBe(0);
        expect(resolved.fps).toBe(30);
      }
    }
  });

  it('contain 用 pad 保全画面，cover 用 crop 铺满，且保留可选音频', () => {
    const contain = planFilmExport('in.mp4', 'out.mp4', { quality: '1080p', aspectRatio: '9:16', fit: 'contain' });
    expect(contain.args.join(' ')).toContain('force_original_aspect_ratio=decrease,pad=1080:1920');
    expect(contain.args).toContain('0:a?');
    expect(contain.partialPath).toBe('out.mp4.partial');
    const cover = planFilmExport('in.mp4', 'out.mp4', { quality: '4k', aspectRatio: '4:5', fit: 'cover', fps: 25 });
    expect(cover.args.join(' ')).toContain('force_original_aspect_ratio=increase,crop=2160:2700');
    expect(cover.args.join(' ')).toContain('fps=25');
  });

  it('真实 FFmpeg 导出 1080×1920 并由 ffprobe 二次校验', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qiyin-export-spec-'));
    roots.push(root);
    const input = join(root, 'source.mp4');
    const output = join(root, 'vertical.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=0.2:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', input]);
    const result = await exportFilm(planFilmExport(input, output, { quality: '1080p', aspectRatio: '9:16', fit: 'contain', fps: 30 }));
    expect(result).toMatchObject({ ok: true, width: 1080, height: 1920, fps: 30 });
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(output)).toBe(true);
    expect(existsSync(`${output}.partial`)).toBe(false);
  }, 30_000);

  it('目标已存在时不覆盖并清理 partial', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qiyin-export-collision-'));
    roots.push(root);
    const input = join(root, 'source.mp4');
    const output = join(root, 'existing.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.1:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', input]);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=16x16:d=0.1:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', output]);
    const result = await exportFilm(planFilmExport(input, output, { quality: '1080p', aspectRatio: '1:1', fit: 'cover', fps: 24 }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未覆盖');
    expect(existsSync(`${output}.partial`)).toBe(false);
  }, 30_000);
});
