import { ProviderAuthError } from './errors.js';
import {
  buildAuthorizationUrl, createPkcePair, exchangeAuthorizationCode, refreshAccessToken,
  startLoopbackReceiver, type TokenSet,
} from './oauth2-flow.js';
import type {
  AuthHeaders, AuthStatus, BearerCredential, BrowserSameOriginCredential,
  CredentialRecord, OAuth2Credential, SmsCredential,
} from './types.js';

/* ============================================================
  期音科技 · 四种鉴权策略
   ------------------------------------------------------------
  每个策略回答同一个问题：「给我几个能直接塞进出站请求的头」。
  它们之间的差别只在"头从哪来"，所以接口就一个 `headers()`。

  三条共同规矩：
    · **缺东西要报哪缺了**，不要返回空头让上层收到 401 再猜；
    · **凭据不回显**，`status()` 里没有任何密钥字段；
    · **换新令牌要落盘**，否则下次启动又得过期一次（刷新轮换的场景下
      不落盘还会直接把用户的 refresh_token 作废）。
   ============================================================ */

/** 短信网关：验证码怎么发、怎么验，由外部实现。我们不自己接短信运营商。 */
export interface SmsGateway {
  id: string;
  label: string;
  sendCode(phone: string): Promise<{ sessionId?: string; expiresInSeconds?: number }>;
  verifyCode(input: { phone: string; code: string; sessionId?: string }): Promise<TokenSet>;
}

export interface AuthDeps {
  fetchImpl: typeof fetch;
  /** 从浏览器会话里读 Cookie（Electron 用 `session.cookies.get`）。没有就不支持同源鉴权。 */
  readCookie?: (origin: string, name: string) => Promise<string | null>;
  /** 打开系统浏览器去授权。桌面端用 `shell.openExternal`。 */
  openExternal?: (url: string) => Promise<void>;
  /** 可用的短信网关，按 id 索引。 */
  smsGateways?: ReadonlyMap<string, SmsGateway>;
  /** 令牌到期前多久就提前刷新，默认 60 秒（避免请求发出时刚好过期）。 */
  refreshSkewMs?: number;
  now?: () => number;
  /** 换到新令牌后回写仓库。不传就只在内存里生效（刷新轮换场景会丢）。 */
  persist?: (record: CredentialRecord) => void;
  /** 授权等待超时，默认 5 分钟。 */
  authorizeTimeoutMs?: number;
}

export interface AuthStrategy {
  readonly method: CredentialRecord['method'];
  /** 出站请求头。可能触发刷新。 */
  headers(): Promise<AuthHeaders>;
  /** 给界面看的脱敏状态。 */
  status(): AuthStatus;
}

function bearerHeader(token: string, tokenType: string = 'Bearer'): AuthHeaders {
  return { authorization: `${tokenType} ${token}` };
}

function describeRecord(record: CredentialRecord | null): string {
  switch (record?.method) {
    case 'bearer': return '长期密钥（Bearer）';
    case 'oauth2': return 'OAuth2 授权码 + PKCE';
    case 'browser-same-origin': return '借用浏览器已登录会话';
    case 'sms': return '手机号 + 短信验证码';
    case 'none': return '不需要凭据';
    default: return '未配置';
  }
}

/** 没有任何凭据记录时的兜底：不静默成功，也不谎报"已连接"。 */
class MissingAuthStrategy implements AuthStrategy {
  readonly method: CredentialRecord['method'];
  constructor(readonly providerId: string) {
    this.method = 'none';
  }
  async headers(): Promise<AuthHeaders> {
    throw new ProviderAuthError('missing-credential', `Provider「${this.providerId}」还没有配置凭据`);
  }
  status(): AuthStatus {
    return { method: 'none', ready: false, reason: '还没有配置凭据', expiresAt: null, detail: '未配置' };
  }
}

class NoAuthStrategy implements AuthStrategy {
  readonly method = 'none' as const;
  async headers(): Promise<AuthHeaders> { return {}; }
  status(): AuthStatus {
    return { method: 'none', ready: true, reason: '', expiresAt: null, detail: '不需要凭据' };
  }
}

