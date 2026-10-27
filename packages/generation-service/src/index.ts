import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ProjectService } from '@qiyin/domain';
import type { BackendSettings, GenerationBackend, ProviderCost } from '@qiyin/generation-backend';
import { UnsupportedCapabilityError } from '@qiyin/generation-backend';
import { subjectPromptFragment } from '@qiyin/contracts';
import {
  buildDirectorStagingPrompt,
  type StagingCamera,
  type StagingSubject,
} from './directorStagingPrompt.js';

/* ============================================================
   期音科技 · 生成服务（S5）
   ------------------------------------------------------------
   这是产品里**第一个真正花钱的动作**，因此流程比别处更重：

     ① 领域层登记意图并**预留预算**（G1 未批准则拒绝）
     ② 调 小QTV 真实生成
     ③ 下载产物、按内容哈希入库、登记为候选
     ④ 结清意图：把「预估预留」换成「实际花费」，差额退回

   第 ④ 步不能省。少了它，项目预算只会单调往上爬，
   用户看到的是一个永远在减少、却没有任何东西被释放的数字。
   ============================================================ */

export interface ShotImageRequest {
  shot_id: string;
  /** 该镜的生成提示词，通常来自 ShotFields → PromptBundle 的派生结果。 */
  prompt: string;
}

/**
 * 执行摘要：把"决定这张图长什么样的输入"折成一个字符串。
 *
 * 只有一个用途：判断"这次请求和历史上哪一次是同一件事"。相同就可以复用结果、
 * 不花第二次钱（见 `FLOW-006 缓存与历史结果显式复用`）。
 *
 * 几处刻意的选择：
 *   · **提示词不 trim**：多一个空格就是另一次输入。保守一点只会多花一次钱，
 *     而"宽松比较"会让不该命中的命中——那更难发现；
 *   · 参考图用**内容哈希**（artifact_id）而不是路径：同一张蓝图换个目录存，
 *     它还是同一张图；
 *   · 带 `v: 1`：以后改了口径要能一次性作废旧摘要，而不是让新旧混着比。
 *
 * **已知限制（写在这里，不假装没有）**：摘要里没有 CLI 自己的版本号。
 * 供应商换了模型实现、或者用户升级了 CLI，摘要不会变，于是可能命中一份
 * "用旧模型跑的"结果。小QTV 的 CLI 没有稳定的版本输出，编一个号进去
 * 只会给人"已经防住了"的错觉。要真解决得先有可用的版本来源。
 */
