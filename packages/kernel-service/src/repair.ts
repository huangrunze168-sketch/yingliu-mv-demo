import type { EvalReport, RepairOperation, RepairOperationKind, RepairPlan } from '@qiyin/contracts';

/* ============================================================
   期音科技 · 修复方案生成（S9）
   ------------------------------------------------------------
   输入是评估报告，输出是一份**最小作用域**的方案。三条原则：

     1. 有据可依：只根据报告里分数不足的维度生成动作，不凭感觉加戏；
     2. 作用域最小：有镜头归因的维度只动那几镜；没有归因的才落到整片；
     3. 复用显式：没被点名的镜头写进 `reused`，而不是靠"没提到"来暗示。

   最后一条最重要——未受影响却被动重跑，是复刻类产品最容易悄悄烧钱的地方。
   ============================================================ */

/** 维度 → 修复动作。未列出的维度不会被擅自发明动作。 */
const OPERATION_FOR_DIMENSION: Record<string, RepairOperationKind> = {
  shot_timing: 'retime_clip',
  canvas_match: 'rerender_full',
  audio_presence: 'replace_audio_segment',
  total_duration: 'rerender_full',
};

export interface RepairProposalInput {
  /** 依据的评估报告 id（必须是已记录的报告）。 */
  evalReportId: string;
  report: EvalReport;
  /** 项目里的全部镜头，用于算显式复用清单。 */
  allShots: readonly string[];
  /** 方案针对的项目 revision。 */
  targetRevision: number;
}

/**
 * 由评估生成修复方案。
 *
 * 全部维度都已一致时返回 `null`——没有偏差就不该生成一份「顺手改点什么」的方案。
 */
export function proposeRepairPlan(input: RepairProposalInput): RepairPlan | null {
  const { report, allShots, targetRevision, evalReportId } = input;
  const operations: RepairOperation[] = [];
  const affected = new Set<string>();
  let sequence = 0;

  for (const dimension of report.dimensions) {
    // 已达成的维度不需要修
    if (dimension.score >= 1) continue;
    const kind = OPERATION_FOR_DIMENSION[dimension.name];
    // 未知维度不擅自发明修复动作
    if (!kind) continue;

    const attributed = dimension.attribution
      .map((item) => item.entity_id)
      .filter((entityId) => allShots.includes(entityId));

    if (attributed.length > 0) {
      for (const shotId of attributed) {
        affected.add(shotId);
        sequence += 1;
        operations.push({
          id: `op-${sequence}`,
          kind,
          scope: [shotId],
          preconditions: [`${shotId} 存在且已选定首帧`],
          target_revision: targetRevision,
          estimated_cost_cents: 0,
          estimated_duration_ms: 0,
          affected_closure: [shotId],
          rollback: '回退该镜头的字段表 revision，重新渲染上一版',
          // 改时长不影响首帧，因此不必重过 G2；换画面类的动作才需要
          requires_gate: kind === 'retime_clip' ? 'none' : 'G2',
        });
      }
      continue;
    }

    // 没有镜头归因 → 这是整片层面的问题（画幅、音轨、总长）
    sequence += 1;
    operations.push({
      id: `op-${sequence}`,
      kind,
      scope: ['program'],
      preconditions: ['已存在可评估的成片'],
      target_revision: targetRevision,
      estimated_cost_cents: 0,
      estimated_duration_ms: 0,
      affected_closure: ['program'],
      rollback: '保留上一版成片，不覆盖既有导出',
      requires_gate: 'G3',
    });
  }

  if (operations.length === 0) return null;
  return {
    schema: 'replica.repair-plan@1',
    source_eval_report: evalReportId,
    operations,
    reused: allShots.filter((shotId) => !affected.has(shotId)),
  };
}
