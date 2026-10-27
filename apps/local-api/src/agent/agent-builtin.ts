/* ============================================================
  小QTV · **内置**的对话 Agent
  ------------------------------------------------------------
  为什么要有这一层：小QTV 那个对话 Agent 是它服务端自带的——
  用户装好软件就能聊，不需要先去装一个 CLI。我们原来那几路
  （codex / claude / hermes）都要用户自己先装好、登录好，
  对"打开就能用"这件事来说门槛太高。

  所以这里把 Agent 循环**做进程序自己**：

    模型  任何 OpenAI 兼容的 /chat/completions 端点（用户自己填 baseUrl / model / key）
    工具  走我们自己的领域面——项目、任务级操作、领域命令、画布底板
          判定沿用 agent-tools.ts 那套白名单（不在白名单里的**服务端直接拒**）
    事件  与我们面板已有的种类对齐：正文（分块）/ 思考（分块）/ 工具两态 / 用量
    循环  最多 STEPS 步；每步一次模型调用；工具结果回灌给模型，直到它给出最终回答

  三条边界，写清楚免得后面有人放松：
    ① **闸门批准永远不能由 Agent 代按**：这条在 agent-tools.ts 里强制，
       内置 Agent 走同一套判定，没有第二条捷径；
    ② 模型不是我们提供的：key 存在本机 `agent-settings.json`（明文），
       界面上如实写着这件事；
    ③ 认不出的工具调用一律不执行，把"不在白名单"这句话原样回给模型让它自己纠。
  ============================================================ */

import type { AgentEventKind } from './agent-runner.js';
import {
  builtinToolDone,
  builtinToolRunning,
  generationProgressText,
  type ToolWaiting,
} from './agent-tool-copy.js';

/** 一轮最多几步（防打转：模型反复调工具时总得有个头） */
const BUILTIN_MAX_STEPS = 12;
export interface BuiltinConfig {
  /** OpenAI 兼容端点，例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** 配置齐没齐（缺一项就说明白缺哪项，不写成"未配置"三个字） */
export function describeBuiltinConfig(config: BuiltinConfig | null): { ready: boolean; reason: string } {
  if (config === null) return { ready: false, reason: '还没填内置 Agent 的模型地址' };
  if (config.baseUrl.trim() === '') return { ready: false, reason: '缺请求地址（baseUrl）' };
  if (config.model.trim() === '') return { ready: false, reason: '缺模型名（model）' };
  if (config.apiKey.trim() === '') return { ready: false, reason: '缺 API Key' };
  return { ready: true, reason: '' };
}

/* ---------- 模型返回的增量：流式拼装 ---------- */

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface StreamDelta {
  content?: string;
  reasoning?: string;
  toolCalls: ToolCallDelta[];
  finishReason?: string;
  usage?: Record<string, unknown>;
}

/**
 * 解析一行 SSE。
 *
 * 这一层单独抽出来是因为它是**纯的**：给一行文本，回一个增量。
 * 流式协议最容易出错的地方全在这里（`data: [DONE]`、空行、JSON 半截），
 * 放在循环里就只能靠真跑一遍去猜。
 *
 * 兼容三种常见写法：
 *   · OpenAI / DeepSeek：`choices[0].delta.content` + `delta.tool_calls[]`
 *   · 思考模型：`delta.reasoning_content`（DeepSeek-R1 系）
 *   · 用量：有的在最后一个 chunk 的 `usage`，有的要 `stream_options.include_usage`
 */
export function parseSseLine(line: string): StreamDelta | null {
  const text = line.trim();
  if (text === '' || !text.startsWith('data:')) return null;
  const payload = text.slice('data:'.length).trim();
  if (payload === '' || payload === '[DONE]') return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  const delta: StreamDelta = { toolCalls: [] };
  const usage = parsed.usage;
  if (usage !== null && typeof usage === 'object') delta.usage = usage as Record<string, unknown>;
  const choices = parsed.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    if (typeof first.finish_reason === 'string' && first.finish_reason !== '') {
      delta.finishReason = first.finish_reason;
    }
    const raw = (first.delta ?? {}) as Record<string, unknown>;
    if (typeof raw.content === 'string' && raw.content !== '') delta.content = raw.content;
    if (typeof raw.reasoning_content === 'string' && raw.reasoning_content !== '') {
      delta.reasoning = raw.reasoning_content;
    }
    if (Array.isArray(raw.tool_calls)) {
      for (const item of raw.tool_calls) {
        const call = item as Record<string, unknown>;
        const fn = (call.function ?? {}) as Record<string, unknown>;
        delta.toolCalls.push({
          index: typeof call.index === 'number' ? call.index : 0,
          ...(typeof call.id === 'string' ? { id: call.id } : {}),
          ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
          ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}),
        });
      }
    }
  }
  if (delta.content === undefined && delta.reasoning === undefined
    && delta.toolCalls.length === 0 && delta.finishReason === undefined
    && delta.usage === undefined) {
    return null;
  }
  return delta;
}