export function imageExecutionDigest(input: {
  backendId: string;
  model: string;
  prompt: string;
  ratio?: string;
  quality?: string;
  referenceArtifactId?: string | null;
  /**
   * 主体正脸参考图的 artifact_id（ASSET-002）。

   * 只在**真的带了**这张图时传进来：不传时序列化结果与以前逐字相同，
   * 于是历史缓存不会因为这次改动集体失效（那会让用户白花一遍钱）。
   */
  subjectReferenceArtifactId?: string | null;
  /**
   * 有序的多张参考图（VID-010）。

   * 只在**真的有多张**时才传：单张的序列化结果与以前逐字相同，
   * 历史缓存不会因为这次改动集体失效（那会让用户白花一遍钱）。
   * 顺序参与摘要——把第 1 张与第 2 张对调，是另一次生成。
   */
  referenceArtifactIds?: readonly string[];
}): string {
  const canonical = JSON.stringify({
    v: 1,
    backend: input.backendId,
    model: input.model,
    prompt: input.prompt,
    ratio: input.ratio ?? null,
    quality: input.quality ?? null,
    reference: input.referenceArtifactId ?? null,
    ...(input.subjectReferenceArtifactId === undefined ? {} : { subjectReference: input.subjectReferenceArtifactId }),
    ...(input.referenceArtifactIds === undefined ? {} : { referenceImages: [...input.referenceArtifactIds] }),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * 视频那条路的执行摘要。
 *
 * 与图片版同一套口径，只是"决定这段视频长什么样"的输入不同：
 * 首帧、时长、清晰度。**首帧用内容哈希**（artifact_id），
 * 而不是候选 id 或文件路径——换一次选帧、但选到的是同一张图，那还是同一次请求；
 * 反之，同一个候选被重新抽成另一张图，摘要必须变。
 */
export function videoExecutionDigest(input: {
  backendId: string;
  model: string;
  prompt?: string;
  durationSeconds: number;
  ratio?: string;
  resolution?: string;
  firstFrameArtifactId?: string | null;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    backend: input.backendId,
    model: input.model,
    prompt: input.prompt ?? null,
    duration: input.durationSeconds,
    ratio: input.ratio ?? null,
    resolution: input.resolution ?? null,
    first_frame: input.firstFrameArtifactId ?? null,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export interface GeneratedShotImage {
  shot_id: string;
  candidate_id: string;
  artifact_id: string;
  /** 相对 workspace 的路径，可被成片流程直接使用。 */
  frame_path_relative: string;
  bytes: number;
  /** 服务商返回的原图 URL；仅作记录，不进入领域协议。 */
  source_url: string | null;
  /** 后端侧任务标识（图像生成服务 submit_id / 小QTV 节点名），便于人工追查。 */
  task_ref: string | null;
  /** 后端报出的花费；`null` 表示它不提供计费信息——不是「花了 0 元」。 */
  provider_cost: ProviderCost | null;
  /**
   * 后端对参数做的调整，原样带给界面（没有调整时这个字段不出现）。
   *
   * 有它才会有那句"你设的 resolution=4K 这个模型不支持，已跳过"——
   * 没有它，参数被悄悄收敛掉，用户只会觉得"设了没用"。
   */
  parameter_notes?: string[];
  /**
   * 这一张是从已有结果复用来的（没有调用后端、没有花钱）。
   *
   * 界面要据此如实措辞："复用 2 张"与"生成 2 张"是两件事，
   * 混在一起用户会以为钱花出去了。
   */
  reused?: boolean;
  /** 复用的来源意图；只有 `reused` 为真时有值。 */
  reused_from_intent_id?: string;
}

/**
 * 逐镜进度：**每跑完一镜报一次**（`done` 从 1 开始；`done === total` 就是全部跑完）。
 *
 * 失败的那一镜也要报——不报的话界面上那个"2/5"会卡在中间不动，
 * 看起来像卡死，而实际上后面几镜还在跑。
 */
export interface GenerationProgress {
  done: number;
  total: number;
  /** 刚跑完的这一镜 */
  shotId: string;
  /** 这一镜成没成 */
  ok: boolean;
}

export interface GenerateShotImagesRequest {
  projectId: string;
  expectedRevision: number;
  /**/
  canvasCwd: string;
  /** 产物落盘根目录（会在其下建 frames/<批次>/）。 */
  workspaceDir: string;
  shots: readonly ShotImageRequest[];
  /** 小QTV 模型**显示名**（如 `Z-image Turbo`）——CLI 不接受 modelKey。 */
  model: string;
  ratio?: string;
  quality?: string;
  /**
   * 模型参数透传（键是后端字段名）。
   *
   * 画布的参数面板收到的**一整包**参数（比例、时长、音色、语速、音效…）走这里下去。
   * 与上面 ratio/quality 的关系：那两个是"产品级必填项"，有专门的语义与默认值；
   * settings 是**其余参数**的透传通道。同名冲突时上面那两个优先（它们是产品决定的值）。
   */
  settings?: BackendSettings;
  /** 单张图的预估成本（分）。用于预算预留；实际成本由调用方在结清时给出。 */
  estimatedCostCents?: number;
  /** 单张图的实际成本（分）。省略时按预估计。 */
  actualCostCents?: number;
  /**
   * 批次标签（可选）。同一毫秒内连开两批时，候选 id 会撞车（`cand-<镜>-<批次>`），
   * 表现为第二批第一张就报"候选已存在"。

   * 换机位批量生成就是要**连着开好几批**（每个机位一批），所以调用方可以给一个标签
   * （例如机位 id），让批次 id 天然不同。不给也照旧工作（老调用方不受影响）。
   */
  batchLabel?: string;
  /**
   * 这一镜的构图蓝图要不要作为参考图传下去（默认要）。
   *
   * 做成开关而不是写死：导演台截的蓝图是"这一镜该怎么摆"的留档，
   * 大多数时候正是用户想要的输入；但同一套提示词也可能要跑一条
   * "完全自由发挥"的对照，那时蓝图反而是干扰。
   */
  useBlueprintAsReference?: boolean;

  /**
   * 逐镜进度回调（可选）。
   *
   * 为什么要有它：真后端一镜要几十秒到几分钟，而这条调用是**阻塞**的——
   * 没有心跳的话，界面上从头到尾只有一行「正在生成」，用户没法判断它是在跑还是卡死了
   * （小QTV 那边是「图片节点创建中」这类推进）。
   *
   * 语义写清楚，免得调用方猜：**每跑完一镜报一次**（成功或失败都报），
   * 最后一镜的那次就是"全部跑完"。它在服务层是纯粹的旁路——抛错、返回什么都不影响主流程。
   */
  onProgress?: (progress: GenerationProgress) => void;
  /**
   * 要不要在生成前先找可复用的历史结果（默认要）。
   *
   * 关掉它的场景很具体：用户就是想再跑一次同样的提示词看看会不会有别的结果
   * （模型有随机性），而复用会把上一次的结果原样端回来。
   */
  reuseResults?: boolean;
  actor?: string;
}

export interface GenerateShotImagesOutcome {
  generated: GeneratedShotImage[];
  failures: Array<{ shot_id: string; reason: string; kind: FailureKind }>;
  projectRevision: number;
}

export interface ShotVideoRequest {
  shot_id: string;
  /** 已选定首帧的图片文件，相对 workspace。 */
  image_path_relative: string;
  /** 目标时长（秒）；图生视频模型通常限制 4–15 秒。 */
  duration_seconds: number;
  /** 运动/运镜提示词，通常来自该镜的 camera_move。 */
  prompt?: string;
}

/**
 * 视频续写（VID-006）的请求。

 * `firstFrameFile` 是**上一段成片的尾帧**（由调用方用 ffmpeg 取出来）。
 * 为什么不在这里取帧：取帧是 ffmpeg 的活，属于内核那一层；
 * 生成服务只负责"把这帧交给后端、把产物收回来登记"。
 */
export interface ContinueClipRequest {
  projectId: string;
  expectedRevision: number;
  workspaceDir: string;
  /** 上一段的尾帧（绝对路径，必须是已存在的文件） */
  firstFrameFile: string;
  prompt: string;
  model: string;
  durationSeconds: number;
  resolution?: string;
  ratio?: string;
  estimatedCostCents?: number;
  actualCostCents?: number;
  label?: string;
  actor?: string;
}

export type ContinueClipOutcome =
  | {
    ok: true;
    /** 作为输入的尾帧产物 id（出问题时要能追到是哪一帧） */
    frameArtifactId: string;
    /** 续写出来的新片段产物 id */
    clipArtifactId: string;
    file: string;
    bytes: number;
    cost: ProviderCost | null;
    notes: string[];
    projectRevision: number;
  }
  | { ok: false; reason: string };

export interface GenerateShotVideosRequest {
  projectId: string;
  expectedRevision: number;
  canvasCwd: string;
  workspaceDir: string;
  shots: readonly ShotVideoRequest[];
  /** 逐镜进度回调（与出图同一条语义，见 GenerationProgress） */
  onProgress?: (progress: GenerationProgress) => void;
  /** 小QTV 模型显示名（如 `Seedance 2.0 Mini`）。 */
  model: string;
  resolution?: string;
  /** 模型参数透传（键是后端字段名）；与 ratio/resolution 同名时后者优先 */
  settings?: BackendSettings;
  /**
   * 画幅比例（如 `9:16`）。
   *
   * 省略时用 `adaptive`：**跟随首帧自己的画幅**。这是唯一不会「安静产错画幅」的
   * 缺省值——模型默认的 16:9 会把竖屏首帧变成横屏（实测：540×960 首帧
   * → 864×496 成片），画幅一变，后面按参考画布做的偏差评估就全部失去意义。
   *
   * 调用方若已从参考片探测出画布，应当用 `frameRatio()` 显式传入，
   * 那比「跟随首帧」更准：首帧本身也可能是 1:1 生成出来的。
   */
  ratio?: string;
  estimatedCostCents?: number;
  actualCostCents?: number;
  /** 要不要在生成前先找可复用的历史片段（默认要，与出图同一条规矩） */
  reuseResults?: boolean;
  actor?: string;
}

export interface GeneratedShotVideo {
  shot_id: string;
  artifact_id: string;
  frame_path_relative: string;
  bytes: number;
  duration_seconds: number;
  source_url: string | null;
  task_ref: string | null;
  provider_cost: ProviderCost | null;
  /** 这一段是从已有结果复用来的（没有调用后端、没有花钱） */
  reused?: boolean;
  /** 复用的来源意图；只有 `reused` 为真时有值 */
  reused_from_intent_id?: string;
}

export interface GenerateShotVideosOutcome {
  generated: GeneratedShotVideo[];
  failures: Array<{ shot_id: string; reason: string; kind: FailureKind }>;
  projectRevision: number;
}

/**
 * 视频重拍：拿**已有片段**按提示词重做一遍，产出替换用的新片段。
 *
 * 与整批生成分开一个方法，而不是给 `generateShotVideos` 加个开关：
 * 两者的前置条件不同（重拍要"这一镜已经有片段"，生成要"已经选好首帧"），
 * 且后果不同（重拍会**替换**当前片段）。塞进同一个方法里，
 * 两种前置条件会互相污染——生成时要求"已有片段"，或者重拍时把没选帧的镜头也带上。
 */
export interface RetakeShotVideoRequest {
  projectId: string;
  expectedRevision: number;
  workspaceDir: string;
  shotId: string;
  /** 原片段相对 workspace 的路径。 */
  sourcePathRelative: string;
  /** 原片段的 artifact_id；回执里要说清"替换掉的是哪一份"。 */
  sourceArtifactId: string | null;
  /**
   * 这一镜原本的时长（秒）。
   *
   * 重拍的**实际时长跟随输入片段**（小QTV 的 videoEdit2video 用 duration_auto），
   * 这个值只是领域层记录用的——不然 `video-generation.request` 缺一个必填字段，
   * 而那个字段的真实来源是"上一版片段有多长"，不该由这里另编一个。
   */
  durationSeconds: number;
  model: string;
  /** 要改什么。空提示词在这一层就拒绝——没有它就没有"重拍成什么样"的依据。 */
  prompt: string;
  resolution?: string;
  estimatedCostCents?: number;
  actualCostCents?: number;
  actor?: string;
}

/**
 * 重拍要求片段**不少于 4 秒**。
 *
 * 依据是 小QTV 自己的提示词条：
 * `segmentRemakeDurationLimit=当前仅支持时长不少于 4 秒的视频进行片段重拍`。
 * 提前拦下来比让 CLI 报一句更近——而且这一句是**用户能直接照做的**
 * （"换一段更长的"，而不是"参数不合法"）。
 */
export const MIN_RETAKE_SECONDS = 4;

export interface RetakeShotVideoOutcome extends GeneratedShotVideo {
  /** 被替换掉的那一份；没有就为 null。 */
  replaced_artifact_id: string | null;
  /** 结清之后的项目 revision，调用方据此刷新快照 */
  projectRevision: number;
}

/**
 * 在某一镜的图上执行一个**场景化能力**（多机位九宫格 / 三视图 / 光影校正…）。
 *
 * 与 `generateShotImages`（按提示词出图）的区别：这类能力由后端自己的流程产出，
 * 我们只能选"用哪一项"，所以请求里没有提示词，只有一个 `scene`。
 *
 * 花费照走 G1 与预算闸门（`image-generation.request`）——
 * 它是付费动作，就没有例外。
 */
export interface ApplyImageShortcutRequest {
  projectId: string;
  expectedRevision: number;
  workspaceDir: string;
  shotId: string;
  /**/
  scene: string;
  /** 人可读的场景名，用于记账与回执。 */
  sceneLabel?: string;
  sourcePathRelative: string;
  sourceArtifactId: string;
  estimatedCostCents?: number;
  actualCostCents?: number;
  actor?: string;
}

export interface ApplyImageShortcutOutcome {
  shot_id: string;
  scene: string;
  artifact_id: string;
  frame_path_relative: string;
  bytes: number;
  source_url: string | null;
  task_ref: string | null;
  provider_cost: ProviderCost | null;
  projectRevision: number;
}

/**
 * 图片高清放大（小QTV 界面上的「高清」）。
 *
 * 与场景能力同一条账（`image-generation.request` → 真实调用 → 产物入库 → settle），
 * 产物同样**不登记为候选**：一张放大的图不是"这一镜的首帧"的备选，
 * 它是同一张图的更清晰那份。
 */
export interface UpscaleImageRequest {
  projectId: string;
  expectedRevision: number;
  workspaceDir: string;
  shotId: string;
  sourcePathRelative: string;
  sourceArtifactId: string;
  /** 目标清晰度档。取值随后端（图像生成服务 `image_upscale` 认 2k / 4k / 8k）。 */
  resolution: string;
  estimatedCostCents?: number;
  actualCostCents?: number;
  actor?: string;
}

export interface UpscaleImageOutcome {
  shot_id: string;
  artifact_id: string;
  frame_path_relative: string;
  bytes: number;
  /** 实际用的档位（后端可能夹过值，回执里报的是它真正拿到的那个） */
  resolution: string;
  source_url: string | null;
  task_ref: string | null;
  provider_cost: ProviderCost | null;
  projectRevision: number;
}

/**
 * 失败分类的意义是「下一步该做什么」。
 *
 * `compliance` 是图像生成服务独有的一类：该模型需要先在 Web 端完成一次生成
 * （`AigcComplianceConfirmationRequired`）。重试一万次也不会变好，
 * 只有用户自己去网页上做一次，所以它必须与「参数写错」分开。
 */
export type FailureKind = 'not-installed' | 'auth' | 'compliance' | 'command' | 'protocol' | 'unknown';

/**
 * 这份映射故意放在生成服务边界，保证画布、CLI、批量生成看到同一口径。
 */
export function actionableFailureHint(kind: FailureKind): string {
  switch (kind) {
    case 'not-installed': return '请安装或启用对应的本地生成后端';
    case 'auth': return '请重新登录或检查该 Provider 的凭据';
    case 'compliance': return '请先在 Provider 网页端完成一次合规确认，再重试';
    case 'command': return '请检查模型名、参数与后端日志后重试';
    case 'protocol': return '请检查适配器版本是否与后端协议匹配';
    default: return '请查看详细错误并确认素材、模型与连接状态';
  }
}

function actionableFailureMessage(failure: { message: string; kind: FailureKind }): string {
  return `${failure.message}（下一步：${actionableFailureHint(failure.kind)}）`;
}

/**
 * 结清时该写多少"实际花费"（分）。
 *
 * 只有两个来源算数：
 *   · `billed`  —— 供应商回执里就是人民币（`unit === 'cent'`）；
 *   · `declared` —— 调用方明确给的金额（本机是参数面板按定价源算出来的那个数）。
 *
 * 两个都没有就**什么都不写**（字段留空 = 花费未知）。
 * 以前这里是 `billed ?? actual ?? estimated`，最后一个兜底会把"预估成本"
 * 填进"实际花费"——而供应商此刻可能报的是积分（图像生成服务）、也可能什么都没报（小QTV），
 * 于是账本里那条"实际花费"既不是实际、单位也不对。
 *
 * 供应商原样报了什么，走 `provider_cost` 字段单独记，单位跟着数字一起走。
 */
function settleCostPayload(
  billed: number | undefined,
  declared: number | undefined,
): { actual_cost_cents?: number } {
  const value = billed ?? declared;
  return value === undefined ? {} : { actual_cost_cents: value };
}
/**
 * 模型认识的标准画幅比，按「比值」记录。
 *
 * 图片与视频模型都只接受固定枚举，给一个 540/960 这样的实数没有意义，
 * 因此这里做的是**就近吸附**而不是原样透传。
 */
const SUPPORTED_RATIOS: ReadonlyArray<readonly [literal: string, value: number]> = [
  ['1:1', 1],
  ['9:16', 9 / 16],
  ['3:4', 3 / 4],
  ['4:3', 4 / 3],
  ['16:9', 16 / 9],
  ['21:9', 21 / 9],
];

/**
 * 把画布尺寸折算成模型能接受的画幅比。
 *
 * 为什么必须有这一步：图片与视频模型的 `ratio` **默认都是 16:9**，
 * 而参考片很可能是竖屏。不显式给 ratio，模型会安静地产出横屏——
 * 实测踩到过（首帧 540×960，产出 864×496）。
 *
 * 这不是「复刻得不像」，是根本没对齐：后面按参考画布做的 `canvas_match`
 * 评估会直接判 0，而偏差全部来自我们自己的参数缺省。
 *
 * 距离用比值的对数衡量，因此 9:16 与 16:9 的偏差对称，
 * 不会因为画幅是竖的就天然「离 16:9 更近」。
 */
export function frameRatio(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return '16:9';
  const target = width / height;
  let best = SUPPORTED_RATIOS[0]!;
  let bestDelta = Math.abs(Math.log(target / best[1]));
  for (const entry of SUPPORTED_RATIOS.slice(1)) {
    const delta = Math.abs(Math.log(target / entry[1]));
    if (delta < bestDelta) {
      best = entry;
      bestDelta = delta;
    }
  }
  return best[0];
}

/**
 * 由七字段拼出图片生成提示词。
 *
 * 与领域层 `prompt.derive` 的规则保持一致（景别、机位、光线、替换方案）。
 * 关键是**过滤掉 `unknown`**：它是"还没确认"，不是内容——
 * 把 `unknown` 原样写进提示词，等于让模型去画一个叫 unknown 的东西。
 */
export function imagePromptFromShotFields(shot: Record<string, unknown>): string {
  return [shot.shot_size, shot.camera_position, shot.lighting, shot.replacement]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0 && value !== 'unknown')
    .join('，');
}

/**
 * 从 `plan_json.subjects` 里挑出能用的条目。
 *
 * **宽容解析**：这一行可能来自更早的版本、也可能被手工改过。认不出来的条目跳过，
 * 而不是抛错——为了一个字段形状不对就把整次生成挡下来，代价太大；
 * 而"少描述一个人"最坏也只是这一张图里的人少一个，
 * 用户看得出来，也改得过来。
 *
 * 但**位置必须是三个有限数**：缺了位置的主体没有"摆在哪儿"可说，
 * 拿默认原点是编造一个它并不在的位置。
 */
export function stagingSubjectsFrom(raw: unknown): StagingSubject[] {
  if (!Array.isArray(raw)) return [];
  const result: StagingSubject[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const proxy = item.proxy === 'mannequin' || item.proxy === 'box' ? item.proxy : null;
    if (proxy === null) continue;
    const position = item.position;
    if (!Array.isArray(position) || position.length !== 3) continue;
    if (!position.every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
    const rotation = Array.isArray(item.rotation_deg) && item.rotation_deg.length === 3
      && item.rotation_deg.every((value) => typeof value === 'number' && Number.isFinite(value))
      ? (item.rotation_deg as [number, number, number])
      : undefined;
    result.push({
      subject_ref: typeof item.subject_ref === 'string' ? item.subject_ref : `${proxy}:unknown`,
      proxy,
      position: position as [number, number, number],
      ...(rotation === undefined ? {} : { rotation_deg: rotation }),
      ...(typeof item.pose === 'string' ? { pose: item.pose } : {}),
      ...(typeof item.body_preset === 'string' ? { body_preset: item.body_preset } : { body_preset: null }),
      ...(typeof item.pose_preset === 'string' ? { pose_preset: item.pose_preset } : { pose_preset: null }),
      ...(typeof item.scale === 'number' && Number.isFinite(item.scale) ? { scale: item.scale } : {}),
    });
  }
  return result;
}

/** 契约里的 `camera`：位置 + 看向点。两个都得是三个有限数，缺一个就当没有机位。 */
export function stagingCameraFrom(raw: unknown): StagingCamera | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const triple = (value: unknown): [number, number, number] | null => {
    if (!Array.isArray(value) || value.length !== 3) return null;
    if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null;
    return value as [number, number, number];
  };
  const position = triple(item.position);
  const target = triple(item.target);
  if (position === null || target === null) return null;
  return { position, target };
}

export class GenerationService {
  constructor(
    private readonly projects: ProjectService,
    /**
     * 生成后端。
     *
     * 服务层只认这一件事：「给我一张图 / 一段视频，花了多少」。
     * 画布节点（小QTV）还是异步任务（图像生成服务）都是后端自己的事，
     * 因此换一家生成服务**不需要改这个文件**。
     */
    private readonly backend: GenerationBackend,
  ) {}

  private recordCheckpoint(
    projectId: string,
    intentId: string,
    stage: 'accepted' | 'provider_started' | 'provider_finished' | 'completed' | 'failed',
    checkpoint: Record<string, unknown>,
    providerTaskRef?: string | null,
  ): void {
    try {
      this.projects.recordGenerationCheckpoint(projectId, intentId, stage, checkpoint, providerTaskRef ?? null);
    } catch {
      /* 恢复点写入失败不能反过来弄坏生成任务；领域意图与结算仍以主事务为准。 */
    }
  }

  /**
   * 产物在工作目录里的绝对路径；找不到登记或文件已不在时返回 `null`。
   *
   * 两个键都要认，这是上一轮批量导出踩过的坑：派生类产物写
   * `artifact_path_relative`，生成类写 `frame_path_relative`。
   * 只认一个，另一半就会变成"文件不存在"。
   */
  private artifactFilePath(workspaceDir: string, artifactId: string): string | null {
    /*
      用全局产物表按 id 找，而不是 `listProjectArtifacts`。

      后者只返回**带 `project_id` 元数据**的产物——那是派生类产物（宫格切分等）
      写入的键；生成类产物（候选图/片段）的元数据里没有它。
      这里的 artifactId 来自本项目的候选表，本来就是本项目的，
      所以"按 id 在全局表里取一行"不会张冠李戴。
    */
    const artifacts = this.projects.listArtifacts() as Array<{
      artifact_id: string;
      metadata?: { artifact_path_relative?: unknown; frame_path_relative?: unknown } | null;
    }>;
    const relativePath = artifacts.find((item) => item.artifact_id === artifactId)?.metadata;
    const path = relativePath?.artifact_path_relative ?? relativePath?.frame_path_relative;
    if (typeof path !== 'string' || path.length === 0) return null;
    const absolute = join(workspaceDir, path);
    return existsSync(absolute) ? absolute : null;
  }

  /**
   * 找一条**可以复用**的历史结果；没有就返回 `null`。
   *
   * 判据四连，一个都不能少：
   *   · 同一镜（换镜就是另一件事）
   *   · 那一次成功了（失败的没有产物）
   *   · 摘要逐字相同（决定画面的输入完全一样）
   *   · **产物文件还在**（登记还在但文件被删掉时复用，会得到一张打不开的图）
   *
   * 最后那条是这个功能最容易被忽略的地方：产物可以让用户清理掉，
   * 而领域事实里的候选登记不会因此消失。
   */
  private reusableImage(
    projectId: string, workspaceDir: string, shotId: string, digest: string,
  ): { intentId: string; artifactId: string } | null {
    const intents = this.projects.listImageGenerationIntents(projectId) as Array<{
      intent_id: string; shot_id: string; status: string;
      digest: string | null; candidate_id: string | null;
    }>;
    const candidates = this.projects.listImageCandidates(projectId) as Array<{
      candidate_id: string; artifact_id: string;
    }>;
    for (const intent of intents) {
      if (intent.shot_id !== shotId) continue;
      if (intent.status !== 'COMPLETED') continue;
      if (intent.digest !== digest) continue;
      const artifactId = candidates.find((item) => item.candidate_id === intent.candidate_id)?.artifact_id;
      if (artifactId === undefined) continue;
      if (this.artifactFilePath(workspaceDir, artifactId) === null) continue;
      return { intentId: intent.intent_id, artifactId };
    }
    return null;
  }

  /**
   * 这一镜当前选定的首帧对应的产物 id（内容哈希）；没选帧时返回 `null`。
   *
   * 视频的执行摘要要用它——首帧决定这段视频长什么样，
   * 而"同一张首帧"要按**内容**认，不是按候选 id 或文件路径。
   */
  private firstFrameArtifactId(projectId: string, shotId: string): string | null {
    const project = this.projects.getProject(projectId) as {
      selections?: Array<{ shot_id: string; candidate_id: string }>;
      candidates?: Array<{ candidate_id: string; artifact_id: string }>;
    } | null;
    const candidateId = (project?.selections ?? []).find((item) => item.shot_id === shotId)?.candidate_id;
    if (candidateId === undefined) return null;
    return (project?.candidates ?? []).find((item) => item.candidate_id === candidateId)?.artifact_id ?? null;
  }

  /**
   * 找一条可以复用的历史**片段**；没有就返回 `null`。
   *
   * 与出图那条同一套判据（同镜、成功、摘要相同、文件还在），
   * 区别是产物挂在 `clip_artifact_id` 上——视频没有"候选"这个概念。
   */
  private reusableVideo(
    projectId: string, workspaceDir: string, shotId: string, digest: string,
  ): { intentId: string; artifactId: string } | null {
    const intents = this.projects.listVideoGenerationIntents(projectId) as Array<{
      intent_id: string; shot_id: string; status: string;
      digest: string | null; clip_artifact_id: string | null;
    }>;
    for (const intent of intents) {
      if (intent.shot_id !== shotId) continue;
      if (intent.status !== 'COMPLETED') continue;
      if (intent.digest !== digest) continue;
      const artifactId = intent.clip_artifact_id;
      if (artifactId === null) continue;
      if (this.artifactFilePath(workspaceDir, artifactId) === null) continue;
      return { intentId: intent.intent_id, artifactId };
    }
    return null;
  }

  /**
   * 这一镜的空间方案：蓝图引用 + 站位。没有这一镜、或那行 JSON 读不出来时返回 `null`。
   *
   * 为什么把"解析那一行"收成一个方法：同一份 plan_json 现在有两个消费者——
   * 蓝图参考图（发给后端）与摆位提示词（拼进提示词）。两处各自解析的话，
   * 迟早出现"一处认得出、另一处认不出"的分叉，而那种分叉的表现是
   * "截图用上了、摆位没写进提示词"，从界面上完全看不出来。
   */
  private spatialPlanFor(projectId: string, shotId: string): {
    blueprintArtifactId: string | null;
    subjects: StagingSubject[];
    camera: StagingCamera | null;
  } | null {
    const project = this.projects.getProject(projectId) as
      { spatial_plans?: Array<{ shot_id: string; plan_json: string }> } | null;
    const row = (project?.spatial_plans ?? []).find((item) => item.shot_id === shotId);
    if (!row) return null;

    let plan: { blueprint?: { artifact_id?: unknown }; subjects?: unknown; camera?: unknown };
    try {
      plan = JSON.parse(row.plan_json) as typeof plan;
    } catch {
      return null;
    }
    const artifactId = plan.blueprint?.artifact_id;
    return {
      blueprintArtifactId: typeof artifactId === 'string' && artifactId.length > 0 ? artifactId : null,
      subjects: stagingSubjectsFrom(plan.subjects),
      camera: stagingCameraFrom(plan.camera),
    };
  }

  /**
   * 这一镜的构图蓝图在磁盘上的绝对路径；没有蓝图时返回 `null`。
   *
   * 为什么要在这里兜一层、而不是让调用方给路径：路径由两段拼出来——
   * 空间方案里的 `blueprint.artifact_id`（领域事实）与产物元数据里的
   * `artifact_path_relative`（项目工作目录内的相对路径）——
   * 这两样都在服务层手边，而界面/api 只该说"用这一镜的蓝图"。
   *
   * **找不到时抛错而不是回落成"没有蓝图"**：回落等于用户以为按蓝图生成、
   * 实际按纯提示词生成，而两者出来的画面差别很大。这种"静默降级"
   * 比直接失败难查得多——失败至少会留一句能读的话。
   */
  private blueprintReferenceFrom(
    artifactId: string, projectId: string, workspaceDir: string,
  ): { filePath: string; artifactId: string } {
    const artifacts = this.projects.listProjectArtifacts(projectId) as Array<{
      artifact_id: string;
      metadata?: { artifact_path_relative?: unknown } | null;
    }>;
    const relativePath = artifacts.find((item) => item.artifact_id === artifactId)
      ?.metadata?.artifact_path_relative;
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new Error(`这一镜的构图蓝图在项目里找不到对应文件（${artifactId.slice(0, 20)}…）：请到导演台重新截一张`);
    }
    const absolute = join(workspaceDir, relativePath);
    if (!existsSync(absolute)) {
      throw new Error(`这一镜的构图蓝图文件已经不在了（${relativePath}）：请到导演台重新截一张`);
    }
    return { filePath: absolute, artifactId };
  }

  /**
   * 为每个镜头生成一张图并登记为候选。
   *
   * **单镜失败不中断其它镜头**：一镜的模型名写错、被限流或超时，
   * 不应该让已经花钱成功的其它镜头跟着作废。失败的镜头会如实结清并回报原因。
   */
  async generateShotImages(request: GenerateShotImagesRequest): Promise<GenerateShotImagesOutcome> {
    const actor = request.actor ?? 'user:local';
    const estimated = request.estimatedCostCents ?? 0;
    /*
      批次 id 里带上调用方给的标签（如果有）。

      没有它时，同一毫秒内连开两批会算出同一个候选 id（`cand-<镜>-<批次>`），
      第二批第一张就报"候选已存在"——而"连开几批"恰恰是换机位批量生成的正常用法。
      标签做一次清洗：它会进目录名与候选 id，不能带路径分隔符之类的字符。
    */
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const label = (request.batchLabel ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
    const batch = label === '' ? stamp : `${label}-${stamp}`;
    const outputDir = join(request.workspaceDir, 'frames', `gen-${batch}`);
    mkdirSync(outputDir, { recursive: true });

    const generated: GeneratedShotImage[] = [];
    const failures: GenerateShotImagesOutcome['failures'] = [];
    let revision = request.expectedRevision;

    for (const [index, shot] of request.shots.entries()) {
      let intentId: string | null = null;
      /** 这一镜最后成没成（进度要如实报） */
      let shotOk = false;
      /*
        钱有没有可能已经花出去的分界。

        在这之后失败的，预留一律**不动**：供应商可能已经受理并计费，
        我们只是没拿到结果。以前这里会在失败时写 `actual_cost_cents: 0`
        把预留退回预算——那是个没有凭据的假设，账本上会多出一笔
        "确定花了 0 元"。现在只有在这条线**之前**失败（意图都在领域层被拒、
        或本地就出错）才敢断言没花钱。
      */
      let providerStarted = false;
      try {
        /*
          先算出"这次请求长什么样"，再看有没有可以复用的历史结果。

          这一步放在**登记意图之前**：复用不预留预算，也不该在账上留一条
          "进行中"的记录——它是一次本地登记，没有等待、没有失败。
        */
        const plan = this.spatialPlanFor(request.projectId, shot.shot_id);
        const blueprint = request.useBlueprintAsReference === false || plan?.blueprintArtifactId == null
          ? null
          : this.blueprintReferenceFrom(plan.blueprintArtifactId, request.projectId, request.workspaceDir);
        /*
          导演台摆的站位**要写进提示词**，不能只靠那张截图。

          截图说不出"左起第二个人比第一个人离镜头远 1.5 米"这种相对关系，
          而出图最容易崩的恰恰是这件事（人物粘连、位置互换、多出一个人）。
          directorStagingPrompt.ts 的文件头。

          **摘要也必须用这一份**：摘要决定"这次和历史上哪一次是同一件事"。
          拿原始 shot.prompt 去算摘要的话，用户改完摆位再生成会被判定为
          "同一请求"，于是直接复用上一次的结果——改了摆位、图没变，
          而界面上一切显示成功。
        */
        const subjectReference = this.subjectReferenceFor(plan?.subjects ?? []);
        const stagingPrompt = buildDirectorStagingPrompt({
          basePrompt: shot.prompt,
          /* 有了主体档案就把名字带上：提示词里前后指的必须是同一个人 */
          subjects: subjectReference.namesByRef.size === 0
            ? plan?.subjects ?? []
            : (plan?.subjects ?? []).map((subject) => {
              const name = subjectReference.namesByRef.get(subject.subject_ref);
              return name === undefined ? subject : { ...subject, display_name: name };
            }),
          camera: plan?.camera ?? null,
          hasBlueprintScreenshot: blueprint !== null,
        });
        /*
          参考图槽位（VID-010「受控多参考槽位顺序」）：这一镜可能同时要
          导演台截图**与**主体正脸图，而"第几张是哪张"本身就是语义
          （小QTV 的提示词原话是「使用提示词中给出的编号参考图作为主体身份和外观参考」）。

          所以在服务层把有序清单拼出来：**第 1 张是导演台截图（若有），
          接着是主体的正脸图（若有）**，并把这套编号写进提示词——
          只说"有参考图"而不说哪张是哪张，模型只能自己猜。

          后端的支持程度不一样（小QTV/图像生成服务只连一张、视频生成服务 与插件能吃多张），
          那一层会在 `notes` 里如实说明"只用了第 1 张"，不在这里假装。
        */
        const referenceFiles: string[] = [];
        const referenceArtifactIds: string[] = [];
        const referenceLabels: string[] = [];
        if (blueprint !== null) {
          referenceFiles.push(blueprint.filePath);
          referenceArtifactIds.push(blueprint.artifactId);
          referenceLabels.push('导演台截图');
        }
        const subjectImageFile = subjectReference.imageArtifactId === null
          ? null
          : this.artifactFilePath(request.workspaceDir, subjectReference.imageArtifactId);
        if (subjectReference.imageArtifactId !== null && subjectImageFile !== null) {
          referenceFiles.push(subjectImageFile);
          referenceArtifactIds.push(subjectReference.imageArtifactId);
          referenceLabels.push(`主体「${subjectReference.imageName ?? ''}」的正脸参考`);
        }
        const referenceSentence = referenceLabels.length === 0
          ? ''
          : `参考图顺序：${referenceLabels.map((label, index) => `第 ${index + 1} 张是${label}`).join('；')}。`
            + (referenceLabels.length > 1 ? '请按这个顺序理解它们各自的作用。' : '');
        const subjectFragment = referenceLabels.length > 0 && subjectReference.fragment !== ''
          ? `${subjectReference.fragment}（保持同一人物的五官与外观一致）`
          : subjectReference.fragment;
        const prompt = [stagingPrompt, referenceSentence, subjectFragment]
          .filter((part) => part !== '')
          .join(' ');
        const digest = imageExecutionDigest({
          backendId: this.backend.id,
          model: request.model,
          prompt,
          ...(request.ratio === undefined ? {} : { ratio: request.ratio }),
          ...(request.quality === undefined ? {} : { quality: request.quality }),
          referenceArtifactId: blueprint?.artifactId ?? null,
          /* 只有真的有多张时才加这个字段：单张（历史常见情形）的摘要与以前逐字相同，不让老缓存集体失效 */
          ...(referenceArtifactIds.length > 1 ? { referenceArtifactIds } : {}),
          ...(subjectReference.imageArtifactId === null ? {} : { subjectReferenceArtifactId: subjectReference.imageArtifactId }),
        });
        const reusable = request.reuseResults === false
          ? null
          : this.reusableImage(request.projectId, request.workspaceDir, shot.shot_id, digest);
        if (reusable !== null) {
          const candidateId = `cand-${shot.shot_id}-${batch}-reuse`;
          const reused = this.projects.execute({
            command_id: crypto.randomUUID(),
            actor,
            type: 'image-generation.reuse',
            project_id: request.projectId,
            expected_revision: revision,
            payload: {
              shot_id: shot.shot_id,
              candidate_id: candidateId,
              source_intent_id: reusable.intentId,
              digest,
            },
          });
          revision = reused.project_revision ?? revision + 1;
          generated.push({
            shot_id: shot.shot_id,
            candidate_id: candidateId,
            artifact_id: reusable.artifactId,
            frame_path_relative: relative(
              request.workspaceDir,
              this.artifactFilePath(request.workspaceDir, reusable.artifactId) ?? request.workspaceDir,
            ).split('\\').join('/'),
            bytes: 0,
            source_url: null,
            task_ref: null,
            provider_cost: null,
            reused: true,
            reused_from_intent_id: reusable.intentId,
          });
          shotOk = true;
          continue;
        }

        // ① 登记意图并预留预算（G1 未批准会在这里被拒）
        const admitted = this.projects.execute({
          command_id: crypto.randomUUID(),
          actor,
          type: 'image-generation.request',
          project_id: request.projectId,
          expected_revision: revision,
          payload: {
            /*
              这里记的是**实际发出去的那一份**（含导演台摆位），不是原始七字段那句：
              项目事实要对得上"这一张图是按什么生成的"，否则事后回看根本解释不了
              为什么同一个七字段两次出来的图不一样。
            */
            shot_id: shot.shot_id, model: request.model, prompt,
            estimated_cost_cents: estimated, digest,
          },
        });
        intentId = (admitted.payload as { intent_id: string }).intent_id;
        revision = admitted.project_revision ?? revision + 1;
        if (intentId !== null) {
          this.recordCheckpoint(request.projectId, intentId, 'accepted', { kind: 'image', shot_id: shot.shot_id, prompt, model: request.model, outputDir, resume_from: 'accepted' });
        }

        // ② 真实生成（后端可能是画布节点，也可能是异步任务——服务层不关心）
        if (intentId !== null) {
          this.recordCheckpoint(request.projectId, intentId, 'provider_started', { kind: 'image', shot_id: shot.shot_id, prompt, model: request.model, outputDir, reference_files: referenceFiles, ratio: request.ratio ?? null, quality: request.quality ?? null, settings: request.settings ?? null, resume_from: 'provider_call' });
        }
        providerStarted = true;
        /*
          这一镜截过构图蓝图的话，把它作为**参考图**交给后端：
          小QTV 会先上传成资源节点再连左侧入边，图像生成服务走 `image2image`。

          这一步真正接上之后，导演台摆的站位/体形/机位才不只是留档——
          它们会通过这张图影响出图，这正是空间控制这条差异化能力的落点。
        */
        const media = await this.backend.generateImage({
          prompt,
          model: request.model,
          ...(request.ratio === undefined ? {} : { ratio: request.ratio }),
          ...(request.quality === undefined ? {} : { quality: request.quality }),
          outputDir,
          label: shot.shot_id,
          /*
            参考图按**有序清单**交出去：单张时仍只给 `referenceImageFile`
            （老后端只认这个字段），多张时给数组（VID-010）。
          */
          ...(referenceFiles.length === 0
            ? {}
            : referenceFiles.length === 1
              ? { referenceImageFile: referenceFiles[0] as string }
              : { referenceImageFiles: [...referenceFiles] }),
          /* 其余参数（音色、语速、时长…）原样透传；键是后端字段名 */
          ...(request.settings === undefined ? {} : { settings: request.settings }),
        });
        if (intentId !== null) {
          this.recordCheckpoint(request.projectId, intentId, 'provider_finished', { kind: 'image', shot_id: shot.shot_id, files: media.files, task_ref: media.task_ref, resume_from: 'publish_artifact' });
        }

        // ③ 按内容哈希入库
        const file = media.files[0];
        if (!file || !existsSync(file)) {
          throw new Error('生成成功但未找到下载产物');
        }
        const bytes = readFileSync(file);
        const artifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        const relativePath = relative(request.workspaceDir, file).split('\\').join('/');
        this.projects.execute({
          command_id: crypto.randomUUID(),
          actor,
          type: 'artifact.publish',
          payload: {
            artifact_id: artifactId,
            media_type: mediaTypeOf(file),
            bytes: statSync(file).size,
            metadata: {
              source: `${this.backend.id}-generation`,
              /*
                `project_id` 要记进来：artifacts 表是**全局**的（主键是内容哈希），
                不写这一条的话，按项目取产物的那条路（listProjectArtifacts）
                永远列不到候选图——导出、资产页都拿不到它。
              */
              project_id: request.projectId,
              shot_id: shot.shot_id,
              model: request.model,
              prompt,
              frame_path_relative: relativePath,
              task_ref: media.task_ref,
              provider_cost: media.cost,
            },
          },
        });

        const candidateId = `cand-${shot.shot_id}-${batch}`;
        const added = this.projects.execute({
          command_id: crypto.randomUUID(),
          actor,
          type: 'image-candidate.add',
          project_id: request.projectId,
          expected_revision: revision,
          payload: { shot_id: shot.shot_id, candidate_id: candidateId, artifact_id: artifactId },
        });
        revision = added.project_revision ?? revision + 1;

        /**
         * 4) 结清：实际成本替换预估预留。
         *
         * 后端报的是「分」时直接采信；报的是**积分**（图像生成服务）时不折算——
         * 积分与人民币的汇率没有公开，硬凑一个数写进账目比留空更坏。
         * 积分原样记下来（账目里的 `provider_cost`，artifact metadata 里也留一份），
         * 供人工核对。
         */
        const billed = media.cost?.unit === 'cent' ? media.cost.amount : undefined;
        const settled = this.projects.execute({
          command_id: crypto.randomUUID(),
          actor,
          type: 'image-generation.settle',
          project_id: request.projectId,
          expected_revision: revision,
          payload: {
            intent_id: intentId,
            status: 'COMPLETED',
            ...settleCostPayload(billed, request.actualCostCents),
            ...(media.cost === null ? {} : { provider_cost: media.cost }),
            candidate_id: candidateId,
          },
        });
        revision = settled.project_revision ?? revision + 1;
        if (intentId !== null) {
          this.recordCheckpoint(request.projectId, intentId, 'completed', { kind: 'image', shot_id: shot.shot_id, resume_from: null });
        }

        generated.push({
          shot_id: shot.shot_id,
          candidate_id: candidateId,
          artifact_id: artifactId,
          frame_path_relative: relativePath,
          bytes: statSync(file).size,
          source_url: media.source_url,
          task_ref: media.task_ref,
          provider_cost: media.cost,
          /*
            后端对参数做的调整（丢键 / 改取值 / 这一步不支持透传），如实带上去。
            界面上要说一句——"用户设了、但没按他设的来"必须让他知道。
          */
          ...(media.notes.length === 0 ? {} : { parameter_notes: media.notes }),
        });
        shotOk = true;
      } catch (error) {
        /**
         * G1 未批准、字段表缺失属于**整批不可执行**的前置条件。
         *
      } catch (error) {
        /**
         * G1 未批准、字段表缺失属于**整批不可执行**的前置条件。
         *
         * 它们不该被伪装成「单镜失败」——那会让调用方以为只是这一镜运气不好，
         * 于是重试、再失败。而此时一分钱都还没花，直接抛出才是诚实的。
         *
         * 预算不足则是另一回事：前面的镜头可能已经花钱成功了，
         * 把它记为该镜失败、保住已得结果，比整批作废更合理。
         */
        const code = (error as { code?: string }).code;
        if (code === 'G1_REQUIRED' || code === 'SHOT_FIELDS_REQUIRED') throw error;

        if (intentId !== null) {
          this.recordCheckpoint(request.projectId, intentId, 'failed', { kind: 'image', shot_id: shot.shot_id, error: String(error), provider_started: providerStarted, resume_from: providerStarted ? 'provider_call' : 'accepted' });
        }
        const failure = describeFailure(error);
        failures.push({ shot_id: shot.shot_id, reason: actionableFailureMessage(failure), kind: failure.kind });
        // 意图已登记就必须结清，否则那笔预留会永久占着预算
        if (intentId !== null) {
          try {
            const settled = this.projects.execute({
              command_id: crypto.randomUUID(),
              actor,
              type: 'image-generation.settle',
              project_id: request.projectId,
              expected_revision: revision,
              payload: {
                intent_id: intentId,
                status: 'FAILED',
                failure: failure.message,
                /*
                  没提交给后端 = 确定没花钱，释放预留；
                  提交过 = 是否计费未知，预留留着（不再假装 0 元支出）。
                */
                ...(providerStarted ? {} : {
                  release_reservation: { reason: '还没提交给生成后端：这次调用不可能产生费用' },
                }),
              },
            });
            revision = settled.project_revision ?? revision + 1;
          } catch {
            // 结清本身失败不掩盖原始错误；预算对账可在项目事实里查
          }
        }
      }
      /*
        这一镜跑完了（成功或失败都算跑完）——报一次进度。

        放在 catch **之外**：失败的那一镜也要报，否则"2/5"会卡在中间不动，
        看起来像卡死，而后面几镜还在跑。回调是纯旁路，它抛错不影响生成。
      */
      try {
        request.onProgress?.({
          done: index + 1,
          total: request.shots.length,
          shotId: shot.shot_id,
          ok: shotOk,
        });
      } catch { /* 进度是旁路，报不出去也不能影响生成 */ }
    }

    return { generated, failures, projectRevision: revision };
  }

  /**
   * 为每个镜头生成一段视频（图生视频）。
   *
   * 与图片生成的流程同构，但多一道**最关键的**闸门检查：
   * G2 未批准、或该镜尚未选帧，都在花钱之前被领域层拦下——
   * 这正是 G2 存在的全部意义。
   *
   * 首帧怎么被送到模型那里，是**后端的事**：小QTV 要先上传成画布节点再连线，
   * 图像生成服务直接在 `--image=` 里给本地路径。服务层只给出首帧的绝对路径。
   */
  /**
   * 视频续写（VID-006）：拿一段已有成片的**最后一帧**当起点，生成下一段。

   * 为什么不走"给下一镜选首帧、再生成视频"那条路：那条要动**选帧**，
   * 而动选帧会作废 G2（领域里的规矩是"第一帧变了，之前批准的视频生产不能照旧"）。
   * 续写接的是**一段片子**、与分镜的首帧无关，所以它走**项目级生成意图**
   * （先预留预算、结清按实际退回）——G2 的语义一点不动。
   */
  async continueClip(request: ContinueClipRequest): Promise<ContinueClipOutcome> {
    const actor = request.actor ?? 'user:local';
    if (!existsSync(request.firstFrameFile)) {
      return { ok: false, reason: `找不到要续写的首帧文件：${request.firstFrameFile}` };
    }
    /* 先把尾帧登记成产物：它是这一段续写的**输入凭据**，出问题时要能追到是哪一帧 */
    const frameBytes = readFileSync(request.firstFrameFile);
    const frameArtifactId = `sha256:${createHash('sha256').update(frameBytes).digest('hex')}`;
    this.projects.execute({
      command_id: crypto.randomUUID(),
      actor,
      type: 'artifact.publish',
      payload: {
        artifact_id: frameArtifactId,
        media_type: mediaTypeOf(request.firstFrameFile),
        bytes: frameBytes.length,
        metadata: {
          source: 'continue-last-frame',
          project_id: request.projectId,
          artifact_path_relative: relative(request.workspaceDir, request.firstFrameFile).split('\\').join('/'),
        },
      },
    });

    const admitted = this.projects.execute({
      command_id: crypto.randomUUID(),
      actor,
      type: 'asset-generation.request',
      project_id: request.projectId,
      expected_revision: request.expectedRevision,
      payload: {
        kind: 'video',
        purpose: `continue:${frameArtifactId.slice(-16)}`,
        model: request.model,
        prompt: request.prompt,
        estimated_cost_cents: request.estimatedCostCents ?? 0,
      },
    });
    const intentId = (admitted.payload as { intent_id: string }).intent_id;
    let revision = admitted.project_revision ?? request.expectedRevision;

    const batch = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = join(request.workspaceDir, 'clips', `continue-${batch}`);
    mkdirSync(outputDir, { recursive: true });
    try {
      const media = await this.backend.generateVideoFromImage({
        imageFile: request.firstFrameFile,
        prompt: request.prompt,
        model: request.model,
        durationSeconds: request.durationSeconds,
        outputDir,
        label: request.label ?? `continue-${batch}`,
        ...(request.ratio === undefined ? {} : { ratio: request.ratio }),
        ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
      });
      const file = media.files[0];
      if (file === undefined || !existsSync(file)) throw new Error('后端报成功但没有找到片段产物');
      const bytes = readFileSync(file);
      const clipArtifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'artifact.publish',
        payload: {
          artifact_id: clipArtifactId,
          media_type: mediaTypeOf(file),
          bytes: bytes.length,
          metadata: {
            source: `${this.backend.id}-continue`,
            project_id: request.projectId,
            artifact_path_relative: relative(request.workspaceDir, file).split('\\').join('/'),
          },
        },
      });
      this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'asset-generation.settle',
        project_id: request.projectId,
        expected_revision: revision,
        payload: {
          intent_id: intentId,
          status: 'COMPLETED',
          artifact_id: clipArtifactId,
          ...(request.actualCostCents === undefined ? {} : { actual_cost_cents: request.actualCostCents }),
          ...(media.cost === null ? {} : { provider_cost: media.cost }),
        },
      });
      revision += 1;
      return {
        ok: true,
        frameArtifactId,
        clipArtifactId,
        file,
        bytes: bytes.length,
        cost: media.cost,
        notes: media.notes,
        projectRevision: revision,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      /*
        失败也要结清（不清就等于那笔预留永远占着预算）。
        **不写 actual_cost**：不知道对方扣没扣钱——与图片/视频两条路同一条口径。
      */
      try {
        this.projects.execute({
          command_id: crypto.randomUUID(),
          actor,
          type: 'asset-generation.settle',
          project_id: request.projectId,
          expected_revision: revision,
          payload: { intent_id: intentId, status: 'FAILED', failure: reason },
        });
      } catch { /* 结清失败不该盖住原来的错 */ }
      return { ok: false, reason };
    }
  }

  async generateShotVideos(request: GenerateShotVideosRequest): Promise<GenerateShotVideosOutcome> {
    const actor = request.actor ?? 'user:local';
    const estimated = request.estimatedCostCents ?? 0;
    const batch = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = join(request.workspaceDir, 'clips', `gen-${batch}`);
    mkdirSync(outputDir, { recursive: true });

    const generated: GeneratedShotVideo[] = [];
    const failures: GenerateShotVideosOutcome['failures'] = [];
    let revision = request.expectedRevision;

    for (const [index, shot] of request.shots.entries()) {
      let intentId: string | null = null;
      /* 与出图同一条分界：提交之后失败，预留就不再假装置信为 0 */
      let providerStarted = false;
      /** 这一镜最后成没成（进度要如实报） */
      let shotOk = false;
      try {
        /*
          先算摘要、看有没有可复用的片段——与出图同一条规矩：
          复用不预留预算，也不该在账上留一条"进行中"的记录。
        */
        const digest = videoExecutionDigest({
          backendId: this.backend.id,
          model: request.model,
          ...(shot.prompt === undefined ? {} : { prompt: shot.prompt }),
          durationSeconds: shot.duration_seconds,
          ...(request.ratio === undefined ? {} : { ratio: request.ratio }),
          ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
          firstFrameArtifactId: this.firstFrameArtifactId(request.projectId, shot.shot_id),
        });
        const reusable = request.reuseResults === false
          ? null
          : this.reusableVideo(request.projectId, request.workspaceDir, shot.shot_id, digest);
        if (reusable !== null) {
          const reused = this.projects.execute({
            command_id: crypto.randomUUID(),
            actor,
            type: 'video-generation.reuse',
            project_id: request.projectId,
            expected_revision: revision,
            payload: { shot_id: shot.shot_id, source_intent_id: reusable.intentId, digest },
          });
          revision = reused.project_revision ?? revision + 1;
          generated.push({
            shot_id: shot.shot_id,
            artifact_id: reusable.artifactId,
            frame_path_relative: relative(
              request.workspaceDir,
              this.artifactFilePath(request.workspaceDir, reusable.artifactId) ?? request.workspaceDir,
            ).split('\\').join('/'),
            bytes: 0,
            duration_seconds: shot.duration_seconds,
            source_url: null,
            task_ref: null,
            provider_cost: null,
            reused: true,
            reused_from_intent_id: reusable.intentId,
          });
          shotOk = true;
          continue;
        }

        // ① 登记意图：G2 与选帧两条前置条件在领域层强制
        const admitted = this.projects.execute({
          command_id: crypto.randomUUID(),
          actor,
          type: 'video-generation.request',
          project_id: request.projectId,
          expected_revision: revision,
          payload: {
            shot_id: shot.shot_id,
            model: request.model,
            duration_seconds: shot.duration_seconds,
            estimated_cost_cents: estimated,
            ...(shot.prompt === undefined ? {} : { prompt: shot.prompt }),
            digest,
          },
        });
        intentId = (admitted.payload as { intent_id: string }).intent_id;
        revision = admitted.project_revision ?? revision + 1;
        if (intentId !== null) {
          this.recordCheckpoint(request.projectId, intentId, 'accepted', { kind: 'video', shot_id: shot.shot_id, model: request.model, duration_seconds: shot.duration_seconds, outputDir, resume_from: 'accepted' });
        }

        // ② 真实生成（首帧给绝对路径，怎么送由后端决定）
        if (intentId !== null) {
          this.recordCheckpoint(request.projectId, intentId, 'provider_started', { kind: 'video', shot_id: shot.shot_id, image_file: shot.image_path_relative, prompt: shot.prompt ?? null, model: request.model, duration_seconds: shot.duration_seconds, outputDir, ratio: request.ratio ?? null, resolution: request.resolution ?? null, settings: request.settings ?? null, resume_from: 'provider_call' });
        }
        providerStarted = true;
        const media = await this.backend.generateVideoFromImage({
          imageFile: join(request.workspaceDir, shot.image_path_relative),
          model: request.model,
          durationSeconds: shot.duration_seconds,
          ...(shot.prompt === undefined ? {} : { prompt: shot.prompt }),
          ...(request.ratio === undefined ? {} : { ratio: request.ratio }),
          ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
          outputDir,
          label: shot.shot_id,
          ...(request.settings === undefined ? {} : { settings: request.settings }),
        });
        if (intentId !== null) {
          this.recordCheckpoint(request.projectId, intentId, 'provider_finished', { kind: 'video', shot_id: shot.shot_id, files: media.files, task_ref: media.task_ref, resume_from: 'publish_artifact' });
        }

        // ③ 按内容哈希入库
        const file = media.files[0];
        if (!file || !existsSync(file)) throw new Error('视频生成成功但未找到下载产物');
        const bytes = readFileSync(file);
        const artifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        const relativePath = relative(request.workspaceDir, file).split('\\').join('/');
        this.projects.execute({
          command_id: crypto.randomUUID(),
          actor,
          type: 'artifact.publish',
          payload: {
            artifact_id: artifactId,
            media_type: mediaTypeOf(file),
            bytes: statSync(file).size,
            metadata: {
              source: `${this.backend.id}-video-generation`, project_id: request.projectId,
              shot_id: shot.shot_id,
              model: request.model,
              duration_seconds: shot.duration_seconds,
              frame_path_relative: relativePath,
              task_ref: media.task_ref,
              provider_cost: media.cost,
            },
          },
        });

        // 4) 结清（后端报「分」才采信；报「积分」不折算，见图片生成那里的说明）
        const billed = media.cost?.unit === 'cent' ? media.cost.amount : undefined;
        const settled = this.projects.execute({
          command_id: crypto.randomUUID(),
          actor,
          type: 'video-generation.settle',
          project_id: request.projectId,
          expected_revision: revision,
          payload: {
            intent_id: intentId,
            status: 'COMPLETED',
            ...settleCostPayload(billed, request.actualCostCents),
            ...(media.cost === null ? {} : { provider_cost: media.cost }),
            clip_artifact_id: artifactId,
          },
        });
        revision = settled.project_revision ?? revision + 1;
        if (intentId !== null) {
          this.recordCheckpoint(request.projectId, intentId, 'completed', { kind: 'video', shot_id: shot.shot_id, resume_from: null });
        }

        generated.push({
          shot_id: shot.shot_id,
          artifact_id: artifactId,
          frame_path_relative: relativePath,
          bytes: statSync(file).size,
          duration_seconds: shot.duration_seconds,
          source_url: media.source_url,
          task_ref: media.task_ref,
          provider_cost: media.cost,
          ...(media.notes.length === 0 ? {} : { parameter_notes: media.notes }),
        });
        shotOk = true;
      } catch (error) {
        // G2/选帧属于整批前置条件，直接抛出；其余记为该镜失败
        const code = (error as { code?: string }).code;
        if (code === 'G2_REQUIRED' || code === 'FIRST_FRAME_REQUIRED' || code === 'FIRST_FRAME_SUPERSEDED') throw error;

        if (intentId !== null) {
          this.recordCheckpoint(request.projectId, intentId, 'failed', { kind: 'video', shot_id: shot.shot_id, error: String(error), provider_started: providerStarted, resume_from: providerStarted ? 'provider_call' : 'accepted' });
        }
        const failure = describeFailure(error);
        failures.push({ shot_id: shot.shot_id, reason: actionableFailureMessage(failure), kind: failure.kind });
        if (intentId !== null) {
          try {
            const settled = this.projects.execute({
              command_id: crypto.randomUUID(),
              actor,
              type: 'video-generation.settle',
              project_id: request.projectId,
              expected_revision: revision,
              payload: {
                intent_id: intentId,
                status: 'FAILED',
                failure: failure.message,
                ...(providerStarted ? {} : {
                  release_reservation: { reason: '还没提交给生成后端：这次调用不可能产生费用' },
                }),
              },
            });
            revision = settled.project_revision ?? revision + 1;
          } catch {
            // 结清失败不掩盖原始错误
          }
        }
      }
      /* 与出图同一条规矩：这一镜跑完就报一次进度（失败的也报） */
      try {
        request.onProgress?.({
          done: index + 1,
          total: request.shots.length,
          shotId: shot.shot_id,
          ok: shotOk,
        });
      } catch { /* 进度是旁路，报不出去也不能影响生成 */ }
    }

    return { generated, failures, projectRevision: revision };
  }

  /**
   * 这一镜引用了哪些**主体**，以及它们的参考图（ASSET-002 的落地点）。

   * 为什么必须接进生成路径：主体库里存了正脸参考图、音色、描述，
   * 但如果生成请求不带这些，主体库就只是一本相册——
   * "跨镜复用同一个角色"这句话等于没实现。

   * 三条口径：

     · **文本部分**用线上词条的说法（`参考 {name} 的五官特点。`，见 contracts 的
       `subjectPromptFragment`），并且拼进 `prompt`——摘要算的就是这一份，
       所以"加了主体引用"会让摘要变化，不会误命中上一次的缓存；
     · **图片部分**受后端能力限制：当前后端接口一次只接受**一张**参考图
       （小QTV 传一个资源节点、图像生成服务走 `image2image` 的单图入口），
       而多参考槽（VID-010）还没做。所以优先级是
       **导演台蓝图 > 主体正脸图**：有蓝图时蓝图优先，没蓝图时用主体正脸。
     · 主体在档案里**没有参考图**时只拼文本，不假装有图。

   * 认不出主体的（`subject_ref` 不在主体库里）跳过：空间方案可能引用了一个
   * 已被删除的主体，那种情况下多拼一句话只会让模型困惑。
   */
  private subjectReferenceFor(
    subjects: readonly StagingSubject[],
  ): {
    fragment: string;
    imageArtifactId: string | null;
    imageName: string | null;
    /** 主体引用 → 主体库里的名字，用来让提示词前后叫的是同一个人 */
    namesByRef: Map<string, string>;
  } {
    if (subjects.length === 0) {
      return { fragment: '', imageArtifactId: null, imageName: null, namesByRef: new Map() };
    }

    let profiles: Array<{ subject_ref: string; profile: { display_name: string; kind: string; images: Array<{ artifact_id: string; frontal: boolean }> } }>;
    try {
      profiles = this.projects.listSubjectProfiles() as typeof profiles;
    } catch {
      /* 主体库读不出来不该让生成失败：这一镜就按没有主体引用处理 */
      return { fragment: '', imageArtifactId: null, imageName: null, namesByRef: new Map() };
    }
    const byRef = new Map(profiles.map((row) => [row.subject_ref, row.profile]));

    const fragments: string[] = [];
    const namesByRef = new Map<string, string>();
    let imageArtifactId: string | null = null;
    let imageName: string | null = null;
    for (const subject of subjects) {
      const profile = byRef.get(subject.subject_ref);
      if (profile === undefined) continue;
      namesByRef.set(subject.subject_ref, profile.display_name);
      fragments.push(subjectPromptFragment({ display_name: profile.display_name, kind: profile.kind === 'person' ? 'person' : 'other' }));
      if (imageArtifactId === null) {
        const frontal = profile.images.find((image) => image.frontal) ?? profile.images[0];
        if (frontal !== undefined) {
          imageArtifactId = frontal.artifact_id;
          imageName = profile.display_name;
        }
      }
    }
    return { fragment: fragments.join(''), imageArtifactId, imageName, namesByRef };
  }

  /**
   * 视频重拍：以已有片段为输入，按提示词重做一遍，产出替换用的新片段。

   * 走的是**与整批生成同一条闸门链**（`video-generation.request` →
   * 真实生成 → 产物入库 → `video-generation.settle`），所以：
   *   · G2 未批准照样被领域层拒绝（重拍同样是付费动作）；
   *   · 预算照常预留与结清；
   *   · 结清时把 `clip_artifact_id` 指到新片段，这一镜的"当前片段"随之替换。
   *
   * 与另起一条链路的区别就在这里：重拍如果在闸门之外走，它就成了整个系统里
   * 唯一一条"不占预算、不过 G2"的付费路径——那正是这套闸门最防的东西。
   */
  async retakeShotVideo(request: RetakeShotVideoRequest): Promise<RetakeShotVideoOutcome> {
    const actor = request.actor ?? 'user:local';
    const prompt = request.prompt.trim();
    if (prompt.length === 0) {
      throw new Error('重拍需要描述要改什么：没有提示词就没有"重拍成什么样"的依据');
    }
    if (!this.backend.capabilities.videoEdit) {
      throw new UnsupportedCapabilityError(this.backend.label, 'videoEdit');
    }
    /*
      时长门槛放在**能力检查之后、登记意图之前**。
      放在登记之后的话，每次被门槛挡下都会在账上留一条 PENDING 意图，
      而那条意图永远结不清——预算里预留下来的那部分再也放不出去。
    */
    if (request.durationSeconds < MIN_RETAKE_SECONDS) {
      throw new Error(
        `这一镜的片段只有 ${request.durationSeconds} 秒，重拍要求不少于 ${MIN_RETAKE_SECONDS} 秒`,
      );
    }

    const estimated = request.estimatedCostCents ?? 0;
    const batch = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = join(request.workspaceDir, 'clips', `retake-${batch}`);
    mkdirSync(outputDir, { recursive: true });

    let revision = request.expectedRevision;
    let intentId: string | null = null;
    /* 与其它付费链路同一条分界：提交之后失败，预留不再假装置信为 0 */
    let providerStarted = false;
    try {
      const admitted = this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'video-generation.request',
        project_id: request.projectId,
        expected_revision: revision,
        payload: {
          shot_id: request.shotId,
          model: request.model,
          duration_seconds: request.durationSeconds,
          estimated_cost_cents: estimated,
          prompt,
        },
      });
      intentId = (admitted.payload as { intent_id: string }).intent_id;
      revision = admitted.project_revision ?? revision + 1;

      providerStarted = true;
      const media = await this.backend.editVideo({
        videoFile: join(request.workspaceDir, request.sourcePathRelative),
        prompt,
        model: request.model,
        ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
        outputDir,
        label: `${request.shotId}-retake`,
      });

      const file = media.files[0];
      if (!file || !existsSync(file)) throw new Error('重拍报成功但未找到下载产物');
      const bytes = readFileSync(file);
      const artifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const relativePath = relative(request.workspaceDir, file).split('\\').join('/');
      this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'artifact.publish',
        payload: {
          artifact_id: artifactId,
          media_type: mediaTypeOf(file),
          bytes: statSync(file).size,
          metadata: {
            source: `${this.backend.id}-video-retake`, project_id: request.projectId,
            shot_id: request.shotId,
            model: request.model,
            duration_seconds: request.durationSeconds,
            frame_path_relative: relativePath,
            task_ref: media.task_ref,
            provider_cost: media.cost,
            /*
              记下"重拍的是哪一份"。回看时能回答"这一版是从哪一版改出来的"——
              没有它，同一镜头的多个片段只能靠时间戳猜。
            */
            retake_of: request.sourceArtifactId,
            retake_prompt: prompt,
          },
        },
      });

      const billed = media.cost?.unit === 'cent' ? media.cost.amount : undefined;
      const settled = this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'video-generation.settle',
        project_id: request.projectId,
        expected_revision: revision,
        payload: {
          intent_id: intentId,
          status: 'COMPLETED',
          ...settleCostPayload(billed, request.actualCostCents),
          ...(media.cost === null ? {} : { provider_cost: media.cost }),
          clip_artifact_id: artifactId,
        },
      });
      revision = settled.project_revision ?? revision + 1;

      return {
        shot_id: request.shotId,
        artifact_id: artifactId,
        frame_path_relative: relativePath,
        bytes: statSync(file).size,
        duration_seconds: request.durationSeconds,
        source_url: media.source_url,
        task_ref: media.task_ref,
        provider_cost: media.cost,
        replaced_artifact_id: request.sourceArtifactId,
        projectRevision: revision,
      };
    } catch (error) {
      /*
        失败也要结清：不然这条意图永远停在 PENDING，预算里预留下来的那部分
        再也放不出去。**但 G2/选帧这类前置条件错误直接抛**——
        那时意图根本没登记，没有东西可结清。
      */
      const code = (error as { code?: string }).code;
      if (code === 'G2_REQUIRED' || code === 'FIRST_FRAME_REQUIRED' || code === 'FIRST_FRAME_SUPERSEDED') throw error;
      if (intentId !== null) {
        try {
          this.projects.execute({
            command_id: crypto.randomUUID(),
            actor,
            type: 'video-generation.settle',
            project_id: request.projectId,
            expected_revision: revision,
            payload: {
              intent_id: intentId,
              status: 'FAILED',
              failure: actionableFailureMessage(describeFailure(error)),
              ...(providerStarted ? {} : {
                release_reservation: { reason: '还没提交给生成后端：这次调用不可能产生费用' },
              }),
            },
          });
        } catch {
          // 结清失败不掩盖原始错误
        }
      }
      throw error;
    }
  }

  /**
   * 在某一镜的图上执行一个场景化能力。

   * 产物**不登记为候选**（`image-candidate`）：候选是"这一镜的首帧"的备选，
   * 而多机位九宫格、三视图这些是**参考素材**，不参与选帧。
   * 它们以 `metadata.source = 'image-shortcut'` 落库，
   * 画布据此把它们画成节点（见 `isNodeLevelDerivedArtifact`），资产页也能看到。
   */
  async applyImageShortcut(request: ApplyImageShortcutRequest): Promise<ApplyImageShortcutOutcome> {
    const actor = request.actor ?? 'user:local';
    if (!this.backend.capabilities.imageShortcut) {
      throw new UnsupportedCapabilityError(this.backend.label, 'imageShortcut');
    }
    const estimated = request.estimatedCostCents ?? 0;
    const batch = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = join(request.workspaceDir, 'frames', `shortcut-${batch}`);
    mkdirSync(outputDir, { recursive: true });

    let revision = request.expectedRevision;
    let intentId: string | null = null;
    /* 同一条分界：场景能力也是付费调用 */
    let providerStarted = false;
    try {
      /*
        `model` 那一栏写的是场景 id。

        领域层的意图表要一个 model 字段，而这类能力没有"选模型"这一步
        （用哪个模型由 小QTV 自己决定）。写空串会让账目里多一行看不懂的记录，
      */
      const admitted = this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'image-generation.request',
        project_id: request.projectId,
        expected_revision: revision,
        payload: {
          shot_id: request.shotId,
          model: `${this.backend.id}-shortcut:${request.scene}`,
          prompt: request.sceneLabel ?? request.scene,
          estimated_cost_cents: estimated,
        },
      });
      intentId = (admitted.payload as { intent_id: string }).intent_id;
      revision = admitted.project_revision ?? revision + 1;

      providerStarted = true;
      const media = await this.backend.applyImageShortcut({
        imageFile: join(request.workspaceDir, request.sourcePathRelative),
        scene: request.scene,
        outputDir,
        label: `${request.shotId}-${request.scene}`,
      });

      const file = media.files[0];
      if (!file || !existsSync(file)) throw new Error('场景能力报成功但未找到下载产物');
      const bytes = readFileSync(file);
      const artifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const relativePath = relative(request.workspaceDir, file).split('\\').join('/');
      this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'artifact.publish',
        payload: {
          artifact_id: artifactId,
          media_type: mediaTypeOf(file),
          bytes: statSync(file).size,
          metadata: {
            source: 'image-shortcut', project_id: request.projectId,
            shot_id: request.shotId,
            scene: request.scene,
            /* 从哪张图派生出来的：回看时能对上，而不是一个孤立的产物 */
            from_artifact: request.sourceArtifactId,
            frame_path_relative: relativePath,
            task_ref: media.task_ref,
            provider_cost: media.cost,
          },
        },
      });

      const billed = media.cost?.unit === 'cent' ? media.cost.amount : undefined;
      const settled = this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'image-generation.settle',
        project_id: request.projectId,
        expected_revision: revision,
        payload: {
          intent_id: intentId,
          status: 'COMPLETED',
          ...settleCostPayload(billed, request.actualCostCents),
          ...(media.cost === null ? {} : { provider_cost: media.cost }),
          /*
            刻意**不传** candidate_id：这些产物**不是候选**（候选是"这一镜的首帧"的备选，
            而多机位九宫格、三视图是参考素材，不参与选帧）。
            传了的话，界面上会冒出一张"可以被选为首帧"的多机位九宫格，
            而那完全说不通。产物身份已经在 artifact.publish 那一步记下了。
          */
        },
      });
      revision = settled.project_revision ?? revision + 1;

      return {
        shot_id: request.shotId,
        scene: request.scene,
        artifact_id: artifactId,
        frame_path_relative: relativePath,
        bytes: statSync(file).size,
        source_url: media.source_url,
        task_ref: media.task_ref,
        provider_cost: media.cost,
        projectRevision: revision,
      };
    } catch (error) {
      /*
        与其它付费链路一样：失败也要结清，否则预留会一直挂着。

        但"结清"不等于"退钱"：只有在**没提交给后端**时才知道这笔没花钱，
        那时才显式释放预留。提交过就如实留着——供应商可能已经计费了。
      */
      if (intentId !== null) {
        try {
          this.projects.execute({
            command_id: crypto.randomUUID(),
            actor,
            type: 'image-generation.settle',
            project_id: request.projectId,
            expected_revision: revision,
            payload: {
              intent_id: intentId,
              status: 'FAILED',
              failure: actionableFailureMessage(describeFailure(error)),
              ...(providerStarted ? {} : {
                release_reservation: { reason: '还没提交给生成后端：这次调用不可能产生费用' },
              }),
            },
          });
        } catch {
          // 结清失败不掩盖原始错误
        }
      }
      throw error;
    }
  }

  /**
   * 图片高清放大。
   *
   * 为什么单独一个方法而不是塞进 `applyImageShortcut`：
   * 场景能力是"用哪一项由后端决定"，而放大是"输出同一张图的更清晰那份"——
   * 两者的产物含义不同（一个产出参考素材、一个产出同一张图的新版本），
   * metadata 里的来源标记也不同（`image-shortcut` / `image-upscale`），
   * 画布据此决定节点怎么画。混成一个方法，这两种含义迟早会互相污染。
   */
  async upscaleImage(request: UpscaleImageRequest): Promise<UpscaleImageOutcome> {
    const actor = request.actor ?? 'user:local';
    if (!this.backend.capabilities.imageUpscale) {
      throw new UnsupportedCapabilityError(this.backend.label, 'imageUpscale');
    }
    const estimated = request.estimatedCostCents ?? 0;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const batch = stamp;
    const outputDir = join(request.workspaceDir, 'frames', `upscale-${batch}`);
    mkdirSync(outputDir, { recursive: true });

    let revision = request.expectedRevision;
    let intentId: string | null = null;
    let providerStarted = false;
    try {
      /*
        意图表要一个 model 字段，而放大没有"选模型"这一步（用哪个由后端定）。
      */
      const admitted = this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'image-generation.request',
        project_id: request.projectId,
        expected_revision: revision,
        payload: {
          shot_id: request.shotId,
          model: `${this.backend.id}-upscale`,
          prompt: `高清放大 → ${request.resolution}`,
          estimated_cost_cents: estimated,
        },
      });
      intentId = (admitted.payload as { intent_id: string }).intent_id;
      revision = admitted.project_revision ?? revision + 1;

      providerStarted = true;
      const media = await this.backend.upscaleImage({
        imageFile: join(request.workspaceDir, request.sourcePathRelative),
        resolution: request.resolution,
        outputDir,
        label: `${request.shotId}-upscale`,
      });

      const file = media.files[0];
      if (!file || !existsSync(file)) throw new Error('高清放大报成功但未找到下载产物');
      const bytes = readFileSync(file);
      const artifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const relativePath = relative(request.workspaceDir, file).split('\\').join('/');
      this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'artifact.publish',
        payload: {
          artifact_id: artifactId,
          media_type: mediaTypeOf(file),
          bytes: statSync(file).size,
          metadata: {
            source: 'image-upscale',
            project_id: request.projectId,
            shot_id: request.shotId,
            resolution: request.resolution,
            /* 从哪张图放大来的：回看时能对上，而不是一个孤立的产物 */
            from_artifact: request.sourceArtifactId,
            frame_path_relative: relativePath,
            task_ref: media.task_ref,
            provider_cost: media.cost,
          },
        },
      });

      const billed = media.cost?.unit === 'cent' ? media.cost.amount : undefined;
      const settled = this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'image-generation.settle',
        project_id: request.projectId,
        expected_revision: revision,
        payload: {
          intent_id: intentId,
          status: 'COMPLETED',
          ...settleCostPayload(billed, request.actualCostCents),
          ...(media.cost === null ? {} : { provider_cost: media.cost }),
          /* 同样不传 candidate_id：放大的图不是"这一镜的首帧"的备选 */
        },
      });
      revision = settled.project_revision ?? revision + 1;

      return {
        shot_id: request.shotId,
        artifact_id: artifactId,
        frame_path_relative: relativePath,
        bytes: statSync(file).size,
        resolution: request.resolution,
        source_url: media.source_url,
        task_ref: media.task_ref,
        provider_cost: media.cost,
        projectRevision: revision,
      };
    } catch (error) {
      /* 与其它付费链路一致：失败也要结清，只有"没提交给后端"才显式释放预留 */
      if (intentId !== null) {
        try {
          this.projects.execute({
            command_id: crypto.randomUUID(),
            actor,
            type: 'image-generation.settle',
            project_id: request.projectId,
            expected_revision: revision,
            payload: {
              intent_id: intentId,
              status: 'FAILED',
              failure: actionableFailureMessage(describeFailure(error)),
              ...(providerStarted ? {} : {
                release_reservation: { reason: '还没提交给生成后端：这次调用不可能产生费用' },
              }),
            },
          });
        } catch {
          // 结清失败不掩盖原始错误
        }
      }
      throw error;
    }
  }
}

function mediaTypeOf(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  return 'image/png';
}

/**
 * 按错误的**类名**分类，而不是 `instanceof` 某一家的类型。
 *
 * 理由很实在：服务层不该知道有哪几家后端。两个适配器的错误类都显式设了
 * 又不让生成服务依赖任何一个具体适配器——否则「换一家」又要改这里。
 *
 * 顺序有讲究：`Compliance` 要排在 `Auth` 前面判断，因为它的处置完全不同
 * （去网页端用该模型生成一次，而不是重新登录），而这只有用户能做。
 */
function describeFailure(error: unknown): { message: string; kind: FailureKind } {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (/NotInstalled/.test(name)) return { message, kind: 'not-installed' };
  if (/Compliance/.test(name)) return { message, kind: 'compliance' };
  if (/Auth/.test(name)) return { message, kind: 'auth' };
  if (/Command/.test(name)) return { message, kind: 'command' };
  if (/Protocol/.test(name)) return { message, kind: 'protocol' };
  return { message, kind: 'unknown' };
}

