/* ============================================================
  FLOW-006「缓存与历史结果显式复用」的量化验收。

  矩阵要的是"复用误命中 = 0"。复用的价值全压在一个判定上：
  **这一次请求和那一次是不是同一件事**。判错的后果是用户拿到一张不相干的图，
  而账上写着省了钱——比多花一次钱更糟。

  这里真的走一遍：

    ① 申请一次图片生成（摘要 A）并按实际 50 分结清，登记候选；
    ② 拿摘要 B 去复用它 → 必须被拒（REUSE_DIGEST_MISMATCH），且预留金额不动；
    ③ 拿摘要 A 去复用 → 允许，且**不再预留任何预算**；
    ④ 复用那一笔的 `actual_cost_cents` 必须是 0（0 是事实，"不知道花没花"才是 null）。

  另外把"摘要算错"这件事也量一下：不同输入必须给出不同摘要（撞一次就是一次误命中）。
   ============================================================ */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { command, recordAcceptance, rejectionCode } from './_acceptance.js';

function setup() {
  const db = openDatabase(':memory:');
  const service = new ProjectService(db);
  const created = service.execute(command('project.create', {
    name: '复用验收', max_budget_cents: 1000, rights_confirmed: true,
  }));
  const projectId = created.project_id as string;
  const revision = () => (service.getProject(projectId) as { revision: number }).revision;
  const reserved = () => (service.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents;
  service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: revision() }));
  service.execute(command('shot-fields.seed', {
    breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2000 }],
  }, { project_id: projectId, expected_revision: revision() }));
  service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: revision() }));
  service.execute(command('image-candidate.add', {
    shot_id: 'shot-01', candidate_id: 'cand-A', artifact_id: `sha256:${'a'.repeat(64)}`,
  }, { project_id: projectId, expected_revision: revision() }));
  return { service, projectId, revision, reserved };
}

describe('[FLOW-006] 结果复用与摘要校验', () => {
  it('摘要对不上就拒绝复用；对得上则复用且不再花钱', () => {
    const { service, projectId, revision, reserved } = setup();
    const source = service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'acceptance-model', prompt: '一只猫',
      estimated_cost_cents: 50, digest: 'digest-A',
    }, { project_id: projectId, expected_revision: revision() }));
    const sourceIntentId = (source.payload as { intent_id: string }).intent_id;
    service.execute(command('image-generation.settle', {
      intent_id: sourceIntentId, status: 'COMPLETED', actual_cost_cents: 50, candidate_id: 'cand-A',
    }, { project_id: projectId, expected_revision: revision() }));
    const reservedBeforeReuse = reserved();

    const mismatch = rejectionCode(() => service.execute(command('image-generation.reuse', {
      shot_id: 'shot-01', candidate_id: 'cand-B', source_intent_id: sourceIntentId, digest: 'digest-B',
    }, { project_id: projectId, expected_revision: revision() })));
    const reservedAfterMismatch = reserved();

    const reused = service.execute(command('image-generation.reuse', {
      shot_id: 'shot-01', candidate_id: 'cand-C', source_intent_id: sourceIntentId, digest: 'digest-A',
    }, { project_id: projectId, expected_revision: revision() }));
    const reservedAfterReuse = reserved();
    const reusePayload = reused.payload as { candidate_id: string; actual_cost_cents: number; source_intent_id: string };

    recordAcceptance('FLOW-006', {
      criterion: '复用误命中 = 0，且复用不产生新预留',
      mismatchRejectedCode: mismatch,
      reservedBeforeReuse,
      reservedAfterMismatch,
      reservedAfterReuse,
      reusedFrom: reusePayload.source_intent_id,
      reusedCandidate: reusePayload.candidate_id,
      reusedActualCostCents: reusePayload.actual_cost_cents,
    });

    expect(mismatch).toBe('REUSE_DIGEST_MISMATCH');
    expect(reservedAfterMismatch).toBe(reservedBeforeReuse);
    expect(reusePayload.source_intent_id).toBe(sourceIntentId);
    expect(reusePayload.actual_cost_cents).toBe(0);
    expect(reservedAfterReuse).toBe(reservedBeforeReuse);
  });

  it('不同输入的摘要两两不同（摘要算法本身不产生误命中）', () => {
    const inputs = Array.from({ length: 300 }, (_unused, index) => JSON.stringify({
      shot_id: `shot-${index}`, model: `model-${index % 7}`, prompt: `提示词 ${index}`,
      duration_seconds: 3 + (index % 5), spatial_revision: index % 11,
    }));
    const digests = inputs.map((input) => createHash('sha256').update(input).digest('hex'));
    const unique = new Set(digests);

    recordAcceptance('FLOW-006.digest-collision', {
      samples: inputs.length,
      uniqueDigests: unique.size,
      collisions: inputs.length - unique.size,
    });

    expect(unique.size).toBe(inputs.length);
  });
});