/** ① Bearer：长期密钥。最普通、也最不容易出错的一种。 */
class BearerAuthStrategy implements AuthStrategy {
  readonly method = 'bearer' as const;
  constructor(private readonly credential: BearerCredential) {}
  async headers(): Promise<AuthHeaders> {
    if (this.credential.key === '') {
      throw new ProviderAuthError('incomplete-credential', 'Bearer 凭据里没有密钥');
    }
    return bearerHeader(this.credential.key);
  }
  status(): AuthStatus {
    const ready = this.credential.key !== '';
    return {
      method: 'bearer',
      ready,
      reason: ready ? '' : '缺少密钥',
      expiresAt: null,
      /* 不复述方式名：界面上已经写着"长期密钥（Bearer）"，这里说的是**状态**。 */
      detail: '已配置密钥',
    };
  }
}

/**
 * ② OAuth2：拿 access_token 用，过期自动换。
 *
 * 并发去重是这里唯一有点讲究的地方：画布上同时点十张图，
 * 十个请求会同时发现"令牌过期了"。如果各刷各的，在**刷新轮换**
 * （服务端一次刷新就作废旧 refresh_token）的站点上，后九次全都会失败。
 * 所以用一个 `#pending` 把并发的刷新合并成一次。
 */
class OAuth2AuthStrategy implements AuthStrategy {
  readonly method = 'oauth2' as const;
  #credential: OAuth2Credential;
  #pending: Promise<TokenSet> | null = null;
  constructor(private readonly providerId: string, credential: OAuth2Credential, private readonly deps: AuthDeps) {
    this.#credential = credential;
  }
  #skew(): number {
    return this.deps.refreshSkewMs ?? 60_000;
  }
  #now(): number {
    return (this.deps.now ?? Date.now)();
  }
  #isFresh(): boolean {
    const { accessToken, expiresAt } = this.#credential;
    if (accessToken === undefined || accessToken === '') return false;
    /* 没给过期时间就认为不会过期——比"猜一个时长"更诚实：
       猜错会导致无谓刷新，甚至把还能用的会话刷掉。 */
    if (expiresAt === undefined) return true;
    return expiresAt - this.#skew() > this.#now();
  }
  #missingFields(): string[] {
    const missing: string[] = [];
    if (this.#credential.authorizationEndpoint === '') missing.push('authorizationEndpoint');
    if (this.#credential.tokenEndpoint === '') missing.push('tokenEndpoint');
    if (this.#credential.clientId === '') missing.push('clientId');
    return missing;
  }
  #apply(refreshed: TokenSet): void {
    this.#credential = {
      ...this.#credential,
      accessToken: refreshed.accessToken,
      ...(refreshed.refreshToken !== undefined ? { refreshToken: refreshed.refreshToken } : {}),
      ...(refreshed.expiresAt !== undefined ? { expiresAt: refreshed.expiresAt } : {}),
      ...(refreshed.tokenType !== undefined ? { tokenType: refreshed.tokenType } : {}),
    };
    this.deps.persist?.(this.#credential);
  }
  async headers(): Promise<AuthHeaders> {
    const missing = this.#missingFields();
    if (missing.length > 0) {
      throw new ProviderAuthError('incomplete-credential', `OAuth2 凭据缺少：${missing.join('、')}`);
    }
    if (this.#isFresh()) return bearerHeader(this.#credential.accessToken as string, this.#credential.tokenType);
    if (this.#credential.refreshToken === undefined || this.#credential.refreshToken === '') {
      throw new ProviderAuthError('expired-no-refresh', `Provider「${this.providerId}」的授权已过期，需要重新登录一次`);
    }
    this.#pending ??= refreshAccessToken({
      tokenEndpoint: this.#credential.tokenEndpoint,
      clientId: this.#credential.clientId,
      ...(this.#credential.clientSecret !== undefined ? { clientSecret: this.#credential.clientSecret } : {}),
      refreshToken: this.#credential.refreshToken,
      fetchImpl: this.deps.fetchImpl,
      ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
    }).then((token) => {
      this.#apply(token);
      return token;
    }).finally(() => {
      this.#pending = null;
    });
    const token = await this.#pending;
    return bearerHeader(token.accessToken, token.tokenType);
  }
  /** 走一次完整授权：开浏览器 → 本机回调收码 → 换令牌。 */
  async authorize(): Promise<void> {
    const missing = this.#missingFields();
    if (missing.length > 0) {
      throw new ProviderAuthError('incomplete-credential', `OAuth2 凭据缺少：${missing.join('、')}`);
    }
    if (this.deps.openExternal === undefined) {
      throw new ProviderAuthError('token-request-failed', '当前宿主没有提供"打开浏览器"的能力');
    }
    const { verifier, challenge, method } = createPkcePair();
    const receiver = await startLoopbackReceiver(
      this.deps.authorizeTimeoutMs !== undefined ? { timeoutMs: this.deps.authorizeTimeoutMs } : {},
    );
    const state = createPkcePair().verifier;
    const url = buildAuthorizationUrl({
      authorizationEndpoint: this.#credential.authorizationEndpoint,
      clientId: this.#credential.clientId,
      redirectUri: receiver.redirectUri,
      ...(this.#credential.scope !== undefined ? { scope: this.#credential.scope } : {}),
      state,
      challenge,
      challengeMethod: method,
    });
    try {
      await this.deps.openExternal(url);
      const callback = await receiver.waitForCode();
      /* `state` 对不上说明回调不是我们这次发起的（CSRF / 另一个实例的回调串了）。 */
      if (callback.state !== state) {
        throw new ProviderAuthError('token-request-failed', '回调 state 与本次授权不一致，已放弃');
      }
      const token = await exchangeAuthorizationCode({
        tokenEndpoint: this.#credential.tokenEndpoint,
        clientId: this.#credential.clientId,
        ...(this.#credential.clientSecret !== undefined ? { clientSecret: this.#credential.clientSecret } : {}),
        code: callback.code,
        codeVerifier: verifier,
        redirectUri: receiver.redirectUri,
        fetchImpl: this.deps.fetchImpl,
        ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
      });
      this.#apply(token);
    } finally {
      await receiver.close();
    }
  }
  status(): AuthStatus {
    const missing = this.#missingFields();
    if (missing.length > 0) {
      return { method: 'oauth2', ready: false, reason: `缺少：${missing.join('、')}`, expiresAt: null, detail: describeRecord(this.#credential) };
    }
    const hasRefresh = this.#credential.refreshToken !== undefined && this.#credential.refreshToken !== '';
    const ready = this.#isFresh() || hasRefresh;
    const reason = ready ? '' : '尚未授权，或授权已过期';
    return {
      method: 'oauth2',
      ready,
      reason,
      expiresAt: this.#credential.expiresAt ?? null,
      detail: hasRefresh ? '已授权（过期可自动续期）' : '已获得令牌（无续期凭据）',
    };
  }
}

/**
 * ③ 浏览器同源：凭据就是用户**已经在浏览器里登录过**的那份会话。
 *
 * 每次取用时现读、不缓存。原因是用户随时可能在浏览器里登出或换号，
 * 缓存一份就等于"我们替他记着密码"——那既没必要，也更危险。
 */
class BrowserSameOriginAuthStrategy implements AuthStrategy {
  readonly method = 'browser-same-origin' as const;
  constructor(private readonly credential: BrowserSameOriginCredential, private readonly deps: AuthDeps) {}
  async headers(): Promise<AuthHeaders> {
    if (this.deps.readCookie === undefined) {
      throw new ProviderAuthError('unsupported-method', '当前宿主不支持读取浏览器会话');
    }
    let value: string | null;
    try {
      value = await this.deps.readCookie(this.credential.origin, this.credential.cookieName);
    } catch (error) {
      throw new ProviderAuthError('cookie-missing', `读取浏览器会话失败：${String(error)}`);
    }
    if (value === null || value === '') {
      throw new ProviderAuthError(
        'cookie-missing',
        `浏览器里没有 ${this.credential.origin} 的 ${this.credential.cookieName}，请先在这个站点的内置浏览器里登录`,
      );
    }
    const headerName = this.credential.headerName ?? 'authorization';
    const prefix = this.credential.headerPrefix ?? 'Bearer ';
    return { [headerName]: headerName.toLowerCase() === 'cookie'
      ? `${this.credential.cookieName}=${value}`
      : `${prefix}${value}` };
  }
  status(): AuthStatus {
    const ready = this.deps.readCookie !== undefined
      && this.credential.origin !== '' && this.credential.cookieName !== '';
    const reason = this.deps.readCookie === undefined
      ? '当前宿主不支持读取浏览器会话'
      : this.credential.origin === '' || this.credential.cookieName === ''
        ? '缺少站点地址或 Cookie 名'
        : '';
    return {
      method: 'browser-same-origin',
      ready,
      reason,
      expiresAt: null,
      detail: `${this.credential.origin} · Cookie「${this.credential.cookieName}」`,
    };
  }
}

/**
 * ④ 短信：手机号 + 验证码换令牌。
 *
 * 我们**不自己发短信**——接运营商是另一件事，而且各地合规要求不同。
 * 这里定义的是"怎么用网关"，网关由宿主或插件按 `SmsGateway` 实现。
 * 没有网关时明确报 `gateway-absent`，而不是让界面上的按钮点了没反应。
 */
class SmsAuthStrategy implements AuthStrategy {
  readonly method = 'sms' as const;
  #credential: SmsCredential;
  #session: { sessionId?: string } = {};
  constructor(private readonly deps: AuthDeps, credential: SmsCredential) {
    this.#credential = credential;
  }
  #gateway(): SmsGateway {
    const gateway = this.deps.smsGateways?.get(this.#credential.gatewayId);
    if (gateway === undefined) {
      throw new ProviderAuthError('gateway-absent', `没有可用的短信网关「${this.#credential.gatewayId}」`);
    }
    return gateway;
  }
  #now(): number {
    return (this.deps.now ?? Date.now)();
  }
  #isFresh(): boolean {
    const { accessToken, expiresAt } = this.#credential;
    if (accessToken === undefined || accessToken === '') return false;
    if (expiresAt === undefined) return true;
    return expiresAt - (this.deps.refreshSkewMs ?? 60_000) > this.#now();
  }
  /** 第一步：让网关把验证码发到用户手机上。 */
  async requestCode(): Promise<{ expiresInSeconds: number | null }> {
    if (this.#credential.phone === '') {
      throw new ProviderAuthError('incomplete-credential', '还没有填手机号');
    }
    const gateway = this.#gateway();
    const sent = await gateway.sendCode(this.#credential.phone);
    this.#session = sent.sessionId !== undefined ? { sessionId: sent.sessionId } : {};
    return { expiresInSeconds: sent.expiresInSeconds ?? null };
  }
  /** 第二步：用验证码换令牌并落盘。 */
  async submitCode(code: string): Promise<void> {
    const gateway = this.#gateway();
    const token = await gateway.verifyCode({
      phone: this.#credential.phone,
      code,
      ...(this.#session.sessionId !== undefined ? { sessionId: this.#session.sessionId } : {}),
    });
    this.#credential = {
      ...this.#credential,
      accessToken: token.accessToken,
      ...(token.refreshToken !== undefined ? { refreshToken: token.refreshToken } : {}),
      ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
      ...(token.tokenType !== undefined ? { tokenType: token.tokenType } : {}),
    };
    this.deps.persist?.(this.#credential);
  }
  async headers(): Promise<AuthHeaders> {
    if (this.#isFresh()) {
      return bearerHeader(this.#credential.accessToken as string, this.#credential.tokenType);
    }
    if (this.#credential.accessToken !== undefined && this.#credential.accessToken !== '') {
      throw new ProviderAuthError('expired-no-refresh', '短信登录已过期，请重新获取验证码');
    }
    throw new ProviderAuthError('missing-credential', '还没有完成短信登录');
  }
  status(): AuthStatus {
    const hasGateway = this.deps.smsGateways?.has(this.#credential.gatewayId) ?? false;
    if (!hasGateway) {
      return {
        method: 'sms', ready: false,
        reason: `没有可用的短信网关「${this.#credential.gatewayId}」`,
        expiresAt: null, detail: '手机号 + 短信验证码',
      };
    }
    const fresh = this.#isFresh();
    return {
      method: 'sms',
      ready: fresh,
      reason: fresh ? '' : '还没有完成短信登录',
      expiresAt: this.#credential.expiresAt ?? null,
      detail: `${this.#credential.phone} · 手机号 + 短信验证码`,
    };
  }
}

/** 造一个策略。`record` 为 null 表示这家还没配过。 */
export function createAuthStrategy(
  providerId: string,
  record: CredentialRecord | null,
  deps: AuthDeps,
): AuthStrategy {
  switch (record?.method) {
    case 'bearer': return new BearerAuthStrategy(record);
    case 'oauth2': return new OAuth2AuthStrategy(providerId, record, deps);
    case 'browser-same-origin': return new BrowserSameOriginAuthStrategy(record, deps);
    case 'sms': return new SmsAuthStrategy(deps, record);
    case 'none': return new NoAuthStrategy();
    default: return new MissingAuthStrategy(providerId);
  }
}

/** 给界面用：把策略的类型收窄，拿到 OAuth2 / 短信特有的交互方法。 */
export function asOAuth2(strategy: AuthStrategy): { authorize(): Promise<void> } | null {
  return strategy instanceof OAuth2AuthStrategy ? strategy : null;
}

export function asSms(strategy: AuthStrategy): { requestCode(): Promise<{ expiresInSeconds: number | null }>; submitCode(code: string): Promise<void> } | null {
  return strategy instanceof SmsAuthStrategy ? strategy : null;
}
