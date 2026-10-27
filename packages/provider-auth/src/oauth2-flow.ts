import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { ProviderAuthError } from './errors.js';

/* ============================================================
  期音科技 · OAuth2 授权码 + PKCE
   ------------------------------------------------------------
  桌面软件做 OAuth 有两个容易做错的地方，这里都堵掉了：

    ① **不能用隐式流程，也不该假装自己是机密客户端**。
       装在本机的 client_secret 谁都能扒出来，等于没有。
       所以走 PKCE：每次授权现生成一对 verifier/challenge，
       授权码只有在**发起那一方**手里才能换成令牌。

    ② **回调地址必须是本机回环**，不能是自定义协议或网页中转。
       `http://127.0.0.1:<随机端口>/callback` 只有一个进程能监听，
       别的程序抢不到；随机端口避免和用户其它服务打架。

  这里只实现"流程"，不实现"什么时候该发起授权"——那是界面的事。
   ============================================================ */

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** RFC 7636 要求的 43–128 字符、URL 安全随机串。 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export interface AuthorizationUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state: string;
  challenge: string;
  /** 有些服务端要求显式声明 `S256`；不传则不加这个参数。 */
  challengeMethod?: string;
}

export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  if (input.challengeMethod !== undefined) url.searchParams.set('code_challenge_method', input.challengeMethod);
  if (input.scope !== undefined && input.scope !== '') url.searchParams.set('scope', input.scope);
  return url.toString();
}

export interface LoopbackReceiver {
  redirectUri: string;
  /** 等到授权码（或超时/被拒）为止。 */
  waitForCode(): Promise<{ code: string; state: string }>;
  close(): Promise<void>;
}

/** 授权页显示给用户的提示文案，由调用方给（中文）。 */
export interface LoopbackOptions {
  /** 授权成功后浏览器里显示的那句话。 */
  successHtml?: string;
  timeoutMs?: number;
}

const DEFAULT_SUCCESS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>授权完成</title></head><body style="font-family:system-ui;padding:48px;text-align:center">
<h2>授权完成，可以关闭这个页面了</h2><p>请回到 小QTV 继续操作。</p></body></html>`;

/** 浏览器和 Node fetch 禁止访问的部分 TCP 端口；系统分配到这些端口时必须重新监听。 */
const forbiddenFetchPorts = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
const escapeCallbackHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
export function isFetchSafeLoopbackPort(port: number): boolean {
  return Number.isInteger(port) && port > 1023 && port < 65535 && !forbiddenFetchPorts.has(port);
}

/**
 * 起一个只监听 127.0.0.1 的一次性回调服务器。
 *
 * 监听端口交给系统给（`listen(0)`），拿到的端口再拼进 redirect_uri——
 * 这样同一个应用开两个实例也不会互相抢端口。
 */
export async function startLoopbackReceiver(options: LoopbackOptions = {}): Promise<LoopbackReceiver> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const successHtml = options.successHtml ?? DEFAULT_SUCCESS_HTML;

  let resolveCode: (value: { code: string; state: string }) => void;
  let rejectCode: (error: unknown) => void;
  const result = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  /* 先给这个 promise 挂一个空的处理器。

     为什么：用户点"拒绝授权"时，回调会**立刻**把它置为 rejected，
     而调用方此刻往往还在 await `openExternal` 或者别的东西——
     这一小段窗口里，Node 会把它判定成 unhandled rejection 并打断进程。
     挂一个 no-op catch 只是让"暂时没人接"这件事合法，
     真正的错误仍然由 `waitForCode()` 原样抛出，不会被吞掉。 */
  void result.catch(() => {});

  const server: Server = createServer((request, response) => {
    const target = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (target.pathname !== '/callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    const error = target.searchParams.get('error');
    if (error !== null) {
      const description = target.searchParams.get('error_description') ?? '';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>
<body style="font-family:system-ui;padding:48px;text-align:center">
<h2>授权未完成</h2><p>${escapeCallbackHtml(error)} ${escapeCallbackHtml(description)}</p></body></html>`);
      rejectCode(new ProviderAuthError('token-request-failed', `授权被拒绝：${error} ${description}`.trim()));
      return;
    }
    const code = target.searchParams.get('code');
    const state = target.searchParams.get('state');
    if (code === null || code === '') {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('missing code');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(successHtml);
    resolveCode({ code, state: state ?? '' });
  });

  let address = server.address();
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListen); reject(error); };
      const onListen = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(0, '127.0.0.1');
    });
    address = server.address();
    if (address !== null && typeof address !== 'string' && isFetchSafeLoopbackPort(address.port)) break;
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
  if (address === null || typeof address === 'string' || !isFetchSafeLoopbackPort(address.port)) {
    throw new ProviderAuthError('token-request-failed', '无法在 127.0.0.1 上取得浏览器允许的回调端口');
  }

  const timer = setTimeout(() => {
    rejectCode(new ProviderAuthError('token-request-failed', '等待授权超时，请重新发起'));
  }, timeoutMs);
  timer.unref?.();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  };

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode() {
      /* 收码后就关掉这个一次性端口，再把手里的 promise 交出去。
         交出去之前再挂一个空处理器：调用方从"拿到 promise"到"await 它"
         之间还有一段自己的代码要跑，而拒绝可能就发生在那段窗口里。 */
      const settled = result.finally(() => close());
      void settled.catch(() => {});
      return settled;
    },
    close,
  };
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** 绝对时间戳（毫秒）；服务端没给 `expires_in` 时为 undefined。 */
  expiresAt?: number;
  scope?: string;
  tokenType: string;
}

