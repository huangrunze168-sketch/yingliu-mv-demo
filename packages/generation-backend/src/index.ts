/* ============================================================
   期音科技 · 生成后端端口
   ------------------------------------------------------------
   为什么必须有这一层：生成服务真正在乎的只有三件事——
   「给我一张图」「给我一段视频」「花了多少」。至于这些是画布节点、
   异步任务还是 HTTP 调用，是**后端自己的事**。

   意味着改服务层代码。而现实是：本机同时装着 小QTV 与图像生成服务两套 CLI，
   两者的执行模型完全不同——

     小QTV   画布/节点：upload → node create → node --run → download
     图像生成服务     异步任务：submit（拿 submit_id）→ query_result 轮询 → 下载

   差异全部被这个端口吸收：闸门、预算、入库、结清、单镜失败隔离
   这些**产品逻辑**一行都不用改。
   ============================================================ */

/** 一个模型参数的值：能落到命令行 `--set key=value` 上的三种标量 */
export type BackendSettingValue = string | number | boolean;

/**
 * 模型参数透传（键是**后端字段名**）。
 *
 * 为什么要有这一层：画布的参数面板收的是一整包参数（提示词、比例、时长、音色、语速…），
 * 而各家后端认的键各不相同。这个端口**不认识参数语义**，只负责把它们交给后端。
 *
 * 三条如实说明：
 *   · 键名由调用方保证是后端字段名（`originalField` 那一套），这一层不做映射；
 *   · **后端必须自己按模型能力收敛参数**。小QTV 的 CLI 会按模型 schema 校验 `-s`：
 *     键不认识、取值不在枚举里，都会直接拒绝整条 `node create`（实测，2026-09）——
 *     不是忽略。所以那家后端自己做了 `param-normalize`；换一家后端要照做。
 *   · 这一层仍然**保证不了**后端真的用了它：参数被后端接受 ≠ 模型照做了。
 *     要证明后者，只能拿真实生成对比（花钱）。
 */
export type BackendSettings = Record<string, BackendSettingValue>;

export interface BackendImageRequest {
  /** 提示词。 */
  prompt: string;
  /**
   * 模型标识。各家语义不同：小QTV 要的是**显示名**（`Z-image Turbo`），
   * 图像生成服务要的是 model_version（`5.0`）。后端负责把差异吃掉。
   */
  model: string;
  /** 画幅比，如 `9:16`。省略时由后端按自己的规矩决定。 */
  ratio?: string;
  /** 清晰度档位，如 `1K`（小QTV）或 `2k`（图像生成服务）。 */
  quality?: string;
  /** 产物落盘目录；调用方保证它已存在。 */
  outputDir: string;
  /** 人类可读的标签，通常是 shot_id；后端用它拼资源名。 */
  label: string;
  /**
   * 参考图的**绝对**路径（可选）：构图蓝图或某张已选定的首帧。
   *
   * 为什么由调用方给路径、而不是给 artifact_id：这一层不认识领域模型，
   * 它只知道"文件在哪"。artifact → 路径的解析在主进程侧完成
   * （那边才知道项目工作目录）。
   *
   * **后端必须如实处理这个字段**：接了参考图就真的把它当参考传下去；
   * 这家后端做不到时**报错**，不能默默忽略——静默忽略会让用户以为
   * "按蓝图生成的"，而出来的图跟蓝图毫无关系。
   */
  referenceImageFile?: string;
  /**
   * **有序的**多张参考图（VID-010「受控多参考槽位顺序」）。

   * 顺序即语义：第 1 张是首要身份参考，后面依次是补充参考
   * （小QTV 的提示词里就是这么说的——「使用提示词中给出的编号参考图作为主体身份和外观参考」）。
   * 所以这里用**数组**而不是集合：顺序变了就是另一次生成，摘要也跟着变。

   * 它与 `referenceImageFile` 的关系：后者是单图时代的字段，仍然保留，
   * 但只要给了数组就以数组为准。后端的支持程度不一样（见各适配器的 note），
   * **只支持一张的后端必须把"只用了第 1 张"写进 `notes`**——
   * 悄悄只用第一张，用户会以为另外几张也生效了。
   */
  referenceImageFiles?: readonly string[];
  /** 模型参数透传（见 BackendSettings 的说明） */
  settings?: BackendSettings;
}

