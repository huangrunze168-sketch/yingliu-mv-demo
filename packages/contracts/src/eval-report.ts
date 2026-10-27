import { z } from 'zod';
import { sha256Schema } from './primitives.js';

/* ============================================================
   EvalReport@1 —— 偏差评估结果（架构 v2.3 §7.3）
   ------------------------------------------------------------
   产品要回答的不是「像不像」这一个总分，而是「哪一镜不像、差在哪」。
   因此每条结论都必须带证据与**归因**：`attribution` 指向具体实体
   （通常是某个 shot）与字段路径，修复阶段才能只重跑受影响的部分。

   第一版只做可计算指标（时长、画幅、音轨）——它们确定性、可复现、
   不花钱。审美/情绪这类模型判断要求低置信度不得自动触发付费重跑，
   因此不在这里，也不会被自动执行。
   ============================================================ */

export const evalAttributionSchema = z.object({
  /** 归因指向的实体，例如 `shot-03`。 */
  entity_id: z.string().min(1),
  /** 该实体上的字段路径，例如 `duration_ms`。 */
  path: z.string().min(1),
  /** 0–1，多个归因之间的相对责任。 */
  weight: z.number().min(0).max(1),
});

export const evalDimensionSchema = z.object({
  name: z.string().min(1),
  /** 0–1，1 表示与参考完全一致。 */
  score: z.number().min(0).max(1),
  /** 该维度的具体落差，例如 `{ expected_ms, actual_ms }`。 */
  delta: z.record(z.string(), z.unknown()).optional(),
  /** 该结论的置信度；可计算指标为 1。 */
  confidence: z.number().min(0).max(1),
  /** 参考侧的证据，例如时间区间。 */
  reference_evidence: z.array(z.record(z.string(), z.unknown())).default([]),
  /** 成片侧的证据。 */
  result_evidence: z.array(z.record(z.string(), z.unknown())).default([]),
  attribution: z.array(evalAttributionSchema).default([]),
});

export const evalReportSchema = z.object({
  schema: z.literal('replica.eval-report@1'),
  reference_artifact: sha256Schema,
  result_artifact: sha256Schema,
  evaluator: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
  dimensions: z.array(evalDimensionSchema).min(1),
});

export type EvalReport = z.infer<typeof evalReportSchema>;
export type EvalDimension = z.infer<typeof evalDimensionSchema>;
export type EvalAttribution = z.infer<typeof evalAttributionSchema>;
