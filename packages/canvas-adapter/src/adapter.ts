import {
  CanvasAuthError,
  CanvasCommandError,
  CanvasProtocolError,
} from './errors.js';
import type {
  CanvasAccountInfo,
  CanvasModelSearchResult,
  CanvasModelSchemaResult,
  CanvasImageShortcutList,
  CanvasModality,
  CanvasNodeResult,
  CanvasWorkspace,
} from './protocol.js';
import type { CanvasRunner } from './runner.js';

export interface CanvasAdapterOptions {
  /**/
  cwd?: string;
  timeoutMs?: number;
  /** 生成类命令的超时（视频可能数分钟）。 */
  longTimeoutMs?: number;
}

/**
 * 小QTV 官方 CLI 的门面。
 *
 * 产品不自己发明 HTTP 请求，也不绕到网页端——所有画布/节点/模型操作都经这里
 * 而「Agent 用 CLI 生成内容」与「界面用同一套能力」也天然一致。
 */
export class CanvasAdapter {
  constructor(
    private readonly runner: CanvasRunner,
    private readonly options: CanvasAdapterOptions = {},
  ) {}

  /** 当前账号。也用作「凭据是否有效」的自检。 */
  accountInfo(): Promise<CanvasAccountInfo> {
    return this.call<CanvasAccountInfo>(['account', 'info']);
  }

  listWorkspaces(): Promise<{ folders?: CanvasWorkspace[] }> {
    return this.call(['workspace', 'list']);
  }

  listProjects(): Promise<unknown> {
    return this.call(['project', 'list']);
  }

  /**
   * 新建一张画布。
   *
   * 返回体实测是 `{ projectMeta: { id, uuid, name, ownerId, … } }`——
   * 真正要留下的是 `uuid`（`project use` 认的是它，不是数字 id）。
   *
   * 这一步会在用户账号里真实建出一张画布，所以产品侧必须是**用户显式发起**
   * 的动作，不能在「生成」里顺手做掉：界面上的按钮写的是「新建并绑定画布」。
   */
  async createCanvas(name: string, options: { cwd?: string } = {}): Promise<{ canvasUuid: string; canvasName: string | null }> {
    const payload = await this.call<{ projectMeta?: { uuid?: unknown; name?: unknown } }>(
      ['project', 'create', name],
      options.cwd === undefined ? {} : { cwd: options.cwd },
    );
    const uuid = payload?.projectMeta?.uuid;
    if (typeof uuid !== 'string' || uuid.length === 0) {
      throw new CanvasProtocolError('canvas project create 的返回里没有 projectMeta.uuid', { payload });
    }
    return { canvasUuid: uuid, canvasName: typeof payload.projectMeta?.name === 'string' ? payload.projectMeta.name : name };
  }

  /**
   * 把当前目录绑定到一张画布。
   *
   * 不是我们发明的格式。因此绑定之后，`node create` / `download` 这些命令
   * 只要在这个目录里跑，就能找到同一张画布。
   */
  async useCanvas(uuid: string, options: { cwd?: string } = {}): Promise<{ canvasUuid: string; canvasName: string | null }> {
    const payload = await this.call<{ projectUuid?: unknown; name?: unknown }>(
      ['project', 'use', uuid],
      options.cwd === undefined ? {} : { cwd: options.cwd },
    );
    const bound = payload?.projectUuid;
    if (typeof bound !== 'string' || bound.length === 0) {
      throw new CanvasProtocolError('canvas project use 的返回里没有 projectUuid', { payload });
    }
    return { canvasUuid: bound, canvasName: typeof payload.name === 'string' ? payload.name : null };
  }

