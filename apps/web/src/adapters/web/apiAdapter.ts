import type {
  AccountEntitlements,
  AgentMessage,
  AppPorts,
  Asset,
  GenerationJob,
  PersistedCanvasDocument,
  TimelineDocument,
  TimelineExportJob,
  CanvasPort,
  ProjectSettings,
  ProjectSummary,
  WorkspaceDetail,
  WorkspacePort,
  WorkspaceSummary,
  ReferenceSource,
  Shot,
} from '../../ports/index.js';
import { memoryAdapter } from './memoryAdapter.js';
import { storageAdapter } from './storageAdapter.js';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

const API_BASE = '/api/v1';

type ApiProjectRow = {
  id: string;
  workspace_id: string;
  name: string;
  revision: number;
  state: string;
  max_budget_cents: number;
  reserved_budget_cents?: number;
  rights_confirmed?: boolean | number;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
};

type ApiProjectDetail = ApiProjectRow & {
  shot_fields?: { shots?: Array<Record<string, unknown>> } | null;
  sources?: Array<Record<string, unknown>>;
  derived_artifacts?: Array<Record<string, unknown>>;
  asset_ratings?: Array<{ artifact_id: string; stars: number }>;
  image_generations?: Array<Record<string, unknown>>;
  video_generations?: Array<Record<string, unknown>>;
  gate_status?: Record<string, string | null>;
  canvas_document?: { document_revision: number; document: PersistedCanvasDocument; updated_at: string } | null;
  timeline_document?: { document_revision: number; document: TimelineDocument; updated_at: string } | null;
};
type ApiWorkspaceRow = { id: string; name: string; revision: number; deleted_at?: string | null; created_at: string; updated_at: string; canvas_count: number; primary_project_id: string | null };
type ApiWorkspaceDetail = ApiWorkspaceRow & { canvases: ApiProjectRow[] };

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Local API ${response.status}: ${body}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function fallback<T>(request: Promise<T>, demo: () => Promise<T>): Promise<T> {
  return request.catch(() => demo());
}

function uuid(): string {
  return crypto.randomUUID();
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

function projectSummary(row: ApiProjectRow, detail?: ApiProjectDetail): ProjectSummary {
  const shots = detail?.shot_fields?.shots?.length ?? 0;
  const assets = (detail?.sources?.length ?? 0) + (detail?.derived_artifacts?.length ?? 0);
  const gateValues = Object.values(detail?.gate_status ?? {});
  const approvedGates = gateValues.filter(value => value === 'APPROVED').length;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: detail?.state === 'EMPTY' ? '新项目 · 等待读入参考素材' : '项目数据已由本地能力后端管理',
    updatedAt: relativeTime(row.updated_at),
    status: row.deleted_at ? 'archived' : 'active',
    shots,
    assets,
    progress: gateValues.length ? Math.round((approvedGates / Math.max(6, gateValues.length)) * 100) : 0,
    revision: row.revision,
    state: row.state,
    maxBudgetCents: row.max_budget_cents,
    rightsConfirmed: Boolean(row.rights_confirmed),
  };
}

function workspaceSummary(row: ApiWorkspaceRow): WorkspaceSummary {
  return { id: row.id, name: row.name, description: `${Number(row.canvas_count ?? 0)} 张画布`, updatedAt: relativeTime(row.updated_at), status: row.deleted_at ? 'archived' : 'active', revision: row.revision, canvasCount: Number(row.canvas_count ?? 0), primaryProjectId: row.primary_project_id ?? null, shots: 0, assets: 0, progress: 0, state: row.deleted_at ? 'ARCHIVED' : 'WORKSPACE', maxBudgetCents: 0, rightsConfirmed: false };
}
function workspaceDetail(row: ApiWorkspaceDetail): WorkspaceDetail {
  const canvases = (row.canvases ?? []).map(canvas => projectSummary(canvas));
  return { ...workspaceSummary({ ...row, canvas_count: row.canvas_count ?? canvases.length, primary_project_id: row.primary_project_id ?? canvases[0]?.id ?? null }), canvases };
}

async function getDetail(projectId: string): Promise<ApiProjectDetail> {
  return apiFetch<ApiProjectDetail>(`/projects/${encodeURIComponent(projectId)}`);
}

