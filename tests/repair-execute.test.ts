import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildEvalReport, frameRateFromReport, planRepairExecution, proposeRepairPlan } from '@qiyin/kernel-service';
import type { FrontkernelMediaProbe } from '@qiyin/frontkernel-adapter';
import type { RepairPlan } from '@qiyin/contracts';

/* ============================================================
   修复执行（S9 的后半段）。

   方案里只有 `scope` 与 `kind`，没有"改成什么值"的载荷。所以执行器只能做
   "动作本身就能确定"的那几件事，其余一律拒绝并说明理由——**不编**。

   这一组测试盯三件事：
     1. retime_clip 真的把时长吸附到整帧，而且只动方案点名的镜头；
     2. 花钱的重跑**带着作用域**（shots 只有那几个），不是整片重来；
     3. 做不了的动作必须出现在 refused 里，且理由是"人能照着做的"。
   ============================================================ */

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function probe(overrides: Partial<FrontkernelMediaProbe> = {}): FrontkernelMediaProbe {
  return { path: 'x.mp4', duration: 4.2, hasVideo: true, hasAudio: true, width: 540, height: 960, frameRate: 30, ...overrides };
}

const SHOTS_WITH_DRIFT = [
  { shot_id: 'shot-01', duration_ms: 2100 },
  { shot_id: 'shot-02', duration_ms: 1234 },
  { shot_id: 'shot-03', duration_ms: 2100 },
];

function reportFrom(shots = SHOTS_WITH_DRIFT) {
  return buildEvalReport({
    referenceArtifact: HASH_A, resultArtifact: HASH_B,
    reference: probe(), result: probe(), shots, frameRate: 30,
  });
}

/** 真实生成的方案（只含 retime_clip），用来测"免费那一半" */
function realPlan(): RepairPlan {
  const plan = proposeRepairPlan({
    evalReportId: randomUUID(), report: reportFrom(), allShots: ['shot-01', 'shot-02', 'shot-03'], targetRevision: 3,
  });
  if (plan === null) throw new Error('这份评估本该生成方案');
  return plan;
}

const SHOTS = [
  { shot_id: 'shot-01', t0_ms: 0, t1_ms: 2100, duration_ms: 2100 },
  { shot_id: 'shot-02', t0_ms: 2100, t1_ms: 3334, duration_ms: 1234 },
  { shot_id: 'shot-03', t0_ms: 3334, t1_ms: 5434, duration_ms: 2100 },
];

const ALL_APPROVED = () => true;
const NONE_APPROVED = () => false;

describe('修复执行：能算的那一半', () => {
  it('retime_clip 把该镜吸附到整帧，并且只动那一镜', () => {
    const exec = planRepairExecution({
      plan: realPlan(), shots: SHOTS, frameRate: 30, frameRateFrom: 'report', gateApproved: ALL_APPROVED,
    });
    expect(exec.edits).toHaveLength(1);
    expect(exec.edits[0]?.shotId).toBe('shot-02');
    /* 1234ms @30fps = 37.02 帧 → 37 帧 = 1233.33ms；取整后 1233 */
    expect(exec.edits[0]?.durationMs).toBe(1233);
    expect(exec.edits[0]?.t1Ms).toBe(2100 + 1233);
    expect(exec.edits[0]?.previousDurationMs).toBe(1234);
    expect(exec.edits[0]?.reason).toContain('30fps');
    /* 其余镜头一个字都没提 */
    expect(exec.edits.map((edit) => edit.shotId)).not.toContain('shot-01');
    expect(exec.reused.sort()).toEqual(['shot-01', 'shot-03']);
  });

  it('本来就对齐的镜头不算改动，记进 unchanged 而不是编一个 edit', () => {
    const aligned = SHOTS.map((shot) => ({ ...shot, t1_ms: shot.t0_ms + 2100, duration_ms: 2100 }));
    const exec = planRepairExecution({
      plan: realPlan(), shots: aligned, frameRate: 30, frameRateFrom: 'report', gateApproved: ALL_APPROVED,
    });
    expect(exec.edits).toEqual([]);
    expect(exec.unchanged).toEqual(['op-1']);
  });

  it('rerender_full 只标记需要重渲染，不假装自己做了别的', () => {
    const plan: RepairPlan = {
      schema: 'replica.repair-plan@1',
      source_eval_report: randomUUID(),
      operations: [{
        id: 'op-r', kind: 'rerender_full', scope: ['program'], preconditions: [],
        target_revision: 3, estimated_cost_cents: 0, estimated_duration_ms: 0,
        affected_closure: ['program'], rollback: '保留上一版', requires_gate: 'none',
      }],
      reused: ['shot-01'],
    };
    const exec = planRepairExecution({ plan, shots: SHOTS, frameRate: 30, frameRateFrom: 'report', gateApproved: ALL_APPROVED });
    expect(exec.needsRerender).toBe(true);
    expect(exec.rerenderScope).toEqual(['program']);
    expect(exec.rerenderOperations).toEqual(['op-r']);
    expect(exec.edits).toEqual([]);
    expect(exec.refused).toEqual([]);
  });
});

