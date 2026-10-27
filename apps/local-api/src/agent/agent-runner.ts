/* ============================================================
   前置 Agent 运行器
   ------------------------------------------------------------

     所以「前置 agent」这一层由**用户自己已经装好、已经登录的 agent CLI** 承担，
     我们只负责：起进程、把它的输出流回来、能中止、把日志留档。

   这么做的直接好处是**我们不经手任何凭据**：
   agent 的账号、模型、额度全在它自己的配置里（DSH Profile、`~/.codex/config.toml`、
   `~/.claude/*`）。软件既不读、也不存、更不转发这些密钥。

   默认走 DSH（`dsh --profile headless --json -`）；同时保留 codex、claude 与 Hermes 兼容入口。

   一个**刻意不做**的事：不用 `codex login status` 判断可用性。
   实测它只看 OpenAI 官方账号，而本机 codex 走的是自定义 provider
   （config.toml 里的 `experimental_bearer_token`），于是它报「Not logged in」，
   可 `codex exec` 明明能跑通。拿它当判据会把可用的一路误判成不可用，
   所以这里只探测**可执行文件在不在**，登录与否让第一次真实调用去说——
   它报出来的原文（比如「Not logged in · Please run /login」）比我们编一句更可操作。
   ============================================================ */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startAcpRun } from './agent-acp.js';
import { describeBuiltinConfig, startBuiltinRun, type BuiltinConfig } from './agent-builtin.js';
import type { ToolWaiting } from './agent-tool-copy.js';

/**
 * 可用的前置 Agent。
 *
 * `hermes` 走的是 ACP（见 agent-acp.ts），不是 JSONL——
 * 它的 `-z` 一次性模式实测中间一个字节都不给，画不出"正在执行"。
 */
/**
 * 可用的对话 Agent。
 *
 * `builtin` 是**程序自己内置**的那一路（agent-builtin.ts）：不要用户装任何 CLI，
 * 只要填一个 OpenAI 兼容的端点就能用——这一条对应 小QTV 那种"开箱自带 agent"。
 * 外部 CLI 中，DSH / codex / claude 走 JSONL，hermes 走 ACP。
 */
export type AgentId = 'builtin' | 'dsh' | 'codex' | 'claude' | 'hermes';

/**
 * codex 的沙箱模式。
 *
 * 默认 `workspace-write`：agent 能改工作目录，但动不了工作目录以外的东西。
 * 之所以还要暴露 `danger-full-access`，是因为实测**这台机器上 codex 的 Windows 沙箱
 * 起不了子进程**（`CreateProcessWithLogonW failed: 2`，三种模式都试过）：
 *   read-only        6 次沙箱报错，最终勉强能跑
 *   workspace-write  完全跑不了命令（连 echo 都失败）
 *   danger-full-access 0 报错
 * 这时只有两个选择：功能不可用，或者用户明确同意去掉隔离。
 * 我们**不替用户选**：默认保持隔离，失败时把话说清楚，由用户显式改。
 */
export type AgentSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface AgentDescriptor {
  id: AgentId;
  label: string;
  /** 解析到的可执行文件；为 null 表示这台机器上没有这一路 */
  command: string | null;
  version: string | null;
  /** 这一路会用掉谁的账号额度，摆在界面上，免得被当成我们提供的额度 */
  account: string;
  /**
   * 这一路**现在为什么不能用**（能用时不写）。
   *
   * 为什么单独一个字段：内置那一路"装了"但"没配"是最常见的情形，
   * 而 `command === null` 在界面上被读成"没装"——那会把"缺个 API Key"
   * 说成"软件没装好"，用户按那句话去装东西是白费功夫。
   */
  reason?: string;
}

/*
  `reasoning` 是单独一类，不和 `note` 混在一起。

  理由：小QTV 把模型的思考画成一条**可折叠的「思考过程」**（词条
  `chatMessageReasoningText0178ef` / 运行中 `…dc269a`「思考中」），
  而我们原来把它当普通备注——于是"模型在想什么"和"应用要说的话"
  在界面上长得一模一样，用户没法区分。分类落在事件上，界面才画得出来。
*/
export type AgentEventKind = 'started' | 'message' | 'tool' | 'reasoning' | 'note' | 'error' | 'done';