async function sendCommand(type: string, payload: Record<string, unknown>, projectId?: string, expectedRevision?: number) {
  const result = await apiFetch<{ project_id: string; project_revision: number; payload?: Record<string, unknown> }>('/commands', {
    method: 'POST',
    body: JSON.stringify({ command_id: uuid(), type, payload, ...(projectId ? { project_id: projectId } : {}), ...(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}) }),
  });
  if (typeof window !== 'undefined' && result.project_id && Number.isInteger(result.project_revision)) window.dispatchEvent(new CustomEvent('qiyin:project-revision', { detail: { projectId: result.project_id, revision: result.project_revision } }));
  return result;
}

const demoProject = (id: string) => memoryAdapter.canvases.get(id);

function mapShot(row: Record<string, unknown>): Shot {
  const durationMs = Number(row.duration_ms ?? 0);
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return {
    id: String(row.shot_id ?? crypto.randomUUID()),
    title: `镜头 · ${String(row.shot_size ?? '中景')}`,
    scene: `${String(row.camera_position ?? '机位待定')} / ${String(row.lighting ?? '光线待定')}`,
    status: 'draft',
    duration: `00:${String(seconds).padStart(2, '0')}`,
    prompt: String(row.replacement ?? row.sound ?? '待补充镜头描述'),
  };
}

function mapAsset(row: Record<string, unknown>): Asset {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const mediaType = String(row.media_type ?? '');
  const kind: Asset['kind'] = mediaType.startsWith('video') ? 'video' : mediaType.startsWith('audio') ? 'audio' : mediaType.startsWith('image') ? 'image' : 'document';
  return {
    id: String(row.artifact_id ?? crypto.randomUUID()),
    name: String(metadata.name ?? metadata.file_name ?? metadata.filename ?? '项目产物'),
    kind,
    meta: `${String(row.bytes ?? 0)} bytes · ${mediaType || 'unknown'}`,
    color: kind === 'video' ? '#325d42' : kind === 'audio' ? '#53439a' : kind === 'document' ? '#5d5143' : '#245c70',
    ...(typeof row.artifact_id === 'string' && typeof metadata.project_id === 'string' ? { previewUrl: `/api/v1/projects/${encodeURIComponent(metadata.project_id)}/assets/${encodeURIComponent(row.artifact_id)}` } : {}),
    source: metadata.source === 'local-api-upload' ? 'upload' : 'generation',
  };
}

function mapTimelineExport(row: Record<string, unknown>, projectId: string): TimelineExportJob {
  const requestId = String(row.request_id ?? '');
  const phase = String(row.phase ?? 'failed') as TimelineExportJob['phase'];
  const artifactId = typeof row.artifact_id === 'string' ? row.artifact_id : undefined;
  return { requestId, phase, progress: Number(row.progress ?? 0), ...(artifactId ? { artifactId, downloadUrl: `/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(artifactId)}` } : {}), ...(typeof row.error === 'string' ? { error: row.error } : {}) };
}

function mapSource(row: Record<string, unknown>): ReferenceSource {
  return {
    id: String(row.asset_id ?? crypto.randomUUID()),
    name: String(row.relative_path ?? '参考素材'),
    kind: String(row.media_type ?? '').startsWith('audio') ? 'audio' : 'video',
    meta: `${String(row.bytes ?? 0)} bytes · ${String(row.media_type ?? 'unknown')}`,
    genre: '知识类口播',
    status: 'analyzed',
    accent: '#2f5d6b',
    rhythm: [],
    findings: [],
  };
}

function mapJob(row: Record<string, unknown>, kind: 'image' | 'video'): GenerationJob {
  const rawStatus = String(row.status ?? 'queued').toUpperCase();
  const status: GenerationJob['status'] = rawStatus === 'COMPLETED' ? 'succeeded' : rawStatus === 'FAILED' ? 'failed' : rawStatus === 'ADMITTED' ? 'running' : 'queued';
  return {
    id: String(row.intent_id ?? crypto.randomUUID()),
    title: String(row.prompt ?? `${kind === 'video' ? '视频' : '图像'}生成任务`),
    type: kind === 'video' ? '图生视频' : '图像生成',
    status,
    progress: status === 'succeeded' ? 100 : status === 'running' ? 68 : 0,
    createdAt: relativeTime(String(row.created_at ?? new Date().toISOString())),
  };
}

