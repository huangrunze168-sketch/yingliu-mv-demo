import { z } from 'zod';
import { rfc3339Schema, sha256Schema, uuidSchema } from './primitives.js';
import { subjectRefSchema } from './spatial-plan.js';
import { evalReportSchema } from './eval-report.js';
import { repairPlanSchema } from './repair-plan.js';
import { subjectProfileInputSchema } from './subject-profile.js';

export * from './primitives.js';
export * from './video-mode-validation.js';
export * from './spatial-plan.js';
export * from './eval-report.js';
export * from './repair-plan.js';
export * from './subject-profile.js';
export * from './node-patch-policy.js';
export * from './video-hd-tiers.js';
export * from './skill.js';

export const shotFieldSchema = z.object({
  shot_id: z.string().min(1),
  t0_ms: z.number().int().nonnegative(),
  t1_ms: z.number().int().positive(),
  duration_ms: z.number().int().positive(),
  shot_size: z.string().min(1),
  camera_position: z.string().min(1),
  camera_move: z.string().min(1),
  lighting: z.string().min(1),
  sound: z.string().min(1),
  replacement: z.string().min(1),
  confidence: z.number().min(0).max(1),
  source: z.enum(['model', 'human', 'mixed']),
  author: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.t1_ms <= value.t0_ms) {
    ctx.addIssue({ code: 'custom', path: ['t1_ms'], message: 't1_ms 必须大于 t0_ms' });
  }
  if (value.duration_ms !== value.t1_ms - value.t0_ms) {
    ctx.addIssue({ code: 'custom', path: ['duration_ms'], message: 'duration_ms 必须等于 t1_ms - t0_ms' });
  }
});

export const shotFieldsPayloadSchema = z.object({
  schema: z.literal('replica.shot-fields@1'),
  breakdown_revision: z.number().int().nonnegative(),
  fields_revision: z.number().int().nonnegative(),
  shots: z.array(shotFieldSchema).min(1),
});

const authDeclarationSchema = z.object({
  methods: z.array(z.enum(['bearer', 'oauth2', 'browser-same-origin', 'sms', 'none'])).min(1),
  credential_fields: z.array(z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    secret: z.boolean(),
  })),
  refresh: z.enum(['none', 'oauth2_refresh']),
  test_endpoint: z.object({ method: z.string().min(1), path: z.string().startsWith('/') }),
});

const endpointDeclarationSchema = z.object({
  base_url_required: z.boolean(),
  protocol_version: z.string().min(1),
  operations: z.array(z.object({
    name: z.string().min(1),
    method: z.string().min(1),
    path: z.string().startsWith('/'),
    required_params: z.array(z.string().min(1)).default([]),
  })).min(1),
});

const capabilitiesDeclarationSchema = z.object({
  modalities: z.array(z.enum(['transcription', 'vision', 'image', 'video', 'speech'])).min(1),
  params: z.record(z.string(), z.unknown()),
  features: z.record(z.string(), z.boolean()),
});

const rateLimitDeclarationSchema = z.object({
  quota_source: z.enum(['account', 'project', 'model']),
  rps: z.number().positive(),
  concurrency: z.number().int().positive(),
  backoff: z.enum(['exponential_jitter', 'fixed', 'vendor_directed']),
});

export const providerManifestSchema = z.object({
  schema: z.literal('replica.provider-manifest@1'),
  provider_id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  adapter_version: z.string().min(1),
  adapter_hash: sha256Schema,
  declarations: z.object({
    auth: authDeclarationSchema,
    endpoints: endpointDeclarationSchema,
    capabilities: capabilitiesDeclarationSchema,
    rate_limits: rateLimitDeclarationSchema,
  }),
  pricing_source: z.object({
    kind: z.enum(['vendor_doc', 'account_api', 'manual']),
    url: z.string().url().optional(),
    checked_at: rfc3339Schema,
  }),
  data_handling: z.object({
    region: z.string().min(1),
    retention: z.string().min(1),
    deletion: z.string().min(1),
  }),
  /**
   * 契约漂移探测结果（v2.3 §7.7 规则 8）。
   * 这一节由系统回写、适配器只读，所以适配器提交的任何值都会被领域层重置为 `unknown`——
   * 允许适配器自报 `clean`，就等于允许它伪造「我的接口没有漂移」。
   */
  probe: z.object({
    last_probed_at: rfc3339Schema.nullable().default(null),
    drift_status: z.enum(['clean', 'drifted', 'unknown']).default('unknown'),
    drift_details: z.array(z.unknown()).default([]),
  }).optional(),
  testOnly: z.boolean().optional().default(false),
});

/**
 * 人工闸门全序（总纲 §2.2）。
 * 契约层先于实现给出全部六个闸门，是为了让「G3–G5 尚未接入」表现为一条
 * 明确的领域错误，而不是一个让人摸不着头脑的「枚举值不合法」。
 */