export interface AgentEvent {
  runId: string;
  kind: AgentEventKind;
  text: string;
  at: number;
  /** 结束事件带上 CLI 自己报的用量，原样透传，不做换算 */
  usage?: Record<string, unknown>;
  /**
   * 同一次工具调用的身份。
   *
   * 实测（`kernel-workspaces/…/.qiyin-agent/*.ndjson`）：codex 的
   * `item.started` 与 `item.completed` 共用同一个 `item.id`（item_2…item_6），
   * 所以界面可以拿它把"正在跑"的那一行**就地改成"已完成"**——
   * 不给身份的话，同一次调用会画成两行，看起来像跑了两遍。
   */
  itemId?: string;
  /** 工具调用的两个阶段：开始时一条、结束时再来一条 */
  phase?: 'start' | 'done';
  /** 工具种类（command_execution / mcp_tool_call / file_change / web_search …） */
  toolKind?: string;
  /** 这一条工具调用是不是失败了（completed 里的 exit_code / status） */
  failed?: boolean;
  /**
   * 这一条**没做成，但在等人**（花钱前要预算、闸门要批准）。
   *
   * 与 `failed` 互斥地用：失败是"这条路走不通"，待确认是"只差用户点头"。
   * 小QTV 那套词里这两态也是分开的（`视频待确认后生成` vs 失败），
   * 我们照这个分法，界面才画得出"等你确认"而不是一个红叉。
   */
  pending?: boolean;
  /** 「在等你」的结构化说法（要填预算 / 要去批准 / 要去选首帧），见 agent-tool-copy.ts */
  waiting?: ToolWaiting;
}

export interface AgentRunHandle {
  runId: string;
  cancel: () => void;
}

/**
 * 候选可执行文件。
 *
 * 写成绝对路径优先、裸命令兜底：Windows 上 `claude` 在 PATH 里是个 `.ps1`，
 * `spawn` 起不了脚本；而它包内的 `bin/claude.exe` 是真的可执行文件，
 * 直接指过去就能绕开 shell —— 一旦走 shell，用户输入里的 `&`、`|` 就变成了命令，
 * 这是我们必须避免的注入面。
 */
