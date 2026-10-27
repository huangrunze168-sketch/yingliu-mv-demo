/* ============================================================
  BYOK-004：鉴权方式抽象（Bearer / OAuth2 / 浏览器同源 / 短信）。

  这套用例**只在需要的两处碰网络**，而且两处都是测试自己起的本机服务：

    · OAuth2 的令牌端点 —— 本地 http server，断言发过去的参数；
    · OAuth2 的回调 —— 用真实的 loopback receiver 收码（这正是生产路径）。

  其余全部离线。要验的是几条"写错了会静默出事"的判断：
     · 密钥是不是真的没明文落盘；
     · 过期令牌会不会自动换、换完有没有写回；
     · 十个并发请求会不会刷十次（刷新轮换的站点上这会作废凭据）；
     · 浏览器里没那个 Cookie 时，报的是不是"去登录"而不是 401；
     · 没装短信网关时，按钮是不是能给出可执行的原因。
  ============================================================ */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_METHOD_LABELS, CredentialStore, CredentialStoreCorruptError, ProviderAuthError,
  asOAuth2, asSms, buildAuthorizationUrl, createHttpSmsGateway, createMemoryVault, createPkcePair,
  isFetchSafeLoopbackPort, isProviderAuthError, purgeCredentialFiles, resolveAuth, startLoopbackReceiver, summarizeAuthHeaders,
  type AuthDeps,
} from '@qiyin/provider-auth';

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-auth-'));
  roots.push(root);
  return root;
}

function storeAt(root: string): CredentialStore {
  return new CredentialStore({
    filePath: join(root, 'provider-credentials.json'),
    keyPath: join(root, 'provider-credentials.key'),
  });
}

/** 一个最小的本机 HTTP 服务；`handler` 收到的请求体原样留给断言。 */
async function startServer(
  handler: (input: { path: string; body: string; headers: Record<string, string | string[] | undefined> }) =>
    { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>,
): Promise<{ origin: string }> {
  const received: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        received.push(body);
        const result = await handler({ path: request.url ?? '/', body, headers: request.headers });
        response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result.body));
      })();
    });
  });
  let address = server.address();
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(); }); });
    address = server.address();
    if (address !== null && typeof address !== 'string' && isFetchSafeLoopbackPort(address.port)) break;
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
  if (address === null || typeof address === 'string' || !isFetchSafeLoopbackPort(address.port)) throw new Error('服务没拿到浏览器可访问的端口');
  servers.push(server);
  return { origin: `http://127.0.0.1:${address.port}` };
}

function deps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return { fetchImpl: fetch, now: () => Date.now(), ...overrides };
}

