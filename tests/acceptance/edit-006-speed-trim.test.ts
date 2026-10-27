/* ============================================================
  EDIT-006「变速」与 EDIT-007「裁剪起止点与入出点」的量化验收。

  验收口径是**成片时长的算术**：源里取 1 秒、二倍速，成片就该是 0.5 秒。

  这两条特别容易"看起来做了"：参数存进了项目、界面上也显示着 2 倍速，
  但 `setpts` 没真正接到滤镜图上——那样成片仍是原速，而没有任何一处报错。
  所以这里每次都跑一次真实 FFmpeg，再用 ffprobe 量成片时长。
   ============================================================ */

import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { composeClips, planClipCompose, probeClip } from '@qiyin/kernel-service';
import { recordAcceptance } from './_acceptance.js';
import { acceptanceTempDir, makeColorClip, probeDurationSeconds, removeDir } from './_ffmpeg.js';

const dir = acceptanceTempDir('qiyin-acceptance-speed-');
afterAll(() => removeDir(dir));

const SOURCE_SECONDS = 2;

async function composeOne(
  label: string,
  edit: { sourceOffsetSeconds?: number; sourceDurationSeconds?: number; speed?: number },
  expectedSeconds: number,
): Promise<{ measured: number; expected: number; notes: string[] }> {
  const sourcePath = join(dir, 'source.mp4');
  makeColorClip(sourcePath, 'white', '360x240', SOURCE_SECONDS);
  const probed = await probeClip(sourcePath);
  if (probed === null) throw new Error(`夹具探测失败：${sourcePath}`);

  const output = join(dir, `${label}.mp4`);
  const plan = planClipCompose({
    clips: [{ ...probed, ...edit }],
    transition: { id: 'none', durationSeconds: 0 },
    outputPath: output,
  });
  const done = await composeClips(plan);
  expect(done.ok, done.error).toBe(true);
  return { measured: probeDurationSeconds(output), expected: expectedSeconds, notes: plan.notes };
}

describe('[EDIT-006/EDIT-007] 裁剪入点与变速真的落到成片上', () => {
  it('取用 1 秒 → 成片 1 秒（整段则 2 秒）', async () => {
    const whole = await composeOne('whole', {}, SOURCE_SECONDS);
    const trimmed = await composeOne('trim', { sourceDurationSeconds: 1 }, 1);

    recordAcceptance('EDIT-007', {
      criterion: '取用时长与成片时长一致（误差 ≤ 0.15 秒）',
      whole: whole.measured,
      trimmed: trimmed.measured,
      notes: trimmed.notes,
    });

    expect(Math.abs(whole.measured - SOURCE_SECONDS)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(trimmed.measured - 1)).toBeLessThanOrEqual(0.15);
    expect(trimmed.notes.join(' ')).toContain('裁剪');
  }, 120_000);

  it('二倍速：取用 1 秒 → 成片 0.5 秒', async () => {
    const result = await composeOne('speed2', { sourceDurationSeconds: 1, speed: 2 }, 0.5);

    recordAcceptance('EDIT-006', {
      criterion: '二倍速后成片时长 = 取用时长 ÷ 2（误差 ≤ 0.15 秒）',
      sourceDurationSeconds: 1,
      speed: 2,
      measuredSeconds: result.measured,
      expectedSeconds: 0.5,
      notes: result.notes,
    });

    expect(Math.abs(result.measured - 0.5)).toBeLessThanOrEqual(0.15);
  }, 120_000);

  it('入点 0.5 秒 + 取用 1 秒 → 成片 1 秒（入点只挪起点，不加长）', async () => {
    const result = await composeOne(
      'offset',
      { sourceOffsetSeconds: 0.5, sourceDurationSeconds: 1 },
      1,
    );

    recordAcceptance('EDIT-007.in-point', {
      sourceOffsetSeconds: 0.5,
      sourceDurationSeconds: 1,
      measuredSeconds: result.measured,
    });

    expect(Math.abs(result.measured - 1)).toBeLessThanOrEqual(0.15);
  }, 120_000);
});
