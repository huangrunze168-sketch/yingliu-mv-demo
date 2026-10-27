import type { AccountEntitlements, AppPorts, AgentMessage, Asset, GenerationJob, PersistedCanvasDocument, TimelineDocument, ProjectPort, ProjectSummary, ReferenceSource, Shot, SourceFinding, WorkspaceDetail, WorkspaceSummary } from '../../ports/index.js';

const projects: ProjectSummary[] = [
  { id: 'p-demo', workspaceId: 'w-demo', name: '画布 1', description: '一支 60 秒城市悬疑短片', updatedAt: '刚刚', status: 'active', shots: 12, assets: 28, progress: 68, revision: 4, state: 'PRODUCTION', maxBudgetCents: 2000, rightsConfirmed: true },
  { id: 'p-brand', workspaceId: 'w-brand', name: '画布 1', description: '产品视觉与社媒切片', updatedAt: '昨天', status: 'active', shots: 8, assets: 16, progress: 34, revision: 2, state: 'PRODUCTION', maxBudgetCents: 1200, rightsConfirmed: true },
  { id: 'p-archive', workspaceId: 'w-archive', name: '画布 1', description: '已归档的概念验证项目', updatedAt: '2026-08-18', status: 'archived', shots: 24, assets: 53, progress: 100, revision: 12, state: 'ARCHIVED', maxBudgetCents: 3000, rightsConfirmed: true },
];
const workspaces: WorkspaceSummary[] = [
  { id: 'w-demo', name: '雨夜追踪 · Demo', description: '一支 60 秒城市悬疑短片', updatedAt: '刚刚', status: 'active', revision: 4, canvasCount: 1, primaryProjectId: 'p-demo', shots: 12, assets: 28, progress: 68, state: 'PRODUCTION', maxBudgetCents: 2000, rightsConfirmed: true },
  { id: 'w-brand', name: '品牌片 2026', description: '产品视觉与社媒切片', updatedAt: '昨天', status: 'active', revision: 2, canvasCount: 1, primaryProjectId: 'p-brand', shots: 8, assets: 16, progress: 34, state: 'PRODUCTION', maxBudgetCents: 1200, rightsConfirmed: true },
  { id: 'w-archive', name: '山海志先导片', description: '已归档的概念验证项目', updatedAt: '2026-08-18', status: 'archived', revision: 12, canvasCount: 1, primaryProjectId: 'p-archive', shots: 24, assets: 53, progress: 100, state: 'ARCHIVED', maxBudgetCents: 3000, rightsConfirmed: true },
];
const workspaceDetail = (workspace: WorkspaceSummary): WorkspaceDetail => ({ ...workspace, canvases: projects.filter(project => project.workspaceId === workspace.id) });
const shots: Shot[] = [
  { id: 's1', title: '01 · 霓虹下的脚步', scene: '外景 / 雨夜街道', status: 'approved', duration: '00:05', prompt: '湿润柏油路上的霓虹倒影，手持跟拍，35mm' },
  { id: 's2', title: '02 · 橱窗倒影', scene: '外景 / 商业街', status: 'ready', duration: '00:04', prompt: '人物掠过橱窗，倒影中出现第二个身影' },
  { id: 's3', title: '03 · 楼梯间', scene: '内景 / 老楼', status: 'draft', duration: '00:06', prompt: '狭窄楼梯间，顶部冷光，镜头缓慢推进' },
];
const assets: Asset[] = [
  { id: 'a1', name: '雨夜街道参考', kind: 'image', meta: '2048 × 1152 · JPG', color: '#245c70' },
  { id: 'a2', name: '主角 · 林', kind: 'image', meta: '角色一致性 · 12 张', color: '#7c4d3b' },
  { id: 'a3', name: '城市氛围音', kind: 'audio', meta: '00:48 · WAV', color: '#53439a' },
  { id: 'a4', name: '镜头运动测试', kind: 'video', meta: '00:06 · MP4', color: '#325d42' },
];
let jobs: GenerationJob[] = [{ id: 'j1', title: '02 · 橱窗倒影 · 候选首帧', type: '图像生成', status: 'running', progress: 72, createdAt: '2 分钟前' }, { id: 'j2', title: '01 · 霓虹下的脚步 · 视频', type: '图生视频', status: 'succeeded', progress: 100, createdAt: '昨天' }];

/**
 * 创作类型 → 风格档案。
 * 让「创作类型」这组标签不只是装饰：选中哪个类型，新增的参考片就按对应口径产出分析结论。
 * 注意 findings 里**没有**「镜头节奏」——那一项由 rhythm 推导（见 domain/sourceAnalysis.ts）。
 */
