import { describe, expect, it } from 'vitest';
import {
  isProtocolLine,
  parseClaudeLine,
  parseCodexLine,
  parseDshLine,
  formatAgentFailure,
  type AgentEventKind,
} from '../apps/local-api/src/agent/agent-runner.js';

/* ============================================================
   前置 Agent 的事件解析。

   为什么盯这两条：agent 的输出是**外部协议**，我们只是消费者。
   CLI 换个版本就可能改字段名，改坏了界面表现是「Agent 一句话都不说」——
   那种静默失败最难查。所以把已经实测到的真实报文钉在测试里，
   协议一变先在这里红，而不是等用户报「点了没反应」。

   下面的报文都是**实测抓到的原样**（codex 走 --json，claude 走 --output-format stream-json）。
   ============================================================ */

/*
  收集器要把**第四段**（工具调用的身份与阶段）一起收下来。
  漏掉它的话，那几条关于 phase / itemId / toolKind 的用例会永远"看不见"这些字段，
  而失败的样子是 `undefined`——看不出是解析没做还是测试没接。
*/
interface CollectedEvent {
  kind: AgentEventKind;
  text: string;
  usage?: Record<string, unknown>;
  itemId?: string;
  phase?: 'start' | 'done';
  toolKind?: string;
  failed?: boolean;
}

function collect(): {
  events: CollectedEvent[];
  emit: (kind: AgentEventKind, text: string, usage?: Record<string, unknown>, extra?: Omit<CollectedEvent, 'kind' | 'text' | 'usage'>) => void;
} {
  const events: CollectedEvent[] = [];
  return {
    events,
    emit: (kind, text, usage, extra) => events.push({
      kind,
      text,
      ...(usage === undefined ? {} : { usage }),
      ...(extra ?? {}),
    }),
  };
}

describe('DSH headless 事件解析', () => {
  it('将思考、正文与工具生命周期映射为小QTV 事件，并忽略重复 final', () => {
    const { events, emit } = collect();
    const lines = [
      { type: 'session', sessionId: 'session-1', cwd: 'C:/workspace' },
      { type: 'thinking', text: '先分析创作要求' },
      { type: 'tool_call', callId: 'call-1', tool: 'pwsh', input: { command: 'Get-ChildItem', description: '读取项目文件' } },
      { type: 'tool_result', callId: 'call-1', status: 'completed', result: 'ok' },
      { type: 'text', text: '分析完成' },
      { type: 'final', text: '分析完成' },
    ];
    for (const line of lines) expect(parseDshLine(JSON.stringify(line), emit)).toBe(true);
    expect(events).toEqual([
      { kind: 'reasoning', text: '先分析创作要求' },
      { kind: 'tool', text: '读取项目文件', itemId: 'call-1', phase: 'start', toolKind: 'pwsh' },
      { kind: 'tool', text: '工具调用完成', itemId: 'call-1', phase: 'done', toolKind: 'dsh_tool', failed: false },
      { kind: 'message', text: '分析完成' },
    ]);
  });

  it('将 DSH error 归一为可操作错误', () => {
    const { events, emit } = collect();
    parseDshLine(JSON.stringify({ type: 'error', error: { message: 'authentication_failed' } }), emit);
    expect(events).toEqual([{ kind: 'error', text: '模型服务未授权，请检查 Agent 登录状态或模型服务凭据。' }]);
  });
});

