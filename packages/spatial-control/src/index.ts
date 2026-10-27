import {
  spatialPlanInputSchema,
  type SpatialPlan,
  type SpatialPlanInput,
} from '@qiyin/contracts';

/* ============================================================
   SpatialPlan@1 校验器（架构 v2.3 §7.5.2）
   ------------------------------------------------------------
   形状与参数域由 schema 表示，这里补的是「需要外部上下文才能判定」的部分：
     · 规则 2 引用完整性：subject_ref 必须解析到已登记的主体
     · 规则 5 蓝图必须是已 PUBLISHED 的内容寻址 Artifact
     · 规则 7 密钥零暴露：不得混入临时 URL、签名参数、凭据材料

   规则 1（空对象合法）也在这里兜底：空对象表示「未启用空间控制」，
   是合法输入而不是错误——把它当错误会让所有不用 3D 的项目都被拦住。
   ============================================================ */

export interface SpatialValidationContext {
  /** 已登记的主体引用集合，形如 `character:hero`。 */
  registeredSubjects: ReadonlySet<string>;
  /** 已发布（PUBLISHED）的内容寻址 Artifact id 集合，形如 `sha256:...`。 */
  publishedArtifacts: ReadonlySet<string>;
}

export interface SpatialIssue {
  /** 出错位置，便于 UI 精确定位到某个字段。 */
  path: string;
  code: string;
  message: string;
}

export type SpatialValidationResult =
  | { ok: true; enabled: boolean; plan: SpatialPlanInput }
  | { ok: false; issues: SpatialIssue[] };

/**
 * 凭据材料的特征。
 *
 * 检查的是「值」而不是「键」：临时 URL 与签名参数经常被塞进
 * 看起来无害的字符串字段里，只查键名一定会漏。
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  { pattern: /https?:\/\//i, message: '不得包含 URL：临时 Provider 地址通常带签名参数' },
  { pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/i, message: '不得包含 Bearer 凭据' },
  { pattern: /(x-amz-signature|signature=|access_token=|refresh_token=|api[_-]?key=)/i, message: '不得包含签名或凭据参数' },
  { pattern: /(AKIA|ASIA)[0-9A-Z]{16}/, message: '不得包含云厂商访问密钥' },
];

function isEmptyPlan(value: SpatialPlanInput): value is Record<string, never> {
  return Object.keys(value as Record<string, unknown>).length === 0;
}

/** 递归收集所有字符串值及其路径，用于凭据扫描。 */
function collectStrings(value: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (typeof value === 'string') {
    out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectStrings(item, path ? `${path}.${key}` : key, out);
    }
  }
}

/**
 * 校验一份 `ShotPlan.spatial_plan`。
 *
 * 返回的 plan 是解析后的规范化结果；`enabled` 让调用方不必再判断空对象。
 */
export function validateSpatialPlan(
  input: unknown,
  context: SpatialValidationContext,
): SpatialValidationResult {
  const parsed = spatialPlanInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: 'SPATIAL_PLAN_INVALID',
        message: issue.message,
      })),
    };
  }

  const plan = parsed.data;
  if (isEmptyPlan(plan)) {
    // 未启用空间控制：放行，且不产生任何额外副作用（§7.5.2 规则 1）
    return { ok: true, enabled: false, plan };
  }

  const issues: SpatialIssue[] = [];

  // 规则 2：主体引用必须解析到已登记主体
  plan.subjects.forEach((subject, index) => {
    if (!context.registeredSubjects.has(subject.subject_ref)) {
      issues.push({
        path: `subjects[${index}].subject_ref`,
        code: 'SUBJECT_NOT_REGISTERED',
        message: `主体未登记：${subject.subject_ref}`,
      });
    }
  });

  // 规则 5：蓝图必须是已发布的内容寻址 Artifact
  if (plan.blueprint && !context.publishedArtifacts.has(plan.blueprint.artifact_id)) {
    issues.push({
      path: 'blueprint.artifact_id',
      code: 'BLUEPRINT_NOT_PUBLISHED',
      message: `构图蓝图不是已发布的 Artifact：${plan.blueprint.artifact_id}`,
    });
  }

  // 规则 7：不得出现临时 URL、签名参数或凭据材料
  const strings: Array<{ path: string; text: string }> = [];
  collectStrings(plan, '', strings);
  for (const item of strings) {
    for (const { pattern, message } of CREDENTIAL_PATTERNS) {
      if (pattern.test(item.text)) {
        issues.push({ path: item.path, code: 'CREDENTIAL_MATERIAL', message });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, enabled: plan.enabled, plan };
}

/**
 * 参与 ExecutionSpec digest 的字段。
 *
 * §7.5.2 规则 8：3D 预览的相机操作、面板缩放、鼠标姿态不属于 spatial_plan，
 * 不参与 digest——否则轻微视角抖动就会击穿复用命中。
 *
 * 这份清单同时也是「哪些字段一变就必须让旧候选失效」的依据。
 */
export const SPATIAL_DIGEST_FIELDS = [
  'stage',
  'subjects',
  'camera',
  'lighting',
  'trajectory',
] as const;

/** 从计划里抽出参与 digest 的部分；空对象返回 `null`（表示未启用）。 */
export function spatialDigestInput(plan: SpatialPlanInput): string | null {
  if (isEmptyPlan(plan)) return null;
  const source = plan as SpatialPlan;
  const picked: Record<string, unknown> = {};
  for (const field of SPATIAL_DIGEST_FIELDS) {
    const value = source[field];
    if (value !== undefined) picked[field] = value;
  }
  return JSON.stringify(picked);
}
