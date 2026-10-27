import type { EvalDimension, EvalReport } from '@qiyin/contracts';
import type { FrontkernelMediaProbe } from '@qiyin/frontkernel-adapter';
import { audible, AUDIBLE_MAX_DB, type LoudnessMeasurement } from './loudness.js';

/* ============================================================
   期音科技 · 偏差评估（S8）
   ------------------------------------------------------------
   第一版只做**可计算指标**：总时长、逐镜时长、画幅、音轨。
   它们确定性、可复现、不花钱，而且每一条都能归因到具体镜头——
   这正是「成片不像时能定位到某一镜」所需要的，而不是一个笼统的像不像分数。

   审美/情绪这类模型判断不在这里：架构 §7.3 明确要求低置信度的主观判断
   不得自动触发付费重跑，因此它们既不会被算进这里，也不会驱动下一步动作。
   ============================================================ */

export const EVALUATOR_ID = 'qiyin.structural';
export const EVALUATOR_VERSION = '1.0.0';

export interface ShotExpectation {
  shot_id: string;
  duration_ms: number;
}

export interface EvaluationInput {
  referenceArtifact: string;
  resultArtifact: string;
  reference: FrontkernelMediaProbe;
  result: FrontkernelMediaProbe;
  /**
   * 两侧的响度实测。省略或为 `null` 表示测不出来——
   * 那时会退回「有没有音轨」，并**降置信度**而不是假装量过。
   */
  referenceLoudness?: LoudnessMeasurement | null;
  resultLoudness?: LoudnessMeasurement | null;
  shots: readonly ShotExpectation[];
  frameRate: number;
}

/**
 * 帧量化后的真实时长。
 *
 * 时间轴按帧对齐，所以「2100ms」在 30fps 下是 63 帧（精确），
 * 而「1234ms」是 37.02 帧 → 37 帧 = 1233.3ms。
 * 这不是缺陷而是量化的必然结果，评估必须如实报出来，
 * 否则用户会以为成片"莫名其妙短了 0.7 毫秒"却找不到原因。
 */
export function quantizeToFrames(ms: number, frameRate: number): number {
  if (frameRate <= 0) return ms;
  const frames = Math.round((ms / 1000) * frameRate);
  return (frames / frameRate) * 1000;
}

/** 1 表示完全一致，0 表示偏差达到或超过参考本身。 */
export function scoreFromError(expected: number, actual: number): number {
  if (expected <= 0) return actual <= 0 ? 1 : 0;
  const ratio = Math.abs(actual - expected) / expected;
  return Math.max(0, Math.min(1, 1 - ratio));
}

