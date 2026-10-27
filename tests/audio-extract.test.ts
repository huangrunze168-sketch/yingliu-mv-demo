import { describe, expect, it } from 'vitest';

import {
  audioExtractArgs,
  audioOutputRelativePath,
  canExtractAudio,
} from '../packages/kernel-service/src/audio-extract.js';

/* ============================================================
   音视频分离：能测的是"该不该做"和"怎么做"，执行本身要真实 ffmpeg。

   最要紧的一条是 `canExtractAudio`：没有音轨时提前拦下来。
   不拦的话 ffmpeg 会以
   「Output file #0 does not contain any stream」失败，
   那句话离起因（这条素材本来就没声音）隔着好几层命令行参数，
   用户拿到它只会以为软件坏了。
   ============================================================ */

describe('canExtractAudio', () => {
  it('有音轨就放行', () => {
    expect(canExtractAudio({ hasAudio: true, hasVideo: true })).toEqual({ ok: true });
    /* 纯音频素材也允许"分离"——结果是它自己的一份副本，但那是用户的明确选择 */
    expect(canExtractAudio({ hasAudio: true, hasVideo: false })).toEqual({ ok: true });
  });

  it('没有音轨就拦下来，并说清是哪种"没有"', () => {
    const withVideo = canExtractAudio({ hasAudio: false, hasVideo: true });
    expect(withVideo.ok).toBe(false);
    expect(withVideo.reason).toContain('静音');

    const withoutVideo = canExtractAudio({ hasAudio: false, hasVideo: false });
    expect(withoutVideo.ok).toBe(false);
    expect(withoutVideo.reason).toContain('没有音轨');
  });
});

describe('audioExtractArgs', () => {
  const args = audioExtractArgs('C:/ws/clips/shot-01.mp4', 'C:/ws/derived/audio-1.m4a');

  it('带 -vn：不写的话，带封面的容器会把封面当成一帧视频写进产物', () => {
    expect(args).toContain('-vn');
  });

  it('带 -y：卡在交互式提问上会让子进程一直挂着，而界面只显示"分离中"', () => {
    expect(args).toContain('-y');
  });

  it('统一转 AAC，而不是直接 copy 音轨', () => {
    /* 源音轨可能是 PCM / Opus / AC3，直接 copy 进 mp4 会被拒或产出放不出来的文件 */
    expect(args).toContain('-c:a');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
  });

  it('输入输出都在参数里，且输出在最后', () => {
    expect(args[args.indexOf('-i') + 1]).toBe('C:/ws/clips/shot-01.mp4');
    expect(args[args.length - 1]).toBe('C:/ws/derived/audio-1.m4a');
  });
});

describe('产物落在哪', () => {
  it('放在 derived/ 下，与用户素材分开', () => {
    const relative = audioOutputRelativePath('2026-09-20T04-00-00-000Z');
    expect(relative.startsWith('derived/')).toBe(true);
    expect(relative.endsWith('.m4a')).toBe(true);
    /* 带时间戳：两次分离不会互相覆盖 */
    expect(relative).toContain('2026-09-20T04-00-00-000Z');
  });
});
