/* ============================================================
  VID-005「视频高清 2/4/6 倍 + 30/60/90fps 提帧」的**纯函数**那一半。

  矩阵的口径两句话，两句话都得能在不跑 ffmpeg 的情况下钉住：

    「输出分辨率为请求倍数的整数倍，帧率精确等于请求值（误差 0）」
    「规格不符时明确报错而非静默降级」

  真跑 ffmpeg 的那一半在 `tests/acceptance/vid-005-video-hd.test.ts`。
  分两份不是为了整齐：这一份答"判据本身对不对"，那一份答"跑出来的东西对不对"。
  只留其中一份的话，判据写错时两份会一起说通过。
   ============================================================ */

import { describe, expect, it } from 'vitest';
import {
  VIDEO_HD_FORMATS,
  VIDEO_HD_FPS,
  VIDEO_HD_MAX_SOURCE_BYTES,
  VIDEO_HD_MAX_SOURCE_LONG_SIDE,
  VIDEO_HD_SCALES,
  compareVideoHdSpec,
  judgeVideoHdSpec,
  parseFrameRate,
  parseVideoHdProbe,
  planVideoHd,
  videoHdNodeName,
  videoHdOutputRelativePath,
  type VideoHdFacts,
} from '@qiyin/kernel-service';

/** 一份"正常"的源片事实；各用例只改它关心的那一项。 */
function facts(overrides: Partial<VideoHdFacts> = {}): VideoHdFacts {
  return {
    width: 300,
    height: 220,
    fps: 30,
    durationSeconds: 2,
    bytes: 1024 * 1024,
    extension: 'mp4',
    ...overrides,
  };
}

function plan(overrides: Partial<Parameters<typeof planVideoHd>[0]> = {}, source = facts()) {
  return planVideoHd({
    inputPath: 'in.mp4',
    outputPath: 'out.mp4',
    scale: 2,
    fps: 60,
    workDir: '.',
    ...overrides,
  }, source);
}

