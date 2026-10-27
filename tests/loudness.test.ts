import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audible, AUDIBLE_MAX_DB, measureLoudness, SILENCE_FLOOR_DB } from '@qiyin/kernel-service';

/**
 * 响度测量。
 *
 * 存在的理由只有一个：`hasAudio` 分不清「有声」和「数字静音」。
 * 「声音被丢了」这件事永远发现不了——而它恰恰是复刻里最容易悄悄发生的一次丢失。
 */

/** ffmpeg 是可选依赖：没有它时真实测量那组测试跳过，纯逻辑测试照常跑。 */
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

describe('响度判读', () => {
  it('数字静音不算「有声音」', () => {
    expect(audible({ max_db: SILENCE_FLOOR_DB, mean_db: SILENCE_FLOOR_DB })).toBe(false);
  });

  it('真人说话/音乐那样的电平算「有声音」', () => {
    // 实测生成片段的读数
    expect(audible({ max_db: -8.8, mean_db: -23.3 })).toBe(true);
  });

  it('门槛是严格大于：正好等于门槛判静音', () => {
    expect(audible({ max_db: AUDIBLE_MAX_DB, mean_db: AUDIBLE_MAX_DB })).toBe(false);
    expect(audible({ max_db: AUDIBLE_MAX_DB + 0.1, mean_db: AUDIBLE_MAX_DB })).toBe(true);
  });

  it('测不出来返回 null，与「测出来是静音」严格区分', () => {
    expect(audible(null)).toBeNull();
  });
});

describe('ffmpeg 读表', () => {
  it('文件不存在时返回 null，而不是抛错或猜一个值', async () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'qiyin-loudness-')), 'nope.mp4');
    expect(await measureLoudness(missing)).toBeNull();
  });

  it.skipIf(!hasFfmpeg)('真实音频与真实静音被区分开', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qiyin-loudness-'));
    const tone = join(dir, 'tone.wav');
    const silent = join(dir, 'silent.wav');
    // 440Hz 正弦 0.3s
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-y', tone], { windowsHide: true });
    // 等长静音
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.3', '-y', silent], { windowsHide: true });

    const toneReading = await measureLoudness(tone);
    const silentReading = await measureLoudness(silent);
    expect(toneReading).not.toBeNull();
    expect(silentReading).not.toBeNull();
    expect(audible(toneReading)).toBe(true);
    expect(audible(silentReading)).toBe(false);
    // 静音就是 volumedetect 的下界，这也解释了为什么门槛能定在 -60
    expect(silentReading?.max_db).toBe(SILENCE_FLOOR_DB);
  }, 60_000);
});
