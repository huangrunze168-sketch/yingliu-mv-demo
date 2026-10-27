import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';
import { readSession, saveSession } from '../apps/local-api/src/agent/agent-sessions.js';
import { shotsFromPlan } from '../apps/local-api/src/agent/creative-plan.js';

it('Agent 确认方案不得覆盖其他作者已有分镜', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-agent-ownership-'));
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '现有项目', max_budget_cents: 0, rights_confirmed: false } }).project_id!;
  const plan = { kind: 'plan' as const, title: '原有镜头', direction: '纪实', aspectRatio: '9:16' as const, shots: [{ id: 'shot-01', title: '街角', visual: '傍晚街角', narration: '', durationSeconds: 5 }] };
  service.execute({ command_id: randomUUID(), actor: 'user:editor', type: 'shot-fields.replace', project_id: projectId, expected_revision: 1, payload: { breakdown_revision: 0, shots: shotsFromPlan(plan, 'user:editor') } });
  const app = buildServer(service, undefined, { workspaceRoot: root });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const sessionId = created.json().id as string;
    const dir = join(root, projectId);
    const session = readSession(dir, sessionId)!;
    saveSession(dir, { id: session.id, title: session.title, messages: [{ id: 'plan-other', role: 'plan', text: JSON.stringify(plan) }] });
    const failed = await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/plan/approve`, payload: { project_id: projectId, plan_id: 'plan-other', expected_session_revision: 1 } });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error.code).toBe('PROJECT_ALREADY_IN_PRODUCTION');
    expect((service.getProject(projectId) as { shot_fields: { shots: Array<{ author: string }> } }).shot_fields.shots[0]!.author).toBe('user:editor');
    expect(readSession(dir, sessionId)!.messages).toHaveLength(1);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
