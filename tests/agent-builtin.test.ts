import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOLS,
  applyToolCallDelta,
  assembleToolCalls,
  describeBuiltinConfig,
  parseSseLine,
  startBuiltinRun,
  type AssembledToolCall,
} from '../apps/local-api/src/agent/agent-builtin.js';

/* ============================================================
  内置 Agent（程序自带那一路）。

  这里不连任何外部模型：下面用一个**本地假端点**按 OpenAI 的 SSE 格式回话，
  把整条循环跑通——流式正文、工具调用、工具结果回灌、最终回答、用量。
  这样验的是"我们的循环对不对"，而不是"某个厂商今天通不通"。
  ============================================================ */

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
});

/** 起一个假的 OpenAI 兼容端点；回答由 `replies` 依次给出 */
async function stubModel(replies: string[][]): Promise<{ baseUrl: string; calls: unknown[] }> {
  const calls: unknown[] = [];
  let index = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        calls.push(JSON.parse(body === '' ? '{}' : body));
      } catch {
        calls.push(body);
      }
      const lines = replies[Math.min(index, replies.length - 1)] ?? [];
      index += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const line of lines) response.write(line);
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls };
}

const sse = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;

describe('内置 Agent · 配置判定', () => {
  it('缺哪一项就说哪一项（不写成一句"未配置"）', () => {
    expect(describeBuiltinConfig(null).reason).toContain('地址');
    expect(describeBuiltinConfig({ baseUrl: '', model: 'm', apiKey: 'k' }).reason).toContain('baseUrl');
    expect(describeBuiltinConfig({ baseUrl: 'u', model: '', apiKey: 'k' }).reason).toContain('model');
    expect(describeBuiltinConfig({ baseUrl: 'u', model: 'm', apiKey: '' }).reason).toContain('API Key');
    expect(describeBuiltinConfig({ baseUrl: 'u', model: 'm', apiKey: 'k' })).toEqual({ ready: true, reason: '' });
  });
});

