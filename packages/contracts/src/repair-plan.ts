import { z } from 'zod';
import { uuidSchema } from './primitives.js';

/* ============================================================
   RepairPlan@1 —— 修复方案（架构 v2.3 §7.4）
   ------------------------------------------------------------
   这个契约存在的唯一理由，是让「只重跑受影响的部分」成为可执行的事，
   而不是一句产品口号。因此每个操作必须说清楚四件事：

     · 作用域 scope        —— 到底动谁
     · 受影响闭包 closure  —— 动了之后什么会失效
     · 未受影响的 reused   —— 什么**显式复用**、不重跑
     · 回滚方式 rollback   —— 做错了怎么退回去

   操作类型必须是白名单内的固定集合：修复动作一旦可以自由发明，
   「最小作用域」就无从保证，成本和风险都会失控。
   ============================================================ */

/** 白名单：§7.4 的十项，加上 v2.3 §7.5.4 新增的两项空间操作。 */
export const REPAIR_OPERATION_KINDS = [
  'update_prompt_field',
  'change_candidate_selection',
  'regenerate_image',
  'regenerate_video',
  'adjust_semantic_take',
  'retime_clip',
  'replace_audio_segment',
  'update_caption',
  'rerender_range',
  'rerender_full',
  'update_spatial_plan',
  'recapture_blueprint',
] as const;

export const repairOperationKindSchema = z.enum(REPAIR_OPERATION_KINDS);
export type RepairOperationKind = (typeof REPAIR_OPERATION_KINDS)[number];

export const repairOperationSchema = z.object({
  id: z.string().min(1),
  kind: repairOperationKindSchema,
  /** 作用域：这个操作动到的实体，例如 `shot-02`。 */
  scope: z.array(z.string().min(1)).min(1),
  /** 前置条件；不满足时不得执行。 */
  preconditions: z.array(z.string().min(1)).default([]),
  /**/
  target_revision: z.number().int().nonnegative(),
  estimated_cost_cents: z.number().int().nonnegative().default(0),
  estimated_duration_ms: z.number().int().nonnegative().default(0),
  /** 受影响闭包：这些实体的已产出结果会因此失效。 */
  affected_closure: z.array(z.string().min(1)).default([]),
  rollback: z.string().min(1),
  /** 是否需要重新过闸门才能落地。 */
  requires_gate: z.enum(['none', 'G2', 'G3']).default('none'),
});

export const repairPlanSchema = z.object({
  schema: z.literal('replica.repair-plan@1'),
  /** 依据哪一份评估报告——修复必须有据可依，不能凭感觉。 */
  source_eval_report: uuidSchema,
  operations: z.array(repairOperationSchema).min(1),
  /**
   * 显式复用清单：这些实体不重跑。
   *
   * 它必须被写下来，而不是靠"没提到就是复用"来暗示——
   * 未受影响却被动重跑，正是复刻类产品最容易悄悄烧钱的地方。
   */
  reused: z.array(z.string().min(1)).default([]),
});

export type RepairPlan = z.infer<typeof repairPlanSchema>;
export type RepairOperation = z.infer<typeof repairOperationSchema>;