export const GATE_NAMES = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5'] as const;
export type GateName = (typeof GATE_NAMES)[number];
export const gateSchema = z.enum(GATE_NAMES);

/**
 * 目前真正接入审批流程的闸门；其余闸门在契约里合法，但领域层会明确拒绝。
 * G3（成片评审）尚未接入——它需要一个正式的「成片」事实，目前成片只是内核产物。
 */
export const IMPLEMENTED_GATES = ['G0', 'G1', 'G2', 'G4'] as const;

const baseCommandFields = {
  command_id: uuidSchema,
  correlation_id: uuidSchema.optional(),
  actor: z.string().min(1).default('user:local'),
};

const projectCommandFields = {
  project_id: uuidSchema,
  expected_revision: z.number().int().nonnegative(),
};

/**
 * 供应商报出的花费，**单位跟着数字走**。
 *
 * 为什么不能统一折算成"分"：图像生成服务报的是积分（`credit_count`），小QTV 什么都不报，
 * 而积分与人民币的汇率并未公开。把 3 个积分记成 3 分钱，账本就再也对不上了。
 * 所以这一层只做两件事：原样记下来、把单位一起记下来。
 */
export const providerCostSchema = z.object({
  unit: z.enum(['credit', 'cent']),
  amount: z.number().nonnegative(),
});

/**
 * 显式释放一笔**预留**。
 *
 * 存在的理由是一个曾经写错的账：生成失败时结清会写 `actual_cost_cents: 0`，
 * 好把预留退回预算。可那是个**假设**——供应商完全可能已经计费（请求发出去了、
 * 只是我们没拿到结果）。把假设写成事实，账本上就多了一笔"确定花了 0 元"，
 * 而它没有任何凭据。
 *
 * 现在的口径分成三种，互不冒充：
 *   · 拿到人民币金额 → 写 `actual_cost_cents`，按实际花费退差额；
 *   · 什么都没拿到   → **预留不动**（能证明省了钱才退，证不了就继续占着）；
 *   · 带 `release_reservation` → 明确释放，`reason` 要写清凭什么敢释放
 *     （例如"还没提交给生成后端"）。这个字段是调用方对"这笔没花钱"的断言，
 *     不是推断，所以必须给理由。
 */
export const releaseReservationSchema = z.object({
  reason: z.string().min(1).max(200),
});

/**
 *
 * 放在契约里当权威清单，因为三个地方都要认它：契约的枚举、领域层的归一化、
 * 以及内核层生成配方时选的 operator。各写一份迟早会漂。
 *
 * `cut` 是默认：它走的是"每镜一个 Item"的原生结构，其余几种都要改成
 * `Sequence + Member + Handoff`——**换的不只是参数，是成片结构**。
 */
export const FILM_TRANSITIONS = ['cut', 'crossfade', 'push', 'wipe', 'cover', 'page-turn'] as const;
export type FilmTransition = (typeof FILM_TRANSITIONS)[number];

/**
 * 方向性转场的方向。
 *
 * 只有 push / wipe / cover / page-turn 认它——crossfade 不需要方向，
 * 所以这一项在界面上**只在选了方向性转场时才出现**。
 */
export const TRANSITION_DIRECTIONS = ['left', 'right', 'up', 'down'] as const;
export type TransitionDirection = (typeof TRANSITION_DIRECTIONS)[number];

/**
 * 服务端持久化的画布文档。业务节点参数保持可扩展，但坐标、边和规模在入口处受限，
 * 避免把 React Flow 的瞬时对象或无限大的 localStorage 数据直接写进领域库。
 */
export const canvasDocumentSchema = z.object({
  version: z.literal(2),
  nodes: z.array(z.object({
    id: z.string().min(1).max(120),
    type: z.string().min(1).max(80),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    width: z.number().positive().max(2_000).optional(),
    height: z.number().positive().max(20_000).optional(),
    data: z.record(z.string(), z.unknown()).superRefine((data, context) => {
      if (data.variants === undefined) return;
      if (!Array.isArray(data.variants) || data.variants.length > 8 || data.variants.some(item => !item || typeof item !== 'object' || !/^sha256:[a-f0-9]{64}$/.test(item.artifactId) || !['image', 'video', 'audio'].includes(item.mediaKind) || typeof item.name !== 'string' || item.name.length > 200)) {
        context.addIssue({ code: 'custom', path: ['variants'], message: '生成候选必须是至多 8 个合法素材引用' });
      }
    }),
    groupId: z.string().min(1).max(120).optional(),
    locked: z.boolean().optional(),
  })).max(500),
  edges: z.array(z.object({
    id: z.string().min(1).max(240),
    source: z.string().min(1).max(120),
    target: z.string().min(1).max(120),
    sourceHandle: z.string().max(120).nullable().optional(),
    targetHandle: z.string().max(120).nullable().optional(),
    referenceRole: z.enum(['first-frame', 'last-frame', 'reference-image', 'reference-video', 'reference-audio', 'text-input']).optional(),
  })).max(1_000),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive().min(0.05).max(8) }).optional(),
}).superRefine((document, context) => {
  const ids = new Set<string>();
  document.nodes.forEach((node, index) => {
    if (ids.has(node.id)) context.addIssue({ code: 'custom', path: ['nodes', index, 'id'], message: '节点 id 不能重复' });
    ids.add(node.id);
  });
  document.edges.forEach((edge, index) => {
    if (!ids.has(edge.source) || !ids.has(edge.target)) context.addIssue({ code: 'custom', path: ['edges', index], message: '连线端点必须存在于当前画布' });
    if (edge.source === edge.target) context.addIssue({ code: 'custom', path: ['edges', index], message: '节点不能连接自身' });
  });
});
export type CanvasDocumentContract = z.infer<typeof canvasDocumentSchema>;

