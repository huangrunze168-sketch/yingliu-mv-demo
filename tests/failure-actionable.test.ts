import { describe, expect, it } from 'vitest';
import { actionableFailureHint } from '@qiyin/generation-service';

describe('SAFE-003 内容审核/生成失败归因', () => {
  it('每种失败分类都有可执行的下一步', () => {
    const kinds = ['not-installed', 'auth', 'compliance', 'command', 'protocol', 'unknown'] as const;
    for (const kind of kinds) {
      expect(actionableFailureHint(kind)).toMatch(/^请/);
      expect(actionableFailureHint(kind)).not.toContain('稍后再试');
    }
  });

  it('合规失败明确指向 Provider 网页端确认，而不是让用户重复重试', () => {
    expect(actionableFailureHint('compliance')).toContain('网页端');
    expect(actionableFailureHint('compliance')).toContain('合规确认');
  });
});
