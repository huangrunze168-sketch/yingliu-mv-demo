/* ============================================================
  期音科技 · Provider 鉴权方式抽象（BYOK-004）
   ------------------------------------------------------------
  矩阵原文要求的四种鉴权：**Bearer / OAuth / 浏览器同源 / 短信**。
  在这之前我们只有第一种（baseUrl + key），所以这条一直挂在"部分实现"。

  这一层的职责边界要说清楚：它**不负责**调用模型，只负责"给一个出站
  请求装上正确的凭据，并在过期时把它换新"。调用方拿到的是几个请求头，
  怎么发请求是调用方的事——这样同一套鉴权能同时服务插件、适配器和 CLI。

  为什么四种方式要在一个接口下统一：
  它们对调用方来说是**同一件事**——"我需要一个能用的 Authorization"。
  差异全在"这个头是怎么来的"：直接读、换一次、去浏览器里捞、或者先发短信。
  把差异关在策略里，上层就不必写 `if (method === 'oauth2')` 这种分支。
   ============================================================ */

/** 契约里申报的鉴权方式（与 `providerManifestSchema.declarations.auth.methods` 同一套枚举）。 */
export const AUTH_METHODS = ['bearer', 'oauth2', 'browser-same-origin', 'sms', 'none'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** Bearer：最普通的一种，一个长期 key 直接用。 */
export interface BearerCredential {
  method: 'bearer';
  key: string;
  /**
   * 与主密钥**配套**的附加字段（`{ secret_key: '…' }` 这种）。

   * 为什么需要：不少服务发的是一对密钥（access key + secret key），
   * 两个必须一起给才算一份凭据。它们不是 HTTP 头，也不该硬塞进
   * `key` 里用分隔符拼起来——那样解析回来一定是错的。

   * 边界：`headers()` **不看**这里。它只服务"知道该服务怎么用"的调用方
   * （例如把两个 key 塞进子进程环境的适配器）。真要用它拼请求头，
   * 那是给这个 Provider 写一个专门的策略，而不是在这里塞。
   */
  extra?: Record<string, string>;
}

/**
 * OAuth2：我们只做**授权码 + PKCE**这一个流程。
 *
 * 不做客户端凭据（client_credentials）是因为那本质上是"换了名字的 Bearer 长期密钥"，
 * 用 Bearer 那条路就够了；也不做隐式流程（implicit），那已经被 OAuth 2.1 废弃。
 */
export interface OAuth2Credential {
  method: 'oauth2';
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /**
   * 公开客户端（桌面软件）**默认没有**这一项——这正是 PKCE 的意义：
   * 装在本机的 client_secret 等于没装。只有服务端明确要求时才填。
   */
  clientSecret?: string;
  scope?: string;
  accessToken?: string;
  refreshToken?: string;
  /** 绝对时间戳（毫秒）。缺省表示"不知道什么时候过期"，此时不主动刷新。 */
  expiresAt?: number;
  /** 默认 `Bearer`。只有服务端明确返回别的类型时才需要改。 */
  tokenType?: string;
}

/**
 * 浏览器同源：凭据是**用户已经登录过的那份浏览器会话**，不是我们发的 key。
 *
 * 这类平台（网页版绘画/视频站）通常不开放个人 API Key，只认自己站点的
 * 登录 Cookie。我们不模拟登录、不存用户密码，只从 Cookie 里读一个值——
 * 用户在自家浏览器里登录一次，我们借用同一个会话。
 */
export interface BrowserSameOriginCredential {
  method: 'browser-same-origin';
  /** 必须是完整 origin（`https://example.com`），用来限定只能读属于它的 Cookie。 */
  origin: string;
  cookieName: string;
  /** 默认 `authorization`；有些站点要求 `token` 之类的自定义头。 */
  headerName?: string;
  /** 默认 `Bearer `；设成空串表示原样放 Cookie 值。 */
  headerPrefix?: string;
}

/** 短信：手机号 + 验证码换 token。验证码怎么发由外部网关负责（见 `SmsGateway`）。 */
export interface SmsCredential {
  method: 'sms';
  phone: string;
  /** 网关标识，宿主用它挑一个 `SmsGateway`。 */
  gatewayId: string;
  /**
   * 自建网关的两条地址（可选）。

   * 填了它，宿主就能自己造一个 HTTP 网关（见 `createHttpSmsGateway`），
   * 用户不必再去装插件。**没填又没装网关时**，取用会明确报
   * "没有可用的短信网关"，而不是让界面上的按钮点了没反应。
   */
  gateway?: { sendCodeUrl: string; verifyUrl: string; headers?: Record<string, string> };
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
}

/** `none`：显式声明"这个 Provider 不需要凭据"（本地模型、自建服务）。 */
export interface NoAuthCredential {
  method: 'none';
}

export type CredentialRecord =
  | BearerCredential
  | OAuth2Credential
  | BrowserSameOriginCredential
  | SmsCredential
  | NoAuthCredential;

/**
 * 给界面看的凭据状态。
 *
 * 注意这里**没有任何密钥字段**：界面上要显示"配没配、什么时候过期"，
 * 而不是把 key 回显出来。回显是泄密的第一种形式——截图、日志、投屏都会漏。
 */
export interface AuthStatus {
  method: AuthMethod;
  /** 是否具备发起请求的必要条件（缺字段时为 false）。 */
  ready: boolean;
  /** 不能用的原因；`ready: true` 时为空串。 */
  reason: string;
  /** 绝对过期时间戳；没有这个概念时为 null。 */
  expiresAt: number | null;
  /** 策略自己的一句话说明，例如"从浏览器会话读取"。 */
  detail: string;
}

/** 出站请求要装的头。用普通对象而不是 `Headers`，方便调用方合并和做摘要。 */
export type AuthHeaders = Record<string, string>;