export const TIMELINE_TRACKS = ['C1', 'V2', 'V1', 'A1', 'A2'] as const;
export const timelineDocumentSchema = z.object({
  version: z.literal(1),
  ripple: z.boolean(),
  clips: z.array(z.object({
    id: z.string().min(1).max(120),
    track: z.enum(TIMELINE_TRACKS),
    label: z.string().min(1).max(160),
    startMs: z.number().int().nonnegative(),
    durationMs: z.number().int().positive().max(3_600_000),
    sourceOffsetMs: z.number().int().nonnegative(),
    shotId: z.string().min(1).max(120).optional(),
    artifactId: sha256Schema.optional(),
  })).max(2_000),
}).superRefine((document, context) => {
  const ids = new Set<string>();
  document.clips.forEach((clip, index) => { if (ids.has(clip.id)) context.addIssue({ code: 'custom', path: ['clips', index, 'id'], message: '片段 id 不能重复' }); ids.add(clip.id); });
});
export type TimelineDocumentContract = z.infer<typeof timelineDocumentSchema>;

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ ...baseCommandFields, type: z.literal('project.create'), payload: z.object({ name: z.string().min(1).max(120), workspace_id: uuidSchema.optional(), workspace_name: z.string().min(1).max(120).optional(), max_budget_cents: z.number().int().nonnegative(), rights_confirmed: z.boolean() }) }),
  /**
   * 项目删除分两步，不是一个"删除"按钮。
   *
   * `project.trash` 是可恢复的（软删除），`project.purge` 才是真的抹掉。
   * 分开是因为**这两件事的后果差一个数量级**：前者用户点错了还能回来，
   * 后者回来不了。合成一个命令、用一个"确认"对话框去区分，是把不可逆
   * 和可逆混在同一条代码路径上——那种设计里"确认"迟早会被绕过。
   *
   * `purge` 要求 `confirm_name` 与项目名逐字一致，且**只接受已在回收站的项目**。
   * 两层都必要：只靠输入名字，误删活跃项目一样会发生；只靠"在回收站里"，
   * 回收站里点一下也会删掉一个真实项目。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('project.trash'), payload: z.object({}) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('project.restore'), payload: z.object({}) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('project.purge'), payload: z.object({ confirm_name: z.string().min(1).max(120) }) }),
  /**
   * 改项目名。
   *
   * 与 `project.create` 同一套长度限制（1–120）：改名不该比新建更宽松，
   * 否则会出现"建不出来的名字，改却能改进去"。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('project.rename'), payload: z.object({ name: z.string().min(1).max(120) }) }),
  /** 复制项目基础信息、分镜、素材引用与生成历史；payload.name 可覆盖默认副本名。 */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('project.duplicate'), payload: z.object({ name: z.string().min(1).max(120).optional(), target_project_id: uuidSchema.optional() }) }),
  /**
   * 项目文件夹：**只做分组**，不改变项目本身的任何事实。
   *
   * 为什么值得单独建一张表而不是给项目加个 tag 字段：文件夹是"用户怎么整理自己的项目库"，
   * 与"这条片子做到哪一步"是两件事。混进项目事实里，导出/迁移时会跟着项目走，
   * 而那并不是用户想要的（换台机器还想保留分组，是另一回事）。
   */
  z.object({ ...baseCommandFields, type: z.literal('folder.create'), payload: z.object({ name: z.string().min(1).max(60) }) }),
  /**
   * 删掉一个文件夹。
   *
   * **删文件夹不等于删项目**：里面的项目会回到"未分组"，一个都不少。
   * 这条语义要写进契约注释里——否则将来有人实现成级联删除，用户丢掉的是整批项目。
   */
  z.object({ ...baseCommandFields, type: z.literal('folder.delete'), payload: z.object({ folder_id: uuidSchema }) }),
  /** 改文件夹名；规则与 `folder.create` 一致（重名的照样拒绝）。 */
  z.object({ ...baseCommandFields, type: z.literal('folder.rename'), payload: z.object({ folder_id: uuidSchema, name: z.string().min(1).max(60) }) }),
  /** 把项目放进某个文件夹；`folder_id: null` 表示移出文件夹（回到未分组）。 */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('project.move-to-folder'), payload: z.object({ folder_id: uuidSchema.nullable() }) }),
  /**
   * 成片的播放策略：**片段与镜头不等长时怎么办**。
   *
   * 为什么需要这个选择：镜头时长来自参考片的切镜，片段时长来自生成，
   * 也就是成片尾部露一段黑底——那显然不是任何人想要的，
   * 但"改成什么"有两种合理答案，得让用户定：
   *
   *   hold   —— 播完停在最后一帧（画面还是这一镜的画面）
   *   stretch —— 把源片段拉伸到正好填满窗口（也就是**变速**：源短则慢放，
   *              源长则快放）。参考片的镜头是几秒，成片就正好是几秒。
   *
   * 默认 `hold`：它只影响"多出来的那一段"，不会改变已经对上的部分。
   * `stretch` 会改变播放速度——那是创作决定，不该由我们替用户默认。
   */
  z.object({
    ...baseCommandFields,
    ...projectCommandFields,
    type: z.literal('film.settings.set'),
    payload: z.object({
      /** 片段与镜头不等长时：停最后一帧 / 变速填满 */
      playback: z.enum(['hold', 'stretch']).optional(),
      /**
       * 镜头之间怎么换：硬切 / 淡入淡出。
       *
       * 所以这一项不只是换个参数，而是换一种成片结构。
       */
      transition: z.enum(FILM_TRANSITIONS).optional(),
      /**
       * 方向性转场往哪边走；只有 push / wipe / cover / page-turn 用得上。
       * 它在**换了转场类型之后仍然留着**：用户改成横切再改回推镜，
       * 方向不该被重置——那是两件事。
       */
      direction: z.enum(TRANSITION_DIRECTIONS).optional(),
    }).refine(
      (value) => value.playback !== undefined || value.transition !== undefined || value.direction !== undefined,
      { message: '至少要给一项设置（playback / transition / direction）' },
    ),
  }),
  /**
   * 单独改**某一个镜头**的播放策略。
   *
   * 为什么在项目级之外还要逐镜：真实项目里不同镜头的处理方式确实不同——
   * 对话那几镜想停格（保住口型），空镜想慢放填满（保住节奏）。
   * 只给项目级的话，用户只能二选一，然后手工把不合意的那几镜重做一遍。
   *
   * `inherit` 表示"跟随项目设置"：它不是第三种策略，而是**把覆盖撤掉**。
   * 领域层会删掉那一行——"没设过"与"设成跟随"是同一件事，
   * 存成两行只会让读取方多判一次。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('shot.playback.set'), payload: z.object({ shot_id: z.string().min(1), playback: z.enum(['inherit', 'hold', 'stretch']) }) }),
  z.object({ ...baseCommandFields, type: z.literal('provider.register'), payload: z.object({ manifest: providerManifestSchema }) }),
  /** 仅在用户明确确认素材权利与预算上限后调用；不表示已经消费费用。 */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('project.production.authorize'), payload: z.object({ max_budget_cents: z.number().int().min(1).max(1_000_000), rights_confirmed: z.literal(true) }) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('shot-fields.replace'), payload: z.object({ breakdown_revision: z.number().int().nonnegative(), shots: z.array(shotFieldSchema).min(1) }) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('canvas-document.replace'), payload: z.object({ document: canvasDocumentSchema }) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('timeline-document.replace'), payload: z.object({ document: timelineDocumentSchema }) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('gate.approve'), payload: z.object({ gate: gateSchema, note: z.string().max(500).optional(), approved_budget_cents: z.number().int().nonnegative().optional() }) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('prompt.derive'), payload: z.object({ kit_version: z.string().min(1), model_id: z.string().min(1) }) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('image-candidate.add'), payload: z.object({ shot_id: z.string().min(1), candidate_id: z.string().min(1), artifact_id: sha256Schema }) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('image-candidate.select'), payload: z.object({ shot_id: z.string().min(1), candidate_id: z.string().min(1), expected_selection_revision: z.number().int().nonnegative() }) }),
  /**
   * 移除一张图片候选（不删产物本身）。
   *
   * 为什么要有它：`artifact.delete` 会在"这份产物还被当作候选"时拒绝删除，
   * 而在此之前**没有任何办法把候选摘掉**——一张不满意的图只能永远留在项目里
   * （真机上撞到：验证用的占位图候选删不掉）。小QTV 那边候选是可以清掉的。
   *
   * 与 `image-candidate.add` 对称：只动候选这一层；产物要不要删是**另一件事**，
   * 摘掉候选之后 `artifact.delete` 才轮得到它。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('image-candidate.remove'), payload: z.object({ candidate_id: z.string().min(1) }) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('video.request'), payload: z.object({ shot_id: z.string().min(1), estimated_cost_cents: z.number().int().nonnegative() }) }),
  z.object({ ...baseCommandFields, type: z.literal('subject.register'), payload: z.object({ subject_ref: subjectRefSchema, display_name: z.string().min(1).max(120) }) }),
  /**
   * 主体档案（ASSET-003/005/006）。
   *
   * 与 `subject.register` 的关系：登记是"这个主体存在"（空间方案引用它时校验用），
   * 档案是"这个主体长什么样、能不能配音"。`subject.profile.set` 会顺手把登记也补上，
   * 所以调用方不需要先 register 再 set——两条命令各写一遍只会让人漏掉一条。
   */
  z.object({ ...baseCommandFields, type: z.literal('subject.profile.set'), payload: subjectProfileInputSchema }),
  z.object({ ...baseCommandFields, type: z.literal('subject.profile.remove'), payload: z.object({ subject_ref: z.string().min(1).max(120) }) }),
  /**
   * 画布模板（CAN-010「我的工具箱」/ FLOW-008「流水线固化」）。
   *
   * 契约只保证**信封**：名字、类型、以及"这确实是一份模板载荷（schema 对得上、nodes/edges 是数组）"。
   * 节点配置本身由画布层解析（那份结构与 `CanvasNode` 一一对应，抄一份到契约里迟早两边漂开）。
   *
   * `node_count` / `edge_count` **不由调用方填**——由领域层从载荷里数出来。
   * 让调用方填，就是给"账对不上"留一个口子。
   */
  z.object({
    ...baseCommandFields,
    type: z.literal('template.save'),
    payload: z.object({
      template_id: z.string().min(1).max(120),
      name: z.string().min(1).max(60),
      kind: z.enum(['canvas', 'pipeline']),
      payload: z.object({
        schema: z.literal('xqtv.canvas-template@1'),
        nodes: z.array(z.unknown()),
        edges: z.array(z.unknown()),
      }).passthrough(),
    }),
  }),
  z.object({
    ...baseCommandFields,
    type: z.literal('template.remove'),
    payload: z.object({ template_id: z.string().min(1).max(120) }),
  }),
  /**
   * **不绑镜头**的生成意图（项目级素材生成）。

   * 为什么需要它：有两类生成天然没有"哪一镜"这个概念——
   *   · 主体智能补全（给主体追加其他视角图，见 ASSET-004）
   *   · 音频生成（配音 / 音乐，见 AUD-001 / AUD-002）
   * 而既有的 `image-generation.request` / `video-generation.request` 都要求 `shot_id`，
   * 还要求镜头存在于字段表里——拿它们套这两类生成，等于先编一个假镜头出来。

   * 与那两条**同样的规矩一条不少**：先预留预算、结清时按实际退回、失败要说清原因。
   * `purpose` 必填：它回答"这次生成是为了什么"；
   * 没有它，账上会出现一笔谁也说不清来历的支出。

   * 闸门方面**不查 G1/G2**：那两道管的是"拆解冻结"与"允许花视频的钱"，
   * 而主体补全、配音与镜头拆解无关。**项目预算上限**照样是硬约束。
   */
  z.object({
    ...baseCommandFields,
    ...projectCommandFields,
    type: z.literal('asset-generation.request'),
    payload: z.object({
      /**
       * `video` 用在**视频续写**上：它接的是一段已有成片的尾巴，
       * 与"哪一镜的首帧"无关，所以不走 G2（G2 管的是按分镜出视频）。
       */
      kind: z.enum(['image', 'audio', 'video']),
      /** 这次生成是为了什么（例如 `subject:character:lin:angles`） */
      purpose: z.string().min(1).max(120),
      model: z.string().min(1),
      prompt: z.string().max(4000).optional(),
      estimated_cost_cents: z.number().int().nonnegative(),
      digest: z.string().min(1).max(200).optional(),
    }),
  }),
  z.object({
    ...baseCommandFields,
    ...projectCommandFields,
    type: z.literal('asset-generation.settle'),
    payload: z.object({
      intent_id: uuidSchema,
      status: z.enum(['COMPLETED', 'FAILED']),
      actual_cost_cents: z.number().int().nonnegative().optional(),
      provider_cost: providerCostSchema.optional(),
      /** 产物（内容寻址）。成功却没给产物，等于"跑完了但没东西"——按失败处理 */
      artifact_id: sha256Schema.optional(),
      failure: z.string().max(2000).optional(),
      release_reservation: releaseReservationSchema.optional(),
    }),
  }),
  z.object({ ...baseCommandFields, type: z.literal('artifact.publish'), payload: z.object({ artifact_id: sha256Schema, media_type: z.string().min(1), bytes: z.number().int().nonnegative(), metadata: z.record(z.string(), z.unknown()).optional() }) }),
  /**
   * 删掉一份产物（内容寻址的那张记录 + 磁盘上的文件）。
   *
   * 存在的理由很直白：上传错了、生成废了，**没有地方删**——
   * 界面上没有按钮，领域层也没有这条命令。产物只进不出，项目目录与资产页只会越来越乱。
   *
   * 但它比"删一个文件"重得多，因为 `artifacts` 表是**全局内容寻址**的：
   * 同一份内容可能被别的项目引用，也可能在本项目里已经是某一镜的首帧候选。
   * 所以领域层会**先查引用**（本项目 + 其它项目），还在用就拒绝并说清"还在用在哪"。
   * 那条检查不是形式主义：删掉被引用的产物，界面上只会看到"某张图突然空了"，
   * 而报错点在很远的地方。
   *
   * 磁盘文件由主进程在同一动作里删——领域层不碰磁盘（这条分界从第一天就立着）。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('artifact.delete'), payload: z.object({ artifact_id: sha256Schema }) }),
  /**
   * 给一份资产打分（1–5 星），`stars: 0` 表示**清除评分**。
   *
   * 依据 小QTV 实测（i18n 词条）：资产页有 `historyRatingStars={count}星`、
   * `historyRatingUnrated=未评分`、`historyMinRatingOption={count}星及以上`
   * 三项——也就是说"评级"是资产页的一等筛选维度。
   *
   * 用 `0` 表示清除而不是另开一个命令：界面上"取消评分"与"打 0 星"是同一件事，
   * 分成两个命令只会让调用方多一个判断，而那个判断迟早会写错一边。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('asset.rate'), payload: z.object({ artifact_id: sha256Schema, stars: z.number().int().min(0).max(5) }) }),
  /**
   * `plan` 故意用宽松类型。
   * 完整的 SpatialPlan 校验交给 @qiyin/spatial-control：那里能返回
   * 「哪个字段违规、为什么违规」的结构化 issues；若在这里用完整 schema，
   * 调用方只会拿到一句笼统的「输入不符合契约」，无法定位问题。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('spatial-plan.set'), payload: z.object({ shot_id: z.string().min(1), plan: z.record(z.string(), z.unknown()), expected_spatial_revision: z.number().int().nonnegative() }) }),
  /**
   * 请求 前置内核校验一个 Source（前置 agent 的第一道关口）。
   *
   * 只登记意图，不在领域层同步执行——内核是外部进程，领域层只负责「这件事发生过」
   * 与「结果是什么」。实际调用由上层（本地面板 / API / Agent）发起，再用
   * kernel.result.record 回填，与 video.request 的模式保持一致。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('kernel.check'), payload: z.object({ source_path: z.string().min(1), purpose: z.string().max(200).optional() }) }),
  /** 请求内核规划一个 Run（.svrun）：解析目标与能力需求，不提交任何执行。 */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('kernel.plan'), payload: z.object({ source_path: z.string().min(1), purpose: z.string().max(200).optional() }) }),
  /**
   * 请求内核提交一次构建（.svrun）。
   *
   * 与 check/plan 的差别：它会真正驱动 Provider 执行。默认「提交后即返回」，
   * 由后台 Worker 继续，因此本命令本身仍然是快速的。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('kernel.build'), payload: z.object({ source_path: z.string().min(1), purpose: z.string().max(200).optional() }) }),
  /** 请求内核分析参考视频（媒体探测 + 镜头边界候选）。与其它内核动作同构。 */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('kernel.analyze'), payload: z.object({ source_path: z.string().min(1), purpose: z.string().max(200).optional() }) }),
  /** 请求 前置内核 官方 transcribe 生成逐词时间戳；Provider 与费用由 Runtime Profile 决定。 */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('kernel.transcribe'), payload: z.object({ source_path: z.string().min(1), purpose: z.string().max(200).optional() }) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('kernel.result.record'), payload: z.object({ task_id: uuidSchema, status: z.enum(['COMPLETED', 'FAILED']), report: z.record(z.string(), z.unknown()).optional(), failure: z.string().max(2000).optional() }) }),
  /**
   * 登记一个参考视频（S0 的产物）。
   *
   * 只保存项目内的相对路径与内容哈希：绝对路径会把开发机目录写进项目事实，
   * 而内容哈希才是「这份素材到底是哪一版」的可靠标识。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('source.register'), payload: z.object({ relative_path: z.string().min(1), content_hash: sha256Schema, bytes: z.number().int().nonnegative(), media_type: z.string().min(1).optional() }) }),
  /**
   * 由镜头边界候选生成拆解草稿（S1 → S2 的衔接）。
   *
   * 自动分析只给得出时长；其余六项按契约显式写成 `unknown`，
   * 由人在七字段编辑器中确认——留空会让下游误以为「确认无此项」。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('shot-fields.seed'), payload: z.object({ breakdown_revision: z.number().int().nonnegative(), boundaries: z.array(z.object({ t0_ms: z.number().int().nonnegative(), t1_ms: z.number().int().positive(), confidence: z.number().min(0).max(1).optional() })).min(1) }) }),
  /**
   * 记录一份偏差评估报告（S8）。
   *
   * 评估本身在服务层完成（探测参考片与成片的真实事实），
   * 领域层只负责把结论连证据与归因一起留成项目事实。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('eval.record'), payload: z.object({ report: evalReportSchema }) }),
  /** 记录一份修复方案（S9）。方案来自评估报告的归因，不能凭空产生。 */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('repair.propose'), payload: z.object({ plan: repairPlanSchema }) }),
  /**
   * 记录一次修复执行的结果（S9 的后半段）。
   *
   * 这条命令**只记账**：真正的前置校验（计划是否仍然新鲜、闸门是否批准）发生在
   * 执行器那一侧——因为它必须先于改动发生，而改动一旦落库，revision 就变了。
   * 为了让这份记录仍然可核，执行器必须带上 `execution_revision`（它验证时看到的
   * revision），领域层据此确认"G4 批准的就是这个 revision"，而不是事后拿新 revision 去猜。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('repair.execute'), payload: z.object({
    plan_id: uuidSchema,
    execution_revision: z.number().int().nonnegative(),
    status: z.enum(['EXECUTED', 'PARTIAL', 'FAILED']),
    executed: z.array(z.string().min(1)).default([]),
    refused: z.array(z.object({
      id: z.string().min(1),
      kind: z.string().min(1),
      reason: z.string().min(1).max(600),
    })).default([]),
    note: z.string().max(2000).optional(),
  }) }),
  /**
   * 申请一次图片生成（S5）。
   *
   * 这是**第一个真正花钱的动作**，因此它必须比其它命令更谨慎：
   * 前置条件（G1 已批准）与预算都在领域层检查，预估成本当场预留。
   * 与 video.request 同一套模式——领域层登记意图，上层执行，再回填结果。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('image-generation.request'), payload: z.object({ shot_id: z.string().min(1), model: z.string().min(1), prompt: z.string().min(1).max(4000), estimated_cost_cents: z.number().int().nonnegative(), digest: z.string().min(1).max(200).optional() }) }),
  /**
   * 复用一次已有结果，而不是再花一次钱。
   *
   * 这是 `FLOW-006 缓存与历史结果显式复用` 的落点：生成之前先算一次
   * **执行摘要（digest）**——把"决定这张图长什么样的所有输入"折成一个字符串。
   * 摘要相同、来源意图是成功的那一条，就可以直接把它的产物登记成新候选。
   *
   * 两条硬约束让它不至于变成"乱复用"：
   *   · 来源意图必须 COMPLETED——失败的那条没有产物可复用；
   *   · **摘要必须逐字相同**，由领域层再比一次，而不是只信调用方说"这个能复用"。
   *     只信调用方的话，任何 bug 都能让一张不相干的图被当成命中。
   *
   * 复用**不预留预算、也不花钱**：账目上这一笔的 `actual_cost_cents` 是 0，
   * 而且这是**事实**（我们确实没有调用供应商），不是"不知道"。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('image-generation.reuse'), payload: z.object({ shot_id: z.string().min(1), candidate_id: z.string().min(1), source_intent_id: uuidSchema, digest: z.string().min(1).max(200) }) }),
  /**
   * 回填一次图片生成的结果。
   *
   * 实际成本与预估成本的差额在这里结清：多预留的退回，超支的从项目预算里补记。
   * 不结清就会出现「预留了但没人还」的预算黑洞。
   *
   * `actual_cost_cents` 是**可选**的，这一条很关键：
   * 只有拿到可信的人民币金额时才写它。供应商报的是积分（图像生成服务）或什么都不报（小QTV）时，
   * 这个字段留空——以前这里把"预估成本"顶上来当实际花费，账本于是记着一个
   * 谁也没报过的数字，而且单位还是错的。原样报了什么，就写进 `provider_cost`。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('image-generation.settle'), payload: z.object({ intent_id: uuidSchema, status: z.enum(['COMPLETED', 'FAILED']), actual_cost_cents: z.number().int().nonnegative().optional(), provider_cost: providerCostSchema.optional(), candidate_id: z.string().min(1).optional(), failure: z.string().max(2000).optional(), release_reservation: releaseReservationSchema.optional() }) }),
  /**
   * 事后释放一笔**已经失败结清**的预留。
   *
   * 与结清时的 `release_reservation` 是两个时点：那一条是"失败那一刻就知道没花钱"，
   * 这一条是"当时不知道，后来查清了"（比如对了供应商账单，确认这笔没扣）。
   *
   * 为什么必须有这条命令：`settle` 只能结清一次（第二次会被拒），
   * 所以一旦按"是否计费未知"结清，那笔预留就**再也放不出去**了——
   * 用户的可用预算被永久扣住，而没有任何入口能解开。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('image-generation.release-reservation'), payload: z.object({ intent_id: uuidSchema, reason: z.string().min(1).max(200) }) }),
  /**
   * 申请一次视频生成（S6）。
   *
   * **这是 G2 存在的全部意义**：未选帧的镜头不得产生付费视频请求。
   * 因此前置条件比图片生成更硬——它同时要求 G2 已批准，且该镜已选定首帧。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('video-generation.request'), payload: z.object({ shot_id: z.string().min(1), model: z.string().min(1), prompt: z.string().max(4000).optional(), duration_seconds: z.number().int().positive(), estimated_cost_cents: z.number().int().nonnegative(), digest: z.string().min(1).max(200).optional() }) }),
  /**
   * 复用一段已有的视频结果，而不是再花一次钱。
   *
   * 与图片那条（`image-generation.reuse`）同一套规矩：来源必须成功、
   * 摘要必须逐字相同，而且**它不预留预算**——视频比图片贵得多，
   * 这一条省下的钱是实打实的。
   *
   * 与图片的区别只有一处：图片复用登记的是**候选**，视频复用登记的是**片段**
   * （`clip_artifact_id`）——视频没有"候选"这个概念，一段就是一段。
   */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('video-generation.reuse'), payload: z.object({ shot_id: z.string().min(1), source_intent_id: uuidSchema, digest: z.string().min(1).max(200) }) }),
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('video-generation.settle'), payload: z.object({ intent_id: uuidSchema, status: z.enum(['COMPLETED', 'FAILED']), actual_cost_cents: z.number().int().nonnegative().optional(), provider_cost: providerCostSchema.optional(), clip_artifact_id: sha256Schema.optional(), failure: z.string().max(2000).optional(), release_reservation: releaseReservationSchema.optional() }) }),
  /** 见 `image-generation.release-reservation`：视频那侧同一条。 */
  z.object({ ...baseCommandFields, ...projectCommandFields, type: z.literal('video-generation.release-reservation'), payload: z.object({ intent_id: uuidSchema, reason: z.string().min(1).max(200) }) }),
  ]);

