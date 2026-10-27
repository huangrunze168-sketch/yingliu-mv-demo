import type { SkillDetail, SkillInstallCandidate, SkillListResult, SkillSummary } from '@qiyin/contracts';

const API = '/api/v1/skills';

type ApiError = { error?: { code?: string; message?: string } };
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  } catch { throw new Error('无法连接本地 Skill 服务，请检查本地 API 是否运行。'); }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiError | null;
    throw new Error(body?.error?.message ?? `Skill 服务响应失败（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type SkillTab = 'skill' | 'favorite' | 'mine';
export type SkillQuery = { tab: SkillTab; category?: string; keyword?: string; cursor?: string | null; limit?: number };
export type GitHubInspectResult = {
  location: { repository: string; ref?: string; subdir?: string };
  commit: string;
  candidates: SkillInstallCandidate[];
};

export const skillApi = {
  list(query: SkillQuery): Promise<SkillListResult> {
    const params = new URLSearchParams({ tab: query.tab, limit: String(query.limit ?? 20) });
    if (query.category) params.set('category', query.category);
    if (query.keyword) params.set('keyword', query.keyword);
    if (query.cursor) params.set('cursor', query.cursor);
    return json(`${API}?${params}`);
  },
  detail: (id: string) => json<SkillDetail>(`${API}/${encodeURIComponent(id)}`),
  favorite: (id: string, favorite: boolean) => json<SkillDetail>(`${API}/${encodeURIComponent(id)}/favorite`, { method: 'PUT', body: JSON.stringify({ favorite }) }),
  inspectGitHub: (input: { url: string; ref?: string; subdir?: string }) => json<GitHubInspectResult>(`${API}/imports/github/inspect`, { method: 'POST', body: JSON.stringify(input) }),
  installGitHub: (input: { url: string; ref?: string; subdir?: string; candidate_subdir: string; cover_url?: string }) => json<SkillDetail>(`${API}/imports/github`, { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string) => json<SkillDetail>(`${API}/${encodeURIComponent(id)}/update`, { method: 'POST' }),
  remove: (id: string) => json<void>(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export type { SkillDetail, SkillInstallCandidate, SkillListResult, SkillSummary };