function mapAccount(raw: Record<string, unknown>): AccountEntitlements {
  const entitlements = (raw.entitlements ?? {}) as Record<string, unknown>;
  return {
    accountId: String(raw.account_id ?? 'local-account'),
    plan: raw.plan === 'studio' || raw.plan === 'pro' ? raw.plan : 'free',
    quotaCredits: Number(raw.quota_credits ?? 0),
    watermark: Boolean(raw.watermark),
    subscriptionExpiresAt: typeof raw.subscription_expires_at === 'string' ? raw.subscription_expires_at : null,
    entitlements: {
      max_duration_seconds: Number(entitlements.max_duration_seconds ?? 15),
      preview_quality: String(entitlements.preview_quality ?? '低清预览'),
      watermark: Boolean(entitlements.watermark),
      local_retakes: Number(entitlements.local_retakes ?? 1),
      requires_payment_confirmation: Boolean(entitlements.requires_payment_confirmation ?? true),
    },
  };
}

function agentEventContent(message: Record<string, unknown>): string {
  const raw = String(message.text ?? '').trim();
  if (String(message.role ?? '') !== 'plan' || !raw) return raw;
  try {
    const plan = JSON.parse(raw) as { title?: unknown; direction?: unknown; shots?: Array<{ title?: unknown; visual?: unknown; narration?: unknown; durationSeconds?: unknown }> };
    const sections = [
      typeof plan.title === 'string' ? `创作方案：${plan.title}` : '创作方案',
      typeof plan.direction === 'string' ? plan.direction : '',
    ];
    if (Array.isArray(plan.shots) && plan.shots.length) {
      sections.push(plan.shots.map((shot, index) => {
        const title = typeof shot.title === 'string' ? shot.title : `镜头 ${index + 1}`;
        const duration = typeof shot.durationSeconds === 'number' ? `（${shot.durationSeconds}秒）` : '';
        const details = [typeof shot.visual === 'string' ? shot.visual : '', typeof shot.narration === 'string' && shot.narration ? `旁白：${shot.narration}` : ''].filter(Boolean).join('\n');
        return `${index + 1}. ${title}${duration}${details ? `\n${details}` : ''}`;
      }).join('\n\n'));
    }
    return sections.filter(Boolean).join('\n\n');
  } catch {
    return raw;
  }
}

async function ensureAgentSession(projectId: string, conversationId?: string): Promise<{ id: string; session_revision: number; messages: Array<Record<string, unknown>> }> {
  if (conversationId) return apiFetch(`/agent/sessions/${encodeURIComponent(conversationId)}?project_id=${encodeURIComponent(projectId)}`);
  const sessions = await apiFetch<Array<{ id: string }>>(`/agent/sessions?project_id=${encodeURIComponent(projectId)}`);
  const sessionId = sessions[0]?.id;
  if (sessionId) return apiFetch(`/agent/sessions/${encodeURIComponent(sessionId)}?project_id=${encodeURIComponent(projectId)}`);
  return apiFetch('/agent/sessions', { method: 'POST', body: JSON.stringify({ project_id: projectId, title: '小QTV 项目会话' }) });
}