describe('内置 Agent · SSE 解析', () => {
  it('正文增量', () => {
    expect(parseSseLine(`data: ${JSON.stringify({ choices: [{ delta: { content: '你' } }] })}`))
      .toEqual({ toolCalls: [], content: '你' });
  });

  it('思考增量（reasoning_content）', () => {
    const parsed = parseSseLine(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] })}`);
    expect(parsed?.reasoning).toBe('想');
  });

  it('工具调用增量', () => {
    const parsed = parseSseLine(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_project', arguments: '{"pro' } }] } }],
    })}`);
    expect(parsed?.toolCalls).toEqual([{ index: 0, id: 'call_1', name: 'read_project', arguments: '{"pro' }]);
  });

  it('结束标记、空行、坏 JSON 都不当成事件', () => {
    expect(parseSseLine('data: [DONE]')).toBeNull();
    expect(parseSseLine('')).toBeNull();
    expect(parseSseLine(': keep-alive')).toBeNull();
    expect(parseSseLine('data: {不是 json')).toBeNull();
  });

  it('用量（有的厂商放在最后一个 chunk）', () => {
    const parsed = parseSseLine(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10 } })}`);
    expect(parsed?.usage).toEqual({ prompt_tokens: 10 });
  });
});

describe('内置 Agent · 工具调用拼装', () => {
  it('按 index 把分片的 arguments 拼起来（名字也可能是分片）', () => {
    const calls = new Map<number, AssembledToolCall>();
    applyToolCallDelta(calls, { index: 0, id: 'call_1', name: 'read_' });
    applyToolCallDelta(calls, { index: 0, name: 'project', arguments: '{"project' });
    applyToolCallDelta(calls, { index: 0, arguments: 'Id":"p1"}' });
    expect(assembleToolCalls(calls)).toEqual([
      { id: 'call_1', name: 'read_project', arguments: '{"projectId":"p1"}' },
    ]);
  });
});

describe('内置 Agent · 工具表', () => {
  it('只列我们真的会执行的那几个，且都带参数说明', () => {
    const names = BUILTIN_TOOLS.map((tool) => tool.function.name).sort();
    expect(names).toEqual([
      'add_canvas_nodes', 'connect_canvas_nodes', 'create_nodes_from_shots',
      'generate_for_nodes',
      'list_projects', 'read_canvas', 'read_project',
      'run_task', 'submit_command', 'write_canvas',
      /* 剧本创编那条链路的落点（写进项目的剧本工作区） */
      'write_screenplay',
    ]);
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.function.description.length).toBeGreaterThan(8);
      expect(tool.function.parameters).toBeDefined();
    }
  });

  it('没有"闸门批准"这类工具（那件事只能人做）', () => {
    const names = BUILTIN_TOOLS.map((tool) => tool.function.name);
    expect(names.some((name) => name.includes('approve') || name.includes('gate'))).toBe(false);
  });
});

describe('内置 Agent · 整条循环（本地假端点）', () => {
  it('正文流式吐出来、没有工具调用就收工，并带回用量', async () => {
    const { baseUrl, calls } = await stubModel([[
      sse({ choices: [{ delta: { content: '好' } }] }),
      sse({ choices: [{ delta: { content: '的' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    ]]);
    const events: { kind: string; text: string; streaming?: boolean; usage?: unknown }[] = [];
    const handle = startBuiltinRun({
      config: { baseUrl, model: 'stub', apiKey: 'k' },
      system: '你是测试用的 agent',
      prompt: '打个招呼',
      callTool: async () => ({ ok: true, content: '' }),
      onEvent: (event) => events.push(event),
    });
    await handle.done;
    expect(events.filter((event) => event.kind === 'message').map((event) => event.text)).toEqual(['好', '的']);
    expect(events.filter((event) => event.kind === 'message').every((event) => event.streaming === true)).toBe(true);
    expect(events.at(-1)?.kind).toBe('done');
    expect(events.at(-1)?.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3 });
    /* 第一次请求带上了工具表与系统提示 */
    const first = calls[0] as { tools?: unknown[]; messages?: { role: string }[] };
    expect(Array.isArray(first.tools)).toBe(true);
    expect(first.messages?.[0]?.role).toBe('system');
  });

  it('工具调用：先画「正在执行」，执行完画「已完成」，结果回灌后再问一次', async () => {
    const { baseUrl, calls } = await stubModel([
      [
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_project', arguments: '{"projectId":"p1"}' } }] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ],
      [
        sse({ choices: [{ delta: { content: '这个项目有 3 个镜头' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ],
    ]);
    const events: {
      kind: string; text: string; itemId?: string; phase?: string;
      failed?: boolean; pending?: boolean; toolKind?: string;
    }[] = [];
    const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
    const handle = startBuiltinRun({
      config: { baseUrl, model: 'stub', apiKey: 'k' },
      system: 's',
      prompt: '这个项目怎么样',
      callTool: async (name, args) => {
        toolCalls.push({ name, args });
        return { ok: true, content: '{"shots":3}' };
      },
      onEvent: (event) => events.push(event),
    });
    await handle.done;

    const toolEvents = events.filter((event) => event.kind === 'tool');
    /*
      画出来的**不是函数名**，是状态词：`read_project` → 「正在读取项目 / 已读取项目」。
    */
    expect(toolEvents.map((event) => `${event.text}:${event.phase}`)).toEqual([
      '正在读取项目:start', '项目已读取:done',
    ]);
    expect(toolEvents[0]?.itemId).toBe('call_1');
    /* 原始工具名仍然带在事件上（排查问题时要看得出它到底调了哪一个） */
    expect(toolEvents[0]?.toolKind).toBe('read_project');
    expect(toolCalls).toEqual([{ name: 'read_project', args: { projectId: 'p1' } }]);
    /* 第二次请求里带着工具结果 */
    const second = calls[1] as { messages?: { role: string; content?: string }[] };
    const toolMessage = second.messages?.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toBe('{"shots":3}');
    expect(events.some((event) => event.kind === 'message' && event.text.includes('3 个镜头'))).toBe(true);
  });

  it('被白名单拒了：那条工具行画成失败，拒绝理由原样回给模型', async () => {
    const { baseUrl, calls } = await stubModel([
      [
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'gate_approve', arguments: '{}' } }] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ],
      [sse({ choices: [{ delta: { content: '那一步要你自己点' } }] })],
    ]);
    const events: { kind: string; text: string; failed?: boolean }[] = [];
    const handle = startBuiltinRun({
      config: { baseUrl, model: 'stub', apiKey: 'k' },
      system: 's',
      prompt: '替我批准闸门',
      callTool: async () => ({ ok: false, content: '闸门批准是人的决定，Agent 不得代按' }),
      onEvent: (event) => events.push(event),
    });
    await handle.done;
    const done = events.find((event) => event.kind === 'tool' && event.text === 'gate_approve' && event.failed !== undefined);
    expect(done?.failed).toBe(true);
    const second = calls[1] as { messages?: { role: string; content?: string }[] };
    expect(second.messages?.find((message) => message.role === 'tool')?.content).toContain('不得代按');
  });

  it('完成那条优先用主进程给的 note（里面有真实数量），开始那条也带上数量', async () => {
    const { baseUrl } = await stubModel([
      [
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_3',
                function: {
                  name: 'add_canvas_nodes',
                  arguments: JSON.stringify({
                    projectId: 'p1',
                    nodes: [
                      { name: 'shot-01 出图', type: 'text2image' },
                      { name: 'shot-02 出图', type: 'text2image' },
                      { name: 'shot-03 出图', type: 'text2image' },
                    ],
                  }),
                },
              }],
            },
          }],
        }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ],
      [sse({ choices: [{ delta: { content: '建好了' } }] })],
    ]);
    const events: {
      kind: string; text: string; phase?: string; failed?: boolean; pending?: boolean;
      waiting?: { kind: string; nodeIds: string[]; gate?: string };
    }[] = [];
    const handle = startBuiltinRun({
      config: { baseUrl, model: 'stub', apiKey: 'k' },
      system: 's',
      prompt: '帮我把分镜建到画布上',
      callTool: async () => ({
        ok: true,
        content: '{"建好的节点":[]}',
        note: '已创建 3 个画布节点',
      }),
      onEvent: (event) => events.push(event),
    });
    await handle.done;
    const toolEvents = events.filter((event) => event.kind === 'tool');
    expect(toolEvents[0]?.text).toBe('正在编排画布（3 个节点）');
    expect(toolEvents[1]?.text).toBe('已创建 3 个画布节点');
    expect(toolEvents[1]?.failed).toBe(false);
  });

  it('"在等你点头"不算失败：pending 的那条不标 failed', async () => {
    const { baseUrl } = await stubModel([
      [
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_4',
                function: { name: 'generate_for_nodes', arguments: '{"projectId":"p1","nodeIds":["i-1"]}' },
              }],
            },
          }],
        }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ],
      [sse({ choices: [{ delta: { content: '那得你给个数' } }] })],
    ]);
    const events: {
      kind: string; text: string; phase?: string; failed?: boolean; pending?: boolean;
      waiting?: { kind: string; nodeIds: string[]; gate?: string };
    }[] = [];
    const handle = startBuiltinRun({
      config: { baseUrl, model: 'stub', apiKey: 'k' },
      system: 's',
      prompt: '去生成',
      callTool: async () => ({
        ok: false,
        content: '这一步要花钱，但这些节点都没有预算：……',
        pending: true,
        note: '待你确认预算',
        waiting: { kind: 'budget' as const, nodeIds: ['i-1'] },
      }),
      onEvent: (event) => events.push(event),
    });
    await handle.done;
    const done = events.find((event) => event.kind === 'tool' && event.phase === 'done');
    expect(done?.text).toBe('待你确认预算');
    expect(done?.pending).toBe(true);
    /* 关键：不能同时又标成失败——界面上那是一个红叉，而这里只差一句话 */
    expect(done?.failed).toBe(false);
    /* 「在等什么」也要原样带给界面：那一行要能点（填预算 / 去批准） */
    expect(done?.waiting).toEqual({ kind: 'budget', nodeIds: ['i-1'] });
  });

  it('办不成的那条画「…没能…」，不画「…已…」（同一行不能自相矛盾）', async () => {
    const { baseUrl } = await stubModel([
      [
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_7',
                function: { name: 'generate_for_nodes', arguments: '{"projectId":"p1","nodeIds":["i-1"]}' },
              }],
            },
          }],
        }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ],
      [sse({ choices: [{ delta: { content: '这个节点没挂镜头' } }] })],
    ]);
    const events: { kind: string; text: string; phase?: string; failed?: boolean }[] = [];
    const handle = startBuiltinRun({
      config: { baseUrl, model: 'stub', apiKey: 'k' },
      system: 's',
      prompt: '去生成',
      callTool: async () => ({ ok: false, content: '一个都没能生成：这个节点没有挂镜头' }),
      onEvent: (event) => events.push(event),
    });
    await handle.done;
    const done = events.find((event) => event.kind === 'tool' && event.phase === 'done');
    expect(done?.text).toBe('没能生成');
    expect(done?.failed).toBe(true);
  });

  it('模型接口报错时如实说出来，不装作答完了', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"invalid api key"}}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const events: { kind: string; text: string }[] = [];
    const handle = startBuiltinRun({
      config: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stub', apiKey: 'bad' },
      system: 's',
      prompt: '在吗',
      callTool: async () => ({ ok: true, content: '' }),
      onEvent: (event) => events.push(event),
    });
    await handle.done;
    expect(events[0]?.kind).toBe('error');
    expect(events[0]?.text).toContain('401');
    expect(events[0]?.text).toContain('invalid api key');
    expect(events.at(-1)?.kind).toBe('done');
  });
});

/*
  生成期间的心跳：工具层每跑完一镜调一次进度，**同一行就地改字**。

  为什么用 itemId 认：面板（data/agentMessages.ts）把同 id 的两条并成一行，
  所以这里再发一条 `phase:'start'` 就是"这一行更新了"，不会多出一行。
  真后端一镜几十秒到几分钟，没有这条推进，用户分不清是在跑还是卡死。
*/
describe('内置 Agent · 逐镜进度画到那一行上', () => {
  it('每报一次进度就更新同一行（itemId 不变、文案是第几镜/共几镜）', async () => {
    const { baseUrl } = await stubModel([
      [
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_prog',
                function: { name: 'generate_for_nodes', arguments: '{"projectId":"p1","nodeIds":["i-1","i-2"],"costCents":5}' },
              }],
            },
          }],
        }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ],
      [sse({ choices: [{ delta: { content: '出图完成' } }] })],
    ]);
    const events: {
      kind: string; text: string; itemId?: string; phase?: string;
    }[] = [];
    const handle = startBuiltinRun({
      config: { baseUrl, model: 'stub', apiKey: 'k' },
      system: 's',
      prompt: '给这两镜出图',
      callTool: async (_name, _args, onProgress) => {
        /* 工具层每跑完一镜调一次（真实现里由生成服务在逐镜循环里调） */
        onProgress({ done: 1, total: 2, shotId: 'shot-01', ok: true });
        onProgress({ done: 2, total: 2, shotId: 'shot-02', ok: false });
        return { ok: true, content: '{}', note: '已生成 1 张图片' };
      },
      onEvent: (event) => events.push(event),
    });
    await handle.done;

    const toolEvents = events.filter((event) => event.kind === 'tool');
    /* 开始一条 → 两次进度 → 收口一条，**itemId 全是同一个** */
    expect(toolEvents.map((event) => event.text)).toEqual([
      '正在生成（2 个节点）',
      '正在生成（1/2 镜）',
      '正在生成（2/2 镜）',
      '已生成 1 张图片',
    ]);
    expect(toolEvents.every((event) => event.itemId === 'call_prog')).toBe(true);
  });
});
