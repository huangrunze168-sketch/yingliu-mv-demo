import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('Agent 对话创建、续聊、事件增量与刷新恢复使用同一份项目会话', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-agent-chat-'));
  roots.push(root);
  const service = new ProjectService(openDatabase(':memory:'));
  const project = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '对话测试', max_budget_cents: 0, rights_confirmed: true } });
  const projectId = project.project_id!;
  const prompts: string[] = [];
  const app = buildServer(service, undefined, {
    workspaceRoot: root,
    startAgent: ({ prompt, onEvent }) => {
      prompts.push(prompt);
      const runId = randomUUID();
      onEvent({ runId, kind: 'message', text: `答复：${prompt}`, at: Date.now() });
      onEvent({ runId, kind: 'done', text: '已完成', at: Date.now() + 1 });
      return { runId, cancel: () => {} };
    },
  });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };
    const url = `/api/v1/agent/sessions/${id}`;
    const messageId = randomUUID();
    const first = await app.inject({ method: 'POST', url: `${url}/messages`, payload: { project_id: projectId, message_id: messageId, text: '给我分镜建议', expected_session_revision: 0 } });
    expect(first.statusCode).toBe(202);
    const repeated = await app.inject({ method: 'POST', url: `${url}/messages`, payload: { project_id: projectId, message_id: messageId, text: '给我分镜建议', expected_session_revision: 0 } });
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json().duplicate).toBe(true);
    expect(prompts).toEqual(['给我分镜建议']);
    const events = await app.inject({ method: 'GET', url: `${url}/events?project_id=${projectId}&after=0` });
    expect(events.json().events.map((item: { role: string }) => item.role)).toContain('agent');
    expect(events.json().done).toBe(true);
    const history = await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` });
    expect(history.json().title).toBe('给我分镜建议');
    expect(history.json().messages.some((item: { text: string }) => item.text === '答复：给我分镜建议')).toBe(true);
    const list = await app.inject({ method: 'GET', url: `/api/v1/agent/sessions?project_id=${projectId}` });
    expect(list.json()[0].id).toBe(id);
    const stale = await app.inject({ method: 'POST', url: `${url}/messages`, payload: { project_id: projectId, message_id: randomUUID(), text: '再说说', expected_session_revision: 0 } });
    expect(stale.statusCode).toBe(409);
    expect(prompts).toHaveLength(1);
  } finally { await app.close(); }
});

it('模型不兼容时只保留一次可操作错误，不把日志或进程状态写成对话', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-agent-failure-'));
  roots.push(root);
  const service = new ProjectService(openDatabase(':memory:'));
  const project = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '失败记录测试', max_budget_cents: 0, rights_confirmed: true } });
  const projectId = project.project_id!;
  const app = buildServer(service, undefined, {
    workspaceRoot: root,
    startAgent: ({ onEvent }) => {
      const runId = randomUUID();
      const send = (kind: 'started' | 'note' | 'error' | 'done' | 'tool', text: string) => onEvent({ runId, kind, text, at: Date.now() });
      send('started', 'Codex CLI 已启动');
      send('note', '会话已建立：sample-thread');
      send('note', 'failed to load models cache');
      send('tool', '工具开始执行：web_search');
      send('error', '本机 Codex CLI 版本过旧，无法使用当前模型 gpt-5.6-sol。请更新 Codex CLI 后重试。');
      send('error', '本机 Codex CLI 版本过旧，无法使用当前模型 gpt-5.6-sol。请更新 Codex CLI 后重试。');
      send('done', '进程退出，退出码 1');
      return { runId, cancel: () => {} };
    },
  });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const id = created.json().id as string;
    const url = `/api/v1/agent/sessions/${id}`;
    const sent = await app.inject({ method: 'POST', url: `${url}/messages`, payload: { project_id: projectId, message_id: randomUUID(), text: '制作分镜', expected_session_revision: 0 } });
    expect(sent.statusCode).toBe(202);
    const result = await app.inject({ method: 'GET', url: `${url}/events?project_id=${projectId}&after=0` });
    const events = result.json().events as Array<{ role: string; text: string }>;
    expect(events.map(event => event.role)).toEqual(['user', 'tool', 'error']);
    expect(events.filter(event => event.role === 'agent')).toEqual([]);
    expect(events.filter(event => event.role === 'error')).toHaveLength(1);
    expect(events.map(event => event.text).join(' ')).not.toMatch(/已启动|会话已建立|models cache|退出码/);
    expect(result.json().done).toBe(true);
  } finally { await app.close(); }
});