export interface BackendVideoRequest {
  /** 首帧图片的**绝对**路径。 */
  imageFile: string;
  prompt?: string;
  model: string;
  /** 目标时长（秒）。各家有各自的合法区间，后端负责夹取或拒绝。 */
  durationSeconds: number;
  ratio?: string;
  resolution?: string;
  outputDir: string;
  label: string;
  /** 模型参数透传（见 BackendSettings 的说明） */
  settings?: BackendSettings;
}

/**
 * 视频重拍（小QTV 叫 `videoEdit2video`）：以**已有片段**为输入，
 * 按提示词做一次局部重生成，产出替换用的新片段。
 *
 * 与 `BackendVideoRequest`（图生视频）的区别不只是"输入换成视频"：
 * 重拍的**时长与画幅跟随输入片段**，不由我们指定——小QTV 的 tool_spec 里，
 * 这个模式挂的是 `duration_auto` 与 `ratio_auto`（见 settings.videoEdit2video），
 * 而单图生视频挂的是 `duration` 与 `ratio`。所以这里不给时长参数，
 * 给了反而会落到一个该模式不认识的字段上。
 */
export interface BackendVideoGenerationRequest {
  prompt: string;
  model: string;
  modeType: 'text2video' | 'singleImage2video' | 'frames2video' | 'image2video' | 'mixed2video' | 'videoEdit2video';
  references: readonly { path: string; mediaType: string }[];
  durationSeconds: number;
  ratio?: string;
  resolution?: string;
  outputDir: string;
  label: string;
  settings?: BackendSettings;
}

export interface BackendVideoEditRequest {
  /** 原片段的**绝对**路径。 */
  videoFile: string;
  /** 要改什么。重拍必须有提示词——没有它就没有"重拍成什么样"的依据。 */
  prompt: string;
  model: string;
  resolution?: string;
  outputDir: string;
  label: string;
}

/**
 * 音频生成请求（配音 / 音乐）。

 * 与图片/视频那条路的区别：音频**不绑镜头**，所以请求里没有 shot 相关字段；
 * 产出也不进"候选"而是进**音轨**（见 compose-clips 的 audioTracks）。
 */
export interface BackendAudioRequest {
  /** `speech` = 文本转语音；`music` = 文本生成音乐 / BGM */
  kind: 'speech' | 'music';
  /** 配音是台词；音乐是风格/情绪描述 */
  prompt: string;
  model: string;
  /** 期望时长（秒）。后端可以夹取或拒绝，但必须把改动写进 notes。 */
  durationSeconds: number;
  /** 音色 / 风格等后端自有参数，原样透传 */
  settings?: BackendSettings;
  outputDir: string;
  label: string;
}

/**
 * 供应商报出的花费。
 *
 * 单位必须跟着数字走：小QTV 不报花费，图像生成服务报的是**积分**（`credit_count`），
 * 而积分与人民币的换算并未公开。把 3 个积分当成 3 分钱写进账目是错的，
 * 所以这里保留原单位，由调用方决定怎么记。
 */
export interface ProviderCost {
  amount: number;
  unit: 'credit' | 'cent';
}

/**
 * 把参数的三类处理结果拼成给用户看的句子（两家后端共用同一套措辞）。
 *
 *   dropped  —— 该模型 schema 里没有这个键，没发出去
 *   adjusted —— 取值被规范化或夹取过（例如 1080P → 1080p、时长 99 → 30）
 *   ignored  —— 这家后端压根不支持按参数透传，整包被忽略了
 *
 * 为什么必须说出来：这些都是"用户设了、但没按他设的来"的情况。
 * 悄悄处理掉正是这个仓库最反对的做法——他会以为生效了。
 */