/** 把流式拼起来的 tool_calls 归成一个完整调用（按 index 合并） */
export interface AssembledToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串（模型给的就是字符串，别在这里 parse——parse 失败要回给模型看） */
  arguments: string;
}

export function assembleToolCalls(accumulated: Map<number, AssembledToolCall>): AssembledToolCall[] {
  return [...accumulated.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
}

export function applyToolCallDelta(
  accumulated: Map<number, AssembledToolCall>,
  delta: ToolCallDelta,
): void {
  const current = accumulated.get(delta.index) ?? { id: '', name: '', arguments: '' };
  accumulated.set(delta.index, {
    id: delta.id ?? current.id,
    name: current.name + (delta.name ?? ''),
    arguments: current.arguments + (delta.arguments ?? ''),
  });
}

/* ---------- 工具表：给模型看的说明书 ---------- */

/**
 * 工具定义（OpenAI function-calling 格式）。
 *
 * **只列我们真的会执行的那几个**：`run_task` 与 `submit_command` 的 op/type
 * 由 agent-tools.ts 的白名单把关，`read_canvas`/`write_canvas` 对应
 * 画布底板那两份文件（`<项目>/.canvas/board.json`），`list_projects`/`read_project`
 * 是只读。给模型列一堆做不到的，它会照着说明书去调，然后拿到一串拒绝——
 * 那种"看着很能干"的说明书比少列几个更糟。
 */
export const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: '列出本机上的项目（id、名称、状态）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_project',
      description: '读一个项目的完整状态（镜头表、闸门、预算、参考素材）。',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: '项目 id' } },
        required: ['projectId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_task',
      description: '执行一次任务级操作（真正干活的一层）。允许的 op 见返回的白名单；'
        + '花钱的 op 会被领域层按闸门与预算拦住，拦下就把原因转述给用户。',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', description: '任务 op，例如 analyze / candidates / generate-images / generate-videos / produce / evaluate / available-models' },
          projectId: { type: 'string' },
          payload: { type: 'object', description: '该 op 的其它参数（原样透传）' },
        },
        required: ['op', 'projectId'],
        additionalProperties: true,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_command',
      description: '提交一条领域命令（记录意图。不在白名单或需要人批准闸门的会被拒绝）。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'object', description: '领域命令对象，必须含 type 与 project_id' } },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_canvas',
      description: '读当前项目的画布底板（节点与连线）。',
      parameters: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_canvas',
      description: '整份替换画布底板（用来建节点、连线、摆位置）。'
        + '先 read_canvas 拿现状，改动后再整份写回，避免把别人的改动冲掉。'
        + '**必须带上你读到的那一版 expectRevision**：'
        + '你读完之后用户在画布上动过东西的话，这个数就对不上了，'
        + '写入会被拒绝（底板不会被覆盖），这时重新 read_canvas 再来一次。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          board: { type: 'object', description: '完整底板对象（nodes / edges）' },
          expectRevision: {
            type: 'number',
            description: '你 read_canvas 时那份底板的 revision（返回值里有）。',
          },
        },
        required: ['projectId', 'board', 'expectRevision'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_canvas_nodes',
      description: '往画布上**新建**节点（会自动排到空闲位置，不会叠在已有节点上）。'
        + '返回每个新节点的 id，之后要用它连线。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          nodes: {
            type: 'array',
            description: '要建的节点；type 用画布的类型名（text2image / singleImage2video / text / script …）',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '节点显示名' },
                type: { type: 'string', description: '节点类型' },
                model: { type: 'string', description: '挂在这个节点上的模型显示名（可选）' },
                prompt: { type: 'string', description: '文本/脚本节点的内容（可选）' },
                shotId: { type: 'string', description: '这个节点属于哪个镜头（可选，但生成类节点应当带上）' },
              },
              required: ['name', 'type'],
            },
          },
        },
        required: ['projectId', 'nodes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'connect_canvas_nodes',
      description: '把画布上两个节点连起来（id 来自 read_canvas 或 add_canvas_nodes）。'
        + '两端必须真实存在；重复连线与自连会被跳过并说明。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: '起点节点 id' },
                to: { type: 'string', description: '终点节点 id' },
                kind: { type: 'string', description: 'dependency（参与执行）或 reference（只作示意）' },
              },
              required: ['from', 'to'],
            },
          },
        },
        required: ['projectId', 'edges'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_nodes_from_shots',
      description: '按项目的**镜头表**批量建节点（一个镜头一个，名字带镜头号，'
        + '节点上记着它属于哪个镜头——生成时要用）。已经有节点的镜头会跳过。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          type: { type: 'string', description: '要建的节点类型，默认 text2image' },
          model: { type: 'string', description: '挂上去的模型显示名（可选）' },
        },
        required: ['projectId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_for_nodes',
      description: '按画布节点去生成（图 or 视频）。节点必须**挂着镜头**——提示词来自逐镜字段。'
        + '要花钱：预算优先用 costCents（用户当场告诉你的数字），'
        + '没给就读节点上记的那份（用户在参数面板「成本 ¥」里填过就会存下来）。'
        + '两处都没有就别猜——问用户要一个。'
        + '闸门（G1 图 / G2 视频）与预算由服务端强制，没批准会把原因原样返回。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          nodeIds: {
            type: 'array',
            description: '要生成的节点 id（来自 read_canvas 或 add_canvas_nodes）',
            items: { type: 'string' },
          },
          costCents: {
            type: 'number',
            description: '单条生成的预算（分）。**必须来自用户**（或节点上已经记着的）；'
              + '编一个数字等于替他把钱花了。',
          },
          allowReuse: {
            type: 'boolean',
            description: '允许复用已有结果（同一套输入不再花第二次钱），默认 true',
          },
        },
        required: ['projectId', 'nodeIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      /*
        剧本创编那一条链路的落点。

        为什么是一个工具而不是让模型去写文件：剧本在项目里是**按节点存的**
        （`screenplayWorkspace(projectId, workKey)`，workKey 就是画布上那个剧本节点的 id），
        于是"写剧本"这件事的形状是"给某个节点写一份 .md"。
        让模型自己去拼路径、拼 manifest，迟早会把工作区写坏。
      */
      name: 'write_screenplay',
      description: '把一份剧本正文写进项目（落在画布的剧本节点上，用户能在剧本编辑器里接着改）。'
        + '不传 nodeId 时会自动建一个剧本节点。正文用 Markdown，写**完整的一份**'
        + '（分场、场景、动作、对白），不要只给提纲。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          nodeId: { type: 'string', description: '写进哪个剧本节点（省略则新建一个）' },
          title: { type: 'string', description: '剧本名（也会用作新建节点的名字，最多 120 字）' },
          content: { type: 'string', description: '剧本正文（Markdown）' },
        },
        required: ['projectId', 'content'],
      },
    },
  },
] as const;