describe('修复执行：花钱的那一半必须带作用域', () => {
  const planWithPaid: RepairPlan = {
    schema: 'replica.repair-plan@1',
    source_eval_report: randomUUID(),
    operations: [{
      id: 'op-p', kind: 'regenerate_image', scope: ['shot-02'], preconditions: [],
      target_revision: 3, estimated_cost_cents: 5, estimated_duration_ms: 0,
      affected_closure: ['shot-02'], rollback: '回退候选', requires_gate: 'G2',
    }],
    reused: ['shot-01', 'shot-03'],
  };

  it('没给模型时拒绝——不替用户挑一个模型去花钱', () => {
    const exec = planRepairExecution({
      plan: planWithPaid, shots: SHOTS, frameRate: 30, frameRateFrom: 'report', gateApproved: ALL_APPROVED,
    });
    expect(exec.generations).toEqual([]);
    expect(exec.refused).toHaveLength(1);
    expect(exec.refused[0]?.reason).toContain('选好模型');
  });

  it('闸门没批时拒绝，理由点名是哪个闸门', () => {
    const exec = planRepairExecution({
      plan: planWithPaid, shots: SHOTS, frameRate: 30, frameRateFrom: 'report',
      gateApproved: NONE_APPROVED, models: { image: 'Z-image Turbo' },
    });
    expect(exec.generations).toEqual([]);
    expect(exec.refused[0]?.reason).toContain('G2');
  });

  it('给了模型且闸门已批：只重跑方案点名的那一镜，成本按方案记', () => {
    const exec = planRepairExecution({
      plan: planWithPaid, shots: SHOTS, frameRate: 30, frameRateFrom: 'report',
      gateApproved: ALL_APPROVED, models: { image: 'Z-image Turbo' },
    });
    expect(exec.generations).toHaveLength(1);
    expect(exec.generations[0]?.shots).toEqual(['shot-02']);
    expect(exec.estimatedCostCents).toBe(5);
    expect(exec.reused).toEqual(['shot-01', 'shot-03']);
  });
});

describe('修复执行：做不了的要拒绝，且理由要能照着做', () => {
  const planWithUnknown: RepairPlan = {
    schema: 'replica.repair-plan@1',
    source_eval_report: randomUUID(),
    operations: [
      {
        id: 'op-1', kind: 'update_prompt_field', scope: ['shot-01'], preconditions: [],
        target_revision: 1, estimated_cost_cents: 0, estimated_duration_ms: 0,
        affected_closure: [], rollback: 'r', requires_gate: 'none',
      },
      {
        id: 'op-2', kind: 'change_candidate_selection', scope: ['shot-02'], preconditions: [],
        target_revision: 1, estimated_cost_cents: 0, estimated_duration_ms: 0,
        affected_closure: [], rollback: 'r', requires_gate: 'none',
      },
      {
        id: 'op-3', kind: 'replace_audio_segment', scope: ['program'], preconditions: [],
        target_revision: 1, estimated_cost_cents: 0, estimated_duration_ms: 0,
        affected_closure: [], rollback: 'r', requires_gate: 'none',
      },
    ],
    reused: [],
  };

  it('需要"新值"或"人的选择"的动作一律拒绝，并说清该去哪做', () => {
    const exec = planRepairExecution({
      plan: planWithUnknown, shots: SHOTS, frameRate: 30, frameRateFrom: 'report', gateApproved: ALL_APPROVED,
    });
    expect(exec.refused.map((item) => item.kind).sort()).toEqual([
      'change_candidate_selection', 'replace_audio_segment', 'update_prompt_field',
    ]);
    expect(exec.refused.find((item) => item.kind === 'update_prompt_field')?.reason).toContain('逐镜字段表');
    expect(exec.refused.find((item) => item.kind === 'change_candidate_selection')?.reason).toContain('选帧面板');
    expect(exec.refused.find((item) => item.kind === 'replace_audio_segment')?.reason).toContain('替代音轨');
  });
});

