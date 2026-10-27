import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

it('规划服务商拒绝时隐藏回显密钥，失败不能存成助手成功答复', async () => {
  const secret = 'secret-never-in-history';
  const remote = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `API Key ${secret} 无效` } }));
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address();
  if (!address || typeof address === 'string') throw new Error('测试服务没有分配端口');
  const root = mkdtempSync(join(tmpdir(), 'qiyin-creative-error-'));
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '错误不冒充成功', max_budget_cents: 0, rights_confirmed: false } }).project_id!;
  const app = buildServer(service, undefined, { workspaceRoot: root, plannerConfig: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-planner', apiKey: secret } });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const url = `/api/v1/agent/sessions/${created.json().id as string}`;
    expect((await app.inject({ method: 'POST', url: `${url}/messages`, payload: { project_id: projectId, message_id: randomUUID(), text: '给我分镜', mode: 'creative', expected_session_revision: 0 } })).statusCode).toBe(202);
    await vi.waitFor(async () => {
      const history = (await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` })).json() as { messages: Array<{ role: string; text: string }> };
      expect(history.messages.some(message => message.role === 'error' && message.text.includes('401'))).toBe(true);
      expect(history.messages.some(message => message.role === 'agent' || message.role === 'plan')).toBe(false);
      expect(JSON.stringify(history.messages)).not.toContain(secret);
    });
  } finally {
    await app.close();
    await new Promise<void>(resolve => remote.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