/* ---------- 运行 ---------- */

interface BuiltinToolResult {
  ok: boolean;
  /** 给模型看的正文（原样转述，不要美化） */
  content: string;
  /**
   * 给**面板**看的一句短话（可选）。
   *
   * 为什么不让界面拿 content 去猜：数量（建了几个节点、连了几条线）是主进程
   * 这边现成算出来的，写成「已创建 3 个画布节点」比「画布编排已完成」信息量大；
   * 而从一段 JSON 里正则抠数字，哪天正文改了就会悄悄抠出一个错的数。
   */
  note?: string;
  /**
   * 这一条**没做成，但在等人**（花钱前要预算、闸门要批准）。
   *
   * 它跟"失败"不是一回事：失败是这条路走不通，待确认是只差用户点头。
   * 画成一个色会把用户往错的方向带——小QTV 那套词里这两态也是分开的
   * （`视频待确认后生成` vs 失败）。
   */
  pending?: boolean;
  /**
   * 「在等你」的**结构化**说法（要填预算 / 要去批准 / 要去选首帧）。
   *
   * 界面拿它把那一行变成能点的：中文那句话是给人看的，这个是给动作认的。
   */
  waiting?: ToolWaiting;
}

export interface StartBuiltinRunOptions {
  config: BuiltinConfig;
  /** 创意规划只能读写对话：请求中不声明任何可执行工具。其余既有调用保持默认工具能力。 */
  exposeTools?: boolean;
  /** 规划端点只需正文；兼容不识别 stream_options 的第三方服务。 */
  includeUsage?: boolean;
  /** 限制单次规划输出，避免异常回复无限消耗输出额度。 */
  maxOutputTokens?: number;
  /** 单轮总耗时上限；仅显式配置的只读规划路径启用，避免改变现有生成工具的长任务语义。 */
  maxDurationMs?: number;
  /** 系统提示（项目简报 + 这一轮的模式/生成模式） */
  system: string;
  prompt: string;
  /**
   * 执行一个工具调用；不认识的名字返回 ok:false 并说明不在白名单。
   *
   * 第三个参数是**逐镜进度**的出口（现在只有生成那一步会用到）：工具层每跑完一镜
   * 调一次，这里把它画成"同一行更新一次字"，用户就能看见它在往前走。
   */
  callTool: (
    name: string,
    args: Record<string, unknown>,
    onProgress: (progress: { done: number; total: number; shotId: string; ok: boolean }) => void,
  ) => Promise<BuiltinToolResult>;
  onEvent: (event: {
    kind: AgentEventKind;
    text: string;
    usage?: Record<string, unknown>;
    streaming?: boolean;
    itemId?: string;
    phase?: 'start' | 'done';
    failed?: boolean;
    pending?: boolean;
    waiting?: ToolWaiting;
    toolKind?: string;
  }) => void;
  onLog?: ((line: string) => void) | undefined;
}

