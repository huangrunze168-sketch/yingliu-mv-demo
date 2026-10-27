import { describe, expect, it } from 'vitest';
import { canUseFreeRetake, evaluateFreeExport, requiresPaymentConfirmation } from '../apps/web/src/domain/entitlements.js';

describe('免费额度与导出规则', () => {
  it('免费体验限制 15 秒低清预览并强制水印', () => {
    expect(evaluateFreeExport(15, '低清预览')).toMatchObject({ allowed: true, watermark: true, requiresPaymentConfirmation: false });
    expect(evaluateFreeExport(16, '低清预览')).toMatchObject({ allowed: false, requiresPaymentConfirmation: true });
  });

  it('高清导出必须付费确认，局部重做只赠送一次', () => {
    expect(evaluateFreeExport(15, '高清导出')).toMatchObject({ allowed: true, watermark: true, requiresPaymentConfirmation: true });
    expect(canUseFreeRetake(1)).toBe(true);
    expect(canUseFreeRetake(0)).toBe(false);
    expect(requiresPaymentConfirmation(1)).toBe(true);
    expect(requiresPaymentConfirmation(0)).toBe(false);
  });
});