  /**
   * 列出当前账户可见的画布。
   *
   * 只读：不建节点、不触发生成，所以不消耗额度。界面用它做"绑哪一块画布"的下拉——
   * 让用户手抄一串 32 位 uuid 是把我们的实现细节丢给他。
   *
   * 原始返回里还有 ownerId / folderId 之类的账户信息，这里**只留 uuid 与名字**：
   * 界面不需要别的，多传一层就多一份不知道谁会看到的数据。
   */
  async listCanvases(options: { cwd?: string } = {}): Promise<Array<{ canvasUuid: string; canvasName: string }>> {
    const payload = await this.call<{ projectMetaList?: Array<{ uuid?: unknown; name?: unknown }> }>(
      ['project', 'list'],
      options.cwd === undefined ? {} : { cwd: options.cwd },
    );
    return (payload.projectMetaList ?? [])
      .filter((item) => typeof item.uuid === 'string' && item.uuid.length > 0)
      .map((item) => ({
        canvasUuid: String(item.uuid),
        canvasName: typeof item.name === 'string' && item.name.trim().length > 0 ? item.name : String(item.uuid),
      }));
  }

  /** 按模态列模型，或按关键词检索。 */
  async searchModels(options: { type?: CanvasModality; name?: string } = {}): Promise<CanvasModelSearchResult> {
    const args = ['model', 'search'];
    if (options.type) args.push('--type', options.type);
    if (options.name) args.push(options.name);
    return this.call<CanvasModelSearchResult>(args);
  }

  /**
   *
   * 这是**只读**调用，不消耗额度。用途是让"这个模型支不支持重拍"变成
   * 提交之前就能回答的问题——靠 `supportedModeTypes()` 读它的 modeType 表。
   */
  async modelSchema(name: string): Promise<CanvasModelSchemaResult> {
    return this.call<CanvasModelSchemaResult>(['model', name]);
  }

  /**
   *
   * 只读、不消耗额度。它回答的是"这张图上还能做哪些事"——
   * 多机位九宫格、角色三视图、设定图、光影校正这些。
   */
  async imageShortcuts(): Promise<CanvasImageShortcutList> {
    return this.call<CanvasImageShortcutList>(['image', 'shortcut', 'list']);
  }

  /**
   * 在一张**已在画布上的图片节点**上执行某个场景能力。
   *
   * 注意 `-n` 要的是节点，不是文件路径——所以调用方必须先把图上传成节点
   * （与图生视频那条 `--left` 的规矩一样）。这一步会**真实消耗额度**。
   */
  runImageShortcut(options: { scene: string; node: string }): Promise<CanvasNodeResult> {
    return this.call<CanvasNodeResult>(
      ['image', 'shortcut', options.scene, '-n', options.node],
      { long: true },
    );
  }

  /**
   * 建一个画布节点。
   *
   * `sets` 里的 `model` 必须是**模型显示名**（如 `Z-image Turbo`），
   * 传 modelKey 会被 CLI 明确拒绝——这是实测结论，不是猜测。
   */
  nodeCreate(options: {
    name: string;
    type: string;
    prompt?: string;
    /**
     * `--set key=value` 的那些键值。
     *
     * 布尔也在里面：schema 里确实有布尔型参数（例如智能分镜 `multi_shot`），
     * 它们会以 `key=true/false` 的形式发出去。**这一点没有实测过**
     * （要真的跑一次带布尔参数的生成才知道 CLI 认不认），
     * 所以这里只如实声明"我们会这么发"，不假装已经验证。
     */
    sets?: Record<string, string | number | boolean>;
    /**/
    left?: readonly string[];
  }): Promise<CanvasNodeResult> {
    const args = ['node', 'create', options.name, '-t', options.type];
    if (options.prompt !== undefined) args.push('--prompt', options.prompt);
    for (const [key, value] of Object.entries(options.sets ?? {})) {
      args.push('-s', `${key}=${value}`);
    }
    for (const reference of options.left ?? []) args.push('--left', reference);
    return this.call<CanvasNodeResult>(args);
  }

  /**
   * 上传本地文件为画布上的资源节点。
   *
   * 图生视频必须先有参考图节点：`node --left` 连的是**节点**，不是文件路径。
   * 这一步不消耗生成额度，但会占用账户存储。
   */
  upload(options: { name: string; file: string; type?: 'image' | 'video' | 'audio' }): Promise<CanvasNodeResult> {
    const args = ['upload', options.name, '--resource', options.file];
    if (options.type !== undefined) args.push('-t', options.type);
    return this.call<CanvasNodeResult>(args, { long: true });
  }

