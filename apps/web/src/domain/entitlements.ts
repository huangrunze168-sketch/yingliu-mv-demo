export const freePlan = {
  maxDurationSeconds: 15,
  previewQuality: '低清预览',
  watermark: '小QTV水印',
  localRetakes: 1,
} as const;

export type ExportDecision = {
  allowed: boolean;
  watermark: boolean;
  requiresPaymentConfirmation: boolean;
  reason: string;
};

export function evaluateFreeExport(durationSeconds: number, quality: string): ExportDecision {
  if (durationSeconds > freePlan.maxDurationSeconds) {
    return {
      allowed: false,
      watermark: true,
      requiresPaymentConfirmation: true,
      reason: `免费体验最长 ${freePlan.maxDurationSeconds} 秒，请缩短成片或升级方案。`,
    };
  }
  if (quality !== freePlan.previewQuality) {
    return {
      allowed: true,
      watermark: true,
      requiresPaymentConfirmation: true,
      reason: '高清导出不在免费体验范围内，需要付费或订阅确认。',
    };
  }
  return {
    allowed: true,
    watermark: true,
    requiresPaymentConfirmation: false,
    reason: '低清预览可以免费导出，文件将带小QTV水印。',
  };
}

export function canUseFreeRetake(remaining: number): boolean {
  return remaining > 0;
}

export function requiresPaymentConfirmation(estimatedCostCents: number): boolean {
  return estimatedCostCents > 0;
}