export function describeParameterNotes(input: {
  dropped?: readonly string[];
  adjusted?: readonly { key: string; from: unknown; to: unknown; why: 'enum' | 'clamp' }[];
  ignored?: readonly string[];
}): string[] {
  const notes: string[] = [];
  for (const key of input.dropped ?? []) {
    notes.push(`参数「${key}」这个模型不认识，已跳过`);
  }
  for (const item of input.adjusted ?? []) {
    notes.push(item.why === 'enum'
      ? `参数「${item.key}」的取值按模型的写法改成了 ${String(item.to)}（你设的是 ${String(item.from)}）`
      : `参数「${item.key}」超出模型允许的范围，已夹到 ${String(item.to)}（你设的是 ${String(item.from)}）`);
  }
  if ((input.ignored ?? []).length > 0) {
    notes.push(`这家生成后端暂不支持按参数透传，已忽略：${(input.ignored ?? []).join('、')}`);
  }
  return notes;
}

export interface BackendMedia {
  /** 落盘文件的绝对路径，按后端返回的顺序。 */
  files: string[];
  /** 供应商侧原始 URL；仅作记录，不进入领域协议。 */
  source_url: string | null;
  /** 后端侧任务标识（图像生成服务 submit_id / 小QTV 节点名），便于人工追查。 */
  task_ref: string | null;
  /** 后端报出的花费；`null` 表示它不提供计费信息——这与「花费为 0」是两件事。 */
  cost: ProviderCost | null;
  /**
   * 后端对**参数**做的调整，给用户看的一句话。
   *
   * 为什么要有它：小QTV 的 CLI 会按模型 schema 校验参数（键不认识、取值不在枚举里
   * 都会拒绝整条 create）。我们的做法是**在发出去之前收敛**——丢掉该模型不认的键、
   * 把取值规范到 schema 的写法。但"悄悄丢掉"正是这个仓库最反对的事：
   * 用户设了 `resolution=4K` 而模型只到 1080p，他必须知道自己设的那个没生效。
   *
   * 形如 `['参数 resolution 的取值 4K 该模型不支持，已跳过']`。
   * 没有调整时是空数组（不是 undefined）——省得调用方再判一次。
   */
  notes: string[];
}

export interface GenerationBackend {
  /** 稳定标识，用于在项目里记住「这一批是谁生成的」。 */
  readonly id: string;
  /** 给人看的名字。 */
  readonly label: string;
  /**
   * 这套后端支持哪些能力。
   *
   * 为什么做成**数据**而不是让调用方试一次：界面要在用户点下去之前就知道
   * "这个后端能不能重拍"。靠 try/catch 发现的话，用户已经点了，
   * 而失败可能发生在扣费之后。
   */
  readonly capabilities: GenerationCapabilities;
  generateImage(request: BackendImageRequest): Promise<BackendMedia>;
  generateVideoFromImage(request: BackendVideoRequest): Promise<BackendMedia>;
  generateVideo?(request: BackendVideoGenerationRequest): Promise<BackendMedia>;
  /**
   * 视频重拍。后端不支持时必须抛 `UnsupportedCapabilityError`，
   * 而不是返回一段没经过重拍的视频——那会让用户以为改动生效了。
   */
  editVideo(request: BackendVideoEditRequest): Promise<BackendMedia>;
  /**
   * 在一张图上执行一个**场景化能力**（小QTV 的 `image shortcut`）。
   *
   * 与 `generateImage`（按提示词生成）的区别是：这类能力的产出方式由后端决定，
   * 我们只能选"用哪一项"（多机位九宫格 / 角色三视图 / 光影校正…），
   * 改不了它内部怎么做。所以请求里只有一个 `scene`，没有 prompt。
   */
  /**
   * 音频生成（配音 / 音乐）。后端不支持时必须抛 `UnsupportedCapabilityError`，
   * 而不是返回一段静音音频——那会让用户以为"生成了但没声音"。
   */
  generateAudio(request: BackendAudioRequest): Promise<BackendMedia>;
  applyImageShortcut(request: BackendImageShortcutRequest): Promise<BackendMedia>;
  /**
   * 图片高清放大。不支持的后端必须抛 `UnsupportedCapabilityError`，
   * 而不是把原图复制一份返回——那会让用户以为放大了。
   */
  upscaleImage(request: BackendImageUpscaleRequest): Promise<BackendMedia>;
}

