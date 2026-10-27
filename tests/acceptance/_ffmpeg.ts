/* ============================================================
  验收用的 FFmpeg 辅助：造夹具、跑一遍、再**从像素上**看结果。

  为什么要看到像素：滤镜图写错时 ffmpeg 照样退出码 0，
  产出文件也照样能播——只是画面不对。只断言"命令成功"等于什么都没验。
  所以这里的每个验收都从真实成片里取一帧、读具体坐标的 RGB。

  临时目录统一用 `qiyin-` 前缀，`tests/global-setup.ts` 会收尾清理。
   ============================================================ */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function acceptanceTempDir(prefix = 'qiyin-acceptance-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** 生成一段纯色夹具视频。 */
export function makeColorClip(
  path: string,
  color: string,
  size: string,
  seconds: number,
  fps = 30,
): void {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=${seconds}:r=${fps}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path,
  ], { stdio: 'pipe' });
}

/** 取某一时刻的一帧，返回 rgb24 原始字节。 */
export function frameAt(path: string, seconds: number): Buffer {
  return execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-ss', seconds.toFixed(3), '-i', path,
    '-frames:v', '1', '-vf', 'format=rgb24', '-f', 'rawvideo', '-',
  ], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 从一帧里读某个坐标的颜色。 */
export function pixelAt(frame: Buffer, width: number, x: number, y: number): [number, number, number] {
  const offset = (y * width + x) * 3;
  return [frame[offset] ?? -1, frame[offset + 1] ?? -1, frame[offset + 2] ?? -1];
}

export function probeDurationSeconds(path: string): number {
  const output = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path,
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(output) as { format?: { duration?: string } };
  return Number(parsed.format?.duration ?? 'NaN');
}

export function probeSize(path: string): { width: number; height: number; fps: number } {
  const output = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate', '-of', 'json', path,
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(output) as {
    streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string }>;
  };
  const stream = parsed.streams?.[0] ?? {};
  const [numerator, denominator] = String(stream.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    fps: denominator ? (numerator ?? 0) / denominator : 0,
  };
}

/** 成片里都有哪些流（`video` / `audio`），按出现顺序。 */
export function probeStreamTypes(path: string): string[] {
  const output = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', path,
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(output) as { streams?: Array<{ codec_type?: string }> };
  return (parsed.streams ?? []).map((stream) => String(stream.codec_type ?? ''));
}

/** 生成一段单频正弦音，用作验收里的音轨素材。 */
export function makeToneClip(path: string, frequency: number, seconds: number): void {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}:sample_rate=48000`,
    '-y', path,
  ], { stdio: 'pipe' });
}

/** 颜色是否接近期望值（yuv420p 往返会有偏差，容差按经验给 60）。 */
export function nearColor(
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
  tolerance = 60,
): boolean {
  return actual.every((value, index) => Math.abs(value - (expected[index] ?? 0)) <= tolerance);
}

/**
 * 取色用的纯色色板。
 *
 * `hex` 是写进 ffmpeg 的**全饱和**颜色（不用 `color=c=green`——那个名字在 FFmpeg 里
 * 是 #008000，比"纯绿"暗一半，会让颜色断言看起来像失败）；
 * `rgb` 是转换到 yuv420p 再转回来之后**实测**的样子，
 * 与纯色相差 2–3 是往返误差，所以断言要带走容差。
 */
export const COLORS: Record<string, { hex: string; rgb: readonly [number, number, number] }> = {
  red: { hex: '0xFF0000', rgb: [253, 0, 0] },
  green: { hex: '0x00FF00', rgb: [0, 253, 0] },
  blue: { hex: '0x0000FF', rgb: [0, 0, 254] },
  yellow: { hex: '0xFFFF00', rgb: [253, 253, 0] },
  white: { hex: '0xFFFFFF', rgb: [255, 255, 255] },
};
