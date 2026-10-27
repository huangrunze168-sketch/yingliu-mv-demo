import { describe, expect, it } from 'vitest';
import { requiresAgentConfirmation } from '../apps/web/src/domain/agentActions.js';

describe('requiresAgentConfirmation', () => {
  it('生成、覆盖、导出和额度相关动作必须确认', () => {
    expect(requiresAgentConfirmation('重新生成第 3 镜')).toBe(true);
    expect(requiresAgentConfirmation('覆盖当前结果')).toBe(true);
    expect(requiresAgentConfirmation('导出高清成片')).toBe(true);
    expect(requiresAgentConfirmation('消耗生成额度')).toBe(true);
    expect(requiresAgentConfirmation('删除所有文件')).toBe(true);
    expect(requiresAgentConfirmation('overwrite source clips')).toBe(true);
  });

  it('普通分析与查询可以直接执行', () => {
    expect(requiresAgentConfirmation('检查镜头节奏')).toBe(false);
    expect(requiresAgentConfirmation('整理素材列表')).toBe(false);
    expect(requiresAgentConfirmation('  ')).toBe(false);
  });
});
