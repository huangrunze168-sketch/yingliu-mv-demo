import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-account-'));
  roots.push(root);
  const app = buildServer(new ProjectService(openDatabase(':memory:')), undefined, { workspaceRoot: root });
  return { root, app };
}

describe('本地 API·账号额度与支付确认', () => {
  it('额度消耗必须确认，并持久化到账号账本', async () => {
    const { root, app } = setup();
    const rootResponse = await app.inject({ method: 'GET', url: '/' });
    expect(rootResponse.statusCode).toBe(302);
    expect(rootResponse.headers.location).toBe('http://127.0.0.1:5173/');
    const initial = await app.inject({ method: 'GET', url: '/api/v1/account' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ plan: 'free', quota_credits: 3, watermark: true });

    const unconfirmed = await app.inject({ method: 'POST', url: '/api/v1/account/consume', payload: { credits: 1, reason: 'retake' } });
    expect(unconfirmed.statusCode).toBe(422);
    expect(unconfirmed.json().error.code).toBe('ACCOUNT_CONFIRMATION_REQUIRED');

    const consumed = await app.inject({ method: 'POST', url: '/api/v1/account/consume', payload: { credits: 1, reason: 'retake', confirmation: true } });
    expect(consumed.statusCode).toBe(200);
    expect(consumed.json().quota_credits).toBe(2);
    expect(existsSync(join(root, '.qiyin', 'account.json'))).toBe(true);
    await app.close();
  });

  it('订阅支付必须显式确认，确认后方案与额度一起更新', async () => {
    const { app } = setup();
    const unconfirmed = await app.inject({ method: 'POST', url: '/api/v1/account/payment/confirm', payload: { plan: 'studio', amount_cents: 9900 } });
    expect(unconfirmed.statusCode).toBe(422);
    expect(unconfirmed.json().error.code).toBe('PAYMENT_CONFIRMATION_REQUIRED');

    const confirmed = await app.inject({ method: 'POST', url: '/api/v1/account/payment/confirm', payload: { plan: 'studio', amount_cents: 9900, confirmation: true } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ plan: 'studio', quota_credits: 33, watermark: false });
    await app.close();
  });
});
