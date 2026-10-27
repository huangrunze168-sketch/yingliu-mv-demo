export type ProjectStatus = 'active' | 'archived';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface CanvasSummary { id: string; workspaceId: string; name: string; description: string; updatedAt: string; status: ProjectStatus; shots: number; assets: number; progress: number; revision: number; state: string; maxBudgetCents: number; rightsConfirmed: boolean; }
/** 兼容创作域旧命名；LibTV 的 project 实际就是 workspace 内的一张 canvas。 */
export type ProjectSummary = CanvasSummary;
export interface WorkspaceSummary { id: string; name: string; description: string; updatedAt: string; status: ProjectStatus; revision: number; canvasCount: number; primaryProjectId: string | null; shots: number; assets: number; progress: number; state: string; maxBudgetCents: number; rightsConfirmed: boolean; }
export interface WorkspaceDetail extends WorkspaceSummary { canvases: CanvasSummary[]; }
export interface ProjectCreateInput { name: string; description: string; workspaceId?: string; workspaceName?: string; rightsConfirmed?: boolean; maxBudgetCents?: number; }
export interface ProjectSettings { playback?: 'hold' | 'stretch'; transition?: 'cut' | 'crossfade' | 'push' | 'wipe' | 'cover' | 'page-turn'; direction?: 'left' | 'right' | 'up' | 'down'; }
export interface Shot { id: string; title: string; scene: string; status: 'draft' | 'ready' | 'approved'; duration: string; prompt: string; }
export interface Asset { id: string; name: string; kind: 'image' | 'video' | 'audio' | 'document'; meta: string; color: string; previewUrl?: string; source?: 'upload' | 'generation'; rating?: number; }

/** 风格分析里除「镜头节奏」外的一条结论。节奏不在这里 —— 它由 ReferenceSource.rhythm 推导。 */
export interface SourceFinding { key: string; label: string; value: string; score: number; }

/** 一条已读入的参考片 / 参考音频。 */
export interface ReferenceSource {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  meta: string;
  /** 创作类型，对应落地页的四个入口 */
  genre: string;
  status: 'analyzed' | 'analyzing';
  /** 缩略块渐变的基色，沿用 Asset.color 的写法 */
  accent: string;
  /** 逐镜时长（秒）。风格分析的「镜头节奏」由它推导，不另存文案 */
  rhythm: number[];
  findings: SourceFinding[];
}
export interface GenerationJob { id: string; title: string; type: string; status: JobStatus; progress: number; createdAt: string; asset?: Asset; assets?: Asset[]; notes?: string[]; cost?: { amount: number; unit: 'credit' | 'cent' } | null; }
export type CanvasReferenceRole = 'first-frame' | 'last-frame' | 'reference-image' | 'reference-video' | 'reference-audio' | 'text-input';
export interface PersistedCanvasNode { id: string; type: string; position: { x: number; y: number }; width?: number; height?: number; data: Record<string, unknown>; groupId?: string; locked?: boolean; }
export interface PersistedCanvasEdge { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; referenceRole?: CanvasReferenceRole; }
export interface PersistedCanvasDocument { version: 2; nodes: PersistedCanvasNode[]; edges: PersistedCanvasEdge[]; viewport?: { x: number; y: number; zoom: number }; }
export interface CanvasDocumentSnapshot { document: PersistedCanvasDocument | null; projectRevision: number; documentRevision: number | null; registeredArtifacts?: Array<{ artifactId: string; mediaType: string; nodeId: string; requestId?: string }>; }
export type TimelineTrack = 'C1' | 'V2' | 'V1' | 'A1' | 'A2';
export interface TimelineClip { id: string; track: TimelineTrack; label: string; startMs: number; durationMs: number; sourceOffsetMs: number; shotId?: string; artifactId?: string; }
export interface TimelineDocument { version: 1; ripple: boolean; clips: TimelineClip[]; }
export interface TimelineDocumentSnapshot { document: TimelineDocument | null; projectRevision: number; documentRevision: number | null; }
export interface CanvasDocumentPort {
  load(projectId: string): Promise<CanvasDocumentSnapshot>;
  save(projectId: string, expectedProjectRevision: number, document: PersistedCanvasDocument): Promise<{ projectRevision: number; documentRevision: number }>;
}
export interface TimelineExportJob { requestId: string; phase: 'queued' | 'preparing' | 'rendering' | 'finalizing' | 'completed' | 'failed' | 'canceled' | 'unknown'; progress: number; artifactId?: string; downloadUrl?: string; error?: string; }
export interface TimelinePort {
  load(projectId: string): Promise<TimelineDocumentSnapshot>;
  save(projectId: string, expectedProjectRevision: number, document: TimelineDocument): Promise<{ projectRevision: number; documentRevision: number }>;
  startExport(projectId: string, documentRevision: number, resolution?: '1280x720' | '1920x1080' | '720x1280' | '1080x1920'): Promise<TimelineExportJob>;
  exportStatus(projectId: string, requestId: string): Promise<TimelineExportJob>;
  cancelExport(projectId: string, requestId: string): Promise<TimelineExportJob>;
}
export type ModelModality = 'text' | 'image' | 'video' | 'audio' | 'script' | 'storyboard';
export interface ModelSummary { modelKey: string; modelName: string; description?: string; estimatedTime?: string; supportModality?: string; vip?: boolean; studio?: boolean; }
export interface ModelSchema { modelKey?: string; modelName?: string; properties?: Record<string, unknown>; config?: Record<string, unknown>; rules?: unknown[]; }
export interface ModelCatalogPort { search(type: ModelModality, name?: string): Promise<ModelSummary[]>; schema(modelName: string): Promise<ModelSchema>; }
export interface AgentMessage { id: string; role: 'user' | 'agent'; content: string; createdAt: string; skillRef?: { id: string; version: string; name?: string }; }
export interface AgentReference { id: string; kind: 'asset' | 'shot' | 'node'; label: string; }
export interface AgentSendOptions { references?: AgentReference[]; skillRef?: { id: string; version: string }; model?: string; conversationId?: string; onStarted?: (runId: string) => void; onDelta?: (message: AgentMessage) => void; }
export interface AgentConversation { id: string; title: string; updatedAt: number; messageCount: number; }