export interface TokenExchangeInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl: typeof fetch;
  now?: () => number;
}

interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** 把服务端的令牌响应统一成 `TokenSet`；字段缺失就在这里报，别让上层拿到 `undefined` 去拼头。 */
export function readTokenResponse(body: TokenResponseBody, now: () => number = Date.now): TokenSet {
  if (typeof body.error === 'string') {
    const detail = typeof body.error_description === 'string' ? ` ${body.error_description}` : '';
    throw new ProviderAuthError('token-request-failed', `服务端拒绝发放令牌：${body.error}${detail}`, detail);
  }
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new ProviderAuthError('token-request-failed', '令牌响应里没有 access_token');
  }
  const seconds = typeof body.expires_in === 'number' ? body.expires_in
    : typeof body.expires_in === 'string' && body.expires_in !== '' ? Number(body.expires_in) : Number.NaN;
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    ...(Number.isFinite(seconds) ? { expiresAt: now() + seconds * 1000 } : {}),
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    tokenType: typeof body.token_type === 'string' && body.token_type !== '' ? body.token_type : 'Bearer',
  };
}

async function postToken(body: Record<string, string>, fetchImpl: typeof fetch, tokenEndpoint: string): Promise<TokenResponseBody> {
  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
    });
  } catch (error) {
    throw new ProviderAuthError('token-request-failed', `请求令牌接口失败：${String(error)}`);
  }
  const text = await response.text();
  let parsed: TokenResponseBody;
  try {
    parsed = JSON.parse(text) as TokenResponseBody;
  } catch {
    throw new ProviderAuthError('token-request-failed', `令牌接口返回的不是 JSON（HTTP ${response.status}）`, text.slice(0, 400));
  }
  if (!response.ok && typeof parsed.error !== 'string') {
    throw new ProviderAuthError('token-request-failed', `令牌接口返回 HTTP ${response.status}`, text.slice(0, 400));
  }
  return parsed;
}

export async function exchangeAuthorizationCode(input: TokenExchangeInput): Promise<TokenSet> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
  };
  if (input.clientSecret !== undefined && input.clientSecret !== '') body.client_secret = input.clientSecret;
  const parsed = await postToken(body, input.fetchImpl, input.tokenEndpoint);
  return readTokenResponse(parsed, input.now ?? Date.now);
}

export interface RefreshInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  fetchImpl: typeof fetch;
  now?: () => number;
}

export async function refreshAccessToken(input: RefreshInput): Promise<TokenSet> {
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  };
  if (input.clientSecret !== undefined && input.clientSecret !== '') body.client_secret = input.clientSecret;
  const parsed = await postToken(body, input.fetchImpl, input.tokenEndpoint);
  return readTokenResponse(parsed, input.now ?? Date.now);
}
