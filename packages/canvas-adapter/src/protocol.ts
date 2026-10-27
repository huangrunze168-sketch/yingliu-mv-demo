/* ============================================================
   期音科技 · 小QTV CLI 输出契约
   ------------------------------------------------------------
   只声明本适配器真正消费的字段。

   例如 `project create` 会在 JSON 之前打印一行 `[项目范围] …` 提示，
   `node <名> --run` 会先打印 `[run] task=… status=… progress=…`。
   所以适配器不能直接 JSON.parse(stdout)，必须先定位 JSON 起点。
   ============================================================ */

export type CanvasModality = 'text' | 'image' | 'video' | 'audio' | 'script' | 'storyboard';

/**/
export interface CanvasAccountInfo {
  user?: { uuid?: string; id?: number; nickname?: string };
  activeAccount?: {
    accountId?: number;
    accountName?: string;
    memberAccount?: { memberName?: string; accountLevel?: number; effective?: boolean };
  };
}

export interface CanvasWorkspace {
  id: string | number;
  name?: string;
  description?: string;
  fileCnt?: number;
}

export interface CanvasProject {
  uuid: string;
  name?: string;
  folderId?: string | number;
  projectSpaceId?: string | number;
}

export interface CanvasModelMatch {
  modelKey: string;
  modelName: string;
  description?: string;
  supportModality?: unknown;
}

export interface CanvasModelSearchResult {
  query?: string;
  matchKind?: string;
  nodeType?: string;
  matches: CanvasModelMatch[];
}

/**
 *
 * 只声明我们用到的部分——但**用到的那两处很关键**：
 *   · `schema.properties.modeType.items` 的键 = 这个模型支持哪些生成模式
 *     （`singleImage2video` / `videoEdit2video` / `videoExtend2video` …）；
 *   · `schema.config.settings[modeType]` = 该模式下**要写哪些参数**。
 * 有了它，"这个模型能不能重拍"就不再靠猜，而是提交前就能回答的问题。
 */
export interface CanvasModelSchemaResult {
  nameOrId: string;
  modelName: string;
  modelKey: string;
  toolKey?: string;
  modality?: CanvasModality;
  schema?: {
    modelName?: string;
    modelVendor?: string;
    properties?: Record<string, CanvasModelProperty>;
    config?: { settings?: string[] | Record<string, string[]>; advancedSettings?: string[]; generateTypes?: Record<string, unknown> };
    rules?: unknown[];
  };
}

/**
 *
 * 为什么会需要它：**CLI 会按这份 schema 校验 `-s` 的键与取值**（实测）——
 * 键不认识、取值不在枚举里，都会直接「校验失败」而不是忽略。
 * 所以"我们发什么"必须按这份表收敛一次，否则真实生成会被自己的参数打断。
 */
export interface CanvasModelProperty {
  displayName?: string;
  /** 提交时用的字段名；与属性键不同的情况确实存在 */
  originalField?: string;
  component?: string;
  /** 枚举项可能是对象（value + displayName），也可能直接是值 */
  enum?: Array<{ value?: unknown; displayName?: string } | string | number | boolean>;
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  /** 媒体类字段用它描述"每个模式要几个" */
  items?: Record<string, unknown>;
}

/**
 * 这个模型支持哪些生成模式。
 *
 * **这张表只列"需要输入素材"的模式**——值就是该模式的输入数量区间
 * （`videoEdit2video: [1,1]` = 恰好要 1 个视频输入；`image2video: [1,30]` = 1~30 张图）。
 * 这一点是被测试逼出来的：`text2video` 不在表里，因为它不需要素材，
 * 而它在 `config.settings` 里是有的。把两者混为一谈，就会得出
 * "这个模型不支持文生视频"的错误结论。
 *
 * 拿不到 schema（模型名拼错、CLI 版本不同、网络失败）时返回**空数组**：
 * 调用方据此如实说"查不到能力"，而不是当成"支持"放过去。
 */
export function supportedModeTypes(result: CanvasModelSchemaResult): string[] {
  const items = result.schema?.properties?.modeType?.items;
  return items === undefined ? [] : Object.keys(items);
}

/**
 * 某个模式需要几个输入素材（`[最少, 最多]`）。
 *
 * 查不到就返回 null——调用方据此**不假设**输入数量，而不是当成 `[0, 无穷]`。
 * 重拍这类"恰好要 1 个视频"的模式靠它判断输入够不够。
 */
export function modeInputRange(result: CanvasModelSchemaResult, modeType: string): [number, number] | null {
  const value = result.schema?.properties?.modeType?.items?.[modeType];
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [min, max] = value as unknown[];
  if (typeof min !== 'number' || typeof max !== 'number') return null;
  return [min, max];
}

/** 这个模式下界面上会出现的参数名（`config.settings[mode]`）。查不到就返回空数组。 */
export function settingsForMode(result: CanvasModelSchemaResult, modeType: string): string[] {
  const settings = result.schema?.config?.settings;
  if (Array.isArray(settings)) return settings;
  return settings?.[modeType] ?? [];
}

export interface CanvasNodeResult {
  nodeKey: string;
  nodeType?: string;
  taskId?: string;
  status?: number;
  data?: {
    name?: string;
    url?: string[];
    params?: Record<string, unknown>;
    taskInfo?: { taskId?: string; status?: number; progressPercent?: number; loading?: boolean };
  };
}

/**
 *
 * 实测拿到 16 项（多机位九宫格 / 角色三视图 / 设定图 / 25宫格连贯分镜 /
 * 电影级光影校正 / 画面推演…）。CLI 的原话是"与画布图片生成器输入 `/`
 * 及图片工具栏九宫格一致"——也就是说这份清单就是 小QTV 界面上那些图片工具。
 *
 * 这些**不是提示词包装**：每一项在 CLI 里是一个 `scene`，
 * 由后端按自己的流程执行。我们只能选择"用哪一项"，不能改它内部怎么做。
 */
export interface CanvasImageShortcut {
  scene: string;
  label: string;
  explain?: string;
}

export interface CanvasImageShortcutList {
  nodeType?: string;
  items: CanvasImageShortcut[];
}