export interface WorkspacePort {
  list(): Promise<WorkspaceSummary[]>;
  listArchived(): Promise<WorkspaceSummary[]>;
  get(id: string): Promise<WorkspaceDetail | undefined>;
  create(name?: string): Promise<{ workspace: WorkspaceDetail; project: CanvasSummary }>;
  rename(id: string, name: string): Promise<WorkspaceDetail>;
  trash(id: string): Promise<WorkspaceDetail>;
  restore(id: string): Promise<WorkspaceDetail>;
  purge(id: string, confirmName: string): Promise<void>;
}
export interface CanvasPort {
  list(workspaceId?: string): Promise<CanvasSummary[]>;
  listArchived(): Promise<CanvasSummary[]>;
  get(id: string): Promise<CanvasSummary | undefined>;
  create(input: ProjectCreateInput): Promise<CanvasSummary>;
  rename(id: string, name: string): Promise<CanvasSummary>;
  trash(id: string): Promise<CanvasSummary>;
  restore(id: string): Promise<CanvasSummary>;
  purge(id: string, confirmName: string): Promise<void>;
  duplicate(id: string): Promise<CanvasSummary>;
  updateSettings(id: string, settings: ProjectSettings): Promise<CanvasSummary>;
}
export type ProjectPort = CanvasPort;
export interface ShotPort { list(projectId: string): Promise<Shot[]>; }
export interface MediaPort { listAssets(projectId: string): Promise<Asset[]>; upload(projectId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<Asset>; rate(projectId: string, artifactId: string, stars: number): Promise<void>; remove(projectId: string, artifactId: string): Promise<void>; }
export interface SourcePort {
  list(projectId: string): Promise<ReferenceSource[]>;
  create(projectId: string, name: string, genre: string): Promise<ReferenceSource>;
}
export interface GenerationOptions { nodeId?: string; model?: string; modeType?: string; settings?: Record<string, string | number | boolean>; referenceIds?: string[]; ratio?: string; rightsConfirmed?: boolean; confirmCosts?: boolean; requestId?: string; onStarted?: (requestId: string) => void; }
export interface GenerationRunStatus { requestId: string; phase: 'accepted' | 'provider_started' | 'provider_finished' | 'completed' | 'failed' | 'unknown'; nodeId?: string; error?: string; job?: GenerationJob; }
export interface GenerationPort { listJobs(projectId: string): Promise<GenerationJob[]>; create(projectId: string, title: string, type: string, options?: GenerationOptions): Promise<GenerationJob>; status(projectId: string, requestId: string): Promise<GenerationRunStatus>; }
export interface AccountEntitlements { accountId: string; plan: 'free' | 'studio' | 'pro'; quotaCredits: number; watermark: boolean; subscriptionExpiresAt: string | null; entitlements: { max_duration_seconds: number; preview_quality: string; watermark: boolean; local_retakes: number; requires_payment_confirmation: boolean }; }
export interface CheckoutSession { provider: 'stripe' | 'local'; sessionId: string; url: string; }
export interface AccountPort { get(): Promise<AccountEntitlements>; consume(credits: number, reason: string): Promise<AccountEntitlements>; confirmPayment(plan: 'studio' | 'pro', amountCents: number): Promise<AccountEntitlements>; startCheckout(plan: 'studio' | 'pro', amountCents: number, returnUrl: string): Promise<CheckoutSession>; confirmStripePayment(sessionId: string): Promise<AccountEntitlements>; }
export interface AgentPort { listConversations(projectId: string): Promise<AgentConversation[]>; createConversation(projectId: string): Promise<string>; listMessages(projectId: string, conversationId?: string): Promise<AgentMessage[]>; send(projectId: string, content: string, options?: AgentSendOptions): Promise<AgentMessage>; cancel(projectId: string, runId: string, conversationId?: string): Promise<void>; }
export interface AppPorts { account: AccountPort; workspaces: WorkspacePort; canvases: CanvasPort; canvasDocuments: CanvasDocumentPort; timeline: TimelinePort; models: ModelCatalogPort; shots: ShotPort; media: MediaPort; source: SourcePort; generation: GenerationPort; agent: AgentPort; }
