import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

describe('生成 Provider 持久化恢复点', () => {
  it('记录 accepted、provider_started 与 failed，并随项目彻底删除清理', () => {
    const db = openDatabase(':memory:');
    const service = new ProjectService(db);
    const created = service.execute(command('project.create', {
      name: '恢复点项目',
      max_budget_cents: 1000,
      rights_confirmed: true,
    }));
    const projectId = created.project_id!;
    const intentId = randomUUID();

    service.recordGenerationCheckpoint(projectId, intentId, 'accepted', { resume_from: 'accepted' });
    service.recordGenerationCheckpoint(projectId, intentId, 'provider_started', { resume_from: 'provider_call' }, 'task-42');
    service.recordGenerationCheckpoint(projectId, intentId, 'failed', { resume_from: 'provider_call', error: 'timeout' }, 'task-42');

    const snapshot = service.getProject(projectId) as { generation_checkpoints: Array<{ stage: string; checkpoint: Record<string, unknown>; provider_task_ref: string | null }> };
    expect(snapshot.generation_checkpoints).toHaveLength(1);
    expect(snapshot.generation_checkpoints[0]).toMatchObject({
      stage: 'failed',
      provider_task_ref: 'task-42',
      checkpoint: { resume_from: 'provider_call', error: 'timeout' },
    });

    service.execute(command('project.trash', {}, { project_id: projectId, expected_revision: 1 }));
    service.execute(command('project.purge', { confirm_name: '恢复点项目' }, { project_id: projectId, expected_revision: 2 }));
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM generation_checkpoints WHERE project_id=?').get(projectId) as { n: number };
    expect(remaining.n).toBe(0);
  });
});
