/* ============================================================
  小QTV · 前置 Agent 的第二条通道：ACP（Agent Client Protocol）
  ------------------------------------------------------------
  为什么要有这条：Hermes Agent 的 `-z`（一次性）实测**中间一个字节都不给**——
  68 秒的空白之后一次性吐一句答案；而它另一条路 `hermes acp` 是 JSON-RPC over stdio，
  实测会逐条推事件：

    initialize / session/new 的响应（能力声明里带 loadSession、fork、list、resume）
    session/update · available_commands_update
    session/update · usage_update        { size, used }
    session/update · session_info_update { title }
    session/update · agent_thought_chunk { content: { type:'text', text } }   ← 思考过程
    session/update · agent_message_chunk { content: { type:'text', text } }   ← 正文（分块）
    session/update · tool_call           { toolCallId, kind:'execute', title:'terminal: node -v' }
    session/prompt 的响应                { stopReason, usage:{ inputTokens, outputTokens, … } }

  这套东西正好对上我们面板已有的那几种事件（消息 / 思考 / 工具两态 / 用量），
  所以这一层只做**映射**，不新造一套 UI。

  两处照规矩做的事：
    · 项目简报作为**独立的一段 prompt 内容块**发过去，不跟用户那句话粘成一段
      （codex 那条路是用 stdin 分开的，这里用 ACP 的多内容块达到同样效果）；
    · 参考帧按 ACP 的 image 块发（它能力声明里 `promptCapabilities.image: true`），
      不是塞个文件路径让它自己猜。
  ============================================================ */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { AgentEventKind } from './agent-runner.js';

/** 映射结果：一条 ACP 事件 → 我们面板的一种事件 */
interface AcpMapped {
  kind: AgentEventKind;
  text: string;
  itemId?: string;
  phase?: 'start' | 'done';
  toolKind?: string;
  failed?: boolean;
  /** 在等人（要授权 / 要确认），不是失败——见 mapAcpUpdate 里那一节 */
  pending?: boolean;
  /** 分块推来的正文/思考：界面要把它们接到上一条上，而不是各占一行 */
  streaming?: boolean;
  usage?: Record<string, unknown>;
}

/** 从 ACP 的 content 结构里抠出纯文本（结构有两种：单个 block 或数组） */
function textOfContent(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) return content.map((item) => textOfContent(item)).join('');
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    const node = content as Record<string, unknown>;
    if (typeof node.text === 'string') return node.text;
    if (node.content !== undefined) return textOfContent(node.content);
  }
  return '';
}

/**
 * `session/update` 通知 → 我们的事件。
 *
 * 认不出的 `sessionUpdate` 一律返回 null（**不瞎猜**）：
 * ACP 还在长，多出来的类型画成"某某更新"只会污染对话。
 */
function mapAcpUpdate(update: Record<string, unknown>): AcpMapped | null {
  const kind = String(update.sessionUpdate ?? '');
  if (kind === 'agent_message_chunk') {
    const text = textOfContent(update.content);
    return text === '' ? null : { kind: 'message', text, streaming: true };
  }
  if (kind === 'agent_thought_chunk') {
    const text = textOfContent(update.content);
    return text === '' ? null : { kind: 'reasoning', text, streaming: true };
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const itemId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    const status = String(update.status ?? '');
    /*
      工具的两态：
        tool_call        刚发起（实测没有 status 字段）→ 正在执行
        tool_call_update 带 status（completed / failed）→ 收口
      没有 id 就不画：没有身份的工具行在界面上既不能合并也不能收口，
      留着只会变成一条永远"正在执行"的僵尸行。

      `status === 'pending'` 是**第三态**：这一条在等用户点头（要授权 / 要确认）。
      它不能画成"失败"——那是"这条路走不通"的意思，而这条只差一句同意。
    */
    if (itemId === undefined) return null;
    const title = String(update.title ?? '').trim();
    const failed = status === 'failed' || status === 'cancelled';
    const pending = status === 'pending';
    const done = kind === 'tool_call_update' || status === 'completed' || failed || pending;
    return {
      kind: 'tool',
      text: title === '' ? '（未命名的工具调用）' : title,
      itemId,
      phase: done ? 'done' : 'start',
      toolKind: String(update.kind ?? 'tool'),
      failed,
      ...(pending ? { pending: true } : {}),
    };
  }
  return null;
}

/** `session/prompt` 的响应 → 结束事件（带这一轮的用量） */
function mapAcpPromptResult(result: Record<string, unknown>): AcpMapped {
  const usage = (result.usage ?? {}) as Record<string, unknown>;
  const stop = String(result.stopReason ?? '');
  return {
    kind: 'done',
    text: stop === '' ? '本轮结束' : `本轮结束（${stop}）`,
    ...(Object.keys(usage).length === 0 ? {} : { usage }),
  };
}