const CANDIDATES: Record<AgentId, readonly string[]> = {
  dsh: ['dsh'],
  codex: ['C:\\Tools\\codex\\codex.exe', 'codex'],
  claude: [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    'claude',
  ],
  /*
    Hermes 装在自己的 venv 里（实测路径如下），也允许 PATH 上有一个 `hermes`。
    注意它跟另外两路**协议不同**：走 ACP，命令行是 `hermes acp --accept-hooks`。
  */
  hermes: [
    join(process.env.LOCALAPPDATA ?? '', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
    'hermes',
  ],
  /* 内置那一路没有可执行文件：它的"命令"只是这个标记，探测时直接跳过 */
  builtin: [],
};

const LABELS: Record<AgentId, string> = {
  builtin: '小QTV 内置',
  dsh: 'DeepSeek Harness',
  codex: 'Codex CLI',
  claude: 'Claude Code',
  hermes: 'Hermes Agent',
};

const ACCOUNTS: Record<AgentId, string> = {
  builtin: '用你自己填的模型端点（key 存在本机）',
  dsh: '使用本机 DeepSeek Harness 配置与订阅',
  codex: '用你自己的 Codex 账号/服务商额度',
  claude: '用你自己的 Claude 账号额度',
  hermes: '用本机 Hermes 自己的模型与账号',
};

/** 跑一次 `--version`，能出来就说明这条路可用；顺带把版本号记下来。 */
function probe(command: string, args: readonly string[]): string | null {
  try {
    const needsWindowsLauncher = process.platform === 'win32' && !command.includes('\\');
    const result = spawnSync(needsWindowsLauncher ? (process.env.ComSpec ?? 'cmd.exe') : command, needsWindowsLauncher ? ['/d', '/s', '/c', command, ...args] : [...args], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    return text.split('\n')[0]?.trim() || '已安装';
  } catch {
    return null;
  }
}

/** 探测这台机器上有哪些 agent CLI。没装的一路如实返回 null，不假装可用。 */
export function detectAgents(): AgentDescriptor[] {
  return (Object.keys(CANDIDATES) as AgentId[]).map((id) => {
    /*
      内置那一路不用探测：它没有可执行文件，"能不能用"取决于配没配模型端点。
      所以这里给它一个固定的标记命令，真实状态由调用方用 describeBuiltinConfig 判断。
    */
    if (id === 'builtin') {
      return { id, label: LABELS[id], command: 'builtin', version: null, account: ACCOUNTS[id] };
    }
    for (const candidate of CANDIDATES[id]) {
      /* 绝对路径先看存在性，省掉一次无谓的 spawn */
      if (candidate.includes('\\') && !existsSync(candidate)) continue;
      const version = probe(candidate, ['--version']);
      if (version !== null) {
        return { id, label: LABELS[id], command: candidate, version, account: ACCOUNTS[id] };
      }
    }
    return { id, label: LABELS[id], command: null, version: null, account: ACCOUNTS[id] };
  });
}

function argsFor(id: AgentId, prompt: string, sandbox: AgentSandbox, images: readonly string[]): string[] {
  if (id === 'dsh') return ['--profile', 'headless', '--json', '-'];
  if (id === 'codex') {
    /*
      `--json` 让 codex 按 JSONL 逐事件输出，这是我们能把「它正在干什么」实时画出来的前提。

      沙箱给 workspace-write 而不是 danger-full-access：
      agent 需要能改工作区里的 SVML / 脚本，但没有理由让它动工作区以外的东西。
      `--skip-git-repo-check` 是必需的——项目工作区不是 git 仓库。
    */
    /*
      图片用重复的 `-i` 逐个给，不写成 `-i a.png b.png`：
      后者是可变参数，会把后面的 prompt 也一并吞掉当成图片路径。
      prompt 永远放最后，是这条命令行里唯一的位置参数。
    */
    const imageArgs = images.flatMap((file) => ['-i', file]);
    return ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-s', sandbox, ...imageArgs, prompt];
  }
  /*
    claude 这一路在本机**未验证**（该 CLI 未登录，实测返回 authentication_failed）。
    参数按它的官方 `--help` 写：`-p` 非交互、`stream-json` 逐事件、
    `--permission-mode acceptEdits` 让它能改文件但不做全权放行。
    等这台机器上有可用账号，第一件事就是把它跑通再改这段注释。
  */
  return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
}

/** 事件回调的第四个参数：工具调用的身份与阶段（见 AgentEvent 上那几条说明） */
export interface AgentEventExtra {
  itemId?: string;
  phase?: 'start' | 'done';
  toolKind?: string;
  failed?: boolean;
  /** 见 AgentEvent.pending（在等人，不是失败） */
  pending?: boolean;
  /** 见 AgentEvent.waiting */
  waiting?: ToolWaiting;
}

/**
 * 把一次工具调用说成人话。
 *
 * 三个实测细节（都来自 `kernel-workspaces/…/.qiyin-agent/*.ndjson`）：
 *   · `command_execution` 的 command 前面永远挂着
 *     `"C:\Program Files\PowerShell\7\pwsh.exe" -Command '…'`——
 *     面板只有 400 宽，把那串前缀画出来等于把真正的命令挤出屏幕，所以剥掉；
 *   · `mcp_tool_call` 报的是 `server` + `tool` 两个字段，合成 `server.tool` 才有信息量
 *     （只写 server 的话，同一个 server 下的调用看起来都一样）；
 *   · 认不出的类型**原样报类型名**，不硬塞进某一类。
 */
function describeToolCall(item: Record<string, unknown>): { text: string; kind: string } {
  const itemType = String(item.type ?? 'tool');
  const shorten = (value: unknown, limit = 120): string => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  if (itemType === 'command_execution') {
    const raw = String(item.command ?? '');
    /* 去掉 `"…pwsh.exe" -Command '` 这层壳，只留用户真正想看的那条命令 */
    /*
      末尾那个引号也要剥掉：`-Command 'node … tools'` 的第一版正则里
      最后的 `'?` 是可选的，贪婪的捕获组会把那个引号一起吞进结果，
      命令尾巴上就多挂一个 `'`——面板上看着像命令本身写错了。
      所以捕获组改成非贪婪。
    */
    const shell = /^"?[^"']*?(?:pwsh|powershell|cmd|bash|sh)\.exe"?\s+(?:-NoProfile\s+)?-Command\s+'?([\s\S]*?)'?$/i.exec(raw.trim());
    return { kind: 'command', text: shorten(shell?.[1] ?? raw) };
  }
  if (itemType === 'mcp_tool_call') {
    const server = String(item.server ?? '');
    const tool = String(item.tool ?? '');
    return { kind: 'mcp', text: server !== '' && tool !== '' ? `${server}.${tool}` : shorten(item.path ?? server ?? tool) };
  }
  if (itemType === 'file_change') {
    return { kind: 'file', text: shorten(item.path ?? item.file ?? '文件改动') };
  }
  if (itemType === 'web_search') {
    return { kind: 'search', text: shorten(item.query ?? '联网检索') };
  }
  return { kind: itemType, text: shorten(item.path ?? item.message ?? itemType) };
}

/** 模型服务可能把错误包在字符串 JSON 里，再包在 turn.failed.error 中。 */
export function formatAgentFailure(raw: unknown): string {
  let value: unknown = raw;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof value === 'string' && value.trim().startsWith('{')) {
      try { value = JSON.parse(value) as unknown; continue; } catch { break; }
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const next = record.error ?? record.message;
      if (next !== undefined && next !== value) { value = next; continue; }
    }
    break;
  }
  const text = typeof value === 'string' ? value : '';
  const outdated = /['`‘]([^'`’]+)['`’] model requires a newer version of Codex/i.exec(text);
  if (outdated) return `本机 Codex CLI 版本过旧，无法使用当前模型 ${outdated[1]}。请更新 Codex CLI，或在 Codex 配置中选择兼容模型后重试。`;
  if (/model.*(not found|does not exist|unsupported)/i.test(text)) return '当前配置的模型不可用，请检查 Agent 模型配置后重试。';
  if (/unauthori[sz]ed|invalid.*api.?key|authentication_failed|not logged in|\b401\b/i.test(text)) return '模型服务未授权，请检查 Agent 登录状态或模型服务凭据。';
  if (/rate.limit|too many requests|\b429\b/i.test(text)) return '模型服务请求过于频繁，请稍后重试。';
  if (/context.length|context.window|too many tokens/i.test(text)) return '对话超过模型上下文限制，请新建对话并缩短请求。';
  return 'Agent 本轮运行失败，请检查模型服务与 Agent 配置后重试。';
}