describe('[VID-005] 视频高清的档位与判据', () => {
  it('档位就是 2/4/6 与 30/60/90，且放大档位全是偶数', () => {
    expect([...VIDEO_HD_SCALES]).toEqual([2, 4, 6]);
    expect([...VIDEO_HD_FPS]).toEqual([30, 60, 90]);
    /*
      偶数这条是"整数倍"能成立的前提：H.264 要偶数宽高，管线里有一道偶数对齐，
      奇数档位会被它改动 1 像素，于是"恰为整数倍"当场不成立。
    */
    expect(VIDEO_HD_SCALES.every((scale) => scale % 2 === 0)).toBe(true);
  });

  it('三档分别在 300×220 上承诺的尺寸都是精确整数倍', () => {
    for (const scale of VIDEO_HD_SCALES) {
      const result = plan({ scale });
      expect(result.ok, `${scale} 倍应当能规划`).toBe(true);
      if (!result.ok) continue;
      expect(result.plan.expectedWidth).toBe(300 * scale);
      expect(result.plan.expectedHeight).toBe(220 * scale);
      /* 与管线自己承诺的规格必须一致——两处算得不一样就说明对齐动过手脚 */
      expect(result.plan.pipeline.expected.width).toBe(300 * scale);
      expect(result.plan.pipeline.expected.height).toBe(220 * scale);
    }
  });

  it('档位之外的值拒绝，且说清是哪一档出了问题', () => {
    const badScale = plan({ scale: 3 });
    expect(badScale.ok).toBe(false);
    if (!badScale.ok) {
      expect(badScale.code).toBe('VIDEO_HD_SCALE_UNSUPPORTED');
      expect(badScale.message).toContain('3');
      expect(badScale.message).toContain('2 倍 / 4 倍 / 6 倍');
    }

    const badFps = plan({ fps: 120 });
    expect(badFps.ok).toBe(false);
    if (!badFps.ok) {
      expect(badFps.code).toBe('VIDEO_HD_FPS_UNSUPPORTED');
      expect(badFps.message).toContain('30fps / 60fps / 90fps');
    }
  });

  it('不提帧（自适应原帧率）是允许的，而且不会掉进档位校验里', () => {
    /*
      这条防的是一个很具体的错法：把"自适应"实现成"等于原帧率"。
      原片 24fps 时那个值不在三档里，于是最省事的默认会被自己的校验拒掉。
    */
    const result = plan({ fps: undefined }, facts({ fps: 24 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.fps).toBe(24);
    expect(result.plan.pipeline.notes.join('')).toContain('自适应(原帧率)');
    /* 只放大时不插帧：管线里应当没有插帧那一步的说明 */
    expect(result.plan.pipeline.notes.join('')).not.toContain('minterpolate');
  });

  it('四种做不了的情况都拒绝，文案与 Canvas 线上一致', () => {
    const badFormat = plan({}, facts({ extension: 'webm' }));
    expect(badFormat.ok).toBe(false);
    if (!badFormat.ok) {
      expect(badFormat.code).toBe('VIDEO_HD_FORMAT_UNSUPPORTED');
      expect(badFormat.message).toBe(
        `当前视频格式暂不支持超分，支持格式：${VIDEO_HD_FORMATS.join(' / ')}`,
      );
    }

    const tooBig = plan({}, facts({ bytes: VIDEO_HD_MAX_SOURCE_BYTES + 1 }));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) {
      expect(tooBig.code).toBe('VIDEO_HD_SOURCE_TOO_LARGE');
      expect(tooBig.message).toBe('视频文件超过 10GB，暂不支持超分');
    }

    const over2k = plan({}, facts({ width: VIDEO_HD_MAX_SOURCE_LONG_SIDE + 2, height: 1080 }));
    expect(over2k.ok).toBe(false);
    if (!over2k.ok) {
      expect(over2k.code).toBe('VIDEO_HD_SOURCE_OVER_2K');
      expect(over2k.message).toBe('视频分辨率超过 2K，暂不支持超分');
    }

    const unreadable = plan({}, facts({ fps: 0 }));
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) expect(unreadable.code).toBe('VIDEO_HD_SOURCE_UNREADABLE');
  });

  it('体积读不出来时不当成 0 处理：照样往下走，不因为读不到字节数就拒', () => {
    /*
      文件大小是**可选事实**：读不到它意味着"不知道"，而不是"超了"。
      把它当 0 会放行超限的素材，把它当无穷大会误拒正常素材——两边都错，
      所以这里的规矩是：读不到就不拿它下判断（其余判据照常生效）。
    */
    const result = plan({}, facts({ bytes: null }));
    expect(result.ok).toBe(true);
  });

  it('帧率超过原片 4 倍只警告不拦（Canvas 那句也只是"建议"）', () => {
    const over = plan({ fps: 90 }, facts({ fps: 20 }));
    expect(over.ok).toBe(true);
    if (!over.ok) return;
    expect(over.plan.pipeline.notes.join('')).toContain('建议不超过原视频帧率的 4 倍');

    const within = plan({ fps: 90 }, facts({ fps: 30 }));
    expect(within.ok).toBe(true);
    if (!within.ok) return;
    expect(within.plan.pipeline.notes.join('')).not.toContain('可能影响输出效果');
  });

  it('降帧会被明确说出来，不假装是提帧', () => {
    const down = plan({ fps: 30 }, facts({ fps: 60 }));
    expect(down.ok).toBe(true);
    if (!down.ok) return;
    expect(down.plan.pipeline.notes.join('')).toContain('这是降帧，不是提帧');
  });
});