export interface AcpRunHandle {
  runId: string;
  cancel: () => void;
}

export interface StartAcpRunOptions {
  command: string;
  cwd: string;
  prompt: string;
  /** 项目简报（作为独立内容块发过去） */
  context?: string | undefined;
  /** 随本轮附上的图片（绝对路径） */
  images?: readonly string[] | undefined;
  onEvent: (mapped: AcpMapped) => void;
  /** CLI 的普通输出（stderr 之类），交给上层决定要不要画 */
  onLog?: ((line: string) => void) | undefined;
  /** 起不来或协议错的时候报一句人话 */
  onFail: (message: string) => void;
}

interface Waiter {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/**
 * 起一轮 ACP 会话并把它跑完。
 *
 * 顺序（照协议）：initialize → session/new → session/prompt；
 * 中途所有 `session/update` 通知映射成事件往外推；prompt 的响应到了就收工。
 *
 * `--accept-hooks` 是**必需**的：没有它，遇到没见过的 shell 钩子时
 * CLI 会等你按 TTY 的 y/n——而我们这里没有 TTY，那一轮会永远挂着。
 */
export function startAcpRun(options: StartAcpRunOptions): AcpRunHandle {
  const runId = `acp-${Date.now().toString(36)}`;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.command, ['acp', '--accept-hooks'], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    options.onFail(`起不了 ${options.command}：${(error as Error).message}`);
    return { runId, cancel: () => undefined };
  }

  let nextId = 1;
  const pending = new Map<number, Waiter>();
  let buffer = '';
  let finished = false;
  let sessionId: string | null = null;

  const finish = (message: string) => {
    if (finished) return;
    finished = true;
    options.onFail(message);
  };

  const send = (message: Record<string, unknown>) => {
    if (child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };

  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  };

  const handleLine = (line: string) => {
    const text = line.trim();
    if (text === '') return;
    if (!text.startsWith('{')) {
      options.onLog?.(text);
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      options.onLog?.(text);
      return;
    }
    /* 响应 */
    if (payload.id !== undefined && pending.has(Number(payload.id))) {
      const id = Number(payload.id);
      const waiter = pending.get(id)!;
      pending.delete(id);
      if (payload.error !== undefined) {
        waiter.reject(new Error(JSON.stringify(payload.error).slice(0, 300)));
      } else {
        waiter.resolve((payload.result ?? {}) as Record<string, unknown>);
      }
      return;
    }
    /* 通知 */
    if (payload.method === 'session/update') {
      const params = (payload.params ?? {}) as Record<string, unknown>;
      const update = (params.update ?? {}) as Record<string, unknown>;
      const mapped = mapAcpUpdate(update);
      if (mapped !== null) options.onEvent(mapped);
      return;
    }
    /* 会话里让客户端去读文件之类的请求：我们没实现，按协议回一个"不支持"，
       而不是不吭声——不吭声会让对面一直等。 */
    if (payload.method !== undefined && payload.id !== undefined) {
      send({ id: payload.id, error: { code: -32601, message: `xiaoq-tv 未实现 ${String(payload.method)}` } });
    }
  };

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      handleLine(line);
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      const text = line.trim();
      if (text !== '') options.onLog?.(text);
    }
  });
  child.on('error', (error) => finish(`Hermes ACP 起不来：${error.message}`));
  child.on('close', (code) => finish(`Hermes ACP 提前退出（退出码 ${code}）`));

  void (async () => {
    try {
      await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'xiaoq-tv', version: '0.3.0' },
      });
      const session = await request('session/new', { cwd: options.cwd, mcpServers: [] });
      sessionId = typeof session.sessionId === 'string' ? session.sessionId : null;
      if (sessionId === null) {
        finish('Hermes 没给出会话 id，这一轮没法继续');
        return;
      }
      const prompt: Record<string, unknown>[] = [];
      if (options.context !== undefined && options.context.trim() !== '') {
        prompt.push({ type: 'text', text: options.context });
      }
      for (const file of options.images ?? []) {
        try {
          prompt.push({
            type: 'image',
            mimeType: file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
            data: readFileSync(file).toString('base64'),
          });
        } catch { /* 单张图读不到就不发它，不因此放弃整轮 */ }
      }
      prompt.push({ type: 'text', text: options.prompt });
      const id = nextId++;
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ id, method: 'session/prompt', params: { sessionId, prompt } });
      });
      options.onEvent(mapAcpPromptResult(result));
    } catch (error) {
      finish(`Hermes ACP 协议出错：${(error as Error).message}`);
    }
  })();

  return {
    runId,
    cancel: () => {
      finished = true;
      for (const waiter of pending.values()) waiter.reject(new Error('已取消'));
      pending.clear();
      child.kill();
    },
  };
}