interface GenreProfile { accent: string; rhythm: number[]; findings: SourceFinding[]; }

const profileSpoken: GenreProfile = {
  accent: '#2f5d6b',
  rhythm: [3.4, 3.9, 3.2, 4.1, 3.6],
  findings: [
    { key: 'shotScale', label: '景别结构', value: '中景固定为主', score: 34 },
    { key: 'composition', label: '构图倾向', value: '中轴对称 · 大面积负空间', score: 46 },
    { key: 'emotion', label: '情绪曲线', value: '平推 · 无起伏', score: 28 },
  ],
};
const profileAd: GenreProfile = {
  accent: '#7c4d3b',
  rhythm: [1.2, 1.4, 1.1, 1.6, 1.3, 1.0, 1.5, 1.2, 1.3, 1.4, 1.0],
  findings: [
    { key: 'shotScale', label: '景别结构', value: '特写 + 微距为主', score: 86 },
    { key: 'composition', label: '构图倾向', value: '三分法 · 高对比', score: 63 },
    { key: 'emotion', label: '情绪曲线', value: '高位平推 · 无回落', score: 88 },
  ],
};
const profileDrama: GenreProfile = {
  accent: '#245c70',
  rhythm: [2.6, 1.8, 3.1, 2.2, 2.7, 1.9],
  findings: [
    { key: 'shotScale', label: '景别结构', value: '中近景为主', score: 52 },
    { key: 'composition', label: '构图倾向', value: '中心构图 + 大量留白', score: 74 },
    { key: 'emotion', label: '情绪曲线', value: '低起 · 中段抬升 · 收在静', score: 41 },
  ],
};
const profileSeries: GenreProfile = {
  accent: '#3f5a3a',
  rhythm: [2.0, 2.2, 2.0, 2.1, 2.3, 2.0],
  findings: [
    { key: 'shotScale', label: '景别结构', value: '同构机位 · 统一景别', score: 58 },
    { key: 'composition', label: '构图倾向', value: '固定模板位', score: 82 },
    { key: 'emotion', label: '情绪曲线', value: '每集同强度 · 低方差', score: 36 },
  ],
};

const genreProfiles: Record<string, GenreProfile> = {
  '知识类口播': profileSpoken,
  '产品广告': profileAd,
  '情绪化剧情片': profileDrama,
  '系列内容': profileSeries,
};

