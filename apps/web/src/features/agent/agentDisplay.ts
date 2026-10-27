import type { AgentMessage } from './agentClient.js';

const LIBTV_CANVAS_LINK = /https:\/\/www\.liblib\.tv\/canvas\?projectId=[a-z0-9-]+/i;

/** 只把 LibTV 官方画布地址识别为可点击链接，避免把任意 Agent 文本直接渲染成外链。 */
export function libtvCanvasLink(text: string): string | null {
  return LIBTV_CANVAS_LINK.exec(text)?.[0] ?? null;
}

/** 会话只包含人与助手的正文；CLI 日志、工具、错误不是助手发言。 */
export function dialogue(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(message => message.role === 'user' || message.role === 'agent');
}

/** 仅在服务确认本轮已结束时使用：用户已提交但没有助手答复、方案或错误，不能当成功。 */
export function missingPlanningReply(messages: AgentMessage[]): boolean {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') { lastUser = index; break; }
  }
  return lastUser >= 0 && !messages.slice(lastUser + 1).some(message =>
    message.role === 'agent' || message.role === 'plan' || message.role === 'error');
}

/** 规划运行与媒体任务共用轮询标记；有规划 runId 时，旧的生成进度不可冒充当前正在生成。 */
export function isRealGenerationRunning(messages: AgentMessage[], running: boolean, runId: string | null): boolean {
  if (!running || runId) return false;
  const latest = [...messages].reverse().find(message => message.role === 'progress');
  if (!latest) return false;
  try {
    const state = JSON.parse(latest.text) as { phase?: unknown; kind?: unknown };
    return state.phase === 'running' && (state.kind === 'image' || state.kind === 'video');
  } catch { return false; }
}

function recentActivity(messages: AgentMessage[]): AgentMessage[] {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') { lastUser = index; break; }
  }
  return messages.slice(lastUser + 1);
}

/** 兼容旧会话中已落盘的原始 Codex 错误 JSON，避免刷新后再暴露一遍。 */
function explainFailure(raw: string): string | null {
  let value: unknown = raw;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof value === 'string' && value.trim().startsWith('{')) {
      try { value = JSON.parse(value) as unknown; continue; } catch { break; }
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const next = record.error ?? record.message;
      if (next !== undefined && next !== value) { value = next; continue; }
    }
    break;
  }
  const text = typeof value === 'string' ? value : '';
  if (/Exceeded skills context budget|Model metadata .* not found|models cache/i.test(text)) return null;
  const outdated = /['`‘]([^'`’]+)['`’] model requires a newer version of Codex/i.exec(text);
  if (outdated) return `上轮使用的 Codex CLI 无法运行模型 ${outdated[1]}。小QTV 当前已改用本机 DSH，请重新发送任务。`;
  const persistedOutdated = /本机 Codex CLI 版本过旧，无法使用当前模型\s*([^。]+)/.exec(text);
  if (persistedOutdated) return `上轮使用的 Codex CLI 无法运行模型 ${persistedOutdated[1]}。小QTV 当前已改用本机 DSH，请重新发送任务。`;
  if (/^\s*\{/.test(text)) return 'Agent 本轮运行失败，请检查 Agent 配置后重试。';
  return text || 'Agent 本轮运行失败，请检查 Agent 配置后重试。';
}

export function latestFailure(messages: AgentMessage[]): string {
  const activity = recentActivity(messages);
  let lastPlan = -1;
  for (let index = activity.length - 1; index >= 0; index--) {
    if (activity[index]?.role === 'plan') { lastPlan = index; break; }
  }
  const errors = activity.slice(lastPlan + 1).filter(message => message.role === 'error');
  for (let index = errors.length - 1; index >= 0; index--) {
    const text = explainFailure(errors[index]?.text ?? '');
    if (text) return text;
  }
  return '';
}

/** 只呈现业务可理解的工具状态，绝不透出历史日志正文。 */
export function toolActivities(messages: AgentMessage[]): AgentMessage[] {
  const tools = recentActivity(messages).filter(message => message.role === 'tool');
  const byId = new Map<string, AgentMessage>();
  for (const tool of tools) byId.set(tool.itemId || tool.id, tool);
  return [...byId.values()].filter(tool => /^工具(开始执行|执行完成)/.test(tool.text));
}
