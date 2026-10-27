import { z } from 'zod';
import { rfc3339Schema, sha256Schema } from './primitives.js';

/* ============================================================
   SpatialPlan@1 —— 空间意图的结构化载体（架构 v2.3 §7.5）
   ------------------------------------------------------------
   纯提示词表达不了「谁站在哪、镜头从哪看、光从哪来」。空间意图必须有
   自己的结构化载体，否则只能靠反复重抽碰运气，成本不可控。

   v2.3 §7.5.2 的八条契约规则在这里被拆成两类：
     · 能用 schema 表达的（参数域、坐标系、字段形状）→ 本文件
     · 需要外部上下文才能判定的（主体是否已登记、蓝图是否已发布、
       串里有没有混进临时 URL）→ packages/spatial-control 的校验器
   本文件只放第一类，避免把「校验通过」误当成「业务合法」。
   ============================================================ */

/** 参数域：越界一律在提交前拒绝，绝不静默钳制（§7.5.2 规则 3）。 */
export const SPATIAL_PARAM_DOMAINS = {
  /** 镜头焦距（mm）：8 覆盖鱼眼，1200 覆盖长焦 */
  lens_mm: { min: 8, max: 1200 },
  /** 垂直视场角（度）：趋近 180 即为极广角 */
  fov_deg: { min: 1, max: 179 },
  /** 俯仰角（度）：±90 为完全俯视/仰视 */
  pitch_deg: { min: -90, max: 90 },
  /** 光的相对强度 */
  intensity: { min: 0, max: 10 },
  /** 主体缩放倍率 */
  subject_scale: { min: 0.05, max: 20 },
  /** 场景坐标范围（米）：防止把米和厘米混用后撑爆数值 */
  coordinate_m: { min: -1000, max: 1000 },
} as const;

/** 坐标系固定为 y 轴朝上的右手系，避免导出到不同 Provider 时左右镜像（§7.5.2 规则 4）。 */
export const SPATIAL_COORDINATE_SYSTEM = 'y_up_right_handed' as const;

/** 主体引用形如 `character:hero`；是否真的登记过由校验器判定。 */
export const subjectRefSchema = z.string().regex(
  /^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/,
  '主体引用必须形如 <kind>:<id>，例如 character:hero',
);

/**
 * 角色体型预设的 id 清单。
 *
 * 这份清单必须留在这里、而不是界面里，因为体型要跟着站位落进空间方案，
 * 而**契约是唯一权威**：界面、3D 生成、校验器各维护一份的话，迟早出现
 * "界面上能选、提交时被拒"这种自相矛盾。
 *
 * 逐字对应 `apps/desktop/renderer/src/director/personMesh.ts` 里
 * `traitsForPreset` 认识的形态。那边另有一些别名（`man` / `woman` / `child` /
 * `elder` / `heavyMan`），是给旧数据兜底的，不作为界面选项，所以不在这里。
 *
 * 中文标签不放在契约里：契约面向协议，不面向界面文案。
 * 两份清单是否还对得上，由 `tests/person-body-presets.test.ts` 钉住。
 */
export const PERSON_BODY_PRESET_IDS = [
  'person-adult-male-average',
  'person-adult-male-slim',
  'person-adult-male-strong',
  'person-adult-male-heavy',
  'person-adult-female-average',
  'person-adult-female-slim',
  'person-adult-female-strong',
  'person-adult-female-heavy',
  'person-teen-male',
  'person-teen-female',
  'person-child-boy',
  'person-child-girl',
  'person-elder-male',
  'person-elder-female',
  'tallMan',
  'tallWoman',
  'shortMan',
  'slimWoman',
] as const;

export const personBodyPresetSchema = z.enum(PERSON_BODY_PRESET_IDS);

export type PersonBodyPresetId = z.infer<typeof personBodyPresetSchema>;

/**
 * 角色的**姿态预设** id 清单。
 *
 * 与体型预设同一套理由（见上）：姿态要跟着站位落进空间方案，
 * 所以权威在契约里；界面与渲染层各复制一份、由测试钉住一致。
 *
 * id 逐字对应 `apps/desktop/renderer/src/director/storyboard/directorMotion.ts`
 *
 * 与 `pose` 的关系：`pose` 是**粗粒度**的三值枚举（站立/坐下/自定义），
 * 落库时用它表示"这个人整体是站着还是坐着"；`pose_preset` 是细粒度的那一个。
 * 两者要一致（选了 `sit-*` 的预设，`pose` 就写 `sitting`）——
 * 重复是有意的：粗粒度那个已经在下游被用来判断，不能只留细的。
 */
