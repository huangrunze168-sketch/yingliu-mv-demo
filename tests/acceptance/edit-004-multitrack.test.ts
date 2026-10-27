/* ============================================================
  EDIT-004「多视频轨 + 多音频轨同时编辑」的量化验收。

  一次合成里同时出现：
    · 2 条视频轨（主画面 + 画中画）→ 成片应当只有一路画面，但两块内容都在；
    · 2 条附加油轨（BGM + 配音）→ 成片应当只有一路音轨，但两路都混了进去。

  数字口径：
    工程总时长 = 最长的那条视频轨（并行轨**不叠加**）；
    成片流数 = 1 视频 + 1 音频（多轨被合成，而不是留下多条流）。
   ============================================================ */

import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { composeClips, planClipCompose, probeClip } from '@qiyin/kernel-service';
import { recordAcceptance } from './_acceptance.js';
import {
  COLORS, acceptanceTempDir, frameAt, makeColorClip, makeToneClip, nearColor, pixelAt,
  probeDurationSeconds, probeSize, probeStreamTypes, removeDir,
} from './_ffmpeg.js';

const dir = acceptanceTempDir('qiyin-acceptance-multitrack-');
afterAll(() => removeDir(dir));

describe('[EDIT-004] 多视频轨与多音频轨', () => {
  it('两路视频 + 两路音频合成一条成片：流数为 1+1，时长取最长轨', async () => {
    const basePath = join(dir, 'base.mp4');
    const pipPath = join(dir, 'pip.mp4');
    makeColorClip(basePath, COLORS.red?.hex ?? 'red', '320x180', 2);
    makeColorClip(pipPath, COLORS.blue?.hex ?? 'blue', '160x90', 1);
    const bgmPath = join(dir, 'bgm.wav');
    const voicePath = join(dir, 'voice.wav');
    makeToneClip(bgmPath, 220, 2);
    makeToneClip(voicePath, 660, 2);

    const base = await probeClip(basePath);
    const pip = await probeClip(pipPath);
    if (base === null || pip === null) throw new Error('夹具探测失败');

    const output = join(dir, 'multitrack.mp4');
    const plan = planClipCompose({
      clips: [
        { ...base, videoTrack: 1 },
        { ...pip, videoTrack: 2 },
      ],
      layout: 'pip',
      transition: { id: 'none', durationSeconds: 0 },
      audioTracks: [
        { path: bgmPath, gainDb: -6, label: 'BGM' },
        { path: voicePath, gainDb: 0, label: '配音' },
      ],
      outputPath: output,
    });
    const done = await composeClips(plan);
    expect(done.ok, done.error).toBe(true);

    const duration = probeDurationSeconds(output);
    const streams = probeStreamTypes(output);
    const size = probeSize(output);
    const frame = frameAt(output, 0.5);
    const main = pixelAt(frame, size.width, 20, 20);
    const inset = pixelAt(frame, size.width, 250, 140);
    const notes = plan.notes.join(' | ');

    recordAcceptance('EDIT-004', {
      criterion: '多视频轨并行不叠加时长；多音轨混成一路',
      videoTracks: 2,
      audioTracks: 2,
      expectedDurationSeconds: 2,
      measuredDurationSeconds: duration,
      streams,
      videoStreams: streams.filter((type) => type === 'video').length,
      audioStreams: streams.filter((type) => type === 'audio').length,
      samples: { main, inset },
      notes,
    });

    expect(Math.abs(duration - 2)).toBeLessThanOrEqual(0.2);
    expect(streams.filter((type) => type === 'video').length).toBe(1);
    expect(streams.filter((type) => type === 'audio').length).toBe(1);
    expect(nearColor(main, COLORS.red?.rgb ?? [255, 0, 0])).toBe(true);
    expect(nearColor(inset, COLORS.blue?.rgb ?? [0, 0, 255])).toBe(true);
    expect(notes).toContain('2 条音轨');
  }, 120_000);
});