describe('[VID-005] 规格核对：零容差', () => {
  it('三项全对才达标；分辨率按源片整数倍、帧率精确相等', () => {
    const checks = compareVideoHdSpec(
      { width: 300, height: 220 },
      { scale: 4, fps: 60, sourceFps: 30 },
      { width: 1200, height: 880, fps: 60 },
    );
    expect(checks.map((check) => check.ok)).toEqual([true, true, true]);
    expect(checks[0]?.multipleOfSource).toBe(4);
    expect(checks[1]?.multipleOfSource).toBe(4);
    expect(judgeVideoHdSpec(checks).ok).toBe(true);
    expect(judgeVideoHdSpec(checks).correctRate).toBe('3/3');
  });

  it('帧率差一点点也算不达标（这一条的口径是误差 0，不是 VID-001 的 0.5）', () => {
    const checks = compareVideoHdSpec(
      { width: 300, height: 220 },
      { scale: 2, fps: 60, sourceFps: 30 },
      { width: 600, height: 440, fps: 59.94 },
    );
    const fps = checks.find((check) => check.field === 'fps');
    expect(fps?.ok).toBe(false);
    /* 宽高仍然是对的——不能因为一项错就说整条产物没量到 */
    expect(checks.filter((check) => check.field !== 'fps').every((check) => check.ok)).toBe(true);
  });

  it('分辨率不是整数倍时不达标，并且报的是倍率而不是"失败"', () => {
    const checks = compareVideoHdSpec(
      { width: 300, height: 220 },
      { scale: 2, fps: 60, sourceFps: 30 },
      { width: 601, height: 440, fps: 60 },
    );
    const width = checks.find((check) => check.field === 'width');
    expect(width?.ok).toBe(false);
    expect(width?.multipleOfSource).toBeCloseTo(601 / 300, 6);
  });

  it('量不出来也算不达标，而不是"没量到就放过"', () => {
    const checks = compareVideoHdSpec(
      { width: 300, height: 220 },
      { scale: 2, fps: 60, sourceFps: 30 },
      { width: null, height: null, fps: null },
    );
    expect(checks.every((check) => !check.ok)).toBe(true);
    const verdict = judgeVideoHdSpec(checks);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain('读不出');
  });

  it('不达标时给出可行动的那句话（哪一项、应为多少、实测多少）', () => {
    const verdict = judgeVideoHdSpec(compareVideoHdSpec(
      { width: 300, height: 220 },
      { scale: 6, fps: 90, sourceFps: 30 },
      { width: 1800, height: 1320, fps: 60 },
    ));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.correctRate).toBe('2/3');
    expect(verdict.message).toContain('fps：应为 90，实测 60');
    expect(verdict.message).toContain('不作为结果入库');
  });
});

describe('[VID-005] 探测解析与命名', () => {
  it('帧率解析支持整数与分数两种写法', () => {
    expect(parseFrameRate('60/1')).toBe(60);
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('0/0')).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
  });

  it('读不出宽高 / 时长 / 帧率时解析返回 null（调用方据此拒绝开工）', () => {
    const good = parseVideoHdProbe(JSON.stringify({
      streams: [{ width: 300, height: 220, avg_frame_rate: '30/1' }],
      format: { duration: '2.0' },
    }), 'clip.mp4');
    expect(good?.width).toBe(300);
    expect(good?.fps).toBe(30);
    expect(good?.extension).toBe('mp4');

    expect(parseVideoHdProbe('不是 JSON', 'clip.mp4')).toBeNull();
    expect(parseVideoHdProbe(JSON.stringify({ streams: [{ width: 300, height: 220 }] }), 'clip.mp4')).toBeNull();
  });

  it('产物节点名逐字用 Canvas 的写法，路径落在 derived/ 下', () => {
    expect(videoHdNodeName(2)).toBe('高清（2 倍）');
    expect(videoHdNodeName(6)).toBe('高清（6 倍）');
    expect(videoHdOutputRelativePath('2026-09-21T00-00-00-000Z', 4, 60))
      .toBe('derived/hd-2026-09-21T00-00-00-000Z-4x-60fps.mp4');
  });
});
