import { describe, expect, it } from 'vitest';
import { rhythmShares, summarizeRhythm } from '../apps/web/src/domain/sourceAnalysis.js';

/**
 * 「参考片 → 风格分析」的纯逻辑。
 *
 * 守的是一条数据一致性：界面上「2.4s / 镜」这行文案和节奏条的每段宽度，
 * 必须来自**同一个** rhythm 数组的两种投影。分开写两份数据的话，
 * 改了一处忘了另一处，面板就会自己跟自己打架 —— 而且不会报错，只会慢慢错。
 *
 * 另外这批函数的输入是模型/探测产出的时长，脏数据（0 / NaN / Infinity）不可避免，
 * 所以空状态与夹取（clamp）都要钉死，不能漏出 NaN 到界面上。
 */

describe('summarizeRhythm', () => {
  it('从逐镜时长推出平均镜长与镜头数', () => {
    const summary = summarizeRhythm([2.6, 1.8, 3.1, 2.2, 2.7, 1.9]);
    expect(summary.shotCount).toBe(6);
    expect(summary.totalSeconds).toBe(14.3);
    expect(summary.averageShot).toBe(2.4);
    expect(summary.label).toBe('2.4s / 镜 · 6 镜');
  });

  it('标尺两端：0.5s/镜 满分，3.5s/镜 归零', () => {
    expect(summarizeRhythm([0.5, 0.5]).paceScore).toBe(100);
    expect(summarizeRhythm([3.5, 3.5]).paceScore).toBe(0);
  });

  it('超出标尺时夹在 0–100，不出现负数或 >100', () => {
    expect(summarizeRhythm([0.2, 0.2]).paceScore).toBe(100);
    expect(summarizeRhythm([9, 9]).paceScore).toBe(0);
  });

  it('空数组与全部非法值都退回空状态，且不产出 NaN', () => {
    for (const input of [[], [0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]]) {
      const summary = summarizeRhythm(input);
      expect(summary.shotCount).toBe(0);
      expect(summary.label).toBe('暂无节奏数据');
      expect(summary.paceScore).toBe(0);
      expect(Number.isFinite(summary.averageShot)).toBe(true);
      expect(Number.isFinite(summary.totalSeconds)).toBe(true);
    }
  });

  it('滤掉非法镜后，均值只按有效镜算', () => {
    const summary = summarizeRhythm([2, 0, 4, Number.NaN]);
    expect(summary.shotCount).toBe(2);
    expect(summary.totalSeconds).toBe(6);
    expect(summary.averageShot).toBe(3);
  });
});

describe('rhythmShares', () => {
  it('各镜宽度按占比分配，合计约 100', () => {
    const shares = rhythmShares([2, 3, 5]);
    expect(shares).toEqual([20, 30, 50]);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 1);
  });

  it('单镜独占整条', () => {
    expect(rhythmShares([3.2])).toEqual([100]);
  });

  it('无有效镜时返回空数组，调用方据此不渲染节奏条', () => {
    expect(rhythmShares([])).toEqual([]);
    expect(rhythmShares([0, Number.NaN, -2])).toEqual([]);
  });
});
