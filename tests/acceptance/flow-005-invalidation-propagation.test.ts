/* ============================================================
  FLOW-005「修复建议、影响范围、局部重跑」的量化验收（影响范围那一半）。

  漏掉一处的后果很具体——用户改了镜头表，却还能拿旧提示词去生成，
  而界面上的批准状态看起来仍然是绿的。

  这里直接查库数行：改动前有几份 CURRENT 的提示词包，改动后就必须**一份都不剩**。
   ============================================================ */

import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { command, recordAcceptance } from './_acceptance.js';

describe('[FLOW-005] 改动的影响范围', () => {
  it('改上游后：G1/G2 作废，派生提示词包 100% 置为 STALE', () => {
    const db = openDatabase(':memory:');
    const service = new ProjectService(db);
    const projectId = service.execute(command('project.create', {
      name: '失效传播验收', max_budget_cents: 10_000, rights_confirmed: true,
    })).project_id as string;
    const revision = () => (service.getProject(projectId) as { revision: number }).revision;
    const gates = () => (service.getProject(projectId) as { gate_status: Record<string, string> }).gate_status;

    service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: revision() }));
    service.execute(command('shot-fields.seed', {
      breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2000 }, { t0_ms: 2000, t1_ms: 4000 }],
    }, { project_id: projectId, expected_revision: revision() }));
    service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: revision() }));
    service.execute(command('prompt.derive', { kit_version: 'acceptance@1', model_id: 'acceptance-model' }, {
      project_id: projectId, expected_revision: revision(),
    }));
    /* 再来一份，确保"全部置 STALE"不是只有一行时的巧合 */
    service.execute(command('prompt.derive', { kit_version: 'acceptance@2', model_id: 'acceptance-model' }, {
      project_id: projectId, expected_revision: revision(),
    }));

    const before = db.prepare('SELECT COUNT(*) AS count FROM prompt_bundles WHERE status = ?').get('CURRENT') as unknown as { count: number };
    const gatesBefore = gates();

    service.execute(command('shot-fields.replace', {
      breakdown_revision: 2,
      shots: [{
        shot_id: 'shot-01', t0_ms: 0, t1_ms: 2000, duration_ms: 2000,
        shot_size: '中景', camera_position: '平视', camera_move: '推', lighting: '柔光',
        sound: '对白', replacement: '替换人物', confidence: 0.9, source: 'mixed', author: 'user:acceptance',
      }, {
        shot_id: 'shot-02', t0_ms: 2000, t1_ms: 4000, duration_ms: 2000,
        shot_size: '近景', camera_position: '仰拍', camera_move: '固定', lighting: '硬光',
        sound: '环境音', replacement: '保留原场景', confidence: 0.9, source: 'mixed', author: 'user:acceptance',
      }],
    }, { project_id: projectId, expected_revision: revision() }));

    const currentAfter = db.prepare('SELECT COUNT(*) AS count FROM prompt_bundles WHERE status = ?').get('CURRENT') as unknown as { count: number };
    const staleAfter = db.prepare('SELECT COUNT(*) AS count FROM prompt_bundles WHERE status = ?').get('STALE') as unknown as { count: number };
    const gatesAfter = gates();

    recordAcceptance('FLOW-005', {
      criterion: '上游改动后，下游派生结果 100% 失效',
      currentBefore: before.count,
      currentAfter: currentAfter.count,
      staleAfter: staleAfter.count,
      gatesBefore: gatesBefore.G1,
      gatesAfter: { G1: gatesAfter.G1, G2: gatesAfter.G2 },
    });

    expect(before.count).toBeGreaterThanOrEqual(2);
    expect(gatesBefore.G1).toBe('APPROVED');
    expect(currentAfter.count).toBe(0);
    expect(staleAfter.count).toBe(before.count);
    expect(gatesAfter.G1).toBe('SUPERSEDED');
  });
});
