import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';
import type { AgentEvent } from '../apps/local-api/src/agent/agent-runner.js';

it('手动取消后仍标记已取消，不误报规划服务中断', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-run-cancel-'));
  const service = new ProjectService(openDatabase(':memory:'));
  const project = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '取消规划', max_budget_cents: 0, rights_confirmed: true } });
  const projectId = project.project_id!;
  let canceled = false;
  let emit: ((event: AgentEvent) => void) | undefined;
  const app = buildServer(service, undefined, { workspaceRoot: root, startAgent: ({ onEvent }) => {
    emit = onEvent;
    return { runId: randomUUID(), cancel: () => { canceled = true; } };
  } });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const id = created.json().id as string;
    const base = `/api/v1/agent/sessions/${id}`;
    const started = await app.inject({ method: 'POST', url: `${base}/messages`, payload: { project_id: projectId, message_id: randomUUID(), mode: 'creative', text: '拍摄想法', expected_session_revision: 0 } });
    const runId = started.json().run_id as string;
    const stopped = await app.inject({ method: 'POST', url: `${base}/runs/${runId}/cancel`, payload: { project_id: projectId } });
    expect(stopped.statusCode).toBe(200);
    expect(canceled).toBe(true);
    emit?.({ runId, at: Date.now(), kind: 'message', text: JSON.stringify({ kind: 'plan', title: '迟到方案', direction: '不应入库', aspectRatio: '16:9', shots: [{ id: 'shot-01', title: '开场', visual: '海边', narration: '', durationSeconds: 4 }] }) });
    emit?.({ runId, at: Date.now() + 1, kind: 'done', text: '' });
    const events = await app.inject({ method: 'GET', url: `${base}/events?project_id=${projectId}` });
    expect(events.json()).toMatchObject({ run_state: 'canceled', done: true });
    expect(events.json().events.filter((item: { role: string }) => ['plan', 'agent', 'error'].includes(item.role))).toEqual([]);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
