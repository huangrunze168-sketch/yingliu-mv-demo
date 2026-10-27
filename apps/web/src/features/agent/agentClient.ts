/** 项目内 Agent 会话 API：不使用演示适配器回退，服务不可用时必须显式报错。 */
import type { AgentReference } from '../../ports/index.js';

const API = '/api/v1/agent/sessions';

export type AgentMessage = {
  id: string;
  role: 'user' | 'agent' | 'tool' | 'reasoning' | 'note' | 'error' | 'plan' | 'approval' | 'progress' | 'asset' | 'selection';
  text: string;
  itemId?: string;
  skillRef?: { id: string; version: string; name?: string };
};
export type AgentSession = {
  id: string;
  title: string;
  messages: AgentMessage[];
  session_revision: number;
};
export type AgentSessionSummary = { id: string; title: string; updatedAt: number; messageCount: number };
export type AgentEvents = { events: (AgentMessage & { cursor: number })[]; next_cursor: number; done: boolean; run_id?: string | null; run_state?: 'starting' | 'running' | 'completed' | 'failed' | 'canceled' | 'unknown'; needs_review?: boolean; session_revision: number };
export type AgentRun = { run_id: string | null; session_revision: number; duplicate: boolean };
export type ImageGenerationOptions = {
  backend: 'canvas' | 'imagegen'; model: string; shot_id?: string;
  budget_cap_cents: number; estimated_cost_cents_per_shot: number;
  rights_confirmed: boolean; confirm_costs: boolean;
};
export type VideoGenerationOptions = ImageGenerationOptions & { video_budget_cents: number };
export type GenerationBackendInfo = { id: 'canvas' | 'imagegen'; label: string; installed: boolean; authenticated: null };

export class AgentApiError extends Error {
  constructor(message: string, readonly code: string | null) { super(message); this.name = 'AgentApiError'; }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new Error('无法连接本地 Agent 服务，请检查本地 API 是否运行。');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new AgentApiError(body?.error?.message ?? `Agent 服务响应失败（${response.status}）`, body?.error?.code ?? null);
  }
  return response.json() as Promise<T>;
}

const request = <T,>(path: string, init?: RequestInit) => fetchJson<T>(`${API}${path}`, init);
const projectQuery = (projectId: string) => `?project_id=${encodeURIComponent(projectId)}`;
const sessionPath = (sessionId: string) => `/${encodeURIComponent(sessionId)}`;

export const agentClient = {
  /** 对话默认绑定专属工作区，不擅自覆盖用户已有画布；旧会话仍可从原项目恢复。 */
  homeProject: async (createIfMissing = false): Promise<string | null> => {
    const rows = await fetchJson<{ name: string; primary_project_id: string | null }[]>('/api/v1/workspaces');
    const pinned = localStorage.getItem('qiyin.hero.agent.project');
    const remembered = rows.find(row => row.primary_project_id === pinned)?.primary_project_id;
    if (remembered) return remembered;
    const dedicated = rows.find(row => row.name === 'Agent 创作' && row.primary_project_id)?.primary_project_id;
    if (dedicated) return dedicated;
    if (!createIfMissing) return rows.find(row => row.primary_project_id)?.primary_project_id ?? null;
    return agentClient.createCanvasProject();
  },
  createCanvasProject: async (): Promise<string> => {
    const created = await fetchJson<{ project: { id: string } }>('/api/v1/workspaces', {
      method: 'POST', body: JSON.stringify({ name: 'Agent 创作', canvas_name: '创作画布' }),
    });
    localStorage.setItem('qiyin.hero.agent.project', created.project.id);
    return created.project.id;
  },
  list: (projectId: string) => request<AgentSessionSummary[]>(projectQuery(projectId)),
  create: (projectId: string) => request<AgentSession>('', { method: 'POST', body: JSON.stringify({ project_id: projectId }) }),
  get: (projectId: string, sessionId: string) => request<AgentSession>(`${sessionPath(sessionId)}${projectQuery(projectId)}`),
  send: (projectId: string, sessionId: string, messageId: string, text: string, revision: number, mode?: 'creative', skillRef?: { id: string; version: string }, references?: AgentReference[], model?: string) => request<AgentRun>(`${sessionPath(sessionId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, message_id: messageId, text, expected_session_revision: revision, ...(mode ? { mode } : {}), ...(skillRef ? { skill_ref: skillRef } : {}), ...(references?.length ? { references } : {}), ...(model ? { model } : {}) }),
  }),
  savePlan: (projectId: string, sessionId: string, planId: string, plan: unknown, revision: number) => request<{ plan: AgentMessage; session_revision: number }>(`${sessionPath(sessionId)}/plan`, {
    method: 'PUT', body: JSON.stringify({ project_id: projectId, plan_id: planId, plan, expected_session_revision: revision }),
  }),
  approvePlan: (projectId: string, sessionId: string, planId: string, revision: number) => request<{ approved: boolean; generation_ready: boolean; session_revision: number }>(`${sessionPath(sessionId)}/plan/approve`, {
    method: 'POST', body: JSON.stringify({ project_id: projectId, plan_id: planId, expected_session_revision: revision }),
  }),
  selectFrame: (projectId: string, sessionId: string, planId: string, shotId: string, artifactId: string, revision: number) => request<{ selected: boolean; session_revision: number }>(`${sessionPath(sessionId)}/frames/select`, {
    method: 'POST', body: JSON.stringify({ project_id: projectId, plan_id: planId, shot_id: shotId, artifact_id: artifactId, expected_session_revision: revision }),
  }),
  generationBackends: () => fetchJson<GenerationBackendInfo[]>('/api/v1/agent/generation/backends'),
  generateImages: (projectId: string, sessionId: string, planId: string, requestId: string, revision: number, options: ImageGenerationOptions) => request<AgentRun>(`${sessionPath(sessionId)}/generate/images`, {
    method: 'POST', body: JSON.stringify({ project_id: projectId, plan_id: planId, request_id: requestId, expected_session_revision: revision, ...options }),
  }),
  generateVideos: (projectId: string, sessionId: string, planId: string, requestId: string, revision: number, options: VideoGenerationOptions) => request<AgentRun>(`${sessionPath(sessionId)}/generate/videos`, {
    method: 'POST', body: JSON.stringify({ project_id: projectId, plan_id: planId, request_id: requestId, expected_session_revision: revision, ...options }),
  }),
  events: (projectId: string, sessionId: string, cursor: number) => request<AgentEvents>(`${sessionPath(sessionId)}/events${projectQuery(projectId)}&after=${cursor}&limit=100`),
  acknowledgeUnknown: (projectId: string, sessionId: string, messageId: string) => request<{ needs_review: false; run_state: 'unknown' }>(`${sessionPath(sessionId)}/runs/${encodeURIComponent(messageId)}/acknowledge`, {
    method: 'POST', body: JSON.stringify({ project_id: projectId, confirm_unknown: true }),
  }),
  cancel: (projectId: string, sessionId: string, runId: string) => request<{ canceled: boolean }>(`${sessionPath(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST', body: JSON.stringify({ project_id: projectId }),
  }),
};
