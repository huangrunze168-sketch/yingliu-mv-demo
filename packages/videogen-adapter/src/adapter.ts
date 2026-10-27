import {
  VideogenCommandError,
  VideogenCredentialError,
  VideogenNoArtifactError,
  VideogenPendingConfirmationError,
  VideogenProtocolError,
} from './errors.js';
import type { VideogenRunner } from './runner.js';

/* ============================================================
  期音科技 · 视频生成服务（Agent OpenAPI）门面
   ------------------------------------------------------------
  与 小QTV（画布节点）和图像生成服务（异步任务）都不同：视频生成服务 这层是**agent 驱动**的——
  我们发一句提示词，它那边自己决定调哪些生成工具，完事把产物挂在 thread 上。

  返回体形状来自官方 skill 的源码（`skills/videogen-skill/scripts/agent_skill.py`，
  clone 在 .data/videogen-skill 下，只读参考）：

    POST /v1/openapi/chat              → { thread_id }
    GET  /v1/openapi/chat/status       → { status: running | done | abort | pending_confirmation }
    GET  /v1/openapi/chat/result       → { items: [{ artifacts: [{ type, content }], text }], failures }

  而 CLI 的 `--json` 把这些组装成一份结果，**三个字段决定了我们要不要当成功**：

    final_status          done / abort / pending_confirmation
    generation_succeeded  done 但没有产物时它是 false（对方自己就区分了"跑完"与"产出"）
    downloaded            传了 --download 才有：每项 { type, url, local_path, new }

  这三条是这一层最值钱的地方：**它替我们把"跑完 ≠ 有产物"说清楚了**，
  而我们只要如实转达，不去把它抹平成"成功"。
   ============================================================ */

export interface VideogenAdapterOptions {
  runner: VideogenRunner;
  /**
   * 这一轮使用的 AK/SK。省略时用环境变量（`LOVART_ACCESS_KEY` / `LOVART_SECRET_KEY`）——
   * 那正是官方 skill 自己认的两个名字，所以这里不另发明一套。
   */
  accessKey?: string;
  secretKey?: string;
  defaultTimeoutMs?: number;
}

export interface VideogenChatRequest {
  prompt: string;
  /** 产物下载到哪（调用方保证目录存在）。 */
  outputDir: string;
  projectId?: string;
  /** 复用同一条 thread（上下文连续）。 */
  threadId?: string;
  /** 参考图 / 参考视频的**绝对**路径。 */
  attachments?: readonly string[];
  /** 让 视频生成服务 优先用哪些模型（它自己的 `--prefer-models`）。 */
  preferModels?: readonly string[];
  mode?: 'thinking' | 'fast';
  timeoutMs?: number;
}

export interface VideogenArtifact {
  /** 对方给的产物类型（image / video / audio…）。 */
  type: string;
  url: string;
  /** 只有传了 `--download` 且有本地文件时才有。 */
  localPath: string | null;
}

export interface VideogenChatResult {
  threadId: string;
  projectId: string;
  finalStatus: string;
  artifacts: VideogenArtifact[];
  /** 对方的提示（例如"有工具调用被拒，Agent 可能换了模型才交付"）。 */
  warning: string | null;
  /** 没有产物时，Agent 说过的那些话——用户要的就是这句话。 */
  agentMessage: string | null;
}

/**
 * 从 stdout 里挑出那份 JSON。

 * 为什么不是直接 `JSON.parse(stdout)`：CLI 前面可能打了几行日志
 * （进度、"正在下载"之类），而我们要的是最后那一份结果对象。
 * 从后往前找第一个能解析成功的 `{…}` 块是最稳的做法。
 */
