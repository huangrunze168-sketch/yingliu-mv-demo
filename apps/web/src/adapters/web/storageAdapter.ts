import type { AppPorts, Asset, CanvasDocumentPort, GenerationJob, GenerationPort, MediaPort, PersistedCanvasDocument, ProjectCreateInput, ProjectPort, ProjectSummary, ReferenceSource, Shot, ShotPort, SourcePort, WorkspaceDetail, WorkspacePort, WorkspaceSummary } from '../../ports/index.js';
import { memoryAdapter } from './memoryAdapter.js';

/**
 * localStorage 持久化适配器：包装 memoryAdapter，项目数据刷新不丢。
 * 首次运行从 memoryAdapter 播种演示数据，此后每次变更落盘 qiyin.projects.v1。
 * 存储配额满等异常静默降级为内存态，不影响交互。
 */
const STORAGE_KEY = 'qiyin.projects.v1';

let projects: ProjectSummary[] | null = null;

function readStore(): ProjectSummary[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as ProjectSummary[] | null;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function hydrate(): Promise<ProjectSummary[]> {
  if (projects) return projects;
  const stored = readStore();
  if (stored) {
    projects = stored.map(project => ({ ...project, workspaceId: project.workspaceId || `legacy-${project.id}` }));
    persist();
    return projects;
  }
  const [active, archived] = await Promise.all([memoryAdapter.canvases.list(), memoryAdapter.canvases.listArchived()]);
  projects = [...active, ...archived];
  persist();
  return projects;
}

function persist(): void {
  if (typeof window === 'undefined' || !projects) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch {
    /* 降级为内存态 */
  }
}

const SHOTS_KEY = 'qiyin.shots.v1';
let shotsStore: Record<string, Shot[]> | null = null;

function readShots(): Record<string, Shot[]> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SHOTS_KEY) ?? 'null') as Record<string, Shot[]> | null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistShots(): void {
  if (typeof window === 'undefined' || !shotsStore) return;
  try {
    window.localStorage.setItem(SHOTS_KEY, JSON.stringify(shotsStore));
  } catch {
    /* 降级为内存态 */
  }
}

/** 按项目确定性生成分镜种子：同一项目永远同一组，避免所有项目共用演示镜头。 */
async function seedShots(projectId: string): Promise<Shot[]> {
  if (projectId === 'p-demo') return memoryAdapter.shots.list(projectId);
  let hash = 0;
  for (let i = 0; i < projectId.length; i += 1) hash = (hash * 31 + projectId.charCodeAt(i)) >>> 0;
  const rand = (n: number) => ((hash >> ((n % 8) * 3)) % 100) / 100;
  const scenes = ['外景 / 城市街头', '内景 / 工作室', '外景 / 自然光', '内景 / 走廊', '外景 / 黄昏天台'];
  const statuses = ['draft', 'ready', 'approved'] as const;
  const count = 3 + Math.round(rand(1) * 3);
  const list = Array.from({ length: count }, (_, i) => ({
    id: projectId + '-s' + (i + 1),
    title: '0' + (i + 1) + ' · 镜头 ' + (i + 1),
    scene: scenes[(i + Math.floor(rand(i + 2) * 5)) % scenes.length],
    status: statuses[(i + Math.floor(rand(i + 3) * 3)) % statuses.length],
    duration: '00:0' + (1 + (i % 6)),
    prompt: '由项目方向生成的初始分镜提示词，可在分镜面板细化。',
  }));
  return list as Shot[];
}

const shotPort: ShotPort = {
  list: async projectId => {
    if (!shotsStore) shotsStore = readShots();
    if (!shotsStore[projectId]) {
      shotsStore[projectId] = await seedShots(projectId);
      persistShots();
    }
    return shotsStore[projectId];
  },
};

