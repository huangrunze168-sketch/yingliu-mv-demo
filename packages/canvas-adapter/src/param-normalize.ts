/* ============================================================
  期音科技 · 参数按模型 schema 收敛
  ------------------------------------------------------------

    校验失败:
      - params 顶层不允许设置未知字段「sequential」。仅允许：画布结构字段
        （如 model、prompt、count等），或当前模型 schema 中未归入 settings/advanced
        的属性名 / originalField。

    校验失败:
      - params.settings.resolution="1080P" 不在允许范围。可选: 480p, 720p, 1080p

  两条都很要命：
    · **不是忽略，是整条 create 失败**——参数里混进一个该模型不认识的键，生成就没了；
    · 取值的**大小写**与网页端不同（网页端枚举写 `1080P`，CLI 的取值是 `1080p`），
      而我们的参数字典正是从网页端扒的。

  所以这里按模型 schema 做三件事：丢掉不认识的键、把取值规范到 schema 的写法、
  数字按 min/max 夹取。**拿不到 schema 时原样放行**（不认识就不拦，与仓库里其它地方同一口径）。
   ============================================================ */

import type { CanvasModelProperty, CanvasModelSchemaResult } from './protocol.js';

export type SettingValue = string | number | boolean;

/**
 * 画布结构字段：CLI 明确允许它们出现在 `-s` 里，且不属于任何模型属性。
 * 依据是上面那句报错里点名的 `model`、`prompt`、`count`，加上我们的下游一定会带上的
 * `modeType`（它是 properties 里的一个条目，这里列出来是为了"schema 缺了也别丢"）。
 */
const STRUCTURAL_KEYS = new Set(['model', 'prompt', 'count', 'modeType']);

export interface ParamAdjustment {
  key: string;
  from: SettingValue;
  to: SettingValue;
  /** 为什么改：取值规范化 / 越界夹取 */
  why: 'enum' | 'clamp';
}

export interface NormalizeParamsResult {
  accepted: Record<string, SettingValue>;
  /** 该模型 schema 里没有的键（丢掉，否则整条 create 会失败） */
  droppedKeys: string[];
  /** 取值被规范或夹取过的项 */
  adjusted: ParamAdjustment[];
}

/** 枚举项的取值与显示名都收进来，便于两种写法都能匹配上 */
function enumEntries(def: CanvasModelProperty): Array<{ value: SettingValue; label: string | null }> {
  const out: Array<{ value: SettingValue; label: string | null }> = [];
  for (const item of def.enum ?? []) {
    if (item !== null && typeof item === 'object') {
      const value = (item as { value?: unknown }).value;
      const label = (item as { displayName?: unknown }).displayName;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out.push({ value, label: typeof label === 'string' ? label : null });
      }
      continue;
    }
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out.push({ value: item, label: null });
    }
  }
  return out;
}

/**
 * 按 schema 收敛一个参数包。
 *
 * `schema` 传 `undefined` 时**原样放行**：拿不到 schema（模型名拼错、CLI 版本不同、
 * 网络失败）时，我们宁可让 CLI 去报它自己的错，也不在这里把参数悄悄删掉。
 */
export function normalizeModelParams(
  settings: Record<string, SettingValue> | undefined,
  schema: CanvasModelSchemaResult['schema'] | undefined,
): NormalizeParamsResult {
  const accepted: Record<string, SettingValue> = {};
  const droppedKeys: string[] = [];
  const adjusted: ParamAdjustment[] = [];
  if (!settings) return { accepted, droppedKeys, adjusted };
  if (!schema) return { accepted: { ...settings }, droppedKeys, adjusted };

  const properties = schema.properties ?? {};
  /*
    键 → 属性定义。

    ⚠ 先按**属性键**建，再用 originalField 补别名，而且**只补不覆盖**。
    原因是实测出来的：同一个模型里会有多个属性共用同一个 originalField——
    `ratio` 与 `ratio_auto` 都写 `originalField: "ratio"`，
    `duration` 与 `duration_auto` 都写 `originalField: "duration"`。
    如果无脑用 originalField 建索引，后者会把前者覆盖掉，
    于是面板传上来的真字段（ratio/duration）会被拿去和 `*_auto` 的枚举比对，
    对不上就整条被丢掉——单测就是这么把这个坑照出来的。
  */
  const byName = new Map<string, CanvasModelProperty>();
  for (const [name, def] of Object.entries(properties)) {
    if (def) byName.set(name, def);
  }
  for (const [name, def] of Object.entries(properties)) {
    const field = def?.originalField;
    if (def === undefined || field === undefined || field === name) continue;
    /* 已有同名属性、或这个别名已经被别的字段占走 → 不覆盖 */
    if (byName.has(field)) continue;
    byName.set(field, def);
  }

  for (const [key, value] of Object.entries(settings)) {
    if (STRUCTURAL_KEYS.has(key)) { accepted[key] = value; continue; }
    const def = byName.get(key);
    if (!def) {
      /* schema 里没有这个键 → 丢掉（留着会让 CLI 整条 create 失败） */
      droppedKeys.push(key);
      continue;
    }

    const entries = enumEntries(def);
    if (entries.length > 0) {
      const wanted = String(value).toLowerCase();
      const match = entries.find((entry) => String(entry.value) === String(value))
        ?? entries.find((entry) => (entry.label ?? '').toLowerCase() === wanted)
        ?? entries.find((entry) => String(entry.value).toLowerCase() === wanted);
      if (!match) {
        /* 枚举里没有这个取值：丢掉而不是硬发——硬发的后果是整条 create 失败 */
        droppedKeys.push(key);
        continue;
      }
      if (match.value !== value) adjusted.push({ key, from: value, to: match.value, why: 'enum' });
      accepted[key] = match.value;
      continue;
    }

    if (typeof value === 'number' && (def.min !== undefined || def.max !== undefined)) {
      const min = def.min ?? value;
      const max = def.max ?? value;
      if (value < min || value > max) {
        const clamped = Math.min(Math.max(value, min), max);
        adjusted.push({ key, from: value, to: clamped, why: 'clamp' });
        accepted[key] = clamped;
        continue;
      }
    }
    accepted[key] = value;
  }

  return { accepted, droppedKeys, adjusted };
}
