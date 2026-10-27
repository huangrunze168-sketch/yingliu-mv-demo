import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-stripe-'));
  roots.push(root);
  const app = buildServer(new ProjectService(openDatabase(':memory:')), undefined, { workspaceRoot: root });
  return { root, app };
}

describe('本地 API·Stripe 真实支付渠道', () => {
  it('创建 Checkout 会话并在支付完成后激活订阅', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_placeholder');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/checkout/sessions/cs_test_123')) {
        return new Response(JSON.stringify({
          status: 'complete',
          payment_status: 'paid',
          metadata: { account_id: 'local-account', plan: 'studio' },
          amount_total: 9900,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { app } = setup();
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/v1/account/payment/stripe/checkout',
      payload: { plan: 'studio', amount_cents: 9900, confirmation: true, return_url: 'http://127.0.0.1:5173/signup' },
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json()).toMatchObject({ provider: 'stripe', session_id: 'cs_test_123' });

    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/v1/account/payment/stripe/confirm',
      payload: { session_id: 'cs_test_123' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ plan: 'studio', quota_credits: 33, watermark: false });
    await app.close();
  });

  it('未配置 Stripe 密钥时明确返回 501', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/account/payment/stripe/checkout',
      payload: { plan: 'studio', amount_cents: 9900, confirmation: true },
    });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe('STRIPE_NOT_CONFIGURED');
    await app.close();
  });
});