export function parseVideogenJson(stdout: string): unknown {
  const text = stdout.trim();
  if (text === '') throw new VideogenProtocolError('stdout 是空的', stdout);
  try {
    return JSON.parse(text);
  } catch {
    /* 落到下面按块找 */
  }
  for (let start = text.length - 1; start >= 0; start -= 1) {
    if (text[start] !== '{') continue;
    const candidate = text.slice(start);
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  throw new VideogenProtocolError('stdout 里找不到能解析的 JSON', stdout.slice(0, 400));
}

/** 从 `items[].artifacts[]` 与 `downloaded[]` 里拼出产物清单（下载过的优先带本地路径）。 */
export function collectArtifacts(payload: unknown): VideogenArtifact[] {
  const root = payload as {
    items?: Array<{ artifacts?: Array<{ type?: unknown; content?: unknown }> }>;
    downloaded?: Array<{ type?: unknown; url?: unknown; local_path?: unknown }>;
  };
  const byUrl = new Map<string, VideogenArtifact>();
  for (const item of root.items ?? []) {
    for (const artifact of item.artifacts ?? []) {
      const url = typeof artifact.content === 'string' ? artifact.content : '';
      if (url === '') continue;
      byUrl.set(url, {
        type: typeof artifact.type === 'string' ? artifact.type : 'unknown',
        url,
        localPath: null,
      });
    }
  }
  for (const file of root.downloaded ?? []) {
    const url = typeof file.url === 'string' ? file.url : '';
    const localPath = typeof file.local_path === 'string' && file.local_path !== '' ? file.local_path : null;
    const existing = url === '' ? undefined : byUrl.get(url);
    if (existing !== undefined) {
      existing.localPath = localPath;
      continue;
    }
    byUrl.set(localPath ?? `local:${byUrl.size}`, {
      type: typeof file.type === 'string' ? file.type : 'unknown',
      url,
      localPath,
    });
  }
  return [...byUrl.values()];
}

/**
 * 没有产物时把 Agent 说过的话拼出来。

 * 为什么要有这条兜底：新版的 skill 会把 `items[].text` 组装成顶层 `agent_message`，
 * 但更早的输出里只有 `items[].text`。用户真正要看的就是那句话
 * （"内容审核拒了" / "我换了模型"），拿不到它这个错就等于没说清。
 */
export function collectAgentText(payload: unknown): string | null {
  const items = (payload as { items?: Array<{ text?: unknown }> }).items ?? [];
  const texts = items
    .map((item) => (typeof item.text === 'string' ? item.text.trim() : ''))
    .filter((text) => text !== '');
  return texts.length === 0 ? null : texts.join('\n\n');
}

export class VideogenAdapter {
  readonly #runner: VideogenRunner;
  readonly #accessKey: string | undefined;
  readonly #secretKey: string | undefined;
  readonly #defaultTimeoutMs: number;

  constructor(options: VideogenAdapterOptions) {
    this.#runner = options.runner;
    this.#accessKey = options.accessKey;
    this.#secretKey = options.secretKey;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 15 * 60_000;
  }

  /** 这一轮要带过去的凭据（没给就让它去读环境变量——那是官方 skill 认的路）。 */
  #env(): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.#accessKey !== undefined && this.#accessKey !== '') env.LOVART_ACCESS_KEY = this.#accessKey;
    if (this.#secretKey !== undefined && this.#secretKey !== '') env.LOVART_SECRET_KEY = this.#secretKey;
    return env;
  }

  /**
   * 发一条提示词，等它把产物交出来。
   *
   * 四种结局各自抛不同的错（见 errors.ts）：缺凭据 / 命令失败 / 没产物 / 等人确认。
   * **"等人确认"不是失败**，所以它单独一类——界面据此问用户，而不是说"生成失败"。
   */
  async chat(request: VideogenChatRequest): Promise<VideogenChatResult> {
    const args = [
      'chat',
      '--prompt', request.prompt,
      '--json',
      '--download',
      '--output-dir', request.outputDir,
    ];
    if (request.projectId !== undefined) args.push('--project-id', request.projectId);
    if (request.threadId !== undefined) args.push('--thread-id', request.threadId);
    if (request.mode !== undefined) args.push('--mode', request.mode);
    if (request.preferModels !== undefined && request.preferModels.length > 0) {
      args.push('--prefer-models', request.preferModels.join(','));
    }
    for (const attachment of request.attachments ?? []) args.push('--attachments', attachment);

    const result = await this.#runner.run({
      args,
      timeoutMs: request.timeoutMs ?? this.#defaultTimeoutMs,
      env: this.#env(),
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) {
      if (/LOVART_ACCESS_KEY and LOVART_SECRET_KEY must be set/i.test(combined)) {
        throw new VideogenCredentialError('命令自己说没配 AK/SK');
      }
      throw new VideogenCommandError(result.code, result.stderr.trim().split('\n').slice(-3).join(' '), args);
    }

    const payload = parseVideogenJson(result.stdout) as {
      thread_id?: unknown;
      project_id?: unknown;
      final_status?: unknown;
      generation_succeeded?: unknown;
      warning?: unknown;
      agent_message?: unknown;
    };
    const threadId = typeof payload.thread_id === 'string' ? payload.thread_id : '';
    if (threadId === '') {
        throw new VideogenProtocolError('返回体里没有 thread_id', result.stdout.slice(0, 400));
    }
    const finalStatus = typeof payload.final_status === 'string' ? payload.final_status : 'unknown';

    /* ④ 在等人确认：不是失败，也不是成功——带数据抛出去，让界面问用户 */
    if (finalStatus === 'pending_confirmation') {
      throw new VideogenPendingConfirmationError(threadId, (payload as { pending_confirmation?: unknown }).pending_confirmation ?? null);
    }

    const artifacts = collectArtifacts(payload);
    const warning = typeof payload.warning === 'string' ? payload.warning : null;
    /* 新版 CLI 给顶层 agent_message；旧版只有 items[].text。两种都属于官方输出，不能丢掉旧版的失败说明。 */
    const agentMessage = typeof payload.agent_message === 'string' && payload.agent_message.trim() !== ''
      ? payload.agent_message.trim()
      : collectAgentText(payload);

    /* ③ 跑完但没产物：对方已经用 generation_succeeded 说明过，这里照它的话转达 */
    if (artifacts.length === 0 || payload.generation_succeeded === false) {
      throw new VideogenNoArtifactError(threadId, warning, agentMessage);
    }

    return {
      threadId,
      projectId: typeof payload.project_id === 'string' ? payload.project_id : '',
      finalStatus,
      artifacts,
      warning,
      agentMessage,
    };
  }

  /**
   * 连通性体检（**不花钱**）。
   *
   * 只做两件不打网络请求的事：脚本能不能跑起来、凭据有没有配。
   * 真调一次 API 才算"通"，但那是要花额度的——所以这里**不假装**它通了。
   */
  async probe(): Promise<{ scriptRunnable: boolean; credentialPresent: boolean; detail: string }> {
    const result = await this.#runner.run({ args: ['--help'], timeoutMs: 30_000, env: this.#env() });
    const scriptRunnable = result.code === 0;
    const credentialPresent = (this.#accessKey ?? process.env.LOVART_ACCESS_KEY ?? '') !== ''
      && (this.#secretKey ?? process.env.LOVART_SECRET_KEY ?? '') !== '';
    const detail = !scriptRunnable
      ? `脚本跑不起来：${result.stderr.trim().split('\n').slice(-2).join(' ') || `退出码 ${result.code}`}`
      : credentialPresent
        ? '脚本能跑、凭据已配（真调一次 API 才算通，那要花额度）'
        : '脚本能跑，但没配 AK/SK——到 视频生成服务 平台的头像菜单 → AK/SK Management 拿';
    return { scriptRunnable, credentialPresent, detail };
  }
}