const sources: ReferenceSource[] = [
  { id: 'r1', name: '城市夜景混剪 · 参考', kind: 'video', meta: '00:48 · 1920×1080 · 24fps', genre: '情绪化剧情片', status: 'analyzed', ...profileDrama },
  { id: 'r2', name: '产品特写 · 15 秒', kind: 'video', meta: '00:15 · 3840×2160 · 30fps', genre: '产品广告', status: 'analyzed', ...profileAd },
  /* 分析中：findings 与 rhythm 都还是空的，界面据空数组渲染「进行中」状态，
     不用「待生成」这类假文案占位。 */
  { id: 'r3', name: '氛围音乐 · 48 秒', kind: 'audio', meta: '00:48 · WAV · 48kHz', genre: '系列内容', status: 'analyzing', accent: '#53439a', rhythm: [], findings: [] },
];
let accountState: AccountEntitlements = { accountId: 'demo-account', plan: 'free', quotaCredits: 3, watermark: true, subscriptionExpiresAt: null, entitlements: { max_duration_seconds: 15, preview_quality: '低清预览', watermark: true, local_retakes: 1, requires_payment_confirmation: true } };
const messages: AgentMessage[] = [{ id: 'm1', role: 'agent', content: '你好，我是项目 Agent。可以帮你检查镜头连续性、整理素材，或发起生成任务。', createdAt: '刚刚' }];
const canvasDocuments = new Map<string, { document: PersistedCanvasDocument; revision: number }>();
const timelineDocuments = new Map<string, { document: TimelineDocument; revision: number }>();
const delay = <T,>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 100));
export const memoryAdapter: AppPorts = {
  account: {
    get: () => delay(accountState),
    consume: (credits, _reason) => { accountState = { ...accountState, quotaCredits: Math.max(0, accountState.quotaCredits - credits) }; return delay(accountState); },
    confirmPayment: (plan) => { accountState = { ...accountState, plan, quotaCredits: accountState.quotaCredits + (plan === 'pro' ? 100 : 30), watermark: false, subscriptionExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }; return delay(accountState); },
    startCheckout: async (plan, _amountCents, returnUrl) => { await memoryAdapter.account.confirmPayment(plan, _amountCents); return { provider: 'local', sessionId: 'local-checkout', url: returnUrl }; },
    confirmStripePayment: async () => memoryAdapter.account.confirmPayment('studio', 9900),
  },
  workspaces: {
    list: () => delay(workspaces.filter(workspace => workspace.status === 'active')),
    listArchived: () => delay(workspaces.filter(workspace => workspace.status === 'archived')),
    get: id => { const workspace = workspaces.find(item => item.id === id); return delay(workspace ? workspaceDetail(workspace) : undefined); },
    create: (name = '未命名工作区') => {
      const stamp = Date.now();
      const workspace: WorkspaceSummary = { id: `w-${stamp}`, name, description: '新工作区 · 1 张画布', updatedAt: '刚刚', status: 'active', revision: 1, canvasCount: 1, primaryProjectId: `p-${stamp}`, shots: 0, assets: 0, progress: 0, state: 'EMPTY', maxBudgetCents: 0, rightsConfirmed: false };
      const project: ProjectSummary = { id: `p-${stamp}`, workspaceId: workspace.id, name: '画布 1', description: '', updatedAt: '刚刚', status: 'active', shots: 0, assets: 0, progress: 0, revision: 1, state: 'EMPTY', maxBudgetCents: 0, rightsConfirmed: false };
      workspaces.unshift(workspace); projects.unshift(project);
      return delay({ workspace: workspaceDetail(workspace), project });
    },
    rename: (id, name) => { const workspace = workspaces.find(item => item.id === id); if (!workspace) throw new Error('工作区不存在'); workspace.name = name.trim(); workspace.updatedAt = '刚刚'; workspace.revision += 1; return delay(workspaceDetail(workspace)); },
    trash: id => { const workspace = workspaces.find(item => item.id === id); if (!workspace) throw new Error('工作区不存在'); workspace.status = 'archived'; workspace.updatedAt = '刚刚'; workspace.revision += 1; projects.filter(project => project.workspaceId === id).forEach(project => { project.status = 'archived'; }); return delay(workspaceDetail(workspace)); },
    restore: id => { const workspace = workspaces.find(item => item.id === id); if (!workspace) throw new Error('工作区不存在'); workspace.status = 'active'; workspace.updatedAt = '刚刚'; workspace.revision += 1; projects.filter(project => project.workspaceId === id).forEach(project => { project.status = 'active'; }); return delay(workspaceDetail(workspace)); },
    purge: id => { const wi = workspaces.findIndex(item => item.id === id); if (wi >= 0) workspaces.splice(wi, 1); for (let i = projects.length - 1; i >= 0; i -= 1) if (projects[i]?.workspaceId === id) projects.splice(i, 1); return delay(undefined); },
  },
  canvases: {
    list: workspaceId => delay(projects.filter(project => project.status === 'active' && (!workspaceId || project.workspaceId === workspaceId))),
    listArchived: () => delay(projects.filter(project => project.status === 'archived')),
    get: id => delay(projects.find(project => project.id === id)),
    create: input => {
      const stamp = Date.now();
      const workspaceId = input.workspaceId ?? `w-${stamp}`;
      const project: ProjectSummary = { name: input.name, description: input.description, workspaceId, id: `p-${stamp}`, updatedAt: '刚刚', status: 'active', shots: 0, assets: 0, progress: 0, revision: 1, state: 'EMPTY', maxBudgetCents: input.maxBudgetCents ?? 0, rightsConfirmed: input.rightsConfirmed ?? false };
      projects.push(project);
      const workspace = workspaces.find(item => item.id === workspaceId);
      if (workspace) { workspace.canvasCount += 1; workspace.updatedAt = '刚刚'; workspace.revision += 1; }
      else workspaces.unshift({ id: workspaceId, name: input.workspaceName ?? input.name, description: '新工作区 · 1 张画布', updatedAt: '刚刚', status: 'active', revision: 1, canvasCount: 1, primaryProjectId: project.id, shots: 0, assets: 0, progress: 0, state: 'EMPTY', maxBudgetCents: 0, rightsConfirmed: false });
      return delay(project);
    },
    rename: (id, name) => {
      const project = projects.find(item => item.id === id);
      if (!project) throw new Error('项目不存在');
      project.name = name.trim();
      project.updatedAt = '刚刚';
      project.revision += 1;
      return delay(project);
    },
    trash: id => {
      const project = projects.find(item => item.id === id);
      if (!project) throw new Error('项目不存在');
      project.status = 'archived';
      project.state = 'ARCHIVED';
      project.updatedAt = '刚刚';
      project.revision += 1;
      return delay(project);
    },
    restore: id => {
      const project = projects.find(item => item.id === id);
      if (!project) throw new Error('项目不存在');
      project.status = 'active';
      project.state = 'PRODUCTION';
      project.updatedAt = '刚刚';
      project.revision += 1;
      return delay(project);
    },
    purge: id => {
      const index = projects.findIndex(item => item.id === id);
      if (index >= 0) projects.splice(index, 1);
      return delay(undefined);
    },
    duplicate: id => {
      const source = projects.find(item => item.id === id);
      if (!source) throw new Error('项目不存在');
      const copy: ProjectSummary = { ...source, id: `p-${Date.now()}`, name: `${source.name} · 副本`, updatedAt: '刚刚', status: 'active', state: 'EMPTY', shots: 0, assets: 0, progress: 0, revision: 1, rightsConfirmed: false };
      projects.unshift(copy);
      return delay(copy);
    },
    updateSettings: id => {
      const project = projects.find(item => item.id === id);
      if (!project) throw new Error('项目不存在');
      project.updatedAt = '刚刚';
      project.revision += 1;
      return delay(project);
    },
  } satisfies ProjectPort,
  canvasDocuments: {
    load: projectId => {
      const stored = canvasDocuments.get(projectId);
      const projectRevision = projects.find(project => project.id === projectId)?.revision ?? 1;
      return delay({ document: stored?.document ?? null, projectRevision, documentRevision: stored?.revision ?? null });
    },
    save: (projectId, expectedProjectRevision, document) => {
      const project = projects.find(item => item.id === projectId);
      if (!project) throw new Error('项目不存在');
      if (project.revision !== expectedProjectRevision) throw new Error('画布已在其他位置更新，请重新载入。');
      project.revision += 1;
      canvasDocuments.set(projectId, { document: structuredClone(document), revision: project.revision });
      return delay({ projectRevision: project.revision, documentRevision: project.revision });
    },
  },
  timeline: {
    load: projectId => { const stored = timelineDocuments.get(projectId); const projectRevision = projects.find(project => project.id === projectId)?.revision ?? 1; return delay({ document: stored?.document ?? null, projectRevision, documentRevision: stored?.revision ?? null }); },
    save: (projectId, expectedProjectRevision, document) => { const project = projects.find(item => item.id === projectId); if (!project) throw new Error('项目不存在'); if (project.revision !== expectedProjectRevision) throw new Error('时间线已在其他位置更新，请重新载入。'); project.revision += 1; timelineDocuments.set(projectId, { document: structuredClone(document), revision: project.revision }); return delay({ projectRevision: project.revision, documentRevision: project.revision }); },
    startExport: () => Promise.reject(new Error('本地 API 未连接，无法执行真实 MP4 导出。')),
    exportStatus: () => Promise.reject(new Error('本地 API 未连接，无法读取真实导出状态。')),
    cancelExport: () => Promise.reject(new Error('本地 API 未连接，无法取消真实导出。')),
  },
  models: { search: () => delay([]), schema: () => Promise.reject(new Error('本地模型目录不可用，请连接 Local API。')) },
  shots: { list: () => delay(shots) },
  media: { listAssets: () => delay(assets), upload: () => Promise.reject(new Error('本地 API 未连接，无法上传真实素材。')), rate: async (_projectId, artifactId, stars) => { const asset = assets.find(item => item.id === artifactId); if (asset) { if (stars) asset.rating = stars; else delete asset.rating; } }, remove: async (_projectId, artifactId) => { const index = assets.findIndex(item => item.id === artifactId); if (index >= 0) assets.splice(index, 1); } },
  source: {
    list: () => delay(sources),
    create: (_projectId, name, genre) => {
      const source: ReferenceSource = { id: `r-${Date.now()}`, name, kind: 'video', meta: '刚刚读入 · 规格待补', genre, status: 'analyzed', ...(genreProfiles[genre] ?? profileDrama) };
      sources.unshift(source);
      return delay(source);
    },
  },
  generation: { listJobs: () => delay(jobs), create: (_projectId, title, type) => { const job = { id: `j-${Date.now()}`, title, type, status: 'queued' as const, progress: 0, createdAt: '刚刚' }; jobs = [job, ...jobs]; return delay(job); }, status: () => Promise.reject(new Error('本地 API 未连接，无法核查真实生成任务。')) },
  agent: { listConversations: () => delay([]), createConversation: () => delay(`demo-${Date.now()}`), listMessages: () => delay(messages), send: (_projectId, content) => { const message = { id: `m-${Date.now()}`, role: 'user' as const, content, createdAt: '刚刚' }; messages.push(message); return delay(message); }, cancel: () => Promise.reject(new Error('本地 API 未连接，无法取消真实 Agent。')) },
};
