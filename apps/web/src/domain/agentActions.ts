/**
 * Agent 风险动作的前置判断。
 *
 * 产品约定：Agent 可以主动提出建议，但凡是会消耗生成额度、
 * 触发付费，或覆盖已有结果的动作，必须先让用户确认。
 * 这里只负责识别「是否需要确认」，不负责执行动作。
 */
const RISKY_ACTION = /(生成|重做|覆盖|导出|替换|付费|花费|额度|删除|清空|移除|修改文件|delete|remove|overwrite|export|generate|pay)/i;

export function requiresAgentConfirmation(prompt: string): boolean {
  return RISKY_ACTION.test(prompt.trim());
}
