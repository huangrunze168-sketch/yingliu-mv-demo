import { randomUUID } from 'node:crypto';
import { startBuiltinRun, type BuiltinConfig } from './agent-builtin.js';
import type { AgentEvent, AgentRunHandle } from './agent-runner.js';

/** 规划模型仅从本地后端进程读取密钥；不经网页请求、会话文件或运行日志。 */
export function creativeProviderFromEnv(): BuiltinConfig | null {
  const baseUrl = process.env.QIYIN_PLANNER_BASE_URL ?? '';
  const model = process.env.QIYIN_PLANNER_MODEL ?? '';
  const apiKey = process.env.QIYIN_PLANNER_API_KEY ?? '';
  return baseUrl || model || apiKey ? { baseUrl, model, apiKey } : null;
}

export function creativeProviderConfigError(config: BuiltinConfig): string | null {
  const missing = [
    !config.baseUrl.trim() ? 'QIYIN_PLANNER_BASE_URL' : null,
    !config.model.trim() ? 'QIYIN_PLANNER_MODEL' : null,
    !config.apiKey.trim() ? 'QIYIN_PLANNER_API_KEY' : null,
  ].filter((item): item is string => item !== null);
  if (missing.length > 0) return `第三方规划 API 配置不完整：缺少 ${missing.join('、')}`;
  if (config.model.length > 120 || config.apiKey.length > 4096) return '第三方规划模型名称或密钥过长';
  if (!/^[\x21-\x7e]+$/.test(config.apiKey)) return '第三方 API Key 必须是服务商提供的单行 ASCII 字符串';
  try {
    const parsed = new URL(config.baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return '规划 API 地址必须使用 HTTPS（本机回环地址可用 HTTP），且不能在地址里放密钥或查询参数';
    }
  } catch { return '第三方规划 API 地址不是有效 URL'; }
  return null;
}

/** 用既有流式 OpenAI 兼容客户端规划；整个请求不声明工具，也拒绝异常工具调用。 */
export function startCreativeProviderRun(config: BuiltinConfig, prompt: string, onEvent: (event: AgentEvent) => void, maxDurationMs = 120_000): AgentRunHandle {
  const runId = randomUUID();
  let reply = '';
  let failed = false;
  const emit = (kind: AgentEvent['kind'], text: string) => onEvent({ runId, at: Date.now(), kind, text: text.replaceAll(config.apiKey, '[已隐藏的密钥]') });
  const handle = startBuiltinRun({
    config, exposeTools: false, includeUsage: false, maxOutputTokens: 8192, maxDurationMs,
    system: '你是小QTV的创意规划助手。只澄清需求或输出可编辑分镜方案，不调用任何工具、不执行生成、绝不声称已产出图片或视频。',
    prompt,
    callTool: async () => ({ ok: false, content: '创意规划阶段不授权任何工具调用。' }),
    onEvent: event => {
      if (event.kind === 'message') { reply += event.text; return; }
      if (event.kind === 'error') { failed = true; emit('error', event.text); return; }
      if (event.kind === 'done') {
        if (!failed && reply.trim().length > 8000) emit('error', '规划模型回复超过会话可验证长度，未截断冒充完整方案；请缩短镜头描述后重新规划。');
        else if (!failed && reply.trim()) emit('message', reply.trim());
        else if (!failed) emit('error', '规划模型未返回可用正文；没有生成方案，也没有执行工具。');
        emit('done', event.text);
      }
    },
  });
  return { runId, cancel: handle.cancel };
}