export function buildEvalReport(input: EvaluationInput): EvalReport {
  const { reference, result, shots, frameRate } = input;
  const dimensions: EvalDimension[] = [];

  // 1. 总时长
  const referenceMs = reference.duration * 1000;
  const resultMs = result.duration * 1000;
  dimensions.push({
    name: 'total_duration',
    score: scoreFromError(referenceMs, resultMs),
    delta: { expected_ms: Math.round(referenceMs), actual_ms: Math.round(resultMs) },
    confidence: 1,
    reference_evidence: [{ t0_ms: 0, t1_ms: Math.round(referenceMs) }],
    result_evidence: [{ t0_ms: 0, t1_ms: Math.round(resultMs) }],
    attribution: [],
  });

  /**
   * 2. 逐镜时长。
   *
   * 成片是按各镜时长铺出来的，所以「实际」= 帧量化后的值。
   * 每条偏差都归因到具体镜头——修复阶段据此只重跑受影响的那一镜。
   */
  const timingDimensions = shots.map((shot) => {
    const quantized = quantizeToFrames(shot.duration_ms, frameRate);
    const drift = Math.abs(quantized - shot.duration_ms);
    return { shot, quantized, drift };
  });
  const worstDrift = timingDimensions.reduce((max, item) => Math.max(max, item.drift), 0);
  dimensions.push({
    name: 'shot_timing',
    score: worstDrift === 0 ? 1 : Math.max(0, 1 - worstDrift / Math.max(1, frameRate > 0 ? 1000 / frameRate : 1)),
    delta: {
      expected_ms: shots.reduce((total, shot) => total + shot.duration_ms, 0),
      actual_ms: Math.round(timingDimensions.reduce((total, item) => total + item.quantized, 0)),
      worst_drift_ms: Number(worstDrift.toFixed(3)),
    },
    confidence: 1,
    reference_evidence: [{ unit: 'fps', frame_rate: frameRate }],
    result_evidence: timingDimensions.map((item) => ({
      shot_id: item.shot.shot_id,
      expected_ms: item.shot.duration_ms,
      actual_ms: Number(item.quantized.toFixed(3)),
    })),
    // 只有真的出现漂移时才归因，避免把零偏差也列成「责任镜头」
    attribution: timingDimensions
      .filter((item) => item.drift > 1e-6)
      .map((item) => ({
        entity_id: item.shot.shot_id,
        path: 'duration_ms',
        weight: worstDrift === 0 ? 0 : Number((item.drift / worstDrift).toFixed(3)),
      })),
  });

  // 3. 画幅一致性：成片必须与参考同一画幅，否则构图整体不可比
  const canvasMatches = reference.width === result.width && reference.height === result.height;
  dimensions.push({
    name: 'canvas_match',
    score: canvasMatches ? 1 : 0,
    delta: {
      expected: `${reference.width ?? 0}x${reference.height ?? 0}`,
      actual: `${result.width ?? 0}x${result.height ?? 0}`,
    },
    confidence: 1,
    reference_evidence: [{ width: reference.width, height: reference.height }],
    result_evidence: [{ width: result.width, height: result.height }],
    attribution: [],
  });

  /**
   * 4. 声音。
   *
   * **不能看 `hasAudio`**：前置内核 的成片在合流时总会写一条音轨，
   * 没有声音时写的是数字静音，于是 `hasAudio` 对「有声」和「静音」
   * 都返回 true（实测：参考片、生成片段、我们的成片，三个都是 true，
   * 其中真正的响度是 -91 / -8.8 / -91 dB）。
   *
   * 所以这里用实测响度判断「有没有声音」。测不出来时退回音轨存在性，
   * 并把 `confidence` 降到 0.5——这个降级必须写在报告里，
   * 否则用户会以为「测量过，确实一致」。
   */
  const referenceAudible = audible(input.referenceLoudness ?? null);
  const resultAudible = audible(input.resultLoudness ?? null);
  const measured = referenceAudible !== null && resultAudible !== null;
  const expectedAudio = measured ? referenceAudible : reference.hasAudio;
  const actualAudio = measured ? resultAudible : result.hasAudio;
  dimensions.push({
    name: 'audio_presence',
    score: expectedAudio === actualAudio ? 1 : 0,
    delta: {
      expected: expectedAudio,
      actual: actualAudio,
      measurement: measured ? 'loudness' : 'stream-presence',
      ...(measured ? { audible_above_db: AUDIBLE_MAX_DB } : {}),
    },
    // 量过就是量过；没量出来只能降级，不能装作一致
    confidence: measured ? 1 : 0.5,
    reference_evidence: [{
      has_audio: reference.hasAudio,
      ...(measured ? { max_db: referenceAudible === null ? null : (input.referenceLoudness?.max_db ?? null) } : {}),
    }],
    result_evidence: [{
      has_audio: result.hasAudio,
      ...(measured ? { max_db: input.resultLoudness?.max_db ?? null } : {}),
    }],
    attribution: [],
  });

  return {
    schema: 'replica.eval-report@1',
    reference_artifact: input.referenceArtifact,
    result_artifact: input.resultArtifact,
    evaluator: { id: EVALUATOR_ID, version: EVALUATOR_VERSION },
    dimensions,
  };
}

/** 找出最差的维度；全为 1 时返回 null。 */
export function worstDimension(report: EvalReport): EvalDimension | null {
  const sorted = [...report.dimensions].sort((a, b) => a.score - b.score);
  const first = sorted[0];
  return first && first.score < 1 ? first : null;
}