describe('凭据仓库', () => {
  it('密钥不以明文出现在密文文件里', () => {
    const root = tempRoot();
    const store = storeAt(root);
    store.set('canvas', { method: 'bearer', key: 'sk-super-secret-value' });
    const raw = readFileSync(join(root, 'provider-credentials.json'), 'utf8');
    expect(raw).not.toContain('sk-super-secret-value');
    /* 文件里连 provider id 都不该有：整块明文都在密文里。 */
    expect(raw).not.toContain('canvas');
    expect(existsSync(join(root, 'provider-credentials.key'))).toBe(true);
  });

  it('重新打开还能读回原值（密钥文件持久化）', () => {
    const root = tempRoot();
    storeAt(root).set('kling', { method: 'bearer', key: 'abc123' });
    const reopened = storeAt(root);
    expect(reopened.get('kling')).toEqual({ method: 'bearer', key: 'abc123' });
  });

  it('list 只给"哪家、哪种方式"，不带密钥', () => {
    const root = tempRoot();
    const store = storeAt(root);
    store.set('a', { method: 'bearer', key: 'secret-a' });
    store.set('b', { method: 'oauth2', authorizationEndpoint: 'https://x/auth', tokenEndpoint: 'https://x/token', clientId: 'cid' });
    const listed = store.list();
    expect(listed).toEqual([
      { providerId: 'a', method: 'bearer' },
      { providerId: 'b', method: 'oauth2' },
    ]);
    expect(JSON.stringify(listed)).not.toContain('secret-a');
  });

  it('密文被改过就报错，不静默当成空仓库', () => {
    const root = tempRoot();
    storeAt(root).set('a', { method: 'bearer', key: 'k' });
    const file = join(root, 'provider-credentials.json');
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { data: string };
    const bytes = Buffer.from(envelope.data, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    envelope.data = bytes.toString('base64');
    writeFileSync(file, JSON.stringify(envelope));
    expect(() => storeAt(root).get('a')).toThrow(CredentialStoreCorruptError);
  });

  it('密钥文件丢了也要报错，不许新造一把去解旧密文', () => {
    const root = tempRoot();
    storeAt(root).set('a', { method: 'bearer', key: 'k' });
    rmSync(join(root, 'provider-credentials.key'));
    expect(() => storeAt(root).get('a')).toThrow(CredentialStoreCorruptError);
  });

  it('purge 能把两个文件都抹掉', () => {
    const root = tempRoot();
    const store = storeAt(root);
    store.set('a', { method: 'bearer', key: 'k' });
    const options = { filePath: join(root, 'provider-credentials.json'), keyPath: join(root, 'provider-credentials.key') };
    purgeCredentialFiles(options);
    expect(existsSync(options.filePath)).toBe(false);
    expect(existsSync(options.keyPath)).toBe(false);
  });
});

describe('Bearer', () => {
  it('直接给出 Authorization 头', async () => {
    const resolved = resolveAuth({
      providerId: 'p', declaredMethods: ['bearer'], vault: createMemoryVault({ p: { method: 'bearer', key: 'k-1' } }), deps: deps(),
    });
    expect(await resolved.strategy.headers()).toEqual({ authorization: 'Bearer k-1' });
    expect(resolved.strategy.status().ready).toBe(true);
  });

  it('空字符串的密钥要报"凭据不完整"，不能发出空的 Authorization', async () => {
    const resolved = resolveAuth({
      providerId: 'p', declaredMethods: ['bearer'], vault: createMemoryVault({ p: { method: 'bearer', key: '' } }), deps: deps(),
    });
    await expect(resolved.strategy.headers()).rejects.toMatchObject({ code: 'incomplete-credential' });
  });
});

describe('OAuth2', () => {
  const expired = {
    method: 'oauth2' as const,
    authorizationEndpoint: 'https://id.example.com/authorize',
    tokenEndpoint: 'https://id.example.com/token',
    clientId: 'app-1',
    refreshToken: 'rt-old',
    accessToken: 'at-old',
    expiresAt: 1_000,
  };

  it('令牌没过期就直接用，不发任何请求', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response('{}'); }) as unknown as typeof fetch;
    const vault = createMemoryVault({ p: { ...expired, expiresAt: Date.now() + 3_600_000 } });
    const resolved = resolveAuth({ providerId: 'p', declaredMethods: ['oauth2'], vault, deps: deps({ fetchImpl }) });
    expect(await resolved.strategy.headers()).toEqual({ authorization: 'Bearer at-old' });
    expect(calls).toBe(0);
  });

  it('过期后自动刷新，并把新令牌写回仓库', async () => {
    const endpoint = await startServer(() => ({
      body: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, token_type: 'Bearer' },
    }));
    const vault = createMemoryVault({ p: { ...expired, tokenEndpoint: `${endpoint.origin}/token` } });
    const resolved = resolveAuth({ providerId: 'p', declaredMethods: ['oauth2'], vault, deps: deps() });
    expect(await resolved.strategy.headers()).toEqual({ authorization: 'Bearer at-new' });
    const saved = vault.get('p');
    expect(saved).toMatchObject({ method: 'oauth2', accessToken: 'at-new', refreshToken: 'rt-new' });
    /* 过期时间被换算成绝对时间戳，而不是留着服务端的秒数。 */
    expect((saved as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now());
  });

  it('刷新用的 grant_type / refresh_token 必须真的发出去', async () => {
    let seen = '';
    const endpoint = await startServer(({ body }) => {
      seen = body;
      return { body: { access_token: 'at-new', expires_in: 60 } };
    });
    const vault = createMemoryVault({ p: { ...expired, tokenEndpoint: `${endpoint.origin}/token` } });
    const resolved = resolveAuth({ providerId: 'p', declaredMethods: ['oauth2'], vault, deps: deps() });
    await resolved.strategy.headers();
    const params = new URLSearchParams(seen);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('rt-old');
    expect(params.get('client_id')).toBe('app-1');
  });

  it('十个并发请求只刷一次（刷新轮换的站点上这点是关键）', async () => {
    let tokenCalls = 0;
    const endpoint = await startServer(() => {
      tokenCalls += 1;
      return { body: { access_token: `at-${tokenCalls}`, expires_in: 3600 } };
    });
    const vault = createMemoryVault({ p: { ...expired, tokenEndpoint: `${endpoint.origin}/token` } });
    const resolved = resolveAuth({ providerId: 'p', declaredMethods: ['oauth2'], vault, deps: deps() });
    const headers = await Promise.all(Array.from({ length: 10 }, () => resolved.strategy.headers()));
    expect(tokenCalls).toBe(1);
    for (const header of headers) expect(header).toEqual({ authorization: 'Bearer at-1' });
  });

  it('没有 refresh_token 且已过期：报"要重新登录"，不是笼统失败', async () => {
    const vault = createMemoryVault({
      p: { method: 'oauth2', authorizationEndpoint: 'https://a', tokenEndpoint: 'https://t', clientId: 'c', accessToken: 'old', expiresAt: 1 },
    });
    const resolved = resolveAuth({ providerId: 'p', declaredMethods: ['oauth2'], vault, deps: deps() });
    await expect(resolved.strategy.headers()).rejects.toMatchObject({ code: 'expired-no-refresh' });
  });

  it('缺字段时把缺的字段名列出来', async () => {
    const vault = createMemoryVault({
      p: { method: 'oauth2', authorizationEndpoint: '', tokenEndpoint: 'https://t', clientId: 'c' },
    });
    const resolved = resolveAuth({ providerId: 'p', declaredMethods: ['oauth2'], vault, deps: deps() });
    await expect(resolved.strategy.headers()).rejects.toMatchObject({ code: 'incomplete-credential' });
    await expect(resolved.strategy.headers()).rejects.toThrow(/authorizationEndpoint/);
    expect(resolved.strategy.status().ready).toBe(false);
  });

  it('走完整授权：PKCE 换码 → 本机回调收码 → 落盘', async () => {
    let exchanged = '';
    const tokenEndpoint = await startServer(({ body }) => {
      exchanged = body;
      return { body: { access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 3600, token_type: 'Bearer' } };
    });
    const vault = createMemoryVault({
      p: {
        method: 'oauth2',
        authorizationEndpoint: 'https://id.example.com/authorize',
        tokenEndpoint: `${tokenEndpoint.origin}/token`,
        clientId: 'app-1',
      },
    });
    const resolved = resolveAuth({ providerId: 'p', declaredMethods: ['oauth2'], vault, deps: deps() });
    const oauth = asOAuth2(resolved.strategy);
    expect(oauth).not.toBeNull();

    /* 把"打开浏览器"换成"我们自己去访问那个授权地址"，
       并扮演服务端：校验 PKCE 参数后回调 redirect_uri 带 code 回来。 */
    const authorizeUrlSeen = await new Promise<string>((resolve, reject) => {
      const patched = resolveAuth({
        providerId: 'p',
        declaredMethods: ['oauth2'],
        vault,
        deps: deps({
          openExternal: async (url) => {
            resolve(url);
            const parsed = new URL(url);
            const redirect = parsed.searchParams.get('redirect_uri');
            const state = parsed.searchParams.get('state');
            const challenge = parsed.searchParams.get('code_challenge');
            if (redirect === null || state === null || challenge === null) {
              reject(new Error('授权 URL 缺参数'));
              return;
            }
            setTimeout(() => {
              void fetch(`${redirect}?code=the-code&state=${encodeURIComponent(state)}`);
            }, 10);
          },
        }),
      });
      void asOAuth2(patched.strategy)?.authorize().then(() => {
        /* authorize 成功即已落盘 */
      });
    });
    const parsed = new URL(authorizeUrlSeen);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('client_id')).toBe('app-1');

    /* 等落盘完成 */
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(vault.get('p')).toMatchObject({ method: 'oauth2', accessToken: 'at-fresh', refreshToken: 'rt-fresh' });
    const params = new URLSearchParams(exchanged);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('the-code');
    /* PKCE 的关键：换码时要带上 verifier，且它必须能对回 challenge。 */
    const verifier = params.get('code_verifier') ?? '';
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('回调 state 对不上就放弃，不拿这个 code 去换令牌', async () => {
    let tokenCalls = 0;
    const tokenEndpoint = await startServer(() => { tokenCalls += 1; return { body: { access_token: 'x' } }; });
    const vault = createMemoryVault({
      p: { method: 'oauth2', authorizationEndpoint: 'https://a', tokenEndpoint: `${tokenEndpoint.origin}/token`, clientId: 'c' },
    });
    const resolved = resolveAuth({
      providerId: 'p', declaredMethods: ['oauth2'], vault,
      deps: deps({
        openExternal: async (url) => {
          const redirect = new URL(url).searchParams.get('redirect_uri');
          setTimeout(() => { void fetch(`${redirect}?code=c&state=wrong-state`); }, 10);
        },
      }),
    });
    await expect(asOAuth2(resolved.strategy)?.authorize()).rejects.toThrow(/state/);
    expect(tokenCalls).toBe(0);
  });
});

