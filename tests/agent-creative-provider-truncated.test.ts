import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

it('流式规划若被长度限制截断，只记录错误，不将片段包装为成功答复', async () => {
  const remote = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '这只是半句话' } }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address();
  if (!address || typeof address === 'string') throw new Error('测试服务没有分配端口');
  const root = mkdtempSync(join(tmpdir(), 'qiyin-creative-truncated-'));
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '流式截断测试', max_budget_cents: 0, rights_confirmed: false } }).project_id!;
  const app = buildServer(service, undefined, { workspaceRoot: root, plannerConfig: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-planner', apiKey: 'test-key' } });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const url = `/api/v1/agent/sessions/${created.json().id as string}`;
    expect((await app.inject({ method: 'POST', url: `${url}/messages`, payload: { project_id: projectId, message_id: randomUUID(), text: '请规划', mode: 'creative', expected_session_revision: 0 } })).statusCode).toBe(202);
    await vi.waitFor(async () => {
      const history = (await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` })).json() as { messages: Array<{ role: string; text: string }> };
      expect(history.messages.some(message => message.role === 'error' && message.text.includes('没有正常结束'))).toBe(true);
      expect(history.messages.some(message => message.role === 'agent' || message.role === 'plan')).toBe(false);
    });
  } finally {
    await app.close();
    await new Promise<void>(resolve => remote.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