export function createApiAdapter(fallbackAdapter: AppPorts = storageAdapter): AppPorts {
  const canvases: CanvasPort = {
    list: workspaceId => fallback(apiFetch<ApiProjectRow[]>('/projects').then(rows => Promise.all(rows.filter(row => !workspaceId || row.workspace_id === workspaceId).map(async row => projectSummary(row, await getDetail(row.id))))), () => fallbackAdapter.canvases.list(workspaceId)),
    listArchived: () => fallback(apiFetch<ApiProjectRow[]>('/projects/trash').then(rows => rows.map(row => projectSummary(row))), fallbackAdapter.canvases.listArchived),
    get: id => fallback(getDetail(id).then(detail => projectSummary(detail, detail)), () => demoProject(id)),
    create: input => fallback(sendCommand('project.create', {
      name: input.name,
      workspace_id: input.workspaceId,
      workspace_name: input.workspaceName,
      max_budget_cents: 0,
      rights_confirmed: false,
    }).then(async result => {
      const detail = await getDetail(result.project_id);
      return projectSummary(detail, detail);
    }), () => fallbackAdapter.canvases.create(input)),
    rename: (id, name) => fallback((async () => {
      const detail = await getDetail(id);
      await sendCommand('project.rename', { name }, id, detail.revision);
      const updated = await getDetail(id);
      return projectSummary(updated, updated);
    })(), () => fallbackAdapter.canvases.rename(id, name)),
    trash: id => fallback((async () => {
      const detail = await getDetail(id);
      await sendCommand('project.trash', {}, id, detail.revision);
      const updated = await getDetail(id);
      return projectSummary(updated, updated);
    })(), () => fallbackAdapter.canvases.trash(id)),
    restore: id => fallback((async () => {
      const detail = await getDetail(id);
      await sendCommand('project.restore', {}, id, detail.revision);
      const updated = await getDetail(id);
      return projectSummary(updated, updated);
    })(), () => fallbackAdapter.canvases.restore(id)),
    purge: (id, confirmName) => fallback((async () => {
      const detail = await getDetail(id);
      await sendCommand('project.purge', { confirm_name: confirmName }, id, detail.revision);
    })(), () => fallbackAdapter.canvases.purge(id, confirmName)),
    duplicate: id => fallback((async () => {
      const source = await getDetail(id);
      const targetProjectId = uuid();
      const result = await sendCommand('project.duplicate', { name: source.name + ' · 副本', target_project_id: targetProjectId }, id, source.revision);
      const detail = await getDetail(result.project_id);
      return projectSummary(detail, detail);
    })(), () => fallbackAdapter.canvases.duplicate(id)),
    updateSettings: (id, settings: ProjectSettings) => fallback((async () => {
      const detail = await getDetail(id);
      await sendCommand('film.settings.set', { ...settings }, id, detail.revision);
      const updated = await getDetail(id);
      return projectSummary(updated, updated);
    })(), () => fallbackAdapter.canvases.updateSettings(id, settings)),
  };

  const workspaces: WorkspacePort = {
    list: () => fallback(apiFetch<ApiWorkspaceRow[]>('/workspaces').then(rows => rows.map(workspaceSummary)), fallbackAdapter.workspaces.list),
    listArchived: () => fallback(apiFetch<ApiWorkspaceRow[]>('/workspaces/trash').then(rows => rows.map(workspaceSummary)), fallbackAdapter.workspaces.listArchived),
    get: id => fallback(apiFetch<ApiWorkspaceDetail>(`/workspaces/${encodeURIComponent(id)}`).then(workspaceDetail), () => fallbackAdapter.workspaces.get(id)),
    create: (name = '未命名工作区') => fallback(apiFetch<{ workspace: ApiWorkspaceDetail; project: ApiProjectDetail }>('/workspaces', { method: 'POST', body: JSON.stringify({ name, canvas_name: '画布 1' }) }).then(result => ({ workspace: workspaceDetail(result.workspace), project: projectSummary(result.project, result.project) })), () => fallbackAdapter.workspaces.create(name)),
    rename: (id, name) => fallback(apiFetch<ApiWorkspaceDetail>(`/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }).then(workspaceDetail), () => fallbackAdapter.workspaces.rename(id, name)),
    trash: id => fallback(apiFetch<ApiWorkspaceDetail>(`/workspaces/${encodeURIComponent(id)}/trash`, { method: 'POST', body: '{}' }).then(workspaceDetail), () => fallbackAdapter.workspaces.trash(id)),
    restore: id => fallback(apiFetch<ApiWorkspaceDetail>(`/workspaces/${encodeURIComponent(id)}/restore`, { method: 'POST', body: '{}' }).then(workspaceDetail), () => fallbackAdapter.workspaces.restore(id)),
    purge: (id, confirmName) => fallback(apiFetch<void>(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirm_name: confirmName }) }), () => fallbackAdapter.workspaces.purge(id, confirmName)),
  };

  return {
    account: {
      // 账号端口与其他端口一样接 memoryAdapter 兜底：本地内核未启动（路演、离线）时，
      // /account 请求失败不应让 /create 的账号状态退化为 "Pro / … / 已去除水印"，
      // 而是回到免费体验口径（免费方案 · 少量额度 · 导出带水印）。
      get: () => fallback(apiFetch<Record<string, unknown>>('/account').then(mapAccount), fallbackAdapter.account.get),
      consume: (credits, reason) => fallback(
        apiFetch<Record<string, unknown>>('/account/consume', { method: 'POST', body: JSON.stringify({ credits, reason, confirmation: true }) }).then(mapAccount),
        () => fallbackAdapter.account.consume(credits, reason),
      ),
      confirmPayment: (plan, amountCents) => fallback(
        apiFetch<Record<string, unknown>>('/account/payment/confirm', { method: 'POST', body: JSON.stringify({ plan, amount_cents: amountCents, confirmation: true }) }).then(mapAccount),
        () => fallbackAdapter.account.confirmPayment(plan, amountCents),
      ),
      confirmStripePayment: (sessionId) => fallback(
        apiFetch<Record<string, unknown>>('/account/payment/stripe/confirm', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) }).then(mapAccount),
        () => fallbackAdapter.account.confirmStripePayment(sessionId),
      ),
      startCheckout: async (plan, amountCents, returnUrl) => {
        try {
          const result = await apiFetch<Record<string, unknown>>('/account/payment/stripe/checkout', { method: 'POST', body: JSON.stringify({ plan, amount_cents: amountCents, confirmation: true, return_url: returnUrl }) });
          return { provider: 'stripe', sessionId: String(result.session_id ?? ''), url: String(result.url ?? returnUrl) };
        } catch {
          const result = await fallbackAdapter.account.startCheckout(plan, amountCents, returnUrl);
          return { provider: result.provider === 'stripe' ? 'stripe' : 'local', sessionId: result.sessionId, url: result.url };
        }
      },
    },
    workspaces,
    canvases,
    models: {
      search: async (type, name) => {
        const query = new URLSearchParams({ type, ...(name ? { name } : {}) });
        const result = await apiFetch<{ matches?: Array<{ modelKey: string; modelName: string; description?: string; estimatedTime?: string; supportModality?: string; vip?: boolean; studio?: boolean }> }>(`/canvas/models?${query}`);
        return result.matches ?? [];
      },
      schema: async modelName => {
        const result = await apiFetch<{ schema?: { modelKey?: string; modelName?: string; properties?: Record<string, unknown>; config?: Record<string, unknown>; rules?: unknown[] } }>(`/canvas/models/${encodeURIComponent(modelName)}`);
        if (!result.schema) throw new Error('模型没有返回可用参数 schema');
        return result.schema;
      },
    },
    canvasDocuments: {
      load: async projectId => {
        try {
          const detail = await getDetail(projectId);
          const registeredArtifacts = (detail.derived_artifacts ?? []).flatMap(row => {
            const metadata = row.metadata as Record<string, unknown> | null | undefined;
            if (row.status !== 'PUBLISHED' || metadata?.source !== 'canvas-generation' || typeof row.artifact_id !== 'string' || typeof row.media_type !== 'string' || typeof metadata.node_id !== 'string') return [];
            return [{ artifactId: row.artifact_id, mediaType: row.media_type, nodeId: metadata.node_id, ...(typeof metadata.request_id === 'string' ? { requestId: metadata.request_id } : {}) }];
          });
          return { document: detail.canvas_document?.document ?? null, projectRevision: detail.revision, documentRevision: detail.canvas_document?.document_revision ?? null, registeredArtifacts };
        } catch (error) {
          if (projectId === 'p-demo') return fallbackAdapter.canvasDocuments.load(projectId);
          throw error;
        }
      },
      save: async (projectId, expectedProjectRevision, document) => {
        try {
          const result = await sendCommand('canvas-document.replace', { document }, projectId, expectedProjectRevision);
          return { projectRevision: result.project_revision, documentRevision: Number(result.payload?.document_revision ?? result.project_revision) };
        } catch (error) {
          if (error instanceof Error && error.message.includes('Local API 409')) throw new Error('画布已在其他位置更新，请重新载入。');
          if (projectId === 'p-demo') return fallbackAdapter.canvasDocuments.save(projectId, expectedProjectRevision, document);
          throw error;
        }
      },
    },
    timeline: {
      load: async projectId => {
        try { const detail = await getDetail(projectId); return { document: detail.timeline_document?.document ?? null, projectRevision: detail.revision, documentRevision: detail.timeline_document?.document_revision ?? null }; }
        catch (error) { if (projectId === 'p-demo') return memoryAdapter.timeline.load(projectId); throw error; }
      },
      save: async (projectId, expectedProjectRevision, document) => {
        try { const result = await sendCommand('timeline-document.replace', { document }, projectId, expectedProjectRevision); return { projectRevision: result.project_revision, documentRevision: Number(result.payload?.document_revision ?? result.project_revision) }; }
        catch (error) { if (error instanceof Error && error.message.includes('Local API 409')) throw new Error('时间线已在其他位置更新，请重新载入。'); throw error; }
      },
      startExport: async (projectId, documentRevision, resolution = '1280x720') => { const [width, height] = resolution.split('x').map(Number); const row = await apiFetch<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/timeline-exports`, { method: 'POST', body: JSON.stringify({ request_id: `export-${crypto.randomUUID()}`, document_revision: documentRevision, width, height }) }); return mapTimelineExport(row, projectId); },
      exportStatus: async (projectId, requestId) => mapTimelineExport(await apiFetch<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/timeline-exports/${encodeURIComponent(requestId)}`), projectId),
      cancelExport: async (projectId, requestId) => mapTimelineExport(await apiFetch<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/timeline-exports/${encodeURIComponent(requestId)}`, { method: 'DELETE' }), projectId),
    },
    shots: {
      list: projectId => fallback(getDetail(projectId).then(detail => (detail.shot_fields?.shots ?? []).map(mapShot)), () => fallbackAdapter.shots.list(projectId)),
    },
    media: {
      listAssets: projectId => fallback(getDetail(projectId).then(detail => (detail.derived_artifacts ?? []).map(row => { const asset = mapAsset(row); const stars = detail.asset_ratings?.find(item => item.artifact_id === asset.id)?.stars; return stars ? { ...asset, rating: stars } : asset; })), () => fallbackAdapter.media.listAssets(projectId)),
      upload: (projectId, file, onProgress, signal) => new Promise<Asset>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/projects/${encodeURIComponent(projectId)}/uploads`);
        xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
        xhr.setRequestHeader('x-file-name', file.name);
        if (signal?.aborted) { reject(new DOMException('素材上传已取消。', 'AbortError')); return; }
        signal?.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.upload.addEventListener('progress', event => { if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100)); });
        xhr.addEventListener('error', () => reject(new Error('无法连接本地 API，素材上传失败。')));
        xhr.addEventListener('abort', () => reject(new Error('素材上传已取消。')));
        xhr.addEventListener('load', () => {
          if (xhr.status !== 201) { reject(new Error(`素材上传失败（${xhr.status}）：${xhr.responseText.slice(0, 300)}`)); return; }
          try {
            const row = JSON.parse(xhr.responseText) as Record<string, unknown>;
            resolve(mapAsset({ ...row, metadata: { source: 'local-api-upload', project_id: projectId, file_name: row.file_name } }));
          } catch { reject(new Error('素材上传响应无法解析。')); }
        });
        xhr.send(file);
      }),
      rate: async (projectId, artifactId, stars) => { const detail = await getDetail(projectId); await sendCommand('asset.rate', { artifact_id: artifactId, stars }, projectId, detail.revision); },
      remove: async (projectId, artifactId) => { const detail = await getDetail(projectId); await apiFetch(`/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(artifactId)}`, { method: 'DELETE', body: JSON.stringify({ expected_revision: detail.revision }) }); },
    },
    source: {
      list: projectId => fallback(getDetail(projectId).then(detail => (detail.sources ?? []).map(mapSource)), () => fallbackAdapter.source.list(projectId)),
      create: async (projectId, name, genre) => {
        const detail = await getDetail(projectId);
        const hash = await sha256Hex(`${projectId}:${name}:${genre}`);
        const relativePath = `references/${encodeURIComponent(name).slice(0, 80) || 'reference'}-${hash.slice(0, 12)}.mp4`;
        await sendCommand('source.register', {
          relative_path: relativePath,
          content_hash: `sha256:${hash}`,
          bytes: 1024,
          media_type: 'video/mp4',
        }, projectId, detail.revision);
        const updated = await getDetail(projectId);
        const source = (updated.sources ?? []).map(mapSource).find(item => item.name === relativePath);
        if (source) return source;
        return mapSource({ asset_id: uuid(), relative_path: relativePath, bytes: 1024, media_type: 'video/mp4' });
      },
    },
    generation: {
      listJobs: projectId => fallback(getDetail(projectId).then(detail => [
        ...(detail.image_generations ?? []).map(row => mapJob(row, 'image')),
        ...(detail.video_generations ?? []).map(row => mapJob(row, 'video')),
      ]), () => fallbackAdapter.generation.listJobs(projectId)),
      create: async (projectId, title, type, options) => {
        const isVideo = type.includes('视频') || type.toLowerCase().includes('video');
        if (!options?.model?.trim()) throw new Error('请选择一个真实模型后再生成。');
        const requestId = options?.requestId ?? uuid();
        options?.onStarted?.(requestId);
        const response = await apiFetch<{ request_id: string; status: 'completed'; assets: Array<{ artifact_id: string; media_type: string; bytes: number; file_name: string; url: string }>; notes: string[]; cost: { amount: number; unit: 'credit' | 'cent' } | null }>(`/canvas/projects/${encodeURIComponent(projectId)}/generations`, {
          method: 'POST', body: JSON.stringify({ request_id: requestId, node_id: options.nodeId && /^[A-Za-z0-9_-]{1,160}$/.test(options.nodeId) ? options.nodeId : `web-${requestId}`, kind: isVideo ? 'video' : 'image', model: options.model.trim(), prompt: title, ratio: options.ratio, mode_type: options.modeType, settings: options.settings ?? {}, reference_artifact_ids: options.referenceIds ?? [], rights_confirmed: options.rightsConfirmed === true, confirm_costs: options.confirmCosts === true }),
        });
        const mappedAssets = response.assets.map(media => { const kind: Asset['kind'] = media.media_type.startsWith('video/') ? 'video' : media.media_type.startsWith('audio/') ? 'audio' : 'image'; return { id: media.artifact_id, name: media.file_name, kind, meta: `${media.bytes} bytes · ${media.media_type}`, color: kind === 'video' ? '#325d42' : kind === 'audio' ? '#53439a' : '#245c70', previewUrl: media.url, source: 'generation' as const }; });
        const media = mappedAssets[0]; if (!media) throw new Error('真实生成已结束，但没有返回可用产物。');
        return { id: response.request_id, title, type, status: 'succeeded', progress: 100, createdAt: '刚刚', notes: response.notes, cost: response.cost, asset: media, assets: mappedAssets };
      },
      status: async (projectId, requestId) => {
        const row = await apiFetch<{ request_id: string; phase: 'accepted' | 'provider_started' | 'provider_finished' | 'completed' | 'failed' | 'unknown'; node_id?: string; error?: string; result?: { assets?: Array<{ artifact_id: string; media_type: string; bytes: number; file_name: string; url: string }>; notes?: string[]; cost?: { amount: number; unit: 'credit' | 'cent' } | null } }>(`/canvas/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(requestId)}`);
        const assets = (row.result?.assets ?? []).map(media => { const kind: Asset['kind'] = media.media_type.startsWith('video/') ? 'video' : media.media_type.startsWith('audio/') ? 'audio' : 'image'; return { id: media.artifact_id, name: media.file_name, kind, meta: `${media.bytes} bytes · ${media.media_type}`, color: kind === 'video' ? '#325d42' : kind === 'audio' ? '#53439a' : '#245c70', previewUrl: media.url, source: 'generation' as const }; });
        const first = assets[0]; const job = first ? { id: row.request_id, title: '恢复的真实生成', type: first.kind, status: 'succeeded' as const, progress: 100, createdAt: '刚刚', ...(row.result?.notes ? { notes: row.result.notes } : {}), cost: row.result?.cost ?? null, asset: first, assets } : undefined;
        return { requestId: row.request_id, phase: row.phase, ...(row.node_id ? { nodeId: row.node_id } : {}), ...(row.error ? { error: row.error } : {}), ...(job ? { job } : {}) };
      },
    },
    agent: {
      listConversations: projectId => apiFetch<Array<{ id: string; title: string; updatedAt: number; messageCount: number }>>(`/agent/sessions?project_id=${encodeURIComponent(projectId)}`),
      createConversation: async projectId => (await apiFetch<{ id: string }>('/agent/sessions', { method: 'POST', body: JSON.stringify({ project_id: projectId, title: '小QTV 创作对话' }) })).id,
      listMessages: async (projectId, conversationId) => {
        try {
          const session = await ensureAgentSession(projectId, conversationId);
          return (session.messages ?? []).filter(message => ['user', 'agent', 'plan'].includes(String(message.role ?? ''))).map(message => ({ id: String(message.id ?? crypto.randomUUID()), role: String(message.role) === 'user' ? 'user' as const : 'agent' as const, content: agentEventContent(message), createdAt: '刚刚', ...(message.skillRef && typeof message.skillRef === 'object' && typeof (message.skillRef as { id?: unknown }).id === 'string' && typeof (message.skillRef as { version?: unknown }).version === 'string' ? { skillRef: message.skillRef as { id: string; version: string; name?: string } } : {}) }));
        } catch (error) {
          if (projectId === 'p-demo') return fallbackAdapter.agent.listMessages(projectId);
          throw error;
        }
      },
      send: async (projectId, content, options) => {
        const session = await ensureAgentSession(projectId, options?.conversationId);
        const messageId = uuid();
        const after = session.session_revision;
        const started = await apiFetch<{ run_id: string | null }>(`/agent/sessions/${encodeURIComponent(session.id)}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            project_id: projectId,
            message_id: messageId,
            text: content,
            expected_session_revision: session.session_revision,
            references: options?.references ?? [],
            mode: 'creative',
            ...(options?.skillRef ? { skill_ref: options.skillRef } : {}),
            ...(options?.model ? { model: options.model } : {}),
          }),
        });
        if (started.run_id) options?.onStarted?.(started.run_id);
        // POST 只确认任务入队；DSH 还会解析 Skill 与项目上下文，创作规划可能需要数十秒。
        let cursor = after; const replies: AgentMessage[] = []; const seen = new Set<string>();
        for (let attempt = 0; attempt < 1200; attempt += 1) {
          const update = await apiFetch<{ events: Array<{ id?: string; role?: string; text?: string }>; next_cursor: number; done: boolean }>(`/agent/sessions/${encodeURIComponent(session.id)}/events?project_id=${encodeURIComponent(projectId)}&after=${cursor}&limit=100`);
          cursor = Math.max(cursor, Number(update.next_cursor ?? cursor));
          for (const event of update.events ?? []) { const text = agentEventContent(event); const id = String(event.id ?? `${cursor}-${replies.length}`); if (!['agent', 'plan'].includes(String(event.role ?? '')) || !text || seen.has(id)) continue; seen.add(id); const message = { id, role: 'agent' as const, content: text, createdAt: '刚刚' }; replies.push(message); options?.onDelta?.(message); }
          if (update.done) { if (replies.length) return { id: replies[replies.length - 1]!.id, role: 'agent' as const, content: replies.map(item => item.content).join('\n\n'), createdAt: '刚刚' }; break; }
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        throw new Error('Agent 已提交，但暂未收到完整回复，请点击历史对话刷新。');
      },
      cancel: async (projectId, runId, conversationId) => {
        const session = await ensureAgentSession(projectId, conversationId);
        await apiFetch(`/agent/sessions/${encodeURIComponent(session.id)}/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: JSON.stringify({ project_id: projectId }) });
      },
    },
  };
}

export const apiAdapter = createApiAdapter();