describe('codex 事件解析', () => {
  it('整条 JSON 里带着沙箱报错文本时，仍然算协议行（不能当噪声丢掉）', () => {
    /*
      真机踩到的丢事件：命令失败时 codex 把沙箱报错写进 aggregated_output，
      表现是：那几条动作永远停在「正在执行」。
      这条用例把"判据必须先看是不是 JSON"钉住。
    */
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'command_execution',
        command: 'ls',
        status: 'failed',
        aggregated_output: 'CreateProcessWithLogonW failed: 2',
      },
    });
    expect(isProtocolLine(line)).toBe(true);
    /* 顺带说明：旧的写法确实会把它当成沙箱噪声 */
    expect(/CreateProcessWithLogonW failed|windows sandbox/i.test(line)).toBe(true);
    /* 而且它照样能解析成一条"失败"的动作 */
    const { events, emit } = collect();
    parseCodexLine(line, emit);
    expect(events[0]).toMatchObject({ kind: 'tool', phase: 'done', failed: true });
  });

  it('agent_message 画成 Agent 的话', () => {
    const { events, emit } = collect();
    const handled = parseCodexLine(
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '就绪' } }),
      emit,
    );
    expect(handled).toBe(true);
    expect(events).toEqual([{ kind: 'message', text: '就绪' }]);
  });

  it('真实八行失败记录中的警告不是助手消息，模型 400 归一为一条可操作提示', () => {
    const { events, emit } = collect();
    const modelError = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." } });
    const stdout = [
      { type: 'thread.started', thread_id: 'sample-thread' },
      { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'error', message: 'Exceeded skills context budget of 2%. All skill descriptions were removed.' } },
      { type: 'error', message: modelError },
      { type: 'turn.failed', error: { message: modelError } },
    ];
    // 实际 NDJSON 的另外两行是 stderr 启动提示／缓存报错，不属于 JSON 协议。
    for (const item of stdout) parseCodexLine(JSON.stringify(item), emit);
    expect(events.filter(event => event.kind === 'message' || event.kind === 'note')).toEqual([]);
    expect(events.filter(event => event.kind === 'error')).toHaveLength(2);
    expect(events[0]?.text).toContain('Codex CLI 版本过旧');
    expect(events[1]?.text).toBe(events[0]?.text);
    expect(formatAgentFailure(modelError)).not.toContain('invalid_request_error');
  });

  it('turn.completed 不在进程退出前宣告完成', () => {
    const { events, emit } = collect();
    parseCodexLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 41641, output_tokens: 3 } }), emit);
    expect(events).toEqual([]);
  });

  it('同一条 item 的 started/updated 不重复画', () => {
    const { events, emit } = collect();
    parseCodexLine(JSON.stringify({ type: 'item.started', item: { type: 'agent_message', text: '就绪' } }), emit);
    parseCodexLine(JSON.stringify({ type: 'item.updated', item: { type: 'agent_message', text: '就绪' } }), emit);
    expect(events).toEqual([]);
  });

  it('工具调用的 started 与 completed 各来一条，靠同一个 itemId 认亲', () => {
    /*
      这是实测形状（kernel-workspaces/…/.qiyin-agent/*.ndjson）：
      started 里带 status:"in_progress"，completed 里带 exit_code。
      界面要靠 itemId 把那一行就地改成"已完成"，所以这里把身份钉住。
    */
    const { events, emit } = collect();
    parseCodexLine(JSON.stringify({
      type: 'item.started',
      item: { id: 'item_2', type: 'command_execution', command: 'ls -la', status: 'in_progress' },
    }), emit);
    parseCodexLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_2', type: 'command_execution', command: 'ls -la', exit_code: 0, status: 'completed' },
    }), emit);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'tool', phase: 'start', itemId: 'item_2', toolKind: 'command' });
    expect(events[1]).toMatchObject({ kind: 'tool', phase: 'done', itemId: 'item_2', failed: false });
  });

  it('命令前面那串 pwsh 壳会被剥掉（面板只有 400 宽）', () => {
    const { events, emit } = collect();
    parseCodexLine(JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'command_execution',
        command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'node .qiyin-agent/qiyin-tool.mjs tools\'',
        exit_code: 0,
      },
    }), emit);
    /* 连末尾那个引号也要干净：命令行是 `-Command 'node … tools'` */
    expect(events[0]?.text).toBe('node .qiyin-agent/qiyin-tool.mjs tools');
    expect(events[0]?.text).not.toContain('pwsh.exe');
  });

  it('非 0 退出码标成失败（界面上那一行要变色）', () => {
    const { events, emit } = collect();
    parseCodexLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_3', type: 'command_execution', command: 'false', exit_code: 1 },
    }), emit);
    expect(events[0]).toMatchObject({ phase: 'done', failed: true });
  });

  it('mcp 调用写成 server.tool（只写 server 的话，同一个 server 下的都一样）', () => {
    const { events, emit } = collect();
    parseCodexLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_6', type: 'mcp_tool_call', server: 'node_repl', tool: 'js' },
    }), emit);
    expect(events[0]?.text).toBe('node_repl.js');
    expect(events[0]?.toolKind).toBe('mcp');
  });

  it('非 JSON 行交回调用方（CLI 的普通提示要照实显示）', () => {
    const { events, emit } = collect();
    const handled = parseCodexLine('Reading additional input from stdin...', emit);
    expect(handled).toBe(false);
    expect(events).toEqual([]);
  });

  it('未知 item 类型也画成动作，不静默丢弃', () => {
    const { events, emit } = collect();
    parseCodexLine(
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls -la' } }),
      emit,
    );
    expect(events[0]?.kind).toBe('tool');
    expect(events[0]?.text).toContain('ls -la');
  });
});

describe('claude 事件解析', () => {
  it('assistant 的 text 块画成 Agent 的话', () => {
    const { events, emit } = collect();
    parseClaudeLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '就绪' }] } }),
      emit,
    );
    expect(events).toEqual([{ kind: 'message', text: '就绪' }]);
  });

  it('未登录会被原样带出来（实测报文就是这个形状）', () => {
    const { events, emit } = collect();
    parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
      }),
      emit,
    );
    expect(events).toEqual([
      { kind: 'message', text: 'Not logged in · Please run /login' },
      { kind: 'error', text: 'authentication_failed' },
    ]);
  });

  it('result 是错误时先报错再结束', () => {
    const { events, emit } = collect();
    parseClaudeLine(
      JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login', usage: { output_tokens: 0 } }),
      emit,
    );
    expect(events.map((event) => event.kind)).toEqual(['error', 'done']);
  });

  it('tool_use 块画成动作', () => {
    const { events, emit } = collect();
    parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }), emit);
    expect(events).toEqual([{ kind: 'tool', text: '调用工具：Bash' }]);
  });
});