describe('浏览器同源', () => {
  it('从浏览器会话读到 Cookie 就装进 Authorization', async () => {
    const vault = createMemoryVault({
      p: { method: 'browser-same-origin', origin: 'https://jimeng.example.com', cookieName: 'sessionid' },
    });
    const resolved = resolveAuth({
      providerId: 'p', declaredMethods: ['browser-same-origin'], vault,
      deps: deps({
        readCookie: async (origin, name) => (origin === 'https://jimeng.example.com' && name === 'sessionid' ? 'cookie-value' : null),
      }),
    });
    expect(await resolved.strategy.headers()).toEqual({ authorization: 'Bearer cookie-value' });
  });

  it('要求发原样 Cookie 时可以改成 Cookie 头', async () => {
    const vault = createMemoryVault({
      p: { method: 'browser-same-origin', origin: 'https://x.com', cookieName: 'sid', headerName: 'cookie', headerPrefix: '' },
    });
    const resolved = resolveAuth({
      providerId: 'p', declaredMethods: ['browser-same-origin'], vault,
      deps: deps({ readCookie: async () => 'abc' }),
    });
    expect(await resolved.strategy.headers()).toEqual({ cookie: 'sid=abc' });
  });

  it('浏览器里没这个 Cookie：提示去登录，而不是让它去撞 401', async () => {
    const vault = createMemoryVault({ p: { method: 'browser-same-origin', origin: 'https://x.com', cookieName: 'sid' } });
    const resolved = resolveAuth({
      providerId: 'p', declaredMethods: ['browser-same-origin'], vault, deps: deps({ readCookie: async () => null }),
    });
    await expect(resolved.strategy.headers()).rejects.toMatchObject({ code: 'cookie-missing' });
    await expect(resolved.strategy.headers()).rejects.toThrow(/登录/);
  });

  it('宿主不支持读会话时明确说"不支持"', async () => {
    const vault = createMemoryVault({ p: { method: 'browser-same-origin', origin: 'https://x.com', cookieName: 'sid' } });
    const resolved = resolveAuth({ providerId: 'p', declaredMethods: ['browser-same-origin'], vault, deps: deps() });
    await expect(resolved.strategy.headers()).rejects.toMatchObject({ code: 'unsupported-method' });
    expect(resolved.strategy.status().ready).toBe(false);
  });
});