/** codex 的 JSONL 事件 → 结构化回复／工具／失败，不能把日志当正文。 */
export function parseCodexLine(
  line: string,
  emit: (kind: AgentEventKind, text: string, usage?: Record<string, unknown>, extra?: AgentEventExtra) => void,
): boolean {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return false;
  }
  const type = String(payload.type ?? '');

  if (type === 'thread.started') return true;
  if (type === 'turn.failed' || type === 'error') {
    emit('error', formatAgentFailure(payload.error ?? payload.message ?? payload));
    return true;
  }
  if (type === 'turn.completed') {
    // CLI 未退出前不能提前宣布完成；最终 done 在 child.close 发送。
    return true;
  }
  if (type !== 'item.completed' && type !== 'item.updated' && type !== 'item.started') return true;

  const item = (payload.item ?? {}) as Record<string, unknown>;
  const itemType = String(item.type ?? '');
  const itemId = typeof item.id === 'string' ? item.id : undefined;
  /*
    工具调用画**两条**：started 一条（正在跑）、completed 一条（跑完了）。

    这是实测定的（`item.started` 与 `item.completed` 共用 `item.id`）：
    界面拿 same id 把那一行就地改掉，用户看到的是"这一条正在跑 → 跑完了"，
    而不是"跑了两遍"。`item.updated` 是中间的增量，仍然不画——
    它会把同一行刷新很多次，而内容对用户没有增量信息。
  */
  const isToolType = itemType !== 'agent_message' && itemType !== 'reasoning' && itemType !== 'error';
  if (type === 'item.updated') return true;
  if (type === 'item.started') {
    if (!isToolType) return true;
    const described = describeToolCall(item);
    emit('tool', described.text, undefined, {
      phase: 'start',
      toolKind: described.kind,
      ...(itemId === undefined ? {} : { itemId }),
    });
    return true;
  }

  if (itemType === 'agent_message') {
    emit('message', String(item.text ?? ''));
    return true;
  }
  if (itemType === 'reasoning') {
    emit('reasoning', String(item.text ?? '').slice(0, 800));
    return true;
  }
  if (itemType === 'error') {
    // Codex 的 item.error 还承载模型元数据／技能预算警告；终止失败以 turn.failed 为准。
    return true;
  }
  /*
    跑完的那一条。失败判定用协议里现成的两个字段：
    `exit_code` 非 0，或者 `status` 明确写了 failed/error——
    **两个都没有时按成功算**（命令类事件在成功时 exit_code=0、status=completed）。
  */
  const described = describeToolCall(item);
  const exitCode = item.exit_code;
  const status = String(item.status ?? '');
  const failed = (typeof exitCode === 'number' && exitCode !== 0)
    || /^(failed|error)$/i.test(status);
  emit('tool', described.text, undefined, {
    phase: 'done',
    toolKind: described.kind,
    failed,
    ...(itemId === undefined ? {} : { itemId }),
  });
  return true;
}

