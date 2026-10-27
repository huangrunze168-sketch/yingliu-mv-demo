/* ============================================================
  GEN-005「成本预估、预算上限、实际成本」的量化验收。

  矩阵要的是"超预算的请求在提交前就被拒"。这里用一比一的小账本来量：

    预算 100 分 → 申请 60（过）→ 再申请 60（必须被拒）→ 申请 40（正好用满）
    → 再申请 1（必须被拒）→ 把第一笔按实际 20 结清 → 退回 40，账上剩 60
    → 这时申请 40 又能过（证明退回的是真额度，不是写在纸上的一句话）

  只断言"抛错了"是不够的：真正的失败形态是**账被多扣了钱却没报错**。
  所以每一步都比对 `reserved_budget_cents` 的具体数值。
   ============================================================ */

import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { command, recordAcceptance, rejectionCode } from './_acceptance.js';

const BUDGET_CENTS = 100;

function setup() {
  const db = openDatabase(':memory:');
  const service = new ProjectService(db);
  const created = service.execute(command('project.create', {
    name: '预算上限验收', max_budget_cents: BUDGET_CENTS, rights_confirmed: true,
  }));
  const projectId = created.project_id as string;
  const revision = () => (service.getProject(projectId) as { revision: number }).revision;
  const reserved = () => (service.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents;
  service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: revision() }));
  service.execute(command('shot-fields.seed', {
    breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2000 }],
  }, { project_id: projectId, expected_revision: revision() }));
  service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: revision() }));
  return { db, service, projectId, revision, reserved };
}

describe('[GEN-005] 成本预估与预算上限', () => {
  it('超预算的请求提交前被拒，且账上没有被多扣', () => {
    const { service, projectId, revision, reserved } = setup();
    const request = (cost: number) => service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'acceptance-model', prompt: '一只猫', estimated_cost_cents: cost,
    }, { project_id: projectId, expected_revision: revision() }));

    const first = request(60);
    const afterFirst = reserved();
    const overCode = rejectionCode(() => request(60));
    const afterRefusal = reserved();
    const second = request(40);
    const afterSecond = reserved();
    const overCodeAgain = rejectionCode(() => request(1));
    const afterSecondRefusal = reserved();

    const firstIntent = (first.payload as { intent_id: string }).intent_id;
    service.execute(command('image-generation.settle', {
      intent_id: firstIntent, status: 'COMPLETED', actual_cost_cents: 20, candidate_id: 'cand-A',
    }, { project_id: projectId, expected_revision: revision() }));
    const afterSettle = reserved();
    const afterRefund = request(40);
    const finalReserved = reserved();

    recordAcceptance('GEN-005', {
      criterion: '超预算请求提交前被拒，且预留金额不超过上限',
      budgetCents: BUDGET_CENTS,
      admittedCents: [60, 40],
      rejectedCodes: [overCode, overCodeAgain],
      reservedAfterFirst: afterFirst,
      reservedAfterRefusal: afterRefusal,
      reservedAfterSecond: afterSecond,
      reservedAfterSecondRefusal: afterSecondRefusal,
      reservedAfterSettle: afterSettle,
      secondIntent: (second.payload as { intent_id: string }).intent_id.length > 0,
      reservedAfterRefund: finalReserved,
    });

    expect(afterFirst).toBe(60);
    expect(overCode).toBe('PROJECT_BUDGET_EXCEEDED');
    expect(afterRefusal).toBe(60);
    expect(afterSecond).toBe(100);
    expect(overCodeAgain).toBe('PROJECT_BUDGET_EXCEEDED');
    expect(afterSecondRefusal).toBe(100);
    expect(afterSettle).toBe(60);
    expect(finalReserved).toBe(100);
    expect((afterRefund.payload as { status: string }).status).toBe('ADMITTED');
    expect(finalReserved).toBeLessThanOrEqual(BUDGET_CENTS);
  });

  it('预估与实际不一致时差额退回，账本不会只进不出', () => {
    const { service, projectId, revision, reserved } = setup();
    const request = service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'acceptance-model', prompt: '一只猫', estimated_cost_cents: 80,
    }, { project_id: projectId, expected_revision: revision() }));
    const intentId = (request.payload as { intent_id: string }).intent_id;

    const settled = service.execute(command('image-generation.settle', {
      intent_id: intentId, status: 'COMPLETED', actual_cost_cents: 5, candidate_id: 'cand-B',
    }, { project_id: projectId, expected_revision: revision() }));
    const payload = settled.payload as { actual_cost_cents: number; released_cents: number };

    recordAcceptance('GEN-005.diff-refund', {
      estimatedCents: 80,
      actualCents: payload.actual_cost_cents,
      releasedCents: payload.released_cents,
      reservedBudgetCents: reserved(),
    });

    expect(payload.actual_cost_cents).toBe(5);
    expect(payload.released_cents).toBe(75);
    expect(reserved()).toBe(5);
  });

  it('供应商没报金额时记 null（未知），不拿预估值冒充实际花费', () => {
    const { service, projectId, revision, reserved } = setup();
    const request = service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'acceptance-model', prompt: '一只猫', estimated_cost_cents: 70,
    }, { project_id: projectId, expected_revision: revision() }));
    const intentId = (request.payload as { intent_id: string }).intent_id;
    service.execute(command('image-generation.settle', {
      intent_id: intentId, status: 'COMPLETED', candidate_id: 'cand-C',
      provider_cost: { unit: 'credit', amount: 3 },
    }, { project_id: projectId, expected_revision: revision() }));

    const row = (service.listImageGenerationIntents(projectId) as Array<{ intent_id: string }>)
      .find((intent) => intent.intent_id === intentId) as unknown as
      { actual_cost_cents: number | null; provider_cost_unit: string | null; provider_cost_amount: number | null };

    recordAcceptance('GEN-005.unknown-cost', {
      actualCostCents: row.actual_cost_cents,
      providerCostUnit: row.provider_cost_unit,
      providerCostAmount: row.provider_cost_amount,
      reservedBudgetCents: reserved(),
    });

    expect(row.actual_cost_cents).toBeNull();
    expect(row.provider_cost_unit).toBe('credit');
    expect(row.provider_cost_amount).toBe(3);
  });
});