export type DomainCommand = z.infer<typeof commandSchema>;
export type ProviderManifest = z.infer<typeof providerManifestSchema>;
export type ShotField = z.infer<typeof shotFieldSchema>;

/**
 * 已实现的领域命令类型清单。
 *
 * 存在的意义是区分两种失败：
 *   · 「命令尚未实现」（界面上的按钮还没接后端）→ 501 COMMAND_NOT_IMPLEMENTED
 *   · 「输入不符合契约」（调用方给了错数据）    → 400 VALIDATION_FAILED
 * 两者混在一起时，界面只能显示「输入不符合契约」，用户与开发者都无从判断
 * 到底是自己填错了，还是这个功能根本还没通电。
 *
 * 该清单必须与 commandSchema 保持一致，由 tests/contracts.test.ts 断言。
 */
export const COMMAND_TYPES = [
  'project.create',
  'project.trash',
  'project.restore',
  'project.purge',
  'folder.create',
  'folder.delete',
  'folder.rename',
  'project.rename',
  'project.duplicate',
  'project.move-to-folder',
  'film.settings.set',
  'shot.playback.set',
  'provider.register',
  'project.production.authorize',
  'shot-fields.replace',
  'canvas-document.replace',
  'timeline-document.replace',
  'gate.approve',
  'prompt.derive',
  'image-candidate.add',
  'image-candidate.select',
  'image-candidate.remove',
  'video.request',
  'subject.register',
  'subject.profile.set',
  'subject.profile.remove',
  'template.save',
  'template.remove',
  'asset-generation.request',
  'asset-generation.settle',
  'artifact.publish',
  'artifact.delete',
  'asset.rate',
  'spatial-plan.set',
  'kernel.check',
  'kernel.plan',
  'kernel.build',
  'kernel.analyze',
  'kernel.transcribe',
  'kernel.result.record',
  'source.register',
  'shot-fields.seed',
  'eval.record',
  'repair.propose',
  'repair.execute',
  'image-generation.request',
  'image-generation.reuse',
  'image-generation.settle',
  'image-generation.release-reservation',
  'video-generation.request',
  'video-generation.reuse',
  'video-generation.settle',
  'video-generation.release-reservation',
] as const;

/** 自动分析无法确定时的显式占位。留空与「确认无此项」在语义上不同。 */
export const SHOT_FIELD_UNKNOWN = 'unknown';
export type CommandType = (typeof COMMAND_TYPES)[number];

export interface ResultEnvelope<T = unknown> {
  schema: 'replica.command-result@1';
  command_id: string;
  correlation_id: string;
  project_id: string | null;
  project_revision: number | null;
  created_at: string;
  producer: { name: 'project-service'; version: string };
  payload: T;
  replayed?: boolean;
}

export interface DomainEvent {
  sequence: number;
  event_id: string;
  project_id: string;
  project_revision: number;
  type: string;
  actor: string;
  correlation_id: string;
  created_at: string;
  payload: unknown;
}