/** 图片场景化能力的请求。 */
export interface BackendImageShortcutRequest {
  /** 源图的**绝对**路径。 */
  imageFile: string;
  /** 场景 id（来自 `image shortcut list` 的 `scene` 字段）。 */
  scene: string;
  outputDir: string;
  label: string;
}

/**
 * 图片高清放大（小QTV 界面里的「高清」）。
 *
 * 与 `applyImageShortcut` 的区别：那一类是"风格 / 版式"场景（多机位九宫格、
 * 三视图…），这一件只做一件事——把图放大到更高的清晰度档，输出是同一张图的
 * 高清版本。
 *
 * 档位取值随后端不同，所以这里收**字符串**而不是枚举：
 * 图像生成服务 `image_upscale` 的 `--resolution_type` 只认 `2k|4k|8k`
 * （`imagegen image_upscale -h` 实测），小QTV 界面上那两档叫「2倍高清 / 4倍高清」。
 * 写成枚举就得让两边共用一个并不存在的"通用档位表"。
 */
export interface BackendImageUpscaleRequest {
  /** 源图的**绝对**路径。 */
  imageFile: string;
  /** 目标清晰度档；省略时用后端自己的默认档。 */
  resolution?: string;
  outputDir: string;
  label: string;
}

export interface GenerationCapabilities {
  image: boolean;
  videoFromImage: boolean;
  /** 视频重拍（以已有片段为输入、按提示词局部重生成） */
  videoEdit: boolean;
  /** 图片场景化能力（多机位九宫格 / 三视图 / 光影校正…） */
  imageShortcut: boolean;
  /** 图片高清放大（小QTV 界面里的「高清」） */
  imageUpscale: boolean;
  /**
   * 文本转语音（配音）。

   * 当前**三家内置后端都不支持**（它们的能力面里没有音频），
   * 所以这一位的主要用途是让**签名插件**能声明它——
   * 声明了才会出现在后端列表里、才会被允许调用（见 AUD-001/AUD-002 的说明）。
   * 本机那条免费路径（Windows 系统语音）不走这个端口，它在前端面板里直接可用。
   */
  audioSpeech: boolean;
  /** 文本生成音乐 / BGM。理由同上：内置三家都没有，留给插件声明。 */
  audioMusic: boolean;
}

export const CAPABILITY_LABELS: Readonly<Record<keyof GenerationCapabilities, string>> = {
  image: '文生图 / 图生图',
  videoFromImage: '图生视频',
  videoEdit: '视频重拍（以已有片段为输入）',
  imageShortcut: '图片场景化能力（多机位 / 三视图 / 光影校正…）',
  imageUpscale: '图片高清放大',
  audioSpeech: '文本转语音（配音）',
  audioMusic: '文本生成音乐 / BGM',
};

/** 后端明确不支持某项能力。错误信息是给人看的，会直接显示在界面上。 */
export class UnsupportedCapabilityError extends Error {
  constructor(readonly backendLabel: string, readonly capability: keyof GenerationCapabilities) {
    super(`${backendLabel} 不支持这项能力：${CAPABILITY_LABELS[capability]}`);
    this.name = 'UnsupportedCapabilityError';
  }
}
