import { describe, expect, it } from 'vitest';
import { boundariesToShotRanges } from '@qiyin/kernel-service';

/**
 * 边界候选 → 镜头区间。
 *
 * 所以这条规则必须自己站得住：边界闭合、去重、越界忽略、空候选有兜底。
 */
describe('边界候选切分为镜头区间', () => {
  it('没有候选时整段视频就是一个镜头', () => {
    expect(boundariesToShotRanges([], 8)).toEqual([{ t0_ms: 0, t1_ms: 8000 }]);
  });

  it('按候选点切分，首尾天然闭合', () => {
    expect(boundariesToShotRanges([{ at: 2 }, { at: 5 }], 8)).toEqual([
      { t0_ms: 0, t1_ms: 2000 },
      { t0_ms: 2000, t1_ms: 5000 },
      { t0_ms: 5000, t1_ms: 8000 },
    ]);
  });

  it('候选点乱序也能正确排序', () => {
    expect(boundariesToShotRanges([{ at: 5 }, { at: 2 }], 8).map((r) => r.t0_ms)).toEqual([0, 2000, 5000]);
  });

  it('重复候选只切一次', () => {
    expect(boundariesToShotRanges([{ at: 2 }, { at: 2.0004 }, { at: 2 }], 8)).toHaveLength(2);
  });

  it('越界与非有限候选被忽略，而不是造出空区间', () => {
    expect(boundariesToShotRanges([{ at: 0 }, { at: -3 }, { at: 99 }, { at: Number.NaN }], 8)).toEqual([
      { t0_ms: 0, t1_ms: 8000 },
    ]);
  });

  it('同时接受 at 与 time 两种字段名', () => {
    expect(boundariesToShotRanges([{ time: 4 }], 8)).toEqual([
      { t0_ms: 0, t1_ms: 4000 },
      { t0_ms: 4000, t1_ms: 8000 },
    ]);
  });

  it('时长非法时返回空，不产出假区间', () => {
    expect(boundariesToShotRanges([{ at: 1 }], 0)).toEqual([]);
    expect(boundariesToShotRanges([{ at: 1 }], Number.NaN)).toEqual([]);
  });
});