/** DSH headless --json 事件 → 小QTV 对话流。 */
export function parseDshLine(
  line: string,
  emit: (kind: AgentEventKind, text: string, usage?: Record<string, unknown>, extra?: AgentEventExtra) => void,
): boolean {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return false;
  }
  const type = String(payload.type ?? '');
  if (type === 'session' || type === 'status') return true;
  if (type === 'thinking') {
    const text = String(payload.text ?? '').trim();
    if (text) emit('reasoning', text.slice(0, 800));
    return true;
  }
  if (type === 'text') {
    const text = String(payload.text ?? '').trim();
    if (text) emit('message', text);
    return true;
  }
  if (type === 'final') {
    // DSH 会在 text 事件后再发送完整 final；忽略它，避免正文重复两次。
    return true;
  }
  if (type === 'tool_call') {
    const input = (payload.input ?? {}) as Record<string, unknown>;
    const label = typeof input.description === 'string' && input.description.trim()
      ? input.description.trim()
      : `调用 ${String(payload.tool ?? '工具')}`;
    emit('tool', label, undefined, {
      ...(typeof payload.callId === 'string' ? { itemId: payload.callId } : {}),
      phase: 'start',
      toolKind: String(payload.tool ?? 'dsh_tool'),
    });
    return true;
  }
  if (type === 'tool_result') {
    const status = String(payload.status ?? 'completed');
    emit('tool', /^(failed|error)$/i.test(status) ? '工具调用失败' : '工具调用完成', undefined, {
      ...(typeof payload.callId === 'string' ? { itemId: payload.callId } : {}),
      phase: 'done',
      toolKind: 'dsh_tool',
      failed: /^(failed|error)$/i.test(status),
    });
    return true;
  }
  if (type === 'error') {
    emit('error', formatAgentFailure(payload.error ?? payload.message ?? payload));
    return true;
  }
  return true;
}

/** claude 的 stream-json 事件 → 我们能画的东西（未在本机验证，见 argsFor 的说明） */
export function parseClaudeLine(
  line: string,
  emit: (kind: AgentEventKind, text: string, usage?: Record<string, unknown>, extra?: AgentEventExtra) => void,
): boolean {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return false;
  }
  const type = String(payload.type ?? '');
  if (type === 'system') return true;
  if (type === 'assistant') {
    const message = (payload.message ?? {}) as {
      content?: Array<{ type?: string; text?: string; name?: string; thinking?: string }>;
    };
    for (const block of message.content ?? []) {
      if (block.type === 'text' && block.text) emit('message', block.text);
      else if (block.type === 'tool_use') emit('tool', `调用工具：${String(block.name ?? '')}`);
      /*
        claude 的思考块与 codex 的 reasoning 归为同一类。
        注意它那个字段叫 `thinking` 不叫 `text`——照 codex 那样取 text 会一条都读不到，
        而"读不到"在界面上表现为"这个模型从不思考"，很难查。
      */
      else if (block.type === 'thinking' && block.thinking) emit('reasoning', block.thinking.slice(0, 800));
    }
    /* 未登录这种情况会以 assistant 消息 + error 字段出现，必须原样带出来 */
    if (payload.error) emit('error', String(payload.error));
    return true;
  }
  if (type === 'result') {
    const usage = payload.usage as Record<string, unknown> | undefined;
    if (payload.is_error === true) emit('error', String(payload.result ?? '未知错误'));
    emit('done', String(payload.result ?? '本轮结束'), usage);
    return true;
  }
  return true;
}

/**
 * CLI 的日志噪声。
 *
 * codex 往 stderr 打大量 tracing 行（`…Z WARN codex_core_plugins::manifest: …`），
 * 全画到界面上会把真正的错误淹掉。这些行仍然进留档文件，只是不进对话。
 */
const NOISE = /^\d{4}-\d{2}-\d{2}T\S+\s+(WARN|INFO|DEBUG|TRACE)\s/;

/**
 * 另一类噪声：codex 在 stdin 是管道时会打这行提示。
 *
 * 我们**故意**把 stdin 关掉（见下面 child.stdin.end() 的说明），它仍然会打这句，
 * 属于实现细节，对用户没有信息量；但它必须留在留档文件里，
 * 万一将来 codex 改了行为，这行就是第一线索。
 */
