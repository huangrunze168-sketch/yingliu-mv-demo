import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService, type GateSnapshot } from '@qiyin/domain';

/**
 * 闸门状态的权威性。
 *
 * 背景：`gate_decisions` 是 append-only 的审计表，同一个闸门会同时存在
 * 「旧的 APPROVED」与「新的 SUPERSEDED」两条记录。凡是拿整张表按
 * 当成已批准——这与领域层 `currentGate()`（取 sequence 最大的一条）判断相反。
 *
 * 因此领域层必须直接给出「每个闸门的当前状态」，UI 不得自行推断。
 */

const shot = {
  shot_id: 'shot-01', t0_ms: 0, t1_ms: 2100, duration_ms: 2100,
  shot_size: 'medium_close_up', camera_position: 'eye_level', camera_move: 'slow_push_in',
  lighting: 'soft_key_from_left', sound: 'dialogue', replacement: '替换人物，保留窗光方向',
  confidence: 0.9, source: 'human', author: 'user:test',
} as const;

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

function setupThroughG1(service: ProjectService): string {
  const created = service.execute(command('project.create', { name: '闸门测试项目', max_budget_cents: 1000, rights_confirmed: true }));
  const projectId = created.project_id!;
  service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  service.execute(command('shot-fields.replace', { breakdown_revision: 1, shots: [shot] }, { project_id: projectId, expected_revision: 2 }));
  service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
  return projectId;
}

describe('闸门状态权威性', () => {
  it('项目详情必须给出每个闸门的当前状态，而不是让消费方从历史记录里猜', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = setupThroughG1(service);

    const project = service.getProject(projectId) as { gate_status: Record<string, string> };
    expect(project.gate_status).toBeDefined();
    expect(project.gate_status.G0).toBe('APPROVED');
    expect(project.gate_status.G1).toBe('APPROVED');
    expect(project.gate_status.G2 ?? null).toBeNull();
  });

  it('G1 之后修改字段表，G1 的当前状态必须变为 SUPERSEDED', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = setupThroughG1(service);

    service.execute(command('shot-fields.replace', { breakdown_revision: 2, shots: [shot] }, { project_id: projectId, expected_revision: 4 }));

    const project = service.getProject(projectId) as {
      gate_status: Record<string, string>;
      gates: GateSnapshot[];
    };

    expect(project.gate_status.G1).toBe('SUPERSEDED');
    expect(project.gate_status.G0).toBe('APPROVED');

    // 审计历史必须保留旧批准，不能被删除或覆盖
    const history = project.gates.filter((gate) => gate.gate === 'G1');
    expect(history.some((gate) => gate.status === 'APPROVED')).toBe(true);
    expect(history.some((gate) => gate.status === 'SUPERSEDED')).toBe(true);

    // 任何按「历史里存在 APPROVED」推断的做法都会得出错误结论，这正是要禁止的
    const naive = new Set(
      project.gates.filter((gate) => gate.status === 'APPROVED').map((gate) => gate.gate),
    );
    expect(naive.has('G1')).toBe(true); // 朴素做法确实错了
    expect(project.gate_status.G1).not.toBe('APPROVED'); // 权威状态才是对的
  });

  it('G2 批准后重新选帧，G2 的当前状态必须回到未批准', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = setupThroughG1(service);
    const artifact = `sha256:${'a'.repeat(64)}`;

    service.execute(command('image-candidate.add', { shot_id: 'shot-01', candidate_id: 'candidate-01', artifact_id: artifact }, { project_id: projectId, expected_revision: 4 }));
    service.execute(command('image-candidate.select', { shot_id: 'shot-01', candidate_id: 'candidate-01', expected_selection_revision: 0 }, { project_id: projectId, expected_revision: 5 }));
    service.execute(command('gate.approve', { gate: 'G2', approved_budget_cents: 300 }, { project_id: projectId, expected_revision: 6 }));

    let project = service.getProject(projectId) as { gate_status: Record<string, string> };
    expect(project.gate_status.G2).toBe('APPROVED');

    // 新增候选会令已批准的视频预算失效（首帧可能被换掉）
    service.execute(command('image-candidate.add', { shot_id: 'shot-01', candidate_id: 'candidate-02', artifact_id: artifact }, { project_id: projectId, expected_revision: 7 }));

    project = service.getProject(projectId) as { gate_status: Record<string, string> };
    expect(project.gate_status.G2).toBe('SUPERSEDED');
  });
});
