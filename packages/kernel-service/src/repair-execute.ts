import type { RepairOperationKind, RepairPlan } from '@qiyin/contracts';
import { quantizeToFrames } from './eval.js';

/* ============================================================
   期音科技 · 修复执行（S9 的后半段）
   ------------------------------------------------------------
   方案里只有 `scope` / `kind`，没有"改成什么值"的载荷。这不是缺陷，
   而是这份契约的边界：它描述的是**动谁**，不是**动成什么样**。

   所以执行器只能做那些"动作本身就能确定"的事——多一件都不编：

     retime_clip       把该镜时长吸附到整帧（可算、免费、确定性）
     regenerate_image  按方案点名的镜头重跑出图（花钱，需要 G2）
     regenerate_video  按方案点名的镜头重跑图生视频（花钱，需要 G2）
     rerender_full     重新渲染成片（本地内核，免费）

   其余动作一律**拒绝并给出理由**：`update_prompt_field` 需要"新值"、
   `change_candidate_selection` 是人的选择、`replace_audio_segment` 需要先有替代音轨……
   拒绝不是偷懒，是"没说清要改成什么就动手"比不动手更坏。

   两条顺序上的硬约束，写在代码里免得下次接反：

     1. **改字段表会让 G1/G2 失效**（领域层 writeShotFields 的既有规则），
        所以花钱的重跑必须排在 retime 之前；反过来做，重跑会被自己刚改的一步挡住。
     2. 计划必须**仍然是最后一份**、且 G4 是在它之后批准的——
        否则批的是别的方案，执行的是这一份。
   ============================================================ */

export interface RepairShotLike {
  shot_id: string;
  t0_ms: number;
  t1_ms: number;
  duration_ms: number;
}

export interface RepairExecutionInput {
  plan: RepairPlan;
  shots: readonly RepairShotLike[];
  /**
   * 帧率。来自评估报告 `shot_timing` 维度里的 `reference_evidence[0].frame_rate`；
   * 报告里没有时调用方传默认值，并把 `frameRateFrom` 标成 'default'——
   * 界面要能说出"这个帧率是默认值还是报告给的"，因为它决定吸附结果对不对。
   */
  frameRate: number;
  frameRateFrom: 'report' | 'default';
  /** 闸门当前是否已批准（按方案里每个操作自己的 requires_gate 检查） */
  gateApproved: (gate: 'G2' | 'G3') => boolean;
  /** 这次执行手里有没有可用的模型（没有就拒绝花钱的动作，而不是替用户挑一个） */
  models?: { image?: string | undefined; video?: string | undefined };
}

export interface RepairShotEdit {
  operationId: string;
  shotId: string;
  t0Ms: number;
  t1Ms: number;
  durationMs: number;
  previousDurationMs: number;
  /** 一句话说明这次改动的依据 */
  reason: string;
}

export interface RepairGenerationCall {
  operationId: string;
  kind: 'regenerate_image' | 'regenerate_video';
  /** 只跑这几个镜头——这就是「按作用域只重跑受影响部分」 */
  shots: string[];
  estimatedCostCents: number;
}

export interface RepairRefusal {
  operationId: string;
  kind: RepairOperationKind;
  reason: string;
}

export interface RepairExecutionPlan {
  edits: RepairShotEdit[];
  generations: RepairGenerationCall[];
  needsRerender: boolean;
  /** 需要重渲染的作用域（`program` 或若干镜头） */
  rerenderScope: string[];
  /** 提出重渲染的那些操作 id（记账时要用） */
  rerenderOperations: string[];
  refused: RepairRefusal[];
  /** 可执行但本来就已对齐、不需要改动的操作 id */
  unchanged: string[];
  /**/
  reused: string[];
  estimatedCostCents: number;
  frameRate: number;
  frameRateFrom: 'report' | 'default';
}

/** 需要"额外数据"才能执行的动作，各自的理由。 */
const NEEDS_MORE_DATA: Partial<Record<RepairOperationKind, string>> = {
  update_prompt_field: '方案里没有"改成什么新值"：这一类要人来定，请在逐镜字段表里改',
  change_candidate_selection: '换候选是人的选择：请到选帧面板里挑，不应由"执行修复"代选',
  /*
    这一条以前写的是"本机还没有接入这一步"。现在音轨是有的——
    画布上的「音视频分离」会把声音抽成一段 `.m4a`（见 kernel-service 的 audio-extract.ts）。
    仍然不能由执行器做，是因为**方案里没说清"用哪段、替哪一段"**：
    那是人的决定，执行器替用户挑一段音轨就是在替他改片子。
  */
  replace_audio_segment: '替代音轨用哪一段、替换哪一段要人来定：先在画布上做「音视频分离」拿到音轨，再指定替换范围',
  update_caption: '字幕内容同样需要新值，本机只记录不改写',
  rerender_range: '本机只支持整片重渲染（rerender_full），不做区间渲染',
  update_spatial_plan: '空间方案要在导演台里改（那里有 3D 预览与契约校验）',
  /*
    这一条以前写的是"本机还没有这条入口"——那时确实没有：导演台只有 3D 预览，
    截不了图。现在有了（导演台相机区的「截取构图蓝图」），但**仍然不能由执行器做**：
    截图要用到那个 3D 视口，而执行器跑在领域层，没有界面。
    所以理由改成"去哪儿做"，而不是"做不了"。
  */
  recapture_blueprint: '重新截蓝图要用 3D 视口：请在导演台点「截取构图蓝图」，它会发布新蓝图并写入这一镜',
  adjust_semantic_take: '语义重拍要选模型与提示词：请用画布上的「片段重拍」',
};

