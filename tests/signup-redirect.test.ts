import { describe, expect, it } from 'vitest';
import { resolveSignupRedirect } from '../apps/web/src/features/auth/session.js';

describe('resolveSignupRedirect', () => {
  it('允许回到首屏、create、skill 与 workbench 的站内地址', () => {
    expect(resolveSignupRedirect('/')).toBe('/');
    expect(resolveSignupRedirect('/create')).toBe('/create');
    expect(resolveSignupRedirect('/skill?tab=mine')).toBe('/skill?tab=mine');
    expect(resolveSignupRedirect('/workbench/p-demo?from=signup')).toBe('/workbench/p-demo?from=signup');
  });

  it('空值、外部地址与未知路径回落到 create', () => {
    expect(resolveSignupRedirect(null)).toBe('/create');
    expect(resolveSignupRedirect('https://evil.example')).toBe('/create');
    expect(resolveSignupRedirect('//evil.example')).toBe('/create');
    expect(resolveSignupRedirect('/settings')).toBe('/create');
  });
});