  /** 触发一次生成。这一步会真实消耗账户额度。 */
  nodeRun(name: string): Promise<CanvasNodeResult> {
    return this.call<CanvasNodeResult>(['node', name, '--run'], { long: true });
  }

  /**
   * 下载节点产物。
   *
   * 两个目录必须分开控制，这是实测踩到的：
   *   · **工作目录**决定「节点在哪个画布上被解析」——换掉它就会报「缺少项目」；
   *   · **输出目录**由 `--out` 指定。
   * 曾把两者合一（用 cwd 当输出目录），结果 download 因为找不到画布绑定而失败。
   */
  async download(options: { node: string; to?: string; withoutAiWatermark?: boolean }): Promise<{ savedPaths: string[] }> {
    const args = ['download', '-n', options.node];
    if (options.to !== undefined) args.push('--out', options.to);
    if (options.withoutAiWatermark) args.push('--without-ai-watermark');
    const result = await this.raw(args, { long: true });
    if (result.code !== 0) throw this.toCommandError(args, result);
    // download 打印的是逐行的本地路径，不是 JSON
    const savedPaths = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && /[\\/]/.test(line));
    return { savedPaths };
  }

  /* ---------------- 内部 ---------------- */

  private async call<T>(args: readonly string[], options: { long?: boolean; cwd?: string } = {}): Promise<T> {
    const result = await this.raw(args, options);
    if (result.code !== 0) throw this.toCommandError(args, result);
    const payload = extractJson(result.stdout);
    if (payload === null) {
      throw new CanvasProtocolError(
        `canvas ${args[0]} ${args[1] ?? ''} 的输出里找不到可解析的 JSON`,
        { stdout: result.stdout.slice(0, 500) },
      );
    }
    return payload as T;
  }

  private raw(args: readonly string[], options: { long?: boolean; cwd?: string } = {}) {
    return this.runner.run({
      args,
      timeoutMs: options.long
        ? this.options.longTimeoutMs ?? 600_000
        : this.options.timeoutMs ?? 180_000,
      ...((options.cwd ?? this.options.cwd) === undefined ? {} : { cwd: (options.cwd ?? this.options.cwd) as string }),
    });
  }

  /**
   * 把 CLI 的失败翻译成可处置的错误。
   *
   * 登录失效必须单独归类：它既不是参数写错也不是网络问题，
   */
  private toCommandError(args: readonly string[], result: { code: number; stderr: string; stdout: string }) {
    const text = `${result.stderr}\n${result.stdout}`.trim();
    const message = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).pop()
      ?? `canvas ${args[0]} 退出码 ${result.code}`;
    if (/未登录|登录已过期|unauthor|401|token/i.test(message)) {
      return new CanvasAuthError(`小QTV 凭据无效，请重新登录：${message}`);
    }
    return new CanvasCommandError(message, result.code);
  }
}

/**
 * 从可能夹带提示行的 stdout 里取出 JSON。
 *
 * 与 JSON 混在一起。
 *
 * 这里不能简单地"找第一个 `{` 或 `[` 然后 parse"——因为 `[项目范围]` 本身
 * 就以 `[` 开头，会被当成 JSON 数组的起点，整段解析直接失败（这是实测踩到的）。
 * 正确做法是**逐行尝试**：哪一行开始能解析成 JSON，就取哪一行起的内容。
 */
export function extractJson(stdout: string): unknown {
  const text = stdout.replace(/^\uFEFF/, '');
  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const indent = line.length - line.trimStart().length;
      try {
        return JSON.parse(text.slice(offset + indent).trim()) as unknown;
      } catch {
        // 这一行不是 JSON 的起点（例如 `[项目范围] …` 提示），继续往下找
      }
    }
    offset += line.length + 1;
  }
  return null;
}
