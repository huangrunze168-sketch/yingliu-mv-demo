/* ============================================================
  EDIT-005「画中画 / 三分屏（画布内完成）」的量化验收。

  验收方式不是"跑没跑通"，而是**从成片里逐点取色**：
  三分屏就该在左中右三个位置分别看到三路素材的颜色，四分屏同理。

  为什么必须看到像素：`-filter_complex` 是纯字符串拼装，
  槽位坐标写错（例如第二个 x 偏移算漏一格）时 ffmpeg 不会报错，
  产出文件一切正常，只是整条竖线错位——肉眼看小图基本看不出来。
   ============================================================ */

import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { composeClips, planClipCompose, probeClip, type ClipComposeClip } from '@qiyin/kernel-service';
import { recordAcceptance } from './_acceptance.js';
import {
  COLORS, acceptanceTempDir, frameAt, makeColorClip, nearColor, pixelAt, probeSize, removeDir,
} from './_ffmpeg.js';

const CANVAS = '360x240';
const CANVAS_WIDTH = 360;
const dir = acceptanceTempDir('qiyin-acceptance-layout-');
afterAll(() => removeDir(dir));

describe('[EDIT-005] 多轨布局的画面位置', () => {
  it('三分屏：左中右三块分别是三路素材的颜色', async () => {
    const sources = (['red', 'green', 'blue'] as const).map((color) => {
      const path = join(dir, `three-${color}.mp4`);
      makeColorClip(path, COLORS[color]?.hex ?? color, CANVAS, 1);
      return { color, path };
    });
    const clips: ClipComposeClip[] = [];
    for (const [index, source] of sources.entries()) {
      const probed = await probeClip(source.path);
      if (probed === null) throw new Error(`夹具探测失败：${source.path}`);
      clips.push({ ...probed, videoTrack: (index + 1) as 1 | 2 | 3 });
    }

    const output = join(dir, 'three.mp4');
    const plan = planClipCompose({
      clips,
      layout: 'three',
      transition: { id: 'none', durationSeconds: 0 },
      outputPath: output,
    });
    const done = await composeClips(plan);
    expect(done.ok, done.error).toBe(true);

    const size = probeSize(output);
    const frame = frameAt(output, 0.5);
    const left = pixelAt(frame, size.width, 60, 120);
    const middle = pixelAt(frame, size.width, 180, 120);
    const right = pixelAt(frame, size.width, 300, 120);

    recordAcceptance('EDIT-005.three', {
      outputSize: size,
      samples: { left, middle, right },
      expected: { left: 'red', middle: 'green', right: 'blue' },
    });

    expect(size.width).toBe(CANVAS_WIDTH);
    expect(nearColor(left, COLORS.red?.rgb ?? [255, 0, 0])).toBe(true);
    expect(nearColor(middle, COLORS.green?.rgb ?? [0, 255, 0])).toBe(true);
    expect(nearColor(right, COLORS.blue?.rgb ?? [0, 0, 255])).toBe(true);
  }, 120_000);

  it('四分屏：四象限各是一路素材的颜色', async () => {
    const sources = (['red', 'green', 'blue', 'yellow'] as const).map((color) => {
      const path = join(dir, `quad-${color}.mp4`);
      makeColorClip(path, COLORS[color]?.hex ?? color, CANVAS, 1);
      return { color, path };
    });
    const clips: ClipComposeClip[] = [];
    for (const [index, source] of sources.entries()) {
      const probed = await probeClip(source.path);
      if (probed === null) throw new Error(`夹具探测失败：${source.path}`);
      clips.push({ ...probed, videoTrack: (index + 1) as 1 | 2 | 3 | 4 });
    }

    const output = join(dir, 'quad.mp4');
    const plan = planClipCompose({
      clips,
      layout: 'quad',
      transition: { id: 'none', durationSeconds: 0 },
      outputPath: output,
    });
    const done = await composeClips(plan);
    expect(done.ok, done.error).toBe(true);

    const size = probeSize(output);
    const frame = frameAt(output, 0.5);
    const topLeft = pixelAt(frame, size.width, 90, 60);
    const topRight = pixelAt(frame, size.width, 270, 60);
    const bottomLeft = pixelAt(frame, size.width, 90, 180);
    const bottomRight = pixelAt(frame, size.width, 270, 180);

    recordAcceptance('EDIT-005.quad', {
      outputSize: size,
      samples: { topLeft, topRight, bottomLeft, bottomRight },
      expected: { topLeft: 'red', topRight: 'green', bottomLeft: 'blue', bottomRight: 'yellow' },
    });

    expect(nearColor(topLeft, COLORS.red?.rgb ?? [255, 0, 0])).toBe(true);
    expect(nearColor(topRight, COLORS.green?.rgb ?? [0, 255, 0])).toBe(true);
    expect(nearColor(bottomLeft, COLORS.blue?.rgb ?? [0, 0, 255])).toBe(true);
    expect(nearColor(bottomRight, COLORS.yellow?.rgb ?? [255, 255, 0])).toBe(true);
  }, 120_000);
});
