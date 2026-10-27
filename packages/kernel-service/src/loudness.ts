import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/* ============================================================
   期音科技 · 响度测量
   ------------------------------------------------------------
   为什么需要单独测量，而不是读 `hasAudio`：

   `hasAudio` 回答的是「容器里有没有音频流」，而 前置内核 的成片在合流那一步
   **总会写一条音轨**——没有声音时写的是数字静音。
   实测：一条完全无声的成片（我们声明了 `audio="none"`），

   于是「音轨存在性」这个评估维度会恒为一致，永远发现不了真问题——
   「这一段本来有声音，被我们丢了」。

   实测的三种情况（同一台机器，同一批素材）：

     参考片 sources/final.mp4        hasAudio=true   max=-91.0 dB  → 其实是静音
     生成的片段 shot-01-video.mp4    hasAudio=true   max= -8.8 dB  → 真的有声音
     我们的成片 motion-film.mp4      hasAudio=true   max=-91.0 dB  → 声音被丢了

   三个 true，三种完全不同的事实。所以这一维度必须靠测量。
   ============================================================ */

/** volumedetect 对纯数字静音报的读数就是 -91.0 dB，它同时也是下界。 */
export const SILENCE_FLOOR_DB = -91;

/**
 * 「有声音」的门槛。
 *
 * 取 -60 dB：纯数字静音是 -91，而任何真人说话、音乐、环境音都远高于这个值
 * （实测片段峰值 -8.8 dB）。门槛放在中间，既不会被编码噪声骗过，
 * 也不会把轻声素材误判成静音。
 */
export const AUDIBLE_MAX_DB = -60;

export interface LoudnessMeasurement {
  /** 峰值电平（dBFS）。 */
  max_db: number;
  /** 平均电平（dBFS）。 */
  mean_db: number;
}

export type LoudnessRunner = (file: string) => Promise<LoudnessMeasurement | null>;

/**
 * 用 ffmpeg 的 volumedetect 量一条媒体的响度。
 *
 * 量不出来时返回 `null` 而不是猜一个值：调用方据此降级并**如实标注**，
 * 而不是把一个没测过的结论写成「一致」。
 *
 * ffmpeg 是本地渲染的既有依赖（前置内核 的本地媒体 Provider 也要求它），
 * 因此这里不引入新的部署负担；缺了也只是退化成「只看有没有音轨」。
 */
export async function measureLoudness(file: string): Promise<LoudnessMeasurement | null> {
  if (!existsSync(file)) return null;
  const stderr = await runFfmpegVolumeDetect(file);
  if (stderr === null) return null;
  const max = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  if (max === null && mean === null) return null;
  const maxDb = max === null ? SILENCE_FLOOR_DB : Number(max[1]);
  const meanDb = mean === null ? maxDb : Number(mean[1]);
  if (!Number.isFinite(maxDb) || !Number.isFinite(meanDb)) return null;
  return { max_db: maxDb, mean_db: meanDb };
}

function runFfmpegVolumeDetect(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-nostdin', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        // volumedetect 的报告写在 stderr 上；即使 ffmpeg 退出码非 0，
        // 只要拿到读数就仍然可用（例如轨尾截断的素材）
        const text = typeof stderr === 'string' ? stderr : '';
        if (error !== null && !text.includes('mean_volume')) resolve(null);
        else resolve(text);
      },
    );
  });
}

/**
 * 这条媒体**有没有声音**。
 *
 * `null` 表示测不出来——调用方必须把它与「测出来是静音」区分开。
 */
export function audible(measurement: LoudnessMeasurement | null): boolean | null {
  if (measurement === null) return null;
  return measurement.max_db > AUDIBLE_MAX_DB;
}
