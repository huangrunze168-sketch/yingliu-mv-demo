import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/* ============================================================
  期音科技 · 取一帧（视频续写要用它的尾帧）
   ------------------------------------------------------------
  矩阵 VID-006「视频续写 / 延长」的第一步就是：**拿到上一段的最后一帧**，
  把它当作下一段的起点（图生视频本来就以"首帧"为输入）。

  为什么用 `-sseof`（从结尾往回数）而不是"先 ffprobe 出时长再 `-ss 时长-0.1`"：
  后者要两趟、还要自己处理"时长读出来是 0 或者比实际短"这种边角；
  `-sseof -0.1` 是 ffmpeg 自己的语义，一步到位。

  回退一次（-0.1 失败时试 -1）是刻意的：极短的片段用 -0.1 可能落在流外，
  而"退回 1 秒"在正常片段上仍然取到接近结尾的一帧——比直接报错有用，
  但**必须把回退这件事说出来**（notes），不能让调用方以为取的就是最后那一帧。
   ============================================================ */

export function lastFrameArgs(inputPath: string, outputPath: string, seekBackSeconds = 0.1): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-sseof', `-${seekBackSeconds}`,
    '-i', inputPath,
    '-frames:v', '1',
    '-q:v', '2',
    '-y', outputPath,
  ];
}

export type ExtractFrameResult =
  | { ok: true; bytes: number; usedSeekBackSeconds: number; notes: string[] }
  | { ok: false; reason: string };

export async function extractLastFrame(inputPath: string, outputPath: string): Promise<ExtractFrameResult> {
  if (!existsSync(inputPath)) return { ok: false, reason: `找不到要续写的片段：${inputPath}` };
  mkdirSync(dirname(outputPath), { recursive: true });
  const notes: string[] = [];

  for (const seekBack of [0.1, 1]) {
    rmSync(outputPath, { force: true });
    const result = await run('ffmpeg', lastFrameArgs(inputPath, outputPath, seekBack), 5 * 60_000);
    if (result.ok && existsSync(outputPath) && statSync(outputPath).size > 0) {
      if (seekBack !== 0.1) {
        notes.push(`片段太短，取帧位置退回到结尾前 ${seekBack} 秒`);
      }
      return { ok: true, bytes: statSync(outputPath).size, usedSeekBackSeconds: seekBack, notes };
    }
    if (seekBack === 0.1) continue;
    return { ok: false, reason: result.error || 'ffmpeg 没有产出帧文件' };
  }
  return { ok: false, reason: 'ffmpeg 没有产出帧文件' };
}

function run(command: string, args: readonly string[], timeout: number): Promise<{ ok: boolean; error: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) return resolve({ ok: true, error: '' });
      const tail = String(stderr ?? '').trim().split('\n').slice(-3).join(' ').trim();
      return resolve({ ok: false, error: tail || '命令执行失败' });
    });
  });
}