const canvasPort: ProjectPort = {
  list: async workspaceId => (await hydrate()).filter(project => project.status === 'active' && (!workspaceId || project.workspaceId === workspaceId)),
  listArchived: async () => (await hydrate()).filter(project => project.status === 'archived'),
  get: async id => (await hydrate()).find(project => project.id === id),
  create: async (input: ProjectCreateInput) => {
    const spaces = await hydrateWorkspaces();
    const workspaceId = input.workspaceId ?? `w-${crypto.randomUUID()}`;
    const created: ProjectSummary = { id: `p-${crypto.randomUUID()}`, workspaceId, name: input.name, description: input.description, updatedAt: '刚刚', status: 'active', shots: 0, assets: 0, progress: 0, revision: 1, state: 'EMPTY', maxBudgetCents: input.maxBudgetCents ?? 0, rightsConfirmed: input.rightsConfirmed ?? false };
    (await hydrate()).unshift(created);
    const workspace = spaces.find(item => item.id === workspaceId);
    if (workspace) { workspace.canvasCount += 1; workspace.updatedAt = '刚刚'; workspace.revision += 1; }
    else spaces.unshift({ id: workspaceId, name: input.workspaceName ?? input.name, description: '新工作区 · 1 张画布', updatedAt: '刚刚', status: 'active', revision: 1, canvasCount: 1, primaryProjectId: created.id, shots: 0, assets: 0, progress: 0, state: 'EMPTY', maxBudgetCents: 0, rightsConfirmed: false });
    persistWorkspaces();
    persist();
    return created;
  },
  rename: async (id, name) => {
    const project = (await hydrate()).find(item => item.id === id);
    if (!project) throw new Error('项目不存在');
    project.name = name.trim();
    project.updatedAt = '刚刚';
    project.revision += 1;
    persist();
    return project;
  },
  trash: async id => {
    const project = (await hydrate()).find(item => item.id === id);
    if (!project) throw new Error('项目不存在');
    project.status = 'archived';
    project.state = 'ARCHIVED';
    project.updatedAt = '刚刚';
    project.revision += 1;
    persist();
    return project;
  },
  restore: async id => {
    const project = (await hydrate()).find(item => item.id === id);
    if (!project) throw new Error('项目不存在');
    project.status = 'active';
    project.state = 'PRODUCTION';
    project.updatedAt = '刚刚';
    project.revision += 1;
    persist();
    return project;
  },
  purge: async id => {
    const all = await hydrate();
    const index = all.findIndex(item => item.id === id);
    if (index >= 0) all.splice(index, 1);
    persist();
  },
  duplicate: async id => {
    const source = (await hydrate()).find(item => item.id === id);
    if (!source) throw new Error('项目不存在');
    const copy: ProjectSummary = { ...source, id: 'p-' + Date.now(), name: source.name + ' · 副本', updatedAt: '刚刚', status: 'active', state: 'EMPTY', shots: 0, assets: 0, progress: 0, revision: 1, rightsConfirmed: false };
    (await hydrate()).unshift(copy);
    persist();
    return copy;
  },
  updateSettings: async id => {
    const project = (await hydrate()).find(item => item.id === id);
    if (!project) throw new Error('项目不存在');
    project.updatedAt = '刚刚';
    project.revision += 1;
    persist();
    return project;
  },
};

