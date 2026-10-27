/* 鉴权失败必须是**可归类**的失败。

   "鉴权失败"这四个字对用户没用。真正要区分的是：没配（去配）、
   过期且没有刷新手段（重新登录）、网关不在（装网关）、
   浏览器里没有那个 Cookie（去浏览器登录）。四种情况的处理动作完全不同，
   所以错误里带 `code`，由界面翻译成对应的按钮。 */

export type AuthErrorCode =
  /** 没有任何凭据记录 */
  | 'missing-credential'
  /** 有凭据但缺必要字段（例如 oauth2 没填 tokenEndpoint） */
  | 'incomplete-credential'
  /** 令牌过期且没有 refresh_token，只能重新授权 */
  | 'expired-no-refresh'
  /** 刷新或换取令牌时被服务端拒绝 */
  | 'token-request-failed'
  /** 需要短信网关但宿主没有提供 */
  | 'gateway-absent'
  /** 浏览器里没找到那个 Cookie（用户没登录，或名字不对） */
  | 'cookie-missing'
  /** 申报的方式我们没实现 */
  | 'unsupported-method';

export class ProviderAuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    /** 原始响应体等诊断信息；不包含密钥。 */
    readonly detailText = '',
  ) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

/** 判断一个错误是不是我们这套鉴权抛的。跨模块边界时要能区分"鉴权错"与"网络错"。 */
export function isProviderAuthError(value: unknown): value is ProviderAuthError {
  return value instanceof ProviderAuthError;
}
