import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { startCreativeProviderRun } from '../apps/local-api/src/agent/creative-provider.js';
import type { AgentEvent } from '../apps/local-api/src/agent/agent-runner.js';

it('第三方规划流挂起时停止并明确标记计费结果未知，不保存半成品答复', async () => {
  const remote = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '未完成的方案片段' } }] })}\n\n`);
    // 刻意保持连接，不发送 finish_reason，模拟服务商的流式接口挂起。
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address();
  if (!address || typeof address === 'string') throw new Error('测试服务没有分配端口');
  const events: AgentEvent[] = [];
  const run = startCreativeProviderRun({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'stub', apiKey: 'test-key' }, '写方案', event => events.push(event), 120);
  try {
    await vi.waitFor(() => expect(events.some(event => event.kind === 'done')).toBe(true), { timeout: 2000 });
    expect(events.some(event => event.kind === 'error' && event.text.includes('计费状态未获核实'))).toBe(true);
    expect(events.some(event => event.kind === 'message')).toBe(false);
  } finally {
    run.cancel();
    remote.closeAllConnections();
    await new Promise<void>(resolve => remote.close(() => resolve()));
  }
});