const STDIN_NOTES = [
  'Reading additional input from stdin...',
  /* stdin 非空时它换一个说法。两种都实测遇到过，别再漏一个 */
  'Reading prompt from stdin...',
];

/**
 * codex 的 Windows 沙箱在这台机器上起不来时的报错。
 *
 * 实测：`CreateProcessWithLogonW failed: 2`（ERROR_FILE_NOT_FOUND），
 * 三种模式都试过，只有 `danger-full-access` 不报。它一次运行会重复打十几条，
 * 每条都画出来会把真正有用的内容全挤掉，所以**整个运行只报一次**，
 * 并且换成一句能照着做事的话。
 */
const SANDBOX_FAILURE = /CreateProcessWithLogonW failed|windows sandbox/i;

/**
 * 这一行是不是协议事件（`{…}` 的 JSONL）。
 *
 * 判据本身很简单，**单独抽出来是因为它必须排在所有文本过滤前面**：
 * 真机踩过一次——命令失败时 codex 把沙箱报错文本写进了
 * `item.completed` 的 `aggregated_output` 里，整条 JSON 匹配上"沙箱噪声"，
 * 于是那条完成事件被整条丢掉，界面上的动作永远停在「正在执行」。
 */
export function isProtocolLine(line: string): boolean {
  return line.startsWith('{');
}

