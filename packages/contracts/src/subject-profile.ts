/* ============================================================
  期音科技 · 主体档案（可复用的角色/主体）
   ------------------------------------------------------------
  对标依据：小QTV 线上 bundle 的词条原文
  凡是这里写死的数字与文案，都能在那份词条里逐条对上：

    createSubjectAddImageHint   = 2-4张，第一张图必须为清晰正脸的图片
    createSubjectMaxImages      = 最多可添加 {max} 张图片
    createSubjectAddVideoHint   = {min}-{max}s单一连续镜头的视频
    createSubjectVideoDurationRange = 请上传时长在 {min}~{max} 秒之间的视频
    createSubjectVideoCharacterOnly = 目前视频仅支持人物主体
    createSubjectVoiceTooltip   = 仅主体为人物时支持音色绑定和使用
    createSubjectVoiceDurationRange = 音频时长需在 {min}~{max} 秒之间
    createSubjectAudioFormatError   = 请上传 mp3、wav、mp4 或 mov 格式文件
    createSubjectAudioNameLength    = 音频文件名需在 1~20 个字之间
    createSubjectDescPlaceholder    = 描述主体的核心特征或者描述希望保留的细节，不超过100字
    characterStudioVoiceAuthorization = 克隆音色前，我已获得声音权利人的明确授权
    characterStudioPromptWithReference = {prompt}；参考 {name} 的五官特点。

  为什么规则集中放在**契约**里：同一套判断要被三处使用——
  界面（提交前拦住）、领域层（不信界面，再判一次）、验收（把话术也当验收口径）。
  三处各写一遍必然漂移，漂移的表现是"界面说可以，保存时说不行"。
   ============================================================ */

import { z } from 'zod';
import { sha256Schema } from './primitives.js';
import { subjectRefSchema } from './spatial-plan.js';

/** 图片张数：词条 `createSubjectAddImageHint` / `createSubjectMaxImages` */
export const SUBJECT_IMAGE_MIN = 2;
export const SUBJECT_IMAGE_MAX = 4;

/**
 * 视频时长区间（秒）。

 * 词条里 {min}/{max} 是运行时替换的，没有直接给出数字；
 * 主体克隆这类素材的通行区间是 5–30 秒，因此取 [5, 30]——
 * **这是我们定的**，词条给的是句式，数字待与线上实测核对（写进验收备注）。
 */
export const SUBJECT_VIDEO_MIN_SECONDS = 5;
export const SUBJECT_VIDEO_MAX_SECONDS = 30;

/** 音色素材时长：词条 `createSubjectVoiceDurationRange`，同样取 5–30 秒 */
export const SUBJECT_VOICE_MIN_SECONDS = 5;
export const SUBJECT_VOICE_MAX_SECONDS = 30;

/** 描述字数：词条 `createSubjectDescPlaceholder`（不超过 100 字） */
export const SUBJECT_DESC_MAX_CHARS = 100;

/** 音频名长度：词条 `createSubjectAudioNameLength`（1~20 个字） */
export const SUBJECT_AUDIO_NAME_MAX_CHARS = 20;

/** 音色素材允许的扩展名：词条 `createSubjectAudioFormatError` */
export const SUBJECT_AUDIO_EXTENSIONS = ['mp3', 'wav', 'mp4', 'mov'] as const;

/**
 * 主体类型。

 * `person` 才允许绑音色（`createSubjectVoiceTooltip`）、才允许用视频创建
 * （`createSubjectVideoCharacterOnly = 目前视频仅支持人物主体`）。
 */
/**
 * 资产一级分类。`product` / `scene` 是 ASSET-001 的产品与场景库，
 * 仍复用主体档案的内容寻址与引用计数；`other` 保留旧数据兼容。
 */
export const subjectKindSchema = z.enum(['person', 'product', 'scene', 'other']);
export type SubjectKind = z.infer<typeof subjectKindSchema>;

