import { execFile } from 'node:child_process';
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';

export type ExportQuality = '1080p' | '4k';
export type ExportAspectRatio = '16:9' | '9:16' | '1:1' | '4:5' | '3:4';
export type ExportFit = 'contain' | 'cover';

export interface FilmExportSpec {
  quality: ExportQuality;
  aspectRatio: ExportAspectRatio;
  fit: ExportFit;
  fps?: 24 | 25 | 30 | 50 | 60;
}

export interface ResolvedFilmExportSpec extends FilmExportSpec {
  width: number;
  height: number;
  fps: 24 | 25 | 30 | 50 | 60;
}

const EXPORT_DIMENSIONS: Record<ExportQuality, Record<ExportAspectRatio, readonly [number, number]>> = {
  '1080p': {
    '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '3:4': [1080, 1440],
  },
  '4k': {
    '16:9': [3840, 2160], '9:16': [2160, 3840], '1:1': [2160, 2160], '4:5': [2160, 2700], '3:4': [2160, 2880],
  },
};

export function resolveFilmExportSpec(spec: FilmExportSpec): ResolvedFilmExportSpec {
  const dimensions = EXPORT_DIMENSIONS[spec.quality]?.[spec.aspectRatio];
  if (!dimensions) throw new Error('不支持的导出清晰度或画幅');
  const fps = spec.fps ?? 30;
  if (![24, 25, 30, 50, 60].includes(fps)) throw new Error('导出帧率只支持 24/25/30/50/60');
  if (spec.fit !== 'contain' && spec.fit !== 'cover') throw new Error('导出适配方式只支持 contain 或 cover');
  return { ...spec, width: dimensions[0], height: dimensions[1], fps };
}

export interface FilmExportPlan {
  spec: ResolvedFilmExportSpec;
  inputPath: string;
  outputPath: string;
  partialPath: string;
  args: string[];
}

export function planFilmExport(inputPath: string, outputPath: string, request: FilmExportSpec): FilmExportPlan {
  const spec = resolveFilmExportSpec(request);
  const partialPath = `${outputPath}.partial`;
  const videoFilter = spec.fit === 'contain'
    ? `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease,pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2:color=black`
    : `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=increase,crop=${spec.width}:${spec.height}`;
  return {
    spec,
    inputPath,
    outputPath,
    partialPath,
    args: [
      '-hide_banner', '-nostdin', '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a?',
      '-vf', `${videoFilter},setsar=1,fps=${spec.fps},format=yuv420p`,
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', '-y', partialPath,
    ],
  };
}

export interface FilmExportResult {
  ok: boolean;
  bytes: number;
  width?: number;
  height?: number;
  fps?: number;
  error?: string;
}

export async function exportFilm(plan: FilmExportPlan): Promise<FilmExportResult> {
  rmSync(plan.partialPath, { force: true });
  const encoded = await run('ffmpeg', plan.args, 30 * 60 * 1000);
  if (!encoded.ok || !existsSync(plan.partialPath)) {
    rmSync(plan.partialPath, { force: true });
    return { ok: false, bytes: 0, error: encoded.error ?? 'FFmpeg 没有产出导出文件' };
  }
  const verified = await probeExport(plan.partialPath);
  if (!verified || verified.width !== plan.spec.width || verified.height !== plan.spec.height
    || Math.abs(verified.fps - plan.spec.fps) > .01) {
    rmSync(plan.partialPath, { force: true });
    return {
      ok: false,
      bytes: 0,
      error: verified
        ? `导出规格不符：请求 ${plan.spec.width}×${plan.spec.height}@${plan.spec.fps}，实际 ${verified.width}×${verified.height}@${verified.fps}`
        : '无法复核导出文件规格',
    };
  }
  if (existsSync(plan.outputPath)) {
    rmSync(plan.partialPath, { force: true });
    return { ok: false, bytes: 0, error: '目标文件已存在，未覆盖' };
  }
  renameSync(plan.partialPath, plan.outputPath);
  return { ok: true, bytes: statSync(plan.outputPath).size, ...verified };
}

async function probeExport(path: string): Promise<{ width: number; height: number; fps: number } | null> {
  const result = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate', '-of', 'json', path,
  ], 30_000);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout ?? '') as { streams?: Array<{ width?: unknown; height?: unknown; avg_frame_rate?: unknown }> };
    const stream = parsed.streams?.[0];
    const [numerator, denominator] = String(stream?.avg_frame_rate ?? '0/1').split('/').map(Number);
    const fps = denominator ? (numerator ?? 0) / denominator : 0;
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    return Number.isFinite(width) && Number.isFinite(height) && Number.isFinite(fps) ? { width, height, fps } : null;
  } catch { return null; }
}

function run(command: string, args: readonly string[], timeout: number): Promise<{ ok: boolean; stdout?: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, stdout: typeof stdout === 'string' ? stdout : '' });
      const tail = String(stderr ?? '').trim().split('\n').slice(-4).join(' ');
      return resolve({ ok: false, error: tail || `${command} 执行失败` });
    });
  });
}
