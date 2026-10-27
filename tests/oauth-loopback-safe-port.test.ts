import { expect, it } from 'vitest';
import { isFetchSafeLoopbackPort, startLoopbackReceiver } from '@qiyin/provider-auth';

it('OAuth 回调不用浏览器明令禁止的本机端口', () => {
  expect(isFetchSafeLoopbackPort(6000)).toBe(false);
  expect(isFetchSafeLoopbackPort(6667)).toBe(false);
  expect(isFetchSafeLoopbackPort(10080)).toBe(false);
  expect(isFetchSafeLoopbackPort(43121)).toBe(true);
});

it('授权失败的回调网页转义不可信文本', async () => {
  const receiver = await startLoopbackReceiver({ timeoutMs: 3000 });
  try {
    const callback = new URL(receiver.redirectUri);
    callback.searchParams.set('error', '<script>alert(1)</script>');
    callback.searchParams.set('error_description', '账号受限 & 请重试');
    const response = await fetch(callback);
    const html = await response.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('账号受限 &amp; 请重试');
    expect(html).not.toContain('<script>');
    await expect(receiver.waitForCode()).rejects.toThrow('授权被拒绝');
  } finally { await receiver.close(); }
});
