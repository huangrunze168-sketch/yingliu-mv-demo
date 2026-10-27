import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

/* ============================================================
   期音科技 · 音视频分离（把一段素材的声音拆出来）
   ------------------------------------------------------------
   对齐 小QTV 实测：节点快捷工具条里的「音视频分离」
   （i18n 词条在 ui-strings 里与「智能去字幕 / 主体消除 / 创意片头」同组）。

   为什么用 ffmpeg 而不是内核：前置内核 的能力面是
   version / check / plan / build / status / inspect / media probe / boundaries / frames——
   **没有抽音轨**。而 ffmpeg 本来就是本地渲染的既有依赖
   （`loudness.ts` 用它做 volumedetect，前置内核 的本地媒体 Provider 也要求它），
   所以这里不引入新的部署负担。

   这一层只做一件事：把声音抽出来。**不做**降噪、不重采样成"更好听"的版本——
   那些是加工，用户没要求，做了也说不清改动在哪。
   ============================================================ */

/** 产物的相对路径。放在 `derived/` 下，与用户素材分开（同宫格切分、拉片帧）。 */
export function audioOutputRelativePath(timestamp: string): string {
  return `derived/audio-${timestamp}.m4a`;
}

export interface AudioExtractionVerdict {
  ok: boolean;
  /** `ok: false` 时给出的、能直接显示给用户的原因 */
  reason?: string;
}

/**
 * 这条素材能不能抽音轨。

 * 提前判一次的价值很具体：没有音轨时 ffmpeg 会以
 * 「Output file #0 does not contain any stream」失败，
 * 那句话离起因（这条素材本来就没声音）隔着好几层命令行参数，
 * 用户拿到它只会以为是软件坏了。
 */
export function canExtractAudio(probe: { hasAudio: boolean; hasVideo?: boolean }): AudioExtractionVerdict {
  if (!probe.hasAudio) {
    return {
      ok: false,
      reason: probe.hasVideo === false
        ? '这条素材里没有音轨（它本身是一段音频以外的文件）'
        : '这条素材里没有音轨——上游给的片段是静音的，没有声音可以分离',
    };
  }
  return { ok: true };
}

/**
 * ffmpeg 参数。

 * 几个必须留在参数里的东西，各有理由：
 *   · `-vn`：不写的话，遇到带封面的容器会把封面当成一帧视频写进 m4a；
 *   · `-y`：输出名带时间戳，正常不会撞；加上它是因为**撞了也必须覆盖**——
 *     卡在交互式提问上会让子进程一直挂着，而界面只会显示"分离中"；
 *   · 统一转 AAC 而不是 `-c:a copy`：源音轨可能是 PCM、Opus、AC3，
 *     直接 copy 进 mp4 容器会被 ffmpeg 拒绝或产出无法播放的文件。
 */
export function audioExtractArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-i', inputPath,
    '-vn',
    '-c:a', 'aac', '-b:a', '192k',
    outputPath,
  ];
}

/**
 * 抽音轨。

 * 失败时把 ffmpeg 的 stderr 尾部一起带出来——它的错误信息是这件事上最准确的说明，
 * 我们不该用一句"操作失败"把它盖掉。
 */
export async function extractAudioTrack(inputPath: string, outputPath: string): Promise<{
  ok: boolean;
  bytes: number;
  error?: string;
}> {
  if (!existsSync(inputPath)) return { ok: false, bytes: 0, error: `素材不存在：${inputPath}` };
  const result = await runFfmpeg(audioExtractArgs(inputPath, outputPath));
  if (!result.ok) return { ok: false, bytes: 0, error: result.error ?? 'ffmpeg 执行失败' };
  if (!existsSync(outputPath)) {
    return { ok: false, bytes: 0, error: 'ffmpeg 报成功，但没有产出文件' };
  }
  return { ok: true, bytes: statSync(outputPath).size };
}

function runFfmpeg(args: readonly string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile('ffmpeg', [...args], { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve({ ok: true });
        return;
      }
      const text = (typeof stderr === 'string' ? stderr : '').trim();
      /* 只留最后几行：ffmpeg 的 stderr 很长，前面都是无关的输入探测输出 */
      const tail = text.split('\n').slice(-3).join(' ').trim();
      resolve({ ok: false, error: tail.length > 0 ? `ffmpeg：${tail}` : 'ffmpeg 执行失败' });
    });
  });
}
