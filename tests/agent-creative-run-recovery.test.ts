import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

it('规划进程重启后留下持久未知状态与一次错误，不自动重复请求', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-recovery-'));
  const service = new ProjectService(openDatabase(':memory:'));
  const project = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '规划重启', max_budget_cents: 0, rights_confirmed: true } });
  const projectId = project.project_id!;
  let calls = 0;
  const runner = () => { calls++; return { runId: randomUUID(), cancel: () => {} }; };
  const first = buildServer(service, undefined, { workspaceRoot: root, startAgent: runner });
  let second: ReturnType<typeof buildServer> | undefined;
  try {
    const created = await first.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const id = created.json().id as string;
    const base = `/api/v1/agent/sessions/${id}`;
    const messageId = randomUUID();
    const started = await first.inject({ method: 'POST', url: `${base}/messages`, payload: { project_id: projectId, message_id: messageId, mode: 'creative', text: '拍一个短片', expected_session_revision: 0 } });
    expect(started.statusCode).toBe(202);
    expect(calls).toBe(1);
    await first.close();

    second = buildServer(service, undefined, { workspaceRoot: root, startAgent: runner });
    const unsafeRepeat = await second.inject({ method: 'POST', url: `${base}/messages`, payload: { project_id: projectId, message_id: randomUUID(), mode: 'creative', text: '不检查就再做一遍', expected_session_revision: 1 } });
    expect(unsafeRepeat.json().error.code).toBe('PREVIOUS_RUN_UNVERIFIED');
    expect(calls).toBe(1);
    const recovered = await second.inject({ method: 'GET', url: `${base}/events?project_id=${projectId}&after=1` });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ run_state: 'unknown', needs_review: true, done: true, run_id: null });
    expect(recovered.json().events).toHaveLength(1);
    expect(recovered.json().events[0]).toMatchObject({ role: 'error' });
    expect(recovered.json().events[0].text).toContain('计费状态未经核实');
    const repeat = await second.inject({ method: 'GET', url: `${base}/events?project_id=${projectId}&after=1` });
    expect(repeat.json().events).toHaveLength(1);
    const blocked = await second.inject({ method: 'POST', url: `${base}/messages`, payload: { project_id: projectId, message_id: randomUUID(), mode: 'creative', text: '上一轮还未知', expected_session_revision: 2 } });
    expect(blocked.json().error.code).toBe('PREVIOUS_RUN_NEEDS_REVIEW');
    const ackUrl = `${base}/runs/${messageId}/acknowledge`;
    expect((await second.inject({ method: 'POST', url: ackUrl, payload: { project_id: projectId } })).statusCode).toBe(422);
    expect((await second.inject({ method: 'POST', url: ackUrl, payload: { project_id: projectId, confirm_unknown: true } })).json()).toMatchObject({ needs_review: false, run_state: 'unknown' });
    const afterReview = await second.inject({ method: 'GET', url: `${base}/events?project_id=${projectId}&after=2` });
    expect(afterReview.json().needs_review).toBe(false);
    const continued = await second.inject({ method: 'POST', url: `${base}/messages`, payload: { project_id: projectId, message_id: randomUUID(), mode: 'creative', text: '这是确认后的新方案', expected_session_revision: 2 } });
    expect(continued.statusCode).toBe(202);
    expect(calls).toBe(2);
  } finally {
    await second?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
