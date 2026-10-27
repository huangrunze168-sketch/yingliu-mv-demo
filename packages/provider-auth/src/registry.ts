import { createAuthStrategy, type AuthDeps, type AuthStrategy } from './strategies.js';
import type { AuthMethod, CredentialRecord } from './types.js';
import type { CredentialVault } from './store.js';

/* ============================================================
  期音科技 · 鉴权解析入口
   ------------------------------------------------------------
  Provider 清单里声明了"我支持哪几种登录方式"（`auth.methods`），
  用户实际配了其中一种。这一层负责把两者对上：

    · 配过 → 用配的那种；
    · 没配 → 给出"按声明顺序，第一种该配 X"的明确指引，
      而不是让调用方自己去猜。

  一个刻意的选择：**用户配的方式即使不在清单里，也照样用**。
  清单是 Provider 作者写的声明，不是安全边界；用户可以自己接一层
  代理（比如把 Bearer 塞进同源网关），那时声明当然对不上。
  我们提示，但不拦——拦了只会让人以为是软件坏了。
   ============================================================ */

export interface ResolveAuthInput {
  providerId: string;
  /** 清单里声明支持的方式，按优先级排列。 */
  declaredMethods: readonly AuthMethod[];
  vault: CredentialVault;
  deps: AuthDeps;
}

export interface ResolvedAuth {
  providerId: string;
  strategy: AuthStrategy;
  /** 实际生效的方式；没配过时为 null。 */
  method: AuthMethod | null;
  declaredMethods: AuthMethod[];
  /** 清单里有、但用户还没配的方式。界面可以据此列"还可以怎么登"。 */
  unconfiguredMethods: AuthMethod[];
  /** 给界面的一句话。已配好时为空串。 */
  advice: string;
}

/** 每种方式在界面上怎么说。避免同一个词在三个文件里有三种译法。 */
export const AUTH_METHOD_LABELS: Readonly<Record<AuthMethod, string>> = {
  bearer: '长期密钥（Bearer）',
  oauth2: 'OAuth2 授权登录',
  'browser-same-origin': '浏览器同源会话',
  sms: '手机号 + 短信验证码',
  none: '不需要凭据',
};

export function resolveAuth(input: ResolveAuthInput): ResolvedAuth {
  const declared = [...input.declaredMethods];
  const record = input.vault.get(input.providerId);
  /*
    只声明 `none` 的 Provider，"没配"就等于"不需要配"。

    这条不是抠字眼：小QTV 与图像生成服务是走各自 CLI 的登录态，我们这侧本来就没有
    可配的东西。如果这里还返回"未配置 / 还没有配置凭据"，界面上就会出现
    一个永远填不满的待办——用户会以为漏了哪一步。
  */
  const onlyNone = declared.length === 1 && declared[0] === 'none';
  const effective: CredentialRecord | null = record === null && onlyNone ? { method: 'none' } : record;
  const strategy = createAuthStrategy(input.providerId, effective, withPersist(input, record));
  const method = effective?.method ?? null;
  const unconfigured = declared.filter((item) => item !== method);
  const advice = method !== null
    ? (declared.includes(method) ? '' : `已配置的「${AUTH_METHOD_LABELS[method]}」不在该 Provider 的声明里，仍按你的配置使用`)
    : declared.length === 0
      ? '这个 Provider 没有声明任何鉴权方式'
      : `还没有配置凭据，可选用：${declared.map((item) => AUTH_METHOD_LABELS[item]).join(' / ')}`;
  return {
    providerId: input.providerId,
    strategy,
    method,
    declaredMethods: declared,
    unconfiguredMethods: unconfigured,
    advice,
  };
}

/** 把"换到新令牌就写回仓库"这一步接上；没配过凭据时无从写回，跳过。 */
function withPersist(input: ResolveAuthInput, record: CredentialRecord | null): AuthDeps {
  if (record === null) return input.deps;
  const previous = input.deps.persist;
  return {
    ...input.deps,
    persist: (next) => {
      input.vault.set(input.providerId, next);
      previous?.(next);
    },
  };
}

/**
 * 出站请求头的**脱敏摘要**，专供日志与诊断。
 *
 * 只留"装了哪个头、长得像什么类型"，绝不落值。
 * 这样排查"401 是因为没带 Authorization 吗"时，
 * 不必把用户的令牌打到日志里。
 */
export function summarizeAuthHeaders(headers: Record<string, string>): string {
  const names = Object.keys(headers).sort();
  if (names.length === 0) return '（无鉴权头）';
  return names.map((name) => {
    const value = headers[name] ?? '';
    const kind = value.startsWith('Bearer ')
      ? 'Bearer <已省略>'
      : name.toLowerCase() === 'cookie'
        ? 'Cookie <已省略>'
        : '<已省略>';
    return `${name}: ${kind}`;
  }).join('；');
}
