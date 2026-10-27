import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('创作对话先问必要问题，再保存可编辑方案；确认不伪造生成任务或预览', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-creative-'));
  roots.push(root);
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '分镜项目', max_budget_cents: 0, rights_confirmed: true } }).project_id!;
  const prompts: string[] = [];
  const plan = { kind: 'plan', title: '日落之城', direction: '温暖纪实短片', aspectRatio: '9:16', shots: [{ id: 'shot-01', title: '抵达', visual: '夕阳下的街角，远景', narration: '', durationSeconds: 5 }] };
  const app = buildServer(service, undefined, { workspaceRoot: root, startAgent: ({ prompt, onEvent }) => {
    prompts.push(prompt);
    const runId = randomUUID();
    onEvent({ runId, kind: 'started', text: 'Codex CLI 已启动', at: Date.now() });
    onEvent({ runId, kind: 'message', text: prompts.length === 1 ? '请问视频希望多长时间？' : JSON.stringify(plan), at: Date.now() });
    onEvent({ runId, kind: 'done', text: '本轮结束', at: Date.now() });
    return { runId, cancel: () => {} };
  } });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const url = `/api/v1/agent/sessions/${created.json().id as string}`;
    const send = async (text: string, revision: number) => app.inject({ method: 'POST', url: `${url}/messages`, payload: { project_id: projectId, message_id: randomUUID(), text, expected_session_revision: revision, mode: 'creative' } });
    expect((await send('拍摄日落', 0)).statusCode).toBe(202);
    const clarified = (await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` })).json();
    expect(clarified.messages.map((item: { role: string }) => item.role)).toEqual(['user', 'agent']);
    expect(clarified.messages[1].text).toBe('请问视频希望多长时间？');
    expect((await send('5 秒', clarified.session_revision)).statusCode).toBe(202);
    const snapshot = (await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` })).json();
    expect(snapshot.messages.map((item: { role: string }) => item.role)).toEqual(['user', 'agent', 'user', 'plan']);
    expect(prompts[1]).toContain('拍摄日落');
    expect(prompts[1]).toContain('5 秒');
    const planId = snapshot.messages.at(-1).id as string;
    const invalid = await app.inject({ method: 'PUT', url: `${url}/plan`, payload: { project_id: projectId, plan_id: planId, plan: { kind: 'plan' }, expected_session_revision: snapshot.session_revision } });
    expect(invalid.statusCode).toBe(422);
    const edited = { ...plan, title: '日落城记', shots: [{ ...plan.shots[0], visual: '日落的街角，暖色近景' }] };
    const saved = await app.inject({ method: 'PUT', url: `${url}/plan`, payload: { project_id: projectId, plan_id: planId, plan: edited, expected_session_revision: snapshot.session_revision } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().plan.role).toBe('plan');
    expect(JSON.parse(saved.json().plan.text).title).toBe('日落城记');
    const stale = await app.inject({ method: 'POST', url: `${url}/plan/approve`, payload: { project_id: projectId, plan_id: planId, expected_session_revision: saved.json().session_revision } });
    expect(stale.statusCode).toBe(409);
    const approved = await app.inject({ method: 'POST', url: `${url}/plan/approve`, payload: { project_id: projectId, plan_id: saved.json().plan.id, expected_session_revision: saved.json().session_revision } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().approved).toBe(true);
    expect(approved.json().generation_ready).toBe(false);
    expect(approved.json().project_bound).toBe(true);
    const bound = service.getProject(projectId) as { shot_fields: { shots: Array<{ shot_id: string; duration_ms: number; replacement: string; author: string }> } };
    expect(bound.shot_fields.shots[0]).toMatchObject({ shot_id: 'shot-01', duration_ms: 5000, replacement: '日落的街角，暖色近景', author: `agent:${created.json().id as string}` });
    const latest = (await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` })).json();
    expect(latest.messages.at(-1).role).toBe('approval');
    expect(latest.messages.some((item: { role: string }) => item.role === 'preview' || item.role === 'progress')).toBe(false);
    const repeated = await app.inject({ method: 'POST', url: `${url}/plan/approve`, payload: { project_id: projectId, plan_id: saved.json().plan.id, expected_session_revision: saved.json().session_revision } });
    expect(repeated.json().session_revision).toBe(latest.session_revision);
  } finally { await app.close(); }
});