export const subjectImageRefSchema = z.object({
  artifact_id: sha256Schema,
  /** 是否清晰正脸。第一张必须为真（词条 `createSubjectAddImageHint`） */
  frontal: z.boolean(),
});

/* ============================================================
  一句提醒：下面这些 schema **故意不写上界**。

  一开始它们写的是 `z.array(...).max(4)`，验收用例立刻抓到一个真实缺陷：
  zod 的越界消息是**英文**的（`Too big: expected array to have <=4 items`），
  而且它比 `validateSubjectProfile` 更早触发——于是用户看到的就是一串英文 JSON，
  我们精心对齐的词条文案根本没机会出现。

  所以分工改成：**schema 只保证结构**（是不是这个形状、字段在不在），
  **数字与话术由 `validateSubjectProfile` 一处说了算**。
  这样"2–4 张图"这句话在代码里只有一份，中文提示也只有一份。
  ============================================================ */

export const subjectVideoRefSchema = z.object({
  artifact_id: sha256Schema,
  duration_seconds: z.number().positive(),
});

export const subjectVoiceRefSchema = z.object({
  artifact_id: sha256Schema,
  /** 音色名（对应文件名）。长度规则在 `validateSubjectProfile` 里判，见上面的说明 */
  label: z.string(),
  duration_seconds: z.number().positive(),
  /** 授权确认：没勾就不许绑（词条 `characterStudioVoiceAuthorization`）——真值判定同样在验证器里 */
  authorization_confirmed: z.boolean(),
  /** 素材扩展名（用于格式校验与回显） */
  extension: z.string().min(1).max(8),
});

/**
 * 智能补全的记录。

 * 词条把两件事说得很死，所以这里也如实记下来：
 *   `createSubjectScNotCancelled = 智能补全任务不会取消，积分不返还。`
 *   `createSubjectScShownInHistory = 任务完成后将展示在历史记录。`
 * 因此它是一个**一次性的任务留痕**，不是可以随手清掉的开关。
 */
export const subjectSmartCompletionSchema = z.object({
  status: z.enum(['REQUESTED', 'RUNNING', 'DONE', 'FAILED']),
  requested_at: z.string().min(1),
  /** 补全新增了几张视角图（DONE 之后才有意义） */
  added_images: z.number().int().nonnegative(),
  note: z.string().max(200).optional(),
});