const WORKSPACES_KEY = 'qiyin.workspaces.v1';
let workspaceStore: WorkspaceSummary[] | null = null;
async function hydrateWorkspaces(): Promise<WorkspaceSummary[]> {
  if (workspaceStore) return workspaceStore;
  if (typeof window !== 'undefined') {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(WORKSPACES_KEY) ?? 'null') as WorkspaceSummary[] | null;
      if (Array.isArray(parsed)) { workspaceStore = parsed; return workspaceStore; }
    } catch { /* 使用演示数据播种 */ }
  }
  const canvases = await hydrate();
  const [seedActive, seedArchived] = await Promise.all([memoryAdapter.workspaces.list(), memoryAdapter.workspaces.listArchived()]);
  const seeds = new Map([...seedActive, ...seedArchived].map(workspace => [workspace.id, workspace]));
  const grouped = new Map<string, ProjectSummary[]>();
  for (const canvas of canvases) grouped.set(canvas.workspaceId, [...(grouped.get(canvas.workspaceId) ?? []), canvas]);
  workspaceStore = [...grouped.entries()].map(([id, items]) => {
    const seed = seeds.get(id);
    const primary = items[0]!;
    return seed ?? { id, name: primary.name, description: `${items.length} 张画布`, updatedAt: primary.updatedAt, status: primary.status, revision: primary.revision, canvasCount: items.length, primaryProjectId: primary.id, shots: items.reduce((sum, canvas) => sum + canvas.shots, 0), assets: items.reduce((sum, canvas) => sum + canvas.assets, 0), progress: primary.progress, state: primary.state, maxBudgetCents: primary.maxBudgetCents, rightsConfirmed: primary.rightsConfirmed };
  });
  persistWorkspaces();
  return workspaceStore;
}
function persistWorkspaces(): void {
  if (typeof window === 'undefined' || !workspaceStore) return;
  try { window.localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaceStore)); } catch { /* 降级为内存态 */ }
}
async function workspaceDetail(workspace: WorkspaceSummary): Promise<WorkspaceDetail> {
  return { ...workspace, canvases: (await hydrate()).filter(canvas => canvas.workspaceId === workspace.id) };
}
const workspacePort: WorkspacePort = {
  list: async () => (await hydrateWorkspaces()).filter(item => item.status === 'active'),
  listArchived: async () => (await hydrateWorkspaces()).filter(item => item.status === 'archived'),
  get: async id => { const item = (await hydrateWorkspaces()).find(workspace => workspace.id === id); return item ? workspaceDetail(item) : undefined; },
  create: async (name = '未命名工作区') => {
    const stamp = Date.now();
    const workspace: WorkspaceSummary = { id: `w-${stamp}`, name, description: '新工作区 · 1 张画布', updatedAt: '刚刚', status: 'active', revision: 1, canvasCount: 1, primaryProjectId: `p-${stamp}`, shots: 0, assets: 0, progress: 0, state: 'EMPTY', maxBudgetCents: 0, rightsConfirmed: false };
    const project: ProjectSummary = { id: `p-${stamp}`, workspaceId: workspace.id, name: '画布 1', description: '', updatedAt: '刚刚', status: 'active', shots: 0, assets: 0, progress: 0, revision: 1, state: 'EMPTY', maxBudgetCents: 0, rightsConfirmed: false };
    (await hydrateWorkspaces()).unshift(workspace); (await hydrate()).unshift(project); persistWorkspaces(); persist();
    return { workspace: await workspaceDetail(workspace), project };
  },
  rename: async (id, name) => { const item = (await hydrateWorkspaces()).find(workspace => workspace.id === id); if (!item) throw new Error('工作区不存在'); item.name = name.trim(); item.revision += 1; item.updatedAt = '刚刚'; persistWorkspaces(); return workspaceDetail(item); },
  trash: async id => { const item = (await hydrateWorkspaces()).find(workspace => workspace.id === id); if (!item) throw new Error('工作区不存在'); item.status = 'archived'; item.revision += 1; item.updatedAt = '刚刚'; (await hydrate()).filter(canvas => canvas.workspaceId === id).forEach(canvas => { canvas.status = 'archived'; }); persistWorkspaces(); persist(); return workspaceDetail(item); },
  restore: async id => { const item = (await hydrateWorkspaces()).find(workspace => workspace.id === id); if (!item) throw new Error('工作区不存在'); item.status = 'active'; item.revision += 1; item.updatedAt = '刚刚'; (await hydrate()).filter(canvas => canvas.workspaceId === id).forEach(canvas => { canvas.status = 'active'; }); persistWorkspaces(); persist(); return workspaceDetail(item); },
  purge: async id => { const spaces = await hydrateWorkspaces(); const index = spaces.findIndex(item => item.id === id); if (index >= 0) spaces.splice(index, 1); projects = (await hydrate()).filter(canvas => canvas.workspaceId !== id); persistWorkspaces(); persist(); },
};

/* ---- assets / sources / jobs：与 shots 同款的按项目键控持久化 ---- */
const ASSETS_KEY = 'qiyin.assets.v1';
const SOURCES_KEY = 'qiyin.sources.v1';
const JOBS_KEY = 'qiyin.jobs.v1';
let assetsStore: Record<string, Asset[]> | null = null;
let sourcesStore: Record<string, ReferenceSource[]> | null = null;
let jobsStore: Record<string, GenerationJob[]> | null = null;