export const DIRECTOR_POSE_PRESET_IDS = [
  'stand-neutral',
  'stand-attention',
  'lean-forward',
  'lean-back',
  'hands-on-hips',
  'arms-crossed',
  'sit-upright',
  'sit-relaxed',
  'squat-low',
  'kneel-one',
  'kneel-two',
  'lie-back',
  'walk-stride',
  'run-stride',
  'point-forward',
  'reach-up',
  'wave',
  'look-up',
  'look-down',
  'look-left',
  'look-right',
  'talk-gesture',
  'observe',
  'jump-apex',
] as const;

export const directorPosePresetSchema = z.enum(DIRECTOR_POSE_PRESET_IDS);

export type DirectorPosePresetId = z.infer<typeof directorPosePresetSchema>;

const axisSchema = z.number().finite()
  .min(SPATIAL_PARAM_DOMAINS.coordinate_m.min)
  .max(SPATIAL_PARAM_DOMAINS.coordinate_m.max);

/** 三维向量：[x, y, z]，单位为米。 */
export const vec3Schema = z.tuple([axisSchema, axisSchema, axisSchema]);

const ORIGIN = [0, 0, 0] as [number, number, number];
const UNIT_SCALE = [1, 1, 1] as [number, number, number];

export const spatialTransformSchema = z.object({
  pos: vec3Schema.default(ORIGIN),
  rot_deg: vec3Schema.default(ORIGIN),
  scale: vec3Schema.default(UNIT_SCALE),
});

export const spatialGeometryRefSchema = z.object({
  kind: z.enum(['floor', 'wall', 'door', 'window']),
  id: z.string().min(1),
  transform: spatialTransformSchema.optional(),
});

export const spatialStageSchema = z.object({
  geometry_refs: z.array(spatialGeometryRefSchema).default([]),
  /**
   * 全景底图只保存 Artifact 引用。
   * 若它来自 Provider 生成，生成时的临时 URL 与签名参数一律不得写入这里（§7.5.2 规则 7）。
   */
  panorama_artifact: sha256Schema.nullable().default(null),
});

export const spatialSubjectSchema = z.object({
  subject_ref: subjectRefSchema,
  proxy: z.enum(['mannequin', 'box']),
  position: vec3Schema,
  rotation_deg: vec3Schema.default(ORIGIN),
  pose: z.enum(['standing', 'sitting', 'custom']).default('standing'),
  /**
   * 角色的体型预设；`null` 表示没选过，按默认体形渲染。
   *
   * 为什么体型要进空间方案，而不是"只在界面里取景用"：导演台摆的这个人是
   * **这一镜要出的画面里那个人**。只在界面里生效的话，用户把角色改成小孩、
   * 出的图还是个成年人——那是界面在骗人。`pose` 已经在这张表里了，
   * 体型与它是同一类事实（这个主体在这一镜里长什么样），放同一层自洽。
   *
   * 用 nullable + default(null) 而不是 optional：缺字段与"没选过"是同一件事，
   * 统一成 null 之后下游不必再判"有没有这个键"。
   */
  body_preset: personBodyPresetSchema.nullable().default(null),
  /**
   * 姿态预设（细粒度）；`null` 表示没选过，按 `pose` 的粗粒度值呈现。
   *
   * 与 `pose` 并存：`pose` 是"站着/坐着"这个粗粒度事实（下游已经在用），
   * 这个是"具体哪个体态"（叉腰、单膝跪地、观察…）。
   */
  pose_preset: directorPosePresetSchema.nullable().default(null),
  scale: z.number()
    .min(SPATIAL_PARAM_DOMAINS.subject_scale.min)
    .max(SPATIAL_PARAM_DOMAINS.subject_scale.max)
    .default(1),
});

export const spatialCameraSchema = z.object({
  position: vec3Schema,
  target: vec3Schema,
  lens_mm: z.number()
    .min(SPATIAL_PARAM_DOMAINS.lens_mm.min)
    .max(SPATIAL_PARAM_DOMAINS.lens_mm.max),
  fov_deg: z.number()
    .min(SPATIAL_PARAM_DOMAINS.fov_deg.min)
    .max(SPATIAL_PARAM_DOMAINS.fov_deg.max)
    .optional(),
  shot_size: z.string().min(1).optional(),
  pitch_deg: z.number()
    .min(SPATIAL_PARAM_DOMAINS.pitch_deg.min)
    .max(SPATIAL_PARAM_DOMAINS.pitch_deg.max)
    .default(0),
});