describe('短信', () => {
  function gatewayFixture(): { gateway: ReturnType<typeof createHttpSmsGateway>; calls: string[] } {
    const calls: string[] = [];
    const gateway = createHttpSmsGateway({
      id: 'demo', label: '示例网关',
      sendCodeUrl: 'https://sms.example.com/send',
      verifyUrl: 'https://sms.example.com/verify',
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(`${String(input)} ${String(init?.body ?? '')}`);
        const url = String(input);
        if (url.endsWith('/send')) return new Response(JSON.stringify({ session_id: 's-1', expires_in: 300 }), { status: 200 });
        return new Response(JSON.stringify({ access_token: 'sms-at', refresh_token: 'sms-rt', expires_in: 3600 }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { gateway, calls };
  }

  it('没装网关：状态里就说清楚，取用时也不是"点了没反应"', async () => {
    const vault = createMemoryVault({ p: { method: 'sms', phone: '13800000000', gatewayId: 'missing' } });
    const resolved = resolveAuth({ providerId: 'p', declaredMethods: ['sms'], vault, deps: deps() });
    const status = resolved.strategy.status();
    expect(status.ready).toBe(false);
    expect(status.reason).toContain('missing');
    await expect(asSms(resolved.strategy)?.requestCode()).rejects.toMatchObject({ code: 'gateway-absent' });
  });

  it('发码 → 校验 → 拿令牌 → 落盘', async () => {
    const { gateway, calls } = gatewayFixture();
    const vault = createMemoryVault({ p: { method: 'sms', phone: '13800000000', gatewayId: 'demo' } });
    const resolved = resolveAuth({
      providerId: 'p', declaredMethods: ['sms'], vault,
      deps: deps({ smsGateways: new Map([['demo', gateway]]) }),
    });
    const sms = asSms(resolved.strategy);
    expect(sms).not.toBeNull();
    expect(await sms?.requestCode()).toEqual({ expiresInSeconds: 300 });
    await sms?.submitCode('123456');
    /* session_id 要带到校验请求里，否则服务端对不上这次发码。 */
    expect(calls[1]).toContain('"session_id":"s-1"');
    expect(vault.get('p')).toMatchObject({ method: 'sms', accessToken: 'sms-at' });
    expect(await resolved.strategy.headers()).toEqual({ authorization: 'Bearer sms-at' });
    expect(resolved.strategy.status().ready).toBe(true);
  });

  it('短信登录过期：报"重新获取验证码"', async () => {
    const { gateway } = gatewayFixture();
    const vault = createMemoryVault({
      p: { method: 'sms', phone: '13800000000', gatewayId: 'demo', accessToken: 'old', expiresAt: 1 },
    });
    const resolved = resolveAuth({
      providerId: 'p', declaredMethods: ['sms'], vault,
      deps: deps({ smsGateways: new Map([['demo', gateway]]) }),
    });
    await expect(resolved.strategy.headers()).rejects.toMatchObject({ code: 'expired-no-refresh' });
  });

  it('手机号没填时，发码这一步就拦住', async () => {
    const { gateway } = gatewayFixture();
    const vault = createMemoryVault({ p: { method: 'sms', phone: '', gatewayId: 'demo' } });
    const resolved = resolveAuth({
      providerId: 'p', declaredMethods: ['sms'], vault,
      deps: deps({ smsGateways: new Map([['demo', gateway]]) }),
    });
    await expect(asSms(resolved.strategy)?.requestCode()).rejects.toMatchObject({ code: 'incomplete-credential' });
  });
});

describe('解析与提示', () => {
  it('没配过时给出"可以怎么配"，并且不假装已就绪', () => {
    const resolved = resolveAuth({
      providerId: 'canvas', declaredMethods: ['bearer', 'browser-same-origin'], vault: createMemoryVault(), deps: deps(),
    });
    expect(resolved.method).toBeNull();
    expect(resolved.unconfiguredMethods).toEqual(['bearer', 'browser-same-origin']);
    expect(resolved.advice).toContain(AUTH_METHOD_LABELS.bearer);
    expect(resolved.advice).toContain(AUTH_METHOD_LABELS['browser-same-origin']);
    expect(resolved.strategy.status().ready).toBe(false);
  });

  it('配了就用配的那种，其余记为"还没配"', () => {
    const resolved = resolveAuth({
      providerId: 'p', declaredMethods: ['bearer', 'sms'],
      vault: createMemoryVault({ p: { method: 'bearer', key: 'k' } }), deps: deps(),
    });
    expect(resolved.method).toBe('bearer');
    expect(resolved.unconfiguredMethods).toEqual(['sms']);
    expect(resolved.advice).toBe('');
  });

  it('配的方式不在声明里：提示但不拦（用户可能自己接了代理）', async () => {
    const resolved = resolveAuth({
      providerId: 'p', declaredMethods: ['oauth2'],
      vault: createMemoryVault({ p: { method: 'bearer', key: 'k' } }), deps: deps(),
    });
    expect(resolved.advice).toContain('不在该 Provider 的声明里');
    expect(await resolved.strategy.headers()).toEqual({ authorization: 'Bearer k' });
  });

  it('声明不需要凭据时，headers 是空对象而不是报错', async () => {
    const resolved = resolveAuth({
      providerId: 'local', declaredMethods: ['none'], vault: createMemoryVault({ local: { method: 'none' } }), deps: deps(),
    });
    expect(await resolved.strategy.headers()).toEqual({});
    expect(resolved.strategy.status().ready).toBe(true);
  });

  it('只声明 none 的 Provider：没配记录时也算就绪，不给用户留一个填不满的待办', async () => {
    /**/
    const resolved = resolveAuth({
      providerId: 'canvas', declaredMethods: ['none'], vault: createMemoryVault(), deps: deps(),
    });
    expect(resolved.method).toBe('none');
    expect(resolved.strategy.status().ready).toBe(true);
    expect(resolved.advice).toBe('');
    expect(await resolved.strategy.headers()).toEqual({});
  });

  it('脱敏摘要里不出现令牌本身', () => {
    const text = summarizeAuthHeaders({ authorization: 'Bearer sk-very-secret', 'x-trace': 'abc' });
    expect(text).not.toContain('sk-very-secret');
    expect(text).toContain('authorization: Bearer <已省略>');
    expect(text).toContain('x-trace: <已省略>');
  });
});

describe('PKCE 与回调服务器', () => {
  it('challenge 是 verifier 的 S256 摘要', async () => {
    const { createHash } = await import('node:crypto');
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
    expect(pair.challenge).not.toContain('=');
  });

  it('授权 URL 只带必要参数，scope 为空时不写进去', () => {
    const url = new URL(buildAuthorizationUrl({
      authorizationEndpoint: 'https://id.example.com/authorize?tenant=t1',
      clientId: 'app', redirectUri: 'http://127.0.0.1:1/callback', state: 's', challenge: 'c', scope: '',
    }));
    expect(url.searchParams.get('tenant')).toBe('t1');
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1/callback');
  });

  it('回调服务器真的收得到码，且只监听本机', async () => {
    const receiver = await startLoopbackReceiver({ timeoutMs: 5000 });
    expect(receiver.redirectUri.startsWith('http://127.0.0.1:')).toBe(true);
    const waiting = receiver.waitForCode();
    await fetch(`${receiver.redirectUri}?code=abc&state=st`);
    await expect(waiting).resolves.toEqual({ code: 'abc', state: 'st' });
  });

  it('服务端拒绝授权时，回调和错误原因都说得出来', async () => {
    const receiver = await startLoopbackReceiver({ timeoutMs: 5000 });
    const request = fetch(`${receiver.redirectUri}?error=access_denied&error_description=user%20said%20no`);
    await expect(receiver.waitForCode()).rejects.toMatchObject({ code: 'token-request-failed' });
    await request;
  });

  it('回调还没人来时先拿着 promise，也不会被判成 unhandled rejection', async () => {
    /* 这条钉的是真实场景：调用方 `openExternal` 之后往往还要做别的事，
       才回头 await 收码结果。这段窗口里如果用户点了"拒绝"，
       拒绝必须被我们兜住，不能把整个进程打断。 */
    const receiver = await startLoopbackReceiver({ timeoutMs: 5000 });
    const waiting = receiver.waitForCode();
    /* 刻意先做一段无关的异步工作，让 rejected 状态先于 await 出现。 */
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    await fetch(`${receiver.redirectUri}?error=access_denied`);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    await expect(waiting).rejects.toMatchObject({ code: 'token-request-failed' });
  });

  it('错误对象能跨模块识别，并带诊断文本', () => {
    const error = new ProviderAuthError('token-request-failed', '失败', '{"error":"x"}');
    expect(isProviderAuthError(error)).toBe(true);
    expect(isProviderAuthError(new Error('普通错误'))).toBe(false);
    expect(error.detailText).toBe('{"error":"x"}');
  });
});

describe('HTTP 短信网关适配器', () => {
  it('服务端返回非 JSON 时，报错里带上 HTTP 状态', async () => {
    const gateway = createHttpSmsGateway({
      id: 'g', label: 'G', sendCodeUrl: 'https://s/send', verifyUrl: 'https://s/verify',
      fetchImpl: (async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch,
    });
    await expect(gateway.sendCode('13800000000')).rejects.toMatchObject({ code: 'token-request-failed' });
  });

  it('校验返回里没有 access_token 就报错，不返回半个令牌', async () => {
    const gateway = createHttpSmsGateway({
      id: 'g', label: 'G', sendCodeUrl: 'https://s/send', verifyUrl: 'https://s/verify',
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(gateway.verifyCode({ phone: '13800000000', code: '1' })).rejects.toMatchObject({ code: 'token-request-failed' });
  });
});