function readBuckets<T>(key: string): Record<string, T[]> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Record<string, T[]> | null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeBuckets<T>(key: string, store: Record<string, T[]>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(store));
  } catch {
    /* 降级为内存态 */
  }
}

function hashOf(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}

function seedAssets(projectId: string): Asset[] {
  const rand = (n: number) => ((hashOf(projectId) >> ((n % 8) * 3)) % 100) / 100;
  const kinds: Array<Asset['kind']> = ['image', 'audio', 'video'];
  const colors = ['#245c70', '#7c4d3b', '#53439a', '#325d42'];
  const names = ['参考帧序列', '角色一致性套图', '氛围音轨', '运镜测试片段'];
  const count = 2 + Math.round(rand(1) * 3);
  const list = Array.from({ length: count }, (_, i) => ({
    id: projectId + '-a' + (i + 1),
    name: names[i % names.length],
    kind: kinds[(i + Math.floor(rand(i + 2) * 3)) % 3],
    meta: kinds[(i + 1) % 3] === 'audio' ? '00:' + (10 + i * 7) + ' · WAV' : '1920 × 1080 · ' + (kinds[(i + 1) % 3] === 'video' ? 'MP4' : 'JPG'),
    color: colors[(i + Math.floor(rand(i + 4) * 4)) % 4],
  }));
  return list as Asset[];
}

function seedSources(projectId: string): ReferenceSource[] {
  const rand = (n: number) => ((hashOf(projectId + ':src') >> ((n % 8) * 3)) % 100) / 100;
  const genres = ['知识类口播', '产品广告', '情绪化剧情片', '系列内容'];
  const accents = ['#2f5d6b', '#7c4d3b', '#245c70', '#3f5a3a'];
  const genreIndex = Math.floor(rand(1) * genres.length);
  const rhythm = Array.from({ length: 4 + Math.floor(rand(2) * 4) }, (_, i) => Math.round((1.5 + rand(i + 3) * 2.5) * 10) / 10);
  const findings = [
    { key: 'shotScale', label: '景别结构', value: '中景为主', score: 30 + Math.round(rand(4) * 60) },
    { key: 'composition', label: '构图倾向', value: rand(5) > 0.5 ? '三分法 · 高对比' : '中心构图 + 留白', score: 30 + Math.round(rand(6) * 60) },
    { key: 'emotion', label: '情绪曲线', value: '低位起 · 中段抬升', score: 30 + Math.round(rand(7) * 60) },
  ];
  const list = [{
    id: projectId + '-r1',
    name: '首轮参考 · 自动读入',
    kind: 'video' as const,
    meta: '刚刚读入 · 规格待补',
    genre: genres[genreIndex],
    status: 'analyzed' as const,
    accent: accents[genreIndex],
    rhythm,
    findings,
  }];
  return list as ReferenceSource[];
}

function seedJobs(projectId: string): GenerationJob[] {
  const rand = (n: number) => ((hashOf(projectId + ':job') >> ((n % 8) * 3)) % 100) / 100;
  const list: GenerationJob[] = [
    { id: projectId + '-j1', title: '首镜 · 候选首帧', type: '图像生成', status: 'succeeded', progress: 100, createdAt: '昨天' },
  ];
  if (rand(1) > 0.4) {
    list.push({ id: projectId + '-j2', title: '次镜 · 图生视频', type: '图生视频', status: 'running', progress: 20 + Math.round(rand(2) * 60), createdAt: '2 分钟前' });
  }
  return list;
}

