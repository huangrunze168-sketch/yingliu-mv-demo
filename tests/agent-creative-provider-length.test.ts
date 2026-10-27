import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { startCreativeProviderRun } from '../apps/local-api/src/agent/creative-provider.js';
import type { AgentEvent } from '../apps/local-api/src/agent/agent-runner.js';

it('超长规划回复不截断成假成功或不完整 JSON', async () => {
  const remote = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"kind":"plan","visual":"' + '长'.repeat(8000) } }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address();
  if (!address || typeof address === 'string') throw new Error('测试服务没有分配端口');
  const events: AgentEvent[] = [];
  try {
    startCreativeProviderRun({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'stub', apiKey: 'test-key' }, '写方案', event => events.push(event));
    await vi.waitFor(() => expect(events.some(event => event.kind === 'done')).toBe(true));
    expect(events.some(event => event.kind === 'error' && event.text.includes('未截断冒充完整方案'))).toBe(true);
    expect(events.some(event => event.kind === 'message')).toBe(false);
  } finally {
    await new Promise<void>(resolve => remote.close(() => resolve()));
  }
});
