/**
 * 「参考片 → 风格分析」里可以纯函数化的那部分。
 *
 * 为什么单独放这里：镜头节奏这个指标**不是**写死的文案，而是从逐镜时长算出来的。
 * 如果展示文案和节奏条各写一份数据，两者迟早对不上（改了一个忘了另一个）；
 * 这里让它们同源 —— 同一个 rhythm 数组既产出「2.4s / 镜 · 6 镜」，也产出节奏条的宽度。
 */

export interface RhythmSummary {
  /** 有效镜头数 */
  shotCount: number;
  /** 总时长（秒，一位小数） */
  totalSeconds: number;
  /** 平均每镜时长（秒，一位小数） */
  averageShot: number;
  /** 展示用文案，例如 "2.4s / 镜 · 6 镜" */
  label: string;
  /** 0–100，越高越紧凑。标尺：0.5s/镜 → 100，3.5s/镜 → 0 */
  paceScore: number;
}

/** 快慢标尺的两个端点，改这里等于改整条节奏条的刻度口径。 */
const PACE_FAST_SECONDS = 0.5;
const PACE_SLOW_SECONDS = 3.5;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const isValidShot = (seconds: number) => Number.isFinite(seconds) && seconds > 0;

const round1 = (value: number) => Math.round(value * 10) / 10;

export function summarizeRhythm(rhythm: number[]): RhythmSummary {
  const valid = rhythm.filter(isValidShot);
  if (valid.length === 0) {
    return { shotCount: 0, totalSeconds: 0, averageShot: 0, label: '暂无节奏数据', paceScore: 0 };
  }

  const totalSeconds = valid.reduce((sum, seconds) => sum + seconds, 0);
  const averageShot = totalSeconds / valid.length;

  return {
    shotCount: valid.length,
    totalSeconds: round1(totalSeconds),
    averageShot: round1(averageShot),
    label: `${averageShot.toFixed(1)}s / 镜 · ${valid.length} 镜`,
    paceScore: Math.round(clamp((PACE_SLOW_SECONDS - averageShot) / (PACE_SLOW_SECONDS - PACE_FAST_SECONDS) * 100, 0, 100)),
  };
}

/**
 * 各镜占总时长的百分比（合计约 100，保留一位小数）。
 * 节奏条直接按这个宽度渲染 —— 一眼能看出哪几镜拖长了。
 * 极短镜的可读性交给 CSS 的 min-width，不在数据层里做手脚，否则比例就不诚实了。
 */
export function rhythmShares(rhythm: number[]): number[] {
  const valid = rhythm.filter(isValidShot);
  if (valid.length === 0) return [];
  const total = valid.reduce((sum, seconds) => sum + seconds, 0);
  return valid.map(seconds => round1((seconds / total) * 100));
}