export function startAgentRun(options: {
  runId?: string;
  agentId: AgentId;
  command: string;
  prompt: string;
  /**
   * 补充上下文（项目事实简报）。
   *
   * 走 **stdin** 而不是拼进 prompt：codex 会把管道里的内容追加成一个 `<stdin>` 块，
   * 用户自己写的那句话则原样作为参数传进去。这样"用户说的话"和"系统补的上下文"
   * 在协议层就是两段，不会被混成一句谁写的都分不清的话。
   * 实测确认 agent 能正确读到这段内容。
   */
  context?: string;
  /** 沙箱模式；不传按最保守的 workspace-write 走 */
  sandbox?: AgentSandbox;
  /**
   * 附给 agent 看的图片（项目里已抽出的参考帧）。
   *
   * 七字段（景别/机位/光线…）是对**画面**的判断，只给路径等于让它猜。
   * 只对 codex 生效——claude 那一路没有等价的命令行开关，
   * 与其造一个看起来能用其实没生效的参数，不如在这里说实话。
   */
  images?: readonly string[];
  cwd: string;
  onEvent: (event: AgentEvent) => void;
  /**
   * **内置那一路**用的模型端点（agent-builtin.ts）。
   * 只有 agentId === 'builtin' 时才需要；缺了就在界面上报"还没配"。
   */
  builtinConfig?: BuiltinConfig | null;
  /**
   * 内置那一路执行工具的回调（由主进程注入，走的仍是同一套白名单）。
   *
   * 第三个参数是逐镜进度出口：工具层每跑完一镜调一次，agent-builtin 把它
   * 画成"同一行更新一次字"（生成要跑几分钟，界面上得有动静）。
   */
  callBuiltinTool?: (
    name: string,
    args: Record<string, unknown>,
    onProgress: (progress: { done: number; total: number; shotId: string; ok: boolean }) => void,
  ) => Promise<{ ok: boolean; content: string }>;
}): AgentRunHandle {
  const runId = options.runId ?? randomUUID();

  /*
    Hermes 走 ACP，不走下面那条"逐行 JSONL"的路。

    两边的差别不是参数级的：ACP 是 JSON-RPC 的请求/通知，
    要握手、要拿 sessionId、事件按 `session/update` 推——
    硬塞进 JSONL 那条路只会得到一堆解析不了的行。
    所以这里直接分出去（映射与客户端都在 agent-acp.ts）。
  */
  if (options.agentId === 'hermes') {
    const handle = startAcpRun({
      command: options.command,
      cwd: options.cwd,
      prompt: options.prompt,
      ...(options.context === undefined ? {} : { context: options.context }),
      ...(options.images === undefined ? {} : { images: options.images }),
      onEvent: (mapped) => {
        const { kind, text, usage, ...extra } = mapped;
        options.onEvent({
          runId,
          kind,
          text,
          at: Date.now(),
          ...(usage === undefined ? {} : { usage }),
          ...extra,
        });
      },
      /* ACP 的 stderr 是它的日志（插件注册、模型信息…）：进留档，不进对话 */
      onLog: (line) => log('stderr', line),
      onFail: (message) => {
        options.onEvent({ runId, kind: 'error', text: message, at: Date.now() });
        options.onEvent({ runId, kind: 'done', text: '运行结束', at: Date.now() });
      },
    });
    return { runId, cancel: handle.cancel };
  }

  /*
    内置那一路（程序自带，不要用户装 CLI）。

    它的"起不来"只有一种：模型端点没配齐——那就把缺哪一项原样说出来，
    而不是丢一句"启动失败"让用户去猜。
  */
  if (options.agentId === 'builtin') {
    const readiness = describeBuiltinConfig(options.builtinConfig ?? null);
    if (!readiness.ready || options.builtinConfig === null || options.builtinConfig === undefined) {
      options.onEvent({ runId, kind: 'error', text: `内置 Agent 还不能用：${readiness.reason}`, at: Date.now() });
      options.onEvent({ runId, kind: 'done', text: '本轮结束', at: Date.now() });
      return { runId, cancel: () => undefined };
    }
    if (options.callBuiltinTool === undefined) {
      options.onEvent({ runId, kind: 'error', text: '内置 Agent 没有接到工具层（这是程序内部错误）', at: Date.now() });
      options.onEvent({ runId, kind: 'done', text: '本轮结束', at: Date.now() });
      return { runId, cancel: () => undefined };
    }
    const callBuiltinTool = options.callBuiltinTool;
    const handle = startBuiltinRun({
      config: options.builtinConfig,
      system: options.context ?? '你是小QTV 的内置 Agent。',
      prompt: options.prompt,
      callTool: (name, args, onProgress) => callBuiltinTool(name, args, onProgress),
      onEvent: (event) => {
        options.onEvent({ runId, at: Date.now(), ...event });
      },
      onLog: (line) => log('stderr', line),
    });
    return { runId, cancel: handle.cancel };
  }

  let sawReply = false;
  let sawFailure = false;
  let cancelled = false;
  const failures = new Set<string>();
  const emit = (
    kind: AgentEventKind,
    text: string,
    usage?: Record<string, unknown>,
    extra?: AgentEventExtra,
  ) => {
    if (text.trim() === '' && kind !== 'done') return;
    if (kind === 'message') sawReply = true;
    if (kind === 'error') {
      if (failures.has(text)) return;
      failures.add(text);
      sawFailure = true;
    }
    options.onEvent({
      runId,
      kind,
      text,
      at: Date.now(),
      ...(usage === undefined ? {} : { usage }),
      ...(extra ?? {}),
    });
  };

  /* 原始日志留档：界面只画过滤后的流，排查问题时要有不丢东西的那一份 */
  const logDir = join(options.cwd, '.qiyin-agent');
  const logFile = join(logDir, `${runId}.ndjson`);
  const log = (stream: string, line: string) => {
    try {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), stream, line })}\n`, 'utf8');
    } catch {
      /* 留档失败不影响本次运行 */
    }
  };

  let child: ChildProcessWithoutNullStreams;
  try {
    const images = options.agentId === 'codex' ? (options.images ?? []) : [];
    const cliArgs = argsFor(options.agentId, options.prompt, options.sandbox ?? 'workspace-write', images);
    const useWindowsDshLauncher = options.agentId === 'dsh' && process.platform === 'win32';
    const spawnCommand = useWindowsDshLauncher ? (process.env.ComSpec ?? 'cmd.exe') : options.command;
    const spawnArgs = useWindowsDshLauncher ? ['/d', '/s', '/c', options.command, ...cliArgs] : cliArgs;
    child = spawn(spawnCommand, spawnArgs, {
      cwd: options.cwd,
      windowsHide: true,
      /* 不经 shell：提示词里的 & | > 之类的字符不会被当成命令 */
      shell: false,
      env: { ...process.env, QIYIN_AGENT_RUN_ID: runId },
    });
  } catch (error) {
    emit('error', `起不了 ${options.command}：${(error as Error).message}`);
    emit('done', '运行结束');
    return { runId, cancel: () => {} };
  }

  emit('started', `${LABELS[options.agentId]} 已启动`);

  /** 沙箱失败只报一次，避免十几条重复把对话淹掉 */
  let sandboxReported = false;

  /*
    stdin 必须**写完就关**。

    实测踩过的坑：`codex exec` 的说明里写着「如果 stdin 是管道且同时给了 prompt，
    就把 stdin 追加成一个 <stdin> 块」——于是它**会等 stdin 读到 EOF 才开始跑**。
    Node 的 spawn 默认给一个打开的管道，结果就是进程挂在那儿一动不动，
    界面上只看到一句「Reading additional input from stdin...」，像死掉了一样。

    现在这里承载项目简报：有就写进去，没有就空管道，两种情况都立刻 end()。
  */
  if (options.agentId === 'dsh') {
    const sections = [options.prompt];
    if (options.context?.trim()) sections.push(`\n\n以下是小QTV 提供的项目事实与约束，请据此工作：\n${options.context}`);
    if (options.images?.length) sections.push(`\n\n可读取的参考图片路径：\n${options.images.join('\n')}`);
    const task = sections.join('');
    child.stdin.write(task);
    log('prompt', task);
  } else if (options.context !== undefined && options.context.trim() !== '') {
    child.stdin.write(options.context);
    /* 补进去的上下文也进留档：将来要解释"它为什么这么说"，这是唯一的第一手材料 */
    log('context', options.context);
  }
  child.stdin.end();

  const fragments: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const readLine = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const lines = (fragments[stream] + chunk.toString('utf8')).split(/\r?\n/);
    fragments[stream] = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (line === '') continue;
      log(stream, line);

      /*
        协议事件**先于噪声过滤**处理。

        这是实测踩出来的一个丢事件的坑（第 DI 轮的真机跑）：
        那几条命令执行失败时，codex 把它们写成了
        `{"type":"item.completed","item":{…,"status":"failed","aggregated_output":"…CreateProcessWithLogonW failed…"}}`
        ——整条 JSON 里带着沙箱报错的文本，于是被下面那条"沙箱噪声"判定
        当成噪声 `continue` 掉了。表现是：那几条动作永远停在「正在执行」，
        而对话看上去正常。**协议行一律按事件处理，不参与文本层面的噪声过滤。**
      */
      if (isProtocolLine(line)) {
        const handled = options.agentId === 'codex'
          ? parseCodexLine(line, emit)
          : options.agentId === 'dsh'
            ? parseDshLine(line, emit)
            : parseClaudeLine(line, emit);
        if (handled) continue;
        /* 损坏的协议行只保留在运行日志，不能当作 Agent 正文。 */
        continue;
      }

      /* 剩下的都是 CLI 的普通输出，这时才做噪声与沙箱判定 */
      const sandboxBroken = SANDBOX_FAILURE.test(line);
      const isNoise = NOISE.test(line) || STDIN_NOTES.includes(line) || sandboxBroken;
      if (sandboxBroken) {
        if (!sandboxReported) {
          sandboxReported = true;
          emit(
            'error',
            (options.sandbox ?? 'workspace-write') === 'workspace-write'
              ? '这台机器上 codex 的 Windows 沙箱起不了子进程（CreateProcessWithLogonW failed: 2），'
                + '所以 Agent 一条命令都执行不了——包括调用项目工具。'
                + '工作目录读写、分析都受影响。'
                + '可以在下面的「沙箱」里改成 danger-full-access 再试：那等于去掉隔离，'
                + '只在这台机器和你信任这个项目时用。'
              : '沙箱仍然报了 CreateProcessWithLogonW failed，说明问题不在模式上，'
                + '而在这台机器的 codex 环境（详见工作目录 .qiyin-agent/ 里的运行记录）。',
          );
        }
        continue;
      }
      // stderr 与 stdout 的非协议行是 CLI 运维日志，留档但不显示为助手发言。
      if (!isNoise) continue;
    }
  };

  child.stdout.on('data', readLine('stdout'));
  child.stderr.on('data', readLine('stderr'));

  child.on('error', (error) => {
    emit('error', `${LABELS[options.agentId]} 启动失败：${error.message}`);
  });

  child.on('close', (code) => {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (fragments[stream]) readLine(stream)(Buffer.from('\n'));
    }
    if (cancelled && !sawFailure) emit('error', '本轮已停止，未生成完成结果。');
    else if (!sawFailure && code !== 0) emit('error', 'Agent 本轮运行失败，请检查 Agent 配置与运行环境后重试。');
    else if (!sawReply && !sawFailure) emit('error', 'Agent 本轮未返回可显示的回复，请检查 Agent 配置后重试。');
    emit('done', '运行结束');
  });

  return {
    runId,
    cancel: () => {
      cancelled = true;
      /* 连子进程一起收：agent 会自己再起子进程，只 kill 顶层会留孤儿 */
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
      emit('note', '已请求停止');
    },
  };
}