const spatialLightSchema = z.object({
  pos: vec3Schema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, '灯光颜色必须是 #RRGGBB'),
  intensity: z.number()
    .min(SPATIAL_PARAM_DOMAINS.intensity.min)
    .max(SPATIAL_PARAM_DOMAINS.intensity.max),
});

export const spatialLightingSchema = z.object({
  key: spatialLightSchema.optional(),
  fill: spatialLightSchema.optional(),
  rim: spatialLightSchema.optional(),
  preset_ref: z.string().min(1).nullable().default(null),
});

export const spatialTrajectorySchema = z.object({
  subject_path: z.array(z.object({
    t_ms: z.number().int().nonnegative(),
    position: vec3Schema,
  })).default([]),
  camera_move: z.enum(['static', 'push_in', 'pull_out', 'pan', 'tilt', 'orbit', 'follow']).nullable().default(null),
});

export const spatialBlueprintSchema = z.object({
  /** 必须是已 PUBLISHED 的内容寻址 Artifact；是否已发布由校验器判定（§7.5.2 规则 5）。 */
  artifact_id: sha256Schema,
  published_at: rfc3339Schema,
  /** 这张图基于哪一版场景截的，用于「这条视频用了哪次摆放」的可追溯（§7.5.2 规则 6）。 */
  captured_from_revision: z.number().int().nonnegative(),
});

/**
 * 已启用的空间计划。
 *
 * 用 strictObject 而非 object：未知键一律拒绝。
 * 这条严格性本身就是一道安全边界——临时 URL、签名参数、凭据材料
 * 只要想塞进 spatial_plan，就会在解析阶段被拒，而不是悄悄落库。
 */
export const spatialPlanSchema = z.strictObject({
  schema: z.literal('replica.spatial-plan@1'),
  shot_id: z.string().min(1),
  enabled: z.boolean(),
  units: z.literal('meter').default('meter'),
  coordinate_system: z.literal(SPATIAL_COORDINATE_SYSTEM).default(SPATIAL_COORDINATE_SYSTEM),
  stage: spatialStageSchema.default({ geometry_refs: [], panorama_artifact: null }),
  subjects: z.array(spatialSubjectSchema).default([]),
  camera: spatialCameraSchema.optional(),
  lighting: spatialLightingSchema.optional(),
  trajectory: spatialTrajectorySchema.optional(),
  blueprint: spatialBlueprintSchema.optional(),
}).superRefine((plan, ctx) => {
  if (!plan.enabled) {
    // 关掉空间控制却留着站位或机位，会让下游分不清该按哪一份执行
    if (plan.subjects.length > 0 || plan.camera) {
      ctx.addIssue({
        code: 'custom',
        path: ['enabled'],
        message: 'enabled=false 时不得携带站位或机位',
      });
    }
    return;
  }
  // 开着空间控制却什么都没有，等于给下游一个空承诺
  if (plan.subjects.length === 0 && !plan.camera) {
    ctx.addIssue({
      code: 'custom',
      path: ['subjects'],
      message: 'enabled=true 时至少要提供一项站位或机位',
    });
  }
  /*
    道具没有体型。这一条要在这里拦，而不是等 3D 渲染时忽略：
    静默忽略会让"我明明给箱子选了体型"这种输入一路走到底、什么都不报，
    用户以为存上了。
  */
  plan.subjects.forEach((subject, index) => {
    if (subject.proxy === 'box' && subject.body_preset !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['subjects', index, 'body_preset'],
        message: '道具没有体型：body_preset 只能给角色（proxy=mannequin）用',
      });
    }
  });
});

/**
 * `ShotPlan.spatial_plan` 的合法取值。
 *
 * 空对象 `{}` 表示「未启用空间控制」——这是合法输入，不是校验失败（§7.5.2 规则 1）。
 * 启用空间控制但不带任何站位与机位则会被拒绝，所以「空」只有一种解释。
 */
export const spatialPlanInputSchema = z.union([
  z.strictObject({}),
  spatialPlanSchema,
]);

export type SpatialPlan = z.infer<typeof spatialPlanSchema>;
export type SpatialPlanInput = z.infer<typeof spatialPlanInputSchema>;
export type SpatialSubject = z.infer<typeof spatialSubjectSchema>;
