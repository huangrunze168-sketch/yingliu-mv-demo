import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';
import { sessionsDir } from '../apps/local-api/src/agent/agent-sessions.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function stubApi(handler: (body: Record<string, unknown>) => { content?: string; tool?: boolean; error?: boolean; truncated?: boolean }): Promise<{ baseUrl: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let incoming = '';
    request.on('data', chunk => { incoming += chunk.toString(); });
    request.on('end', () => {
      const body = JSON.parse(incoming) as Record<string, unknown>;
      bodies.push(body);
      const result = handler(body);
      if (result.error) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'test-secret-key 被服务商拒绝' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      if (result.tool) {
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'untrusted-call', function: { name: 'generate_for_nodes', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
        return;
      }
      const text = result.content ?? '';
      const middle = Math.max(1, Math.floor(text.length / 2));
      for (const part of [text.slice(0, middle), text.slice(middle)]) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: result.truncated ? 'length' : 'stop' }] })}\n\n`);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务没有分配端口');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, bodies };
}

it('配置第三方 OpenAI 兼容 API 后只做规划：合并流式正文，不发送工具定义或泄露密钥', async () => {
  const plan = JSON.stringify({ kind: 'plan', title: '海边纪事', direction: '写实', aspectRatio: '16:9', shots: [
    { id: 'shot-01', title: '开场', visual: '海面与夕阳', narration: '', durationSeconds: 5 },
  ] });
  const provider = await stubApi(() => ({ content: plan }));
  const root = mkdtempSync(join(tmpdir(), 'qiyin-creative-provider-'));
  roots.push(root);
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: 'API 规划画布', max_budget_cents: 0, rights_confirmed: false } }).project_id!;
  const app = buildServer(service, undefined, { workspaceRoot: root, plannerConfig: { baseUrl: provider.baseUrl, model: 'test-planner', apiKey: 'test-secret-key' } });
  try {
    const status = await app.inject({ method: 'GET', url: '/api/v1/agent/planner/status' });
    expect(status.json()).toMatchObject({ provider: 'third-party', model: 'test-planner', configured: true, connection_verified: false });
    expect(status.body).not.toContain('test-secret-key');
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const id = created.json().id as string;
    const url = `/api/v1/agent/sessions/${id}`;
    const sent = await app.inject({ method: 'POST', url: `${url}/messages`, payload: { project_id: projectId, message_id: randomUUID(), text: '请帮我规划夕阳海边短片', mode: 'creative', expected_session_revision: 0 } });
    expect(sent.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` });
      const messages = response.json().messages as Array<{ role: string; text: string }>;
      expect(messages.some(message => message.role === 'plan' && JSON.parse(message.text).title === '海边纪事'), JSON.stringify(messages)).toBe(true);
    });
    expect(provider.bodies).toHaveLength(1);
    expect(provider.bodies[0]).not.toHaveProperty('tools');
    expect(provider.bodies[0]).not.toHaveProperty('stream_options');
    expect(provider.bodies[0]?.model).toBe('test-planner');
    expect(provider.bodies[0]?.max_tokens).toBe(8192);
    expect(readFileSync(join(sessionsDir(join(root, projectId)), `${id}.json`), 'utf8')).not.toContain('test-secret-key');
    expect((service.getProject(projectId) as { image_generations: unknown[]; video_generations: unknown[] }).image_generations).toHaveLength(0);
  } finally { await app.close(); }
});

it('配置不全先拒绝；远端即使返回工具调用或回显密钥也不执行、不伪装成方案', async () => {
  const provider = await stubApi(() => ({ tool: true }));
  const root = mkdtempSync(join(tmpdir(), 'qiyin-creative-provider-'));
  roots.push(root);
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: 'API 错误画布', max_budget_cents: 0, rights_confirmed: false } }).project_id!;
  const setup = async (config: { baseUrl: string; model: string; apiKey: string }) => {
    const app = buildServer(service, undefined, { workspaceRoot: root, plannerConfig: config });
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    return { app, url: `/api/v1/agent/sessions/${created.json().id as string}` };
  };
  const broken = await setup({ baseUrl: provider.baseUrl, model: 'test-planner', apiKey: '' });
  const post = (url: string) => ({ method: 'POST' as const, url: `${url}/messages`, payload: { project_id: projectId, message_id: randomUUID(), text: '做方案', mode: 'creative', expected_session_revision: 0 } });
  try {
    const status = await broken.app.inject({ method: 'GET', url: '/api/v1/agent/planner/status' });
    expect(status.json()).toMatchObject({ provider: 'third-party', model: 'test-planner', configured: false, connection_verified: false });
    expect(status.json().reason).toBe('第三方规划 API 配置不完整：缺少 QIYIN_PLANNER_API_KEY');
    expect(status.body).not.toContain('test-secret-key');
    const refused = await broken.app.inject(post(broken.url));
    expect(refused.statusCode).toBe(422);
    expect((await broken.app.inject({ method: 'GET', url: `${broken.url}?project_id=${projectId}` })).json().messages).toEqual([]);
  } finally { await broken.app.close(); }
  const valid = await setup({ baseUrl: provider.baseUrl, model: 'test-planner', apiKey: 'test-secret-key' });
  try {
    expect((await valid.app.inject(post(valid.url))).statusCode).toBe(202);
    await vi.waitFor(async () => {
      const history = (await valid.app.inject({ method: 'GET', url: `${valid.url}?project_id=${projectId}` })).json();
      expect(history.messages.some((message: { role: string; text: string }) => message.role === 'error' && message.text.includes('未授权的工具调用'))).toBe(true);
      expect(history.messages.every((message: { role: string }) => message.role !== 'plan')).toBe(true);
    });
    expect(provider.bodies).toHaveLength(1);
    expect(provider.bodies[0]).not.toHaveProperty('tools');
  } finally { await valid.app.close(); }
});