export interface BuiltinRunHandle {
  cancel: () => void;
  /** 这一轮跑完（或失败）后 resolve，便于上层收尾 */
  done: Promise<void>;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

/**
 * 跑一轮内置 Agent。
 *
 * 循环本身很直白：调用模型 → 有工具调用就执行并回灌 → 再来一次；
 * 没有工具调用就把它的话当最终回答，收工。
 */
export function startBuiltinRun(options: StartBuiltinRunOptions): BuiltinRunHandle {
  const controller = new AbortController();
  let cancelled = false;
  let timedOut = false;
  const timeout = options.maxDurationMs === undefined ? null : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.maxDurationMs);
  timeout?.unref();

  const done = (async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: options.system },
      { role: 'user', content: options.prompt },
    ];

    try {
      for (let step = 0; step < BUILTIN_MAX_STEPS; step += 1) {
        if (cancelled) return;
        const calls = new Map<number, AssembledToolCall>();
        let content = '';
        let finish: string | undefined;
        let usage: Record<string, unknown> | undefined;

        const response = await fetch(`${options.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.config.apiKey}`,
          },
          body: JSON.stringify({
            model: options.config.model,
            ...(options.maxOutputTokens === undefined ? {} : { max_tokens: options.maxOutputTokens }),
            stream: true,
            ...(options.includeUsage === false ? {} : { stream_options: { include_usage: true } }),
            messages,
            ...(options.exposeTools === false ? {} : { tools: BUILTIN_TOOLS }),
          }),
        });
        if (!response.ok || response.body === null) {
          const body = options.exposeTools === false ? '' : await response.text().catch(() => '');
          options.onEvent({
            kind: 'error',
            text: options.exposeTools === false
              ? `第三方规划接口返回 ${response.status}；原始错误正文可能包含凭据，已隐藏。请在服务商侧核对模型、密钥和额度。`
              : `模型接口返回 ${response.status}：${body.slice(0, 300) || '（没有正文）'}`,
          });
          options.onEvent({ kind: 'done', text: '本轮结束' });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done: finished } = await reader.read();
          if (finished) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf('\n');
          while (index >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
            const delta = parseSseLine(line);
            if (delta === null) continue;
            if (delta.reasoning !== undefined) {
              options.onEvent({ kind: 'reasoning', text: delta.reasoning, streaming: true });
            }
            if (delta.content !== undefined) {
              content += delta.content;
              options.onEvent({ kind: 'message', text: delta.content, streaming: true });
            }
            for (const call of delta.toolCalls) applyToolCallDelta(calls, call);
            if (delta.finishReason !== undefined) finish = delta.finishReason;
            if (delta.usage !== undefined) usage = delta.usage;
          }
        }

        const assembled = assembleToolCalls(calls);
        if (options.exposeTools === false && assembled.length > 0) {
          options.onEvent({ kind: 'error', text: '规划模型返回了未授权的工具调用，本轮已停止，未执行工具。' });
          options.onEvent({ kind: 'done', text: '本轮结束' });
          return;
        }
        if (assembled.length === 0) {
          if (options.exposeTools === false && finish !== 'stop') {
            options.onEvent({ kind: 'error', text: `规划响应没有正常结束（finish_reason=${finish ?? '缺失'}），不能把残缺文本当作完整方案。` });
            options.onEvent({ kind: 'done', text: '本轮结束' });
            return;
          }
          options.onEvent({ kind: 'done', text: '本轮结束', ...(usage === undefined ? {} : { usage }) });
          return;
        }

        /* 把这一轮的工具调用挂进对话，再逐个执行、逐个回灌 */
        messages.push({
          role: 'assistant',
          content,
          tool_calls: assembled.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        });

        for (const call of assembled) {
          const itemId = call.id !== '' ? call.id : `${call.name}-${step}`;
          /*
            参数先解析再画那一行：开始那条要带上数量
            （「正在连接节点（4 条连线）」比「正在连接节点」有用），
            而数量就藏在参数里。
          */
          let args: Record<string, unknown> = {};
          let parseError: string | null = null;
          try {
            args = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments) as Record<string, unknown>;
          } catch (error) {
            parseError = `参数不是合法 JSON：${(error as Error).message}`;
          }
          options.onEvent({
            kind: 'tool',
            text: builtinToolRunning(call.name, args),
            itemId,
            phase: 'start',
            toolKind: call.name,
          });
          const result: BuiltinToolResult = parseError === null
            ? await options.callTool(call.name, args, (progress) => {
              /*
                同一行就地改字（itemId 不变）——面板那边已经会把同 id 的两条并成一行，
                所以这里再发一条 phase:'start' 就是"这一行更新了"，不会多出一行。
              */
              options.onEvent({
                kind: 'tool',
                text: generationProgressText(progress),
                itemId,
                phase: 'start',
                toolKind: call.name,
              });
            })
            : { ok: false, content: parseError };
          /*
            收口那条：文字优先用 `note`（里面有真实数量），
            状态优先认 `pending`——"在等你点头"不能画成"失败"。
          */
          const pending = result.pending === true;
          const failed = !result.ok && !pending;
          options.onEvent({
            kind: 'tool',
            text: builtinToolDone(call.name, result.note, failed, args),
            itemId,
            phase: 'done',
            failed,
            ...(pending ? { pending: true } : {}),
            ...(result.waiting === undefined ? {} : { waiting: result.waiting }),
          });
          messages.push({ role: 'tool', tool_call_id: itemId, content: result.content.slice(0, 8000) });
        }
        if (finish === 'length') {
          options.onLog?.('模型这一轮因为长度上限被截断（finish_reason=length）');
        }
      }
      /* 步数用完还没收敛：如实说，别装作做完了 */
      options.onEvent({
        kind: 'error',
        text: `这一轮达到工具调用步数上限（${BUILTIN_MAX_STEPS} 步）还没收敛，已停下。可以把它拆小一点再问。`,
      });
      options.onEvent({ kind: 'done', text: '本轮结束' });
    } catch (error) {
      if (cancelled) {
        options.onEvent({ kind: 'done', text: '已中止' });
        return;
      }
      if (timedOut) {
        options.onEvent({ kind: 'error', text: '第三方规划请求已超时并中止；结果和计费状态未获核实，请先查看服务商记录，不要盲目重复请求。' });
        options.onEvent({ kind: 'done', text: '本轮结束' });
        return;
      }
      options.onEvent({ kind: 'error', text: `内置 Agent 出错：${(error as Error).message}` });
      options.onEvent({ kind: 'done', text: '本轮结束' });
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  })();

  return {
    cancel: () => {
      cancelled = true;
      controller.abort();
    },
    done,
  };
}