export const subjectProfileSchema = z.object({
  schema: z.literal('replica.subject-profile@1'),
  /*
    用**空间方案那一份**的格式（`<kind>:<id>`，例如 `character:hero`）。

    这里曾经写成宽松的 `z.string()`，后果很隐蔽：档案能存下来，
    但空间方案里的同一条引用会被 `subjectRefSchema` 拒掉，
    于是"刚建好的主体用不进导演台"，而报错出现在完全另一处
    （空间计划未通过校验）。两边必须用同一个 schema。
  */
  subject_ref: subjectRefSchema,
  display_name: z.string().min(1).max(60),
  kind: subjectKindSchema,
  description: z.string(),
  tags: z.array(z.string().min(1).max(24)).max(12),
  images: z.array(subjectImageRefSchema),
  video: subjectVideoRefSchema.nullable(),
  voice: subjectVoiceRefSchema.nullable(),
  smart_completion: subjectSmartCompletionSchema.nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type SubjectProfile = z.infer<typeof subjectProfileSchema>;
export type SubjectImageRef = z.infer<typeof subjectImageRefSchema>;
export type SubjectVoiceRef = z.infer<typeof subjectVoiceRefSchema>;

/**
 * 命令载荷：一份主体档案里**由调用方提供**的那部分。

 * `schema` / `created_at` / `updated_at` 由服务端盖章，不由调用方填——
 * 否则"谁创建了它"这件事就成了调用方的一面之词。
 */
export const subjectProfileInputSchema = z.object({
  subject_ref: subjectRefSchema,
  display_name: z.string().min(1).max(60),
  kind: subjectKindSchema,
  description: z.string().default(''),
  tags: z.array(z.string().min(1).max(24)).max(12).default([]),
  images: z.array(subjectImageRefSchema).default([]),
  video: subjectVideoRefSchema.nullable().default(null),
  voice: subjectVoiceRefSchema.nullable().default(null),
  smart_completion: subjectSmartCompletionSchema.nullable().default(null),
});

export type SubjectProfileInput = z.input<typeof subjectProfileInputSchema>;

/**
 * 规则校验：通过返回 `null`，不通过返回**一句能直接给用户看的话**。

 * 话术尽量逐字用线上词条（`{min}`/`{max}` 换成实际数字）。
 * 返回字符串而不是抛错，是因为界面要在**输入过程中**就能提示，
 * 而抛错只适合"提交那一刻"。
 */
export function validateSubjectProfile(input: {
  kind: SubjectKind;
  display_name: string;
  description: string;
  images: readonly SubjectImageRef[];
  video: { duration_seconds: number } | null;
  voice: SubjectVoiceRef | null;
}): string | null {
  if (input.display_name.trim() === '') return '请输入主体名称';
  if (input.description.length > SUBJECT_DESC_MAX_CHARS) {
    return `主体描述不超过 ${SUBJECT_DESC_MAX_CHARS} 字`;
  }
  if (input.images.length > SUBJECT_IMAGE_MAX) {
    return `最多可添加 ${SUBJECT_IMAGE_MAX} 张图片`;
  }
  if (input.images.length > 0) {
    if (input.images.length < SUBJECT_IMAGE_MIN) {
      return `${SUBJECT_IMAGE_MIN}-${SUBJECT_IMAGE_MAX}张，第一张图必须为清晰正脸的图片`;
    }
    if (input.images[0]?.frontal !== true) {
      return '第一张图必须为清晰正脸的图片';
    }
  }
  if (input.video !== null) {
    if (input.kind !== 'person') return '目前视频仅支持人物主体';
    const seconds = input.video.duration_seconds;
    if (!(seconds >= SUBJECT_VIDEO_MIN_SECONDS && seconds <= SUBJECT_VIDEO_MAX_SECONDS)) {
      return `请上传时长在 ${SUBJECT_VIDEO_MIN_SECONDS}~${SUBJECT_VIDEO_MAX_SECONDS} 秒之间的视频`;
    }
  }
  if (input.voice !== null) {
    if (input.kind !== 'person') return '仅主体为人物时支持音色绑定和使用';
    const extension = input.voice.extension.toLowerCase().replace(/^\./, '');
    if (!(SUBJECT_AUDIO_EXTENSIONS as readonly string[]).includes(extension)) {
      return '请上传 mp3、wav、mp4 或 mov 格式文件';
    }
    if (input.voice.label.length < 1 || input.voice.label.length > SUBJECT_AUDIO_NAME_MAX_CHARS) {
      return `音频文件名需在 1~${SUBJECT_AUDIO_NAME_MAX_CHARS} 个字之间`;
    }
    if (input.voice.authorization_confirmed !== true) {
      return '克隆音色前，我已获得声音权利人的明确授权';
    }
    const seconds = input.voice.duration_seconds;
    if (!(seconds >= SUBJECT_VOICE_MIN_SECONDS && seconds <= SUBJECT_VOICE_MAX_SECONDS)) {
      return `音频时长需在 ${SUBJECT_VOICE_MIN_SECONDS}~${SUBJECT_VOICE_MAX_SECONDS} 秒之间`;
    }
  }
  if (input.images.length === 0 && input.video === null) {
    return '请选择图片素材，或上传一段视频素材';
  }
  return null;
}

/**
 * 生成要拼进提示词的那一小段（ASSET-006 的后半截）。

 * 逐字对齐词条 `characterStudioPromptWithReference`：
 *   `{prompt}；参考 {name} 的五官特点。`
 * 非人物主体没有对应词条，用"外观特征"这一版，并在备注里说明这是**我们补的**。
 */
export function subjectPromptFragment(profile: { display_name: string; kind: SubjectKind }): string {
  if (profile.kind === 'person') return `参考 ${profile.display_name} 的五官特点。`;
  if (profile.kind === 'product') return `参考产品「${profile.display_name}」的外观与材质特征。`;
  if (profile.kind === 'scene') return `参考场景「${profile.display_name}」的空间与光线特征。`;
  return `参考 ${profile.display_name} 的外观特征。`;
}

/** 把片段拼到一段提示词后面（已有内容才加分号，避免出现空提示词以标点开头）。 */
export function promptWithSubjectReference(prompt: string, profile: { display_name: string; kind: SubjectKind }): string {
  const base = prompt.trim();
  const fragment = subjectPromptFragment(profile);
  return base === '' ? fragment : `${base}；${fragment}`;
}

/**
 * 智能补全要用的视角。顺序就是优先级：先补三分之四侧，再侧面，最后背面。
 *
 * `createSubjectSmartComplete = 智能补全`。具体是哪几个角度词条没写，
 * 这三个是**我们定的**（也是主体三视图最常见的三档）。
 */
export const SUBJECT_COMPLETION_VIEWS = ['四分之三侧视角', '正侧视角', '背面视角'] as const;

/**
 * 智能补全的一次性说明（词条原文）。

 * `createSubjectScNotCancelled = 智能补全任务不会取消，积分不返还。`
 * `createSubjectScShownInHistory = 任务完成后将展示在历史记录。`
 * 这两句必须原样告诉用户——补全是一次**不可撤回**的付费动作。
 */
export const SUBJECT_COMPLETION_NOTICE =
  '智能补全任务不会取消，积分不返还。任务完成后将展示在历史记录。';

export interface SubjectAnglePlan {
  /** 这次要生成的视角（最多 `requested` 个，且不超过剩余可加张数） */
  views: string[];
  /** 每个视角对应的生成提示词 */
  prompts: string[];
  /** 还能再加几张参考图（上限 4，规则与创建时同一条） */
  remaining: number;
  /** 不能补全时的原因（能补时为 null） */
  blocked: string | null;
}

/**
 * 算一次智能补全要做哪些视角。

 * 三条规矩都在这里，界面与主进程共用同一份（各写一遍必然漂开）：
 *   · 得先有**至少一张**参考图：没有基图就无从"补其他视角"；
 *   · 总张数上限仍是 `SUBJECT_IMAGE_MAX`——补全不是绕过上限的口子；
 *   · 已经到上限就明确说"补不下了"，而不是生成一堆塞不进去的图。
 */
export function subjectAnglePlan(
  profile: { display_name: string; kind: SubjectKind; description: string; images: readonly unknown[] },
  requested = 2,
): SubjectAnglePlan {
  const remaining = Math.max(0, SUBJECT_IMAGE_MAX - profile.images.length);
  const base = [profile.display_name, profile.description].filter((part) => part.trim() !== '').join('，');
  const want = Math.max(1, Math.trunc(Number.isFinite(requested) ? requested : 2));
  if (profile.images.length === 0) {
    return { views: [], prompts: [], remaining, blocked: '先给这个主体加至少一张参考图，才能补其他视角' };
  }
  if (remaining === 0) {
    return {
      views: [], prompts: [], remaining,
      blocked: `已经有 ${SUBJECT_IMAGE_MAX} 张参考图，补不下更多了（要去掉一张才能补）`,
    };
  }
  const count = Math.min(want, remaining, SUBJECT_COMPLETION_VIEWS.length);
  const views = SUBJECT_COMPLETION_VIEWS.slice(0, count) as unknown as string[];
  const prompts = views.map((view) => `${base}；${view}，保持同一人物的五官与外观一致`.replace(/^；/, ''));
  return { views, prompts, remaining, blocked: null };
}