export function planRepairExecution(input: RepairExecutionInput): RepairExecutionPlan {
  const { plan, shots, frameRate, frameRateFrom } = input;
  const shotById = new Map(shots.map((shot) => [shot.shot_id, shot]));
  const edits: RepairShotEdit[] = [];
  const generations: RepairGenerationCall[] = [];
  const refused: RepairRefusal[] = [];
  const unchanged: string[] = [];
  const rerenderScope = new Set<string>();
  const rerenderOperations: string[] = [];

  for (const operation of plan.operations) {
    const refuse = (reason: string) => refused.push({ operationId: operation.id, kind: operation.kind, reason });

    /* 闸门先看：需要过闸而没过，一律不做 */
    if (operation.requires_gate !== 'none' && !input.gateApproved(operation.requires_gate)) {
      refuse(`方案标明这一步要先过 ${operation.requires_gate}，现在还没批准`);
      continue;
    }

    if (operation.kind === 'retime_clip') {
      const scoped = operation.scope.filter((entity) => shotById.has(entity));
      if (scoped.length === 0) {
        refuse(`时间轴修复只支持按镜头作用域，方案给的是：${operation.scope.join('、') || '（空）'}`);
        continue;
      }
      let changedAny = false;
      for (const shotId of scoped) {
        const shot = shotById.get(shotId)!;
        const snapped = quantizeToFrames(shot.duration_ms, frameRate);
        if (Math.abs(snapped - shot.duration_ms) < 1e-6) continue;
        changedAny = true;
        edits.push({
          operationId: operation.id,
          shotId,
          t0Ms: shot.t0_ms,
          t1Ms: Math.round(shot.t0_ms + snapped),
          durationMs: Math.round(snapped),
          previousDurationMs: shot.duration_ms,
          reason: `${frameRate}fps 下 ${shot.duration_ms}ms 不是整帧：吸附到 ${Math.round(snapped)}ms`,
        });
      }
      if (!changedAny) unchanged.push(operation.id);
      continue;
    }

    if (operation.kind === 'regenerate_image' || operation.kind === 'regenerate_video') {
      const kind = operation.kind;
      const model = kind === 'regenerate_image' ? input.models?.image : input.models?.video;
      if (model === undefined || model.trim().length === 0) {
        refuse('这一步要花钱重跑：先在生成面板选好模型，再执行（不替用户挑模型）');
        continue;
      }
      const scoped = operation.scope.filter((entity) => shotById.has(entity));
      if (scoped.length === 0) {
        refuse(`重跑只支持按镜头作用域，方案给的是：${operation.scope.join('、') || '（空）'}`);
        continue;
      }
      generations.push({ operationId: operation.id, kind, shots: scoped, estimatedCostCents: operation.estimated_cost_cents });
      continue;
    }

    if (operation.kind === 'rerender_full') {
      for (const entity of operation.scope) rerenderScope.add(entity);
      rerenderOperations.push(operation.id);
      continue;
    }

    refuse(NEEDS_MORE_DATA[operation.kind] ?? '本机还没有这一类修复动作的执行入口');
  }

  return {
    edits,
    generations,
    needsRerender: rerenderScope.size > 0,
    rerenderScope: [...rerenderScope],
    rerenderOperations,
    refused,
    unchanged,
    reused: [...plan.reused],
    estimatedCostCents: generations.reduce((total, call) => total + call.estimatedCostCents, 0),
    frameRate,
    frameRateFrom,
  };
}

/**
 * 从评估报告里取帧率。
 *
 * `shot_timing` 维度的 `reference_evidence[0].frame_rate` 是评估当时真正用的帧率；
 * 报告里没有就退回默认值，并且**如实标出来**——吸附结果对不对，取决于这个值。
 */
export function frameRateFromReport(
  dimensions: ReadonlyArray<{ name: string; reference_evidence: ReadonlyArray<Record<string, unknown>> }>,
  fallback = 30,
): { frameRate: number; from: 'report' | 'default' } {
  const timing = dimensions.find((dimension) => dimension.name === 'shot_timing');
  for (const evidence of timing?.reference_evidence ?? []) {
    const value = evidence.frame_rate;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return { frameRate: value, from: 'report' };
    }
  }
  return { frameRate: fallback, from: 'default' };
}

/** 方案里每个操作要过的闸门（给界面提前说明用）。 */
export function gatesRequiredBy(plan: RepairPlan): Array<'G2' | 'G3'> {
  const gates = new Set<'G2' | 'G3'>();
  for (const operation of plan.operations) {
    if (operation.requires_gate === 'G2' || operation.requires_gate === 'G3') gates.add(operation.requires_gate);
  }
  return [...gates].sort();
}
