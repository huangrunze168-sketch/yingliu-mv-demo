import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';
import type { AgentEvent } from '../apps/local-api/src/agent/agent-runner.js';

it('Agent 事件超过一页时保留游标，活跃运行可恢复并可停止', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-agent-events-'));
  const service = new ProjectService(openDatabase(':memory:'));
  const project = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '事件测试', max_budget_cents: 0, rights_confirmed: true } });
  const projectId = project.project_id!;
  const runId = randomUUID();
  let emit: ((event: AgentEvent) => void) | undefined;
  let canceled = false;
  const app = buildServer(service, undefined, { workspaceRoot: root, startAgent: ({ onEvent }) => {
    emit = onEvent;
    return { runId, cancel: () => { canceled = true; } };
  } });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const id = created.json().id as string;
    const path = `/api/v1/agent/sessions/${id}`;
    const sent = await app.inject({ method: 'POST', url: `${path}/messages`, payload: { project_id: projectId, message_id: randomUUID(), text: '请分析', expected_session_revision: 0 } });
    expect(sent.statusCode).toBe(202);
    for (let i = 0; i < 120; i++) emit!({ runId, kind: 'message', text: `增量 ${i}`, at: Date.now() + i });
    const first = (await app.inject({ method: 'GET', url: `${path}/events?project_id=${projectId}&after=0&limit=100` })).json();
    expect(first.events).toHaveLength(100);
    expect(first.next_cursor).toBe(100);
    expect(first.session_revision).toBe(121);
    expect(first.done).toBe(false);
    expect(first.run_id).toBe(runId);
    const rest = (await app.inject({ method: 'GET', url: `${path}/events?project_id=${projectId}&after=100&limit=100` })).json();
    expect(rest.events).toHaveLength(21);
    expect(rest.next_cursor).toBe(121);
    const canceledRun = await app.inject({ method: 'POST', url: `${path}/runs/${runId}/cancel`, payload: { project_id: projectId } });
    expect(canceledRun.statusCode).toBe(200);
    expect(canceled).toBe(true);
    const final = (await app.inject({ method: 'GET', url: `${path}/events?project_id=${projectId}&after=121` })).json();
    expect(final.done).toBe(true);
    expect(final.run_id).toBeNull();
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