const mediaPort: MediaPort = {
  listAssets: async projectId => {
    if (!assetsStore) assetsStore = readBuckets(ASSETS_KEY);
    if (!assetsStore[projectId]) {
      assetsStore[projectId] = projectId === 'p-demo' ? await memoryAdapter.media.listAssets(projectId) : seedAssets(projectId);
      writeBuckets(ASSETS_KEY, assetsStore);
    }
    return assetsStore[projectId];
  },
  upload: () => Promise.reject(new Error('本地 API 未连接，无法上传真实素材。')),
  rate: async (projectId, artifactId, stars) => { if (!assetsStore) assetsStore = readBuckets(ASSETS_KEY); const asset = assetsStore[projectId]?.find(item => item.id === artifactId); if (asset) { if (stars) asset.rating = stars; else delete asset.rating; writeBuckets(ASSETS_KEY, assetsStore); } },
  remove: async (projectId, artifactId) => { if (!assetsStore) assetsStore = readBuckets(ASSETS_KEY); assetsStore[projectId] = (assetsStore[projectId] ?? []).filter(item => item.id !== artifactId); writeBuckets(ASSETS_KEY, assetsStore); },
};

const sourcePort: SourcePort = {
  list: async projectId => {
    if (!sourcesStore) sourcesStore = readBuckets(SOURCES_KEY);
    if (!sourcesStore[projectId]) {
      sourcesStore[projectId] = projectId === 'p-demo' ? await memoryAdapter.source.list(projectId) : seedSources(projectId);
      writeBuckets(SOURCES_KEY, sourcesStore);
    }
    return sourcesStore[projectId];
  },
  create: async (projectId, name, genre) => {
    if (!sourcesStore) sourcesStore = readBuckets(SOURCES_KEY);
    if (!sourcesStore[projectId]) sourcesStore[projectId] = await seedSources(projectId);
    const created = await memoryAdapter.source.create(projectId, name, genre);
    sourcesStore[projectId] = [created, ...sourcesStore[projectId]];
    writeBuckets(SOURCES_KEY, sourcesStore);
    return created;
  },
};

const canvasDocumentPort: CanvasDocumentPort = {
  load: async projectId => {
    const project = (await hydrate()).find(item => item.id === projectId);
    if (!project) throw new Error('项目不存在');
    let document: PersistedCanvasDocument | null = null;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(`qiyin.canvas.v2.${projectId}`) ?? 'null') as PersistedCanvasDocument | null;
      if (parsed?.version === 2 && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) document = parsed;
    } catch { /* 损坏的恢复草稿不覆盖项目 */ }
    return { document, projectRevision: project.revision, documentRevision: document ? project.revision : null };
  },
  save: async (projectId, expectedProjectRevision, document) => {
    const project = (await hydrate()).find(item => item.id === projectId);
    if (!project) throw new Error('项目不存在');
    if (project.revision !== expectedProjectRevision) throw new Error('画布已在其他位置更新，请重新载入。');
    try { window.localStorage.setItem(`qiyin.canvas.v2.${projectId}`, JSON.stringify(document)); }
    catch { throw new Error('本地空间不足，画布尚未保存。'); }
    project.revision += 1;
    project.updatedAt = '刚刚';
    persist();
    return { projectRevision: project.revision, documentRevision: project.revision };
  },
};

const generationPort: GenerationPort = {
  listJobs: async projectId => {
    if (!jobsStore) jobsStore = readBuckets(JOBS_KEY);
    if (!jobsStore[projectId]) {
      jobsStore[projectId] = projectId === 'p-demo' ? await memoryAdapter.generation.listJobs(projectId) : seedJobs(projectId);
      writeBuckets(JOBS_KEY, jobsStore);
    }
    return jobsStore[projectId];
  },
  create: async (projectId, title, type) => {
    if (!jobsStore) jobsStore = readBuckets(JOBS_KEY);
    if (!jobsStore[projectId]) jobsStore[projectId] = await seedJobs(projectId);
    const job: GenerationJob = { id: projectId + '-j-' + Date.now(), title, type, status: 'queued', progress: 0, createdAt: '刚刚' };
    jobsStore[projectId] = [job, ...jobsStore[projectId]];
    writeBuckets(JOBS_KEY, jobsStore);
    return job;
  },
  status: () => Promise.reject(new Error('本地 API 未连接，无法核查真实生成任务。')),
};

export const storageAdapter: AppPorts = {
  ...memoryAdapter,
  workspaces: workspacePort,
  canvases: canvasPort,
  canvasDocuments: canvasDocumentPort,
  shots: shotPort,
  media: mediaPort,
  source: sourcePort,
  generation: generationPort,
};
