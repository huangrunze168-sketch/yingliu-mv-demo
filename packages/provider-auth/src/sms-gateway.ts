import { ProviderAuthError } from './errors.js';
import { readTokenResponse } from './oauth2-flow.js';
import type { SmsGateway } from './strategies.js';
import type { TokenSet } from './oauth2-flow.js';

/* ============================================================
  期音科技 · HTTP 短信网关适配器
   ------------------------------------------------------------
  为什么要有这一层而不是让用户去写插件：短信登录的差别几乎全在
  "两个 URL + 字段名"，不是每家公司都值得写一个插件。
  给一个通用适配器，用户填自己的短信服务地址就能用；
  真遇到需要签名、加密、多次握手的服务，再写插件补。

  约定的报文（我们定，用户按这个包一层）：
    发码  POST sendCodeUrl  { phone }            → { session_id?, expires_in? }
    换令牌 POST verifyUrl     { phone, code, session_id? }
                                                 → { access_token, refresh_token?, expires_in?, token_type? }

  令牌那一段刻意跟 OAuth2 **共用同一个解析器**：都是"拿一个短期令牌"，
  没理由写两份、让两处对 expires_in 的处理产生分歧。
   ============================================================ */

export interface HttpSmsGatewayOptions {
  id: string;
  label: string;
  sendCodeUrl: string;
  verifyUrl: string;
  /** 附加到两个请求上的头（例如自建服务的 API Key）。 */
  headers?: Record<string, string>;
  fetchImpl: typeof fetch;
  now?: () => number;
}

/** 网关返回 4xx/5xx 或缺字段时抛出，带上 HTTP 状态便于排查。 */
async function postJson(url: string, body: unknown, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new ProviderAuthError('token-request-failed', `短信网关请求失败：${String(error)}`);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderAuthError('token-request-failed', `短信网关返回的不是 JSON（HTTP ${response.status}）`, text.slice(0, 400));
  }
  if (!response.ok) {
    throw new ProviderAuthError('token-request-failed', `短信网关返回 HTTP ${response.status}`, text.slice(0, 400));
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new ProviderAuthError('token-request-failed', '短信网关返回的 JSON 不是对象');
  }
  return parsed as Record<string, unknown>;
}

export function createHttpSmsGateway(options: HttpSmsGatewayOptions): SmsGateway {
  const headers = options.headers ?? {};
  return {
    id: options.id,
    label: options.label,
    async sendCode(phone) {
      const body = await postJson(options.sendCodeUrl, { phone }, headers, options.fetchImpl);
      const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined;
      const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined;
      return {
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(expiresIn !== undefined ? { expiresInSeconds: expiresIn } : {}),
      };
    },
    async verifyCode(input) {
      const body = await postJson(options.verifyUrl, {
        phone: input.phone,
        code: input.code,
        ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
      }, headers, options.fetchImpl);
      /* 复用 OAuth2 的令牌解析：字段名与语义完全一致。 */
      const token: TokenSet = readTokenResponse(
        {
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expires_in: body.expires_in,
          token_type: body.token_type,
        },
        options.now ?? Date.now,
      );
      return token;
    },
  };
}