describe('帧率从哪来', () => {
  it('报告里有 fps 就用报告的，并标明来源', () => {
    const from = frameRateFromReport(reportFrom().dimensions);
    expect(from).toEqual({ frameRate: 30, from: 'report' });
  });

  it('报告里没有就退回默认值，并如实标明是默认值', () => {
    const from = frameRateFromReport([{ name: 'shot_timing', reference_evidence: [] }]);
    expect(from).toEqual({ frameRate: 30, from: 'default' });
  });
});

describe('修复执行的领域记账', () => {
  function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
    return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
  }

  function setup() {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = service.execute(command('project.create', { name: '修复执行项目', max_budget_cents: 2000, rights_confirmed: true }));
    const projectId = created.project_id!;
    const recorded = service.execute(command('eval.record', { report: reportFrom() }, { project_id: projectId, expected_revision: 1 }));
    const reportId = (recorded.payload as { report_id: string }).report_id;
    const plan = proposeRepairPlan({ evalReportId: reportId, report: reportFrom(), allShots: ['shot-01', 'shot-02', 'shot-03'], targetRevision: 2 })!;
    const proposed = service.execute(command('repair.propose', { plan }, { project_id: projectId, expected_revision: 2 }));
    const planId = (proposed.payload as { plan_id: string }).plan_id;
    return { service, projectId, planId };
  }

  it('没批 G4 不许记录执行', () => {
    const { service, projectId, planId } = setup();
    let caught: unknown;
    try {
      service.execute(command('repair.execute', {
        plan_id: planId, execution_revision: 3, status: 'EXECUTED', executed: ['op-1'], refused: [],
      }, { project_id: projectId, expected_revision: 3 }));
    } catch (error) { caught = error; }
    expect((caught as { code?: string }).code).toBe('G4_REQUIRED');
  });

  it('G4 批准之后可以记录执行：状态从 PROPOSED 变成执行结果', () => {
    const { service, projectId, planId } = setup();
    service.execute(command('gate.approve', { gate: 'G4' }, { project_id: projectId, expected_revision: 3 }));
    const done = service.execute(command('repair.execute', {
      plan_id: planId, execution_revision: 4, status: 'EXECUTED', executed: ['op-1'], refused: [],
    }, { project_id: projectId, expected_revision: 4 }));
    expect((done.payload as { status: string }).status).toBe('EXECUTED');
    const stored = service.listRepairPlans(projectId) as Array<{ status: string }>;
    expect(stored[0]?.status).toBe('EXECUTED');
    expect(service.listEvents(projectId).map((event) => event.type)).toContain('repair.executed');
  });

  it('批准之后项目又变了（revision 对不上）：拒绝，理由是"重新评估"', () => {
    const { service, projectId, planId } = setup();
    service.execute(command('gate.approve', { gate: 'G4' }, { project_id: projectId, expected_revision: 3 }));
    /* 执行器声称它是在 R5 上验证的，而 G4 批的是 R4 */
    let caught: unknown;
    try {
      service.execute(command('repair.execute', {
        plan_id: planId, execution_revision: 5, status: 'EXECUTED', executed: ['op-1'], refused: [],
      }, { project_id: projectId, expected_revision: 4 }));
    } catch (error) { caught = error; }
    expect((caught as { code?: string }).code).toBe('REPAIR_PLAN_STALE');
  });

  it('同一份方案不能记两次', () => {
    const { service, projectId, planId } = setup();
    service.execute(command('gate.approve', { gate: 'G4' }, { project_id: projectId, expected_revision: 3 }));
    service.execute(command('repair.execute', {
      plan_id: planId, execution_revision: 4, status: 'EXECUTED', executed: ['op-1'], refused: [],
    }, { project_id: projectId, expected_revision: 4 }));
    let caught: unknown;
    try {
      service.execute(command('repair.execute', {
        plan_id: planId, execution_revision: 5, status: 'EXECUTED', executed: ['op-1'], refused: [],
      }, { project_id: projectId, expected_revision: 5 }));
    } catch (error) { caught = error; }
    expect((caught as { code?: string }).code).toBe('REPAIR_PLAN_NOT_PROPOSED');
  });

  it('部分执行也算数：PARTIAL + 拒绝清单一起记下来', () => {
    const { service, projectId, planId } = setup();
    service.execute(command('gate.approve', { gate: 'G4' }, { project_id: projectId, expected_revision: 3 }));
    const done = service.execute(command('repair.execute', {
      plan_id: planId, execution_revision: 4, status: 'PARTIAL', executed: ['op-1'],
      refused: [{ id: 'op-2', kind: 'update_prompt_field', reason: '需要新值' }],
    }, { project_id: projectId, expected_revision: 4 }));
    expect(done.payload).toMatchObject({ status: 'PARTIAL', executed_count: 1, refused_count: 1 });
  });
});
