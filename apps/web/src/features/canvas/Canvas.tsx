import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type MouseEvent, type PointerEvent } from 'react';
import {
  Background, BackgroundVariant, Handle, MiniMap, Position, ReactFlow,
  ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type NodeProps, type Viewport,
} from '@xyflow/react';
import {
  Boxes, Cable, ChevronDown, Copy, FileText, Hand, ImagePlus, Link2, LocateFixed, Minus, MousePointer2, Music2,
  Maximize2, Play, Plus, Redo2, Settings2, Sparkles, Trash2, Undo2, Unlink, WandSparkles, X,
} from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './canvas.css';
import './canvas-node-inline.css';
import { CANVAS_NODE_LABELS, CANVAS_NODE_TYPES, IMAGE_ASPECT_RATIOS, isCanvasGenerationNode, isRunnableCanvasGenerationNode, type CanvasNodeType } from '../../domain/canvas';
import { ports } from '../../app/useAppData';
import { validateVideoModeReferences } from '@qiyin/contracts/video-mode-validation';
import type { CanvasReferenceRole, GenerationJob, ModelSchema, ModelSummary, PersistedCanvasDocument } from '../../ports/index.js';
import { agentProjectGraph, type AgentProjectSnapshot } from './agentProjectGraph';
import { canvasExecutionPlan, canvasNodeConsentText, invalidateCanvasDependents } from './canvasDag';
import { saveCanvasWithReconciliation } from './canvasSave';
import { discardCanvasDraft, inspectCanvasDraft, readCanvasDraft, reconcileCanvasDraftAfterSave, storeCanvasDraft, type CanvasDraftReview } from './canvasDraft';
import { validateCanvasConnection } from '../../domain/canvasConnections';
import {
  duplicateCanvasNode, indexCanvasReferences, initialCanvas, isPreviousCanvasResult, isUnresolvedPaidCanvasNode, loadCanvasDocument, makeCanvasNode, parseCanvasDocument, removeLegacyCanvasDocument, resolveLoadedCanvasDocument, restoreRegisteredCanvasResults, serializeCanvasDocument, toPersistedCanvasDocument,
  type CanvasDocument, type CanvasEdge, type CanvasNode, type CanvasNodeData,
} from './canvasDocument';

const palette: Array<{ kind: CanvasNodeType; icon: typeof ImagePlus; detail: string; tone: string }> = [
  { kind: CANVAS_NODE_TYPES.upload, icon: ImagePlus, detail: '图片、视频或音频参考', tone: 'slate' },
  { kind: CANVAS_NODE_TYPES.aiText, icon: FileText, detail: '脚本、提示词与结构化文本', tone: 'amber' },
  { kind: CANVAS_NODE_TYPES.imageEdit, icon: Boxes, detail: '从提示词或参考图生成图像', tone: 'violet' },
  { kind: CANVAS_NODE_TYPES.aiVideo, icon: Play, detail: '首帧、尾帧或参考视频', tone: 'cyan' },
  { kind: CANVAS_NODE_TYPES.aiAudio, icon: Music2, detail: '配音、音效与音乐草案', tone: 'rose' },
  { kind: CANVAS_NODE_TYPES.storyboardGen, icon: WandSparkles, detail: '把脚本拆成可确认镜头', tone: 'lime' },
];
const edgeStyle = { stroke: 'var(--canvas-edge)', strokeWidth: 1.5 };
const referenceRoleLabels: Record<CanvasReferenceRole, string> = { 'first-frame': '首帧', 'last-frame': '尾帧', 'reference-image': '参考图', 'reference-video': '参考视频', 'reference-audio': '参考音频', 'text-input': '文本输入' };
const paletteByKind = new Map(palette.map(item => [item.kind, item]));

type InsertMenu = { mode: 'toolbar' | 'cursor'; x?: number; y?: number; position?: { x: number; y: number } };
type MouseMode = 'select' | 'hand' | 'connect';
type CanvasContextMenu = { kind: 'pane' | 'node'; x: number; y: number; position?: { x: number; y: number }; nodeId?: string };
type CanvasNodeActions = {
  openSettings: (id: string) => void;
  toggleExpanded: (id: string) => void;
  updateNode: (id: string, patch: Partial<CanvasNodeData>) => void;
  runNode: (id: string) => void;
  selectModel: (id: string, modelName: string) => void;
  modelsFor: (kind: CanvasNodeType) => ModelSummary[];
  schemaFor: (modelName?: string) => ModelSchema | undefined;
  removeReference: (targetId: string, sourceId: string) => void;
  previewMedia: (id: string) => void;
};
const CanvasNodeActionsContext = createContext<CanvasNodeActions>({ openSettings: () => undefined, toggleExpanded: () => undefined, updateNode: () => undefined, runNode: () => undefined, selectModel: () => undefined, modelsFor: () => [], schemaFor: () => undefined, removeReference: () => undefined, previewMedia: () => undefined });
const isRunnableGenerationNode = isRunnableCanvasGenerationNode;
function canvasJobStatus(status: 'queued' | 'running' | 'succeeded' | 'failed'): CanvasNodeData['status'] { return status === 'succeeded' ? 'ready' : status; }
function videoReferenceFeedback(schema: ModelSchema | undefined, mode: string, references: Array<{ artifactId?: string; mediaKind?: 'image' | 'video' | 'audio'; label: string }>): string | null {
  if (!schema) return '真实模型规则尚未载入，暂不能发起视频生成';
  const missing = references.find(reference => !reference.artifactId || !reference.mediaKind);
  if (missing) return `「${missing.label}」尚无可用的真实参考素材`;
  return validateVideoModeReferences(schema, mode, references.map(reference => `${reference.mediaKind}/`));
}
function canvasJobResult(job: GenerationJob): Partial<CanvasNodeData> {
  if (!job.asset) return {};
  const asset = job.asset;
  return { artifactId: asset.id, ...(asset.kind !== 'document' ? { mediaKind: asset.kind } : {}), variants: job.assets && job.assets.length > 1 ? job.assets.flatMap(item => item.kind === 'document' ? [] : [{ artifactId: item.id, mediaKind: item.kind, name: item.name, ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}) }]) : [], previewUrl: asset.kind === 'image' ? asset.previewUrl ?? '' : '', videoUrl: asset.kind === 'video' ? asset.previewUrl ?? '' : '' };
}
function hydrateCanvasPreviewUrls(projectId: string, nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map(node => {
    const assetUrl = node.data.artifactId ? `/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(node.data.artifactId)}` : undefined;
    return { ...node, type: 'qtv', data: { ...node.data, ...(node.data.variants ? { variants: node.data.variants.map(variant => ({ ...variant, previewUrl: `/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(variant.artifactId)}` })) } : {}), ...(assetUrl && node.data.mediaKind === 'image' ? { previewUrl: assetUrl } : {}), ...(assetUrl && node.data.mediaKind === 'video' ? { videoUrl: assetUrl } : {}) } };
  });
}
function defaultReferenceRole(source: CanvasNodeType, target: CanvasNodeType) {
  if (source === CANVAS_NODE_TYPES.aiText) return 'text-input' as const;
  if (source === CANVAS_NODE_TYPES.aiAudio) return 'reference-audio' as const;
  if (source === CANVAS_NODE_TYPES.aiVideo) return 'reference-video' as const;
  if (target === CANVAS_NODE_TYPES.aiVideo) return 'first-frame' as const;
  return 'reference-image' as const;
}

function schemaDefaults(schema: ModelSchema, kind: CanvasNodeType): Partial<CanvasNodeData> {
  const properties = schema.properties ?? {};
  const modeProperty = properties.modeType as { items?: Record<string, unknown> } | undefined;
  const config = schema.config ?? {};
  const modes = Array.from(new Set([...Object.keys(modeProperty?.items ?? {}), ...Object.keys(config.settings && !Array.isArray(config.settings) && typeof config.settings === 'object' ? config.settings : {})]));
  const modeType = kind === CANVAS_NODE_TYPES.aiVideo ? (modes.includes('text2video') ? 'text2video' : modes[0] ?? 'text2video') : (modes.includes('image2image') ? 'image2image' : modes[0]);
  const configured = config.settings;
  const keys = Array.isArray(configured) ? configured.filter((key): key is string => typeof key === 'string') : configured && typeof configured === 'object' && modeType ? ((configured as Record<string, unknown>)[modeType] as unknown[] | undefined)?.filter((key): key is string => typeof key === 'string') ?? [] : [];
  const settings: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const property = properties[key];
    if (!property || typeof property !== 'object' || Array.isArray(property)) continue;
    const value = (property as Record<string, unknown>).default;
    const originalField = (property as Record<string, unknown>).originalField;
    if (['string', 'number', 'boolean'].includes(typeof value)) settings[typeof originalField === 'string' ? originalField : key] = value as string | number | boolean;
  }
  const ratio = typeof settings.ratio === 'string' && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(settings.ratio) ? settings.ratio : undefined;
  return { ...(modeType ? { modeType } : {}), settings, ...(ratio ? { aspectRatio: ratio } : {}) };
}

function schemaSettingFields(schema: ModelSchema | undefined, modeType?: string) {
  if (!schema) return [];
  const properties = schema.properties ?? {};
  const configured = schema.config?.settings;
  const modeKeys = Array.isArray(configured) ? configured : configured && typeof configured === 'object' && modeType ? (configured as Record<string, unknown>)[modeType] : [];
  const advancedKeys = schema.config?.advancedSettings;
  const keys = [...(Array.isArray(modeKeys) ? modeKeys : []), ...(Array.isArray(advancedKeys) ? advancedKeys : [])];
  return Array.from(new Set(keys)).filter((key): key is string => typeof key === 'string').map(key => {
    const property = properties[key];
    if (!property || typeof property !== 'object' || Array.isArray(property)) return null;
    const definition = property as Record<string, unknown>;
    return { key, field: typeof definition.originalField === 'string' ? definition.originalField : key, label: typeof definition.displayName === 'string' ? definition.displayName : key, definition };
  }).filter((field): field is NonNullable<typeof field> => Boolean(field));
}

function canvasStatusLabel(status: CanvasNodeData['status'], isUpload = false) {
  if (status === 'ready') return isUpload ? '素材就绪' : '生成完成';
  if (status === 'queued') return '任务排队中';
  if (status === 'running') return '正在生成';
  if (status === 'failed') return '生成失败，可重试';
  if (status === 'unknown') return '上次结果与费用未知，核查后重试';
  return '等待配置生成参数';
}

function WorkflowNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const actions = useContext(CanvasNodeActionsContext);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => { setPreviewFailed(false); }, [data.previewUrl, data.videoUrl]);
  const item = paletteByKind.get(data.kind) ?? palette[0]!;
  const Icon = item.icon;
  const isUpload = data.kind === CANVAS_NODE_TYPES.upload;
  const isGeneration = isCanvasGenerationNode(data.kind);
  const isText = data.kind === CANVAS_NODE_TYPES.aiText;
  const isAudio = data.kind === CANVAS_NODE_TYPES.aiAudio;
  const runnable = isRunnableGenerationNode(data.kind);
  const models = actions.modelsFor(data.kind);
  const modelSchema = actions.schemaFor(data.model);
  const schemaFields = schemaSettingFields(modelSchema, data.modeType);
  const videoModes = data.kind === CANVAS_NODE_TYPES.aiVideo && modelSchema?.config?.settings && !Array.isArray(modelSchema.config.settings) && typeof modelSchema.config.settings === 'object' ? Object.keys(modelSchema.config.settings) : [];
  const videoFeedback = data.kind === CANVAS_NODE_TYPES.aiVideo && data.model ? videoReferenceFeedback(modelSchema, data.modeType ?? videoModes[0] ?? 'text2video', (data.references ?? []).filter(reference => reference.role !== 'text-input' && reference.kind !== CANVAS_NODE_TYPES.aiText)) : null;
  const selectVideoMode = (modeType: string) => { const nextSettings: Record<string, string | number | boolean> = {}; for (const field of schemaSettingFields(modelSchema, modeType)) { const value = field.definition.default; if (['string','number','boolean'].includes(typeof value)) nextSettings[field.field] = value as string | number | boolean; } actions.updateNode(id, { modeType, settings: nextSettings, status: 'draft', jobId: undefined, progress: undefined }); };
  const updateSetting = (field: string, value: string | number | boolean) => actions.updateNode(id, { settings: { ...(data.settings ?? {}), [field]: value }, ...(field === 'ratio' && typeof value === 'string' && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(value) ? { aspectRatio: value } : {}) });
  const active = data.status === 'queued' || data.status === 'running';
  const frozen = active || isUnresolvedPaidCanvasNode(data);
  const progress = Math.max(0, Math.min(100, Number(data.progress ?? 0)));
  const previousResult = isGeneration && isPreviousCanvasResult(data);
  const updateSpotlight = (event: PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--spotlight-x', `${event.clientX - bounds.left}px`);
    event.currentTarget.style.setProperty('--spotlight-y', `${event.clientY - bounds.top}px`);
  };
  const togglePreview = () => { if (isGeneration) actions.toggleExpanded(id); };
  const stageContent = <>
    {data.videoUrl ? (previewFailed ? <p className="qtv-project-preview-failed">视频已登记，但当前文件不可播放，请核对产物</p> : <video className="qtv-project-preview nodrag" width={430} height={242} controls preload="metadata" src={data.videoUrl} aria-label={previousResult ? `${data.label}上一次成功的视频，本次生成尚未成功` : `${data.label}真实视频`} onError={() => setPreviewFailed(true)} />) : data.previewUrl ? (previewFailed ? <p className="qtv-project-preview-failed">项目已登记产物，但预览文件不可用</p> : <img className="qtv-project-preview" width={430} height={242} loading="lazy" decoding="async" src={data.previewUrl} alt={previousResult ? `${data.label}上一次成功的首帧，本次生成尚未成功` : `${data.label}真实首帧`} onError={() => setPreviewFailed(true)} />) : isText && data.origin === 'project' ? <p className="qtv-project-storyboard-text">{data.prompt}</p> : isText ? <div className="qtv-text-preview"><b /><span /><span /><span /></div> : isAudio ? <div className="qtv-audio-preview">{[10,18,28,16,34,24,12,30,20,8,22,14].map((height, index) => <i key={index} style={{ height }} />)}</div> : <><div className="qtv-stage-mark"><Icon size={28} strokeWidth={1.25} aria-hidden="true" /><span>{isUpload ? '参考素材' : data.status === 'ready' ? '生成已完成' : '尚未生成'}</span></div><div className="qtv-stage-orb" /></>}
    {previousResult && <span className="qtv-previous-preview-note">上一次成功产物 · 本次尚未成功</span>}
    <span className="qtv-ratio-badge">{data.aspectRatio}</span>
    {isGeneration && data.origin !== 'project' ? <span className="qtv-preview-toggle" aria-hidden="true"><ChevronDown size={14} /></span> : null}
  </>;
  return (
    <article data-node-id={id} className={`qtv-canvas-node tone-${item.tone}${isUpload ? ' is-source' : ' is-generation'}${data.expanded ? ' is-expanded' : ' is-collapsed'}${active ? ' is-busy' : ''}${selected ? ' is-selected' : ''}`} onPointerMove={updateSpotlight}>
      <Handle type="target" position={Position.Left} isConnectable={data.origin !== 'project'} aria-label="输入连接点" />
      <header className="qtv-node-header">
        <div className="qtv-node-title"><span aria-hidden="true"><Icon size={15} strokeWidth={1.7} /></span><div><small>{CANVAS_NODE_LABELS[data.kind]}</small><strong>{data.label}</strong></div></div>
        {(data.previewUrl || data.videoUrl) ? <button type="button" className="qtv-node-preview-open nodrag" aria-label={`全屏预览 ${data.label}`} onClick={() => actions.previewMedia(id)}><Maximize2 size={13} /></button> : null}
        <span className={`qtv-node-state is-${data.status}`}><i />{data.origin === 'project' ? (isText ? '已确认分镜' : data.status === 'ready' ? data.kind === CANVAS_NODE_TYPES.aiVideo ? '视频已登记' : '首帧已登记' : data.status === 'running' ? '真实任务执行中' : data.status === 'failed' ? data.videoUrl ? '本次失败，保留旧片' : '任务失败' : '等待生成') : canvasStatusLabel(data.status, isUpload)}</span>
      </header>
      {active ? <div className={`qtv-node-progress${data.status === 'running' && progress > 0 ? ' is-determinate' : ' is-indeterminate'}`} role="progressbar" aria-label="生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress || undefined}><span style={progress ? { width: `${progress}%` } : undefined} /></div> : null}
      {isGeneration && data.origin !== 'project' ? <button type="button" className={`qtv-node-stage${isText ? ' is-text' : ''}${isAudio ? ' is-audio' : ''} is-toggleable`} aria-expanded={Boolean(data.expanded)} aria-label={`${data.expanded ? '收起' : '展开'}${data.label}生成配置`} onClick={togglePreview}>{stageContent}</button> : <div className={`qtv-node-stage${isText ? ' is-text' : ''}${isAudio ? ' is-audio' : ''}`} aria-hidden={data.origin !== 'project' || undefined}>{stageContent}</div>}
      {data.variants && data.variants.length > 1 ? <div className="qtv-variant-filmstrip nodrag" aria-label="生成候选与保留项">{data.variants.map((variant, index) => <button type="button" key={variant.artifactId} className={data.artifactId === variant.artifactId ? 'is-keeper' : ''} aria-pressed={data.artifactId === variant.artifactId} aria-label={`保留候选 ${index + 1}`} onClick={() => actions.updateNode(id, { artifactId: variant.artifactId, mediaKind: variant.mediaKind, previewUrl: variant.mediaKind === 'image' ? variant.previewUrl ?? '' : '', videoUrl: variant.mediaKind === 'video' ? variant.previewUrl ?? '' : '' })}>{variant.previewUrl && variant.mediaKind === 'image' ? <img src={variant.previewUrl} alt="" /> : <span>{index + 1}</span>}<i>{data.artifactId === variant.artifactId ? '保留' : '候选'}</i></button>)}</div> : null}
      {data.origin === 'project' ? <div className="qtv-node-composer"><p>{data.prompt || '项目镜头尚未填充画面描述'}</p><div className="qtv-project-node-source">来自项目分镜与真实任务记录 · 只读</div></div> : isGeneration && data.expanded ? <section className="qtv-inline-composer nodrag nowheel" aria-label={`${data.label}生成配置`} onClick={event => event.stopPropagation()}>
        {videoFeedback ? <p className="qtv-reference-feedback" role="status">{videoFeedback}</p> : null}
        {data.references?.length ? <div className="qtv-node-references" aria-label="上游引用">{data.references.map(reference => <div className="qtv-node-reference" key={reference.sourceId} title={reference.label}><span><Link2 size={13} /><b>{reference.label}</b><small>{reference.role ? referenceRoleLabels[reference.role] : CANVAS_NODE_LABELS[reference.kind]}</small></span><button type="button" aria-label={`移除引用 ${reference.label}`} onClick={() => actions.removeReference(id, reference.sourceId)}>×</button></div>)}</div> : <div className="qtv-reference-empty"><Link2 size={12} />可从左侧连接素材或上游节点</div>}
        <textarea name={`generation-prompt-${id}`} autoComplete="off" value={data.prompt} maxLength={2000} disabled={frozen || !runnable} aria-label="生成提示词" placeholder="描述主体、场景、镜头与画面氛围…" onChange={event => actions.updateNode(id, { prompt: event.target.value, status: 'draft', jobId: undefined, progress: undefined })} />
        <div className="qtv-inline-controls">{videoModes.length ? <label><span className="sr-only">视频模式</span><select aria-label="视频模式" value={data.modeType ?? videoModes[0]} disabled={frozen} onChange={event => selectVideoMode(event.target.value)}>{videoModes.map(mode => <option key={mode} value={mode}>{mode === 'text2video' ? '文生视频' : mode === 'singleImage2video' ? '首帧视频' : mode === 'frames2video' ? '首尾帧视频' : mode === 'image2video' ? '多图参考' : mode === 'mixed2video' ? '全能参考' : mode === 'videoEdit2video' ? '视频重拍' : mode}</option>)}</select></label> : null}<label className="qtv-model-select"><Sparkles size={11} aria-hidden="true" /><span className="sr-only">生成模型</span><select aria-label="生成模型" value={data.model ?? ''} disabled={frozen || !runnable || models.length === 0} onChange={event => actions.selectModel(id, event.target.value)}><option value="">{models.length ? '自动模型' : '模型目录不可用'}</option>{models.map(model => <option key={model.modelKey} value={model.modelName}>{model.modelName}</option>)}</select></label><label><span className="sr-only">画幅</span><select aria-label="画幅" value={data.aspectRatio} disabled={frozen || !runnable} onChange={event => actions.updateNode(id, { aspectRatio: event.target.value })}>{IMAGE_ASPECT_RATIOS.map(ratio => <option key={ratio}>{ratio}</option>)}</select></label>{runnable ? <button type="button" className="qtv-inline-run" disabled={active || !data.prompt.trim()} onClick={() => actions.runNode(id)} aria-label={data.status === 'unknown' ? '核查结果与费用后重试' : data.status === 'failed' ? '重试生成' : data.status === 'ready' && data.artifactId ? '逐镜重做（可能产生费用）' : '开始生成'} title={data.status === 'unknown' ? '上次结果与费用未知 · 请先核查' : data.status === 'ready' && data.artifactId ? '逐镜重做 · 可能产生费用' : undefined}>{active ? <i className="ui-mini-loader" /> : <Play size={14} />}</button> : <span className="qtv-capability-note">能力待接入</span>}</div>
        {schemaFields.length ? <div className="qtv-schema-settings" aria-label="模型参数">{schemaFields.map(({ key, field, label, definition }) => {
          const current = data.settings?.[field] ?? definition.default;
          const options = Array.isArray(definition.enum) ? definition.enum : [];
          if (options.length) return <label key={key}><span>{label}</span><select aria-label={label} disabled={frozen} value={String(current ?? '')} onChange={event => { const match = options.map(option => typeof option === 'object' && option ? (option as Record<string, unknown>).value : option).find(value => String(value) === event.target.value); updateSetting(field, typeof match === 'number' || typeof match === 'boolean' ? match : event.target.value); }}>{options.map(option => { const value = typeof option === 'object' && option ? (option as Record<string, unknown>).value : option; const text = typeof option === 'object' && option ? (option as Record<string, unknown>).displayName ?? value : value; return <option key={String(value)} value={String(value)}>{String(text)}</option>; })}</select></label>;
          if (typeof definition.default === 'boolean') return <label key={key}><span>{label}</span><input type="checkbox" aria-label={label} checked={Boolean(current)} disabled={frozen} onChange={event => updateSetting(field, event.target.checked)} /></label>;
          if (typeof definition.min === 'number' || typeof definition.max === 'number') return <label key={key}><span>{label}</span><input type="number" aria-label={label} value={typeof current === 'number' ? current : ''} min={typeof definition.min === 'number' ? definition.min : undefined} max={typeof definition.max === 'number' ? definition.max : undefined} step={typeof definition.step === 'number' ? definition.step : 1} disabled={frozen} onChange={event => updateSetting(field, Number(event.target.value))} /></label>;
          return null;
        })}</div> : null}
      </section> : !isGeneration ? <div className="qtv-node-composer"><p>{isUpload ? '作为生成节点的视觉与风格参考' : data.prompt || item.detail}</p><div><span className="qtv-model-chip"><Sparkles size={11} aria-hidden="true" />自动选择模型</span><button type="button" className="qtv-node-action nodrag" onClick={event => { event.stopPropagation(); actions.openSettings(id); }}>素材设置</button></div></div> : null}
      <Handle type="source" position={Position.Right} isConnectable={data.origin !== 'project'} aria-label="输出连接点" />
    </article>
  );
}
const nodeTypes = { qtv: WorkflowNode };

function CanvasInner({ projectId, onSaveStateChange, onNodeCatalogChange, openInsertSignal = 0 }: { projectId: string; onSaveStateChange?: (state: string) => void; onNodeCatalogChange?: (nodes: Array<{ id: string; label: string }>) => void; openInsertSignal?: number }) {
  const seeded = useMemo(() => initialCanvas(projectId), [projectId]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(seeded.nodes.map(node => ({ ...node, type: 'qtv' })));
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanvasEdge>(seeded.edges);
  const [projectGraph, setProjectGraph] = useState<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>({ nodes: [], edges: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState('已从本机载入');
  const [insertMenu, setInsertMenu] = useState<InsertMenu | null>(null);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(null);
  const [mouseMode, setMouseMode] = useState<MouseMode>('select');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const [generationBusy, setGenerationBusy] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] = useState<{ image: ModelSummary[]; video: ModelSummary[] }>({ image: [], video: [] });
  const [modelSchemas, setModelSchemas] = useState<Record<string, ModelSchema>>({});
  const loadingSchemas = useRef(new Set<string>());
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const generationRunActive = useRef(false);
  const recoveringGenerationIds = useRef(new Set<string>());
  const [zoom, setZoom] = useState(100);
  const [dragConnectTargetId, setDragConnectTargetId] = useState<string | null>(null);
  const nodeDragOrigins = useRef(new Map<string, { x: number; y: number }>());
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const projectFactsFitted = useRef(false);
  const lastSnapshot = useRef(serializeCanvasDocument(seeded));
  const applyingHistory = useRef(false);
  const [readyProjectId, setReadyProjectId] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [draftReview, setDraftReview] = useState<CanvasDraftReview | null>(null);
  const [draftStorageFailed, setDraftStorageFailed] = useState(false);
  const projectRevisions = useRef(new Map<string, number>());
  const canvasDocumentRevisions = useRef(new Map<string, number | null>());
  const lastSavedDocuments = useRef(new Map<string, string>());
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const latestDocuments = useRef(new Map<string, { document: PersistedCanvasDocument; serialized: string }>());
  const legacyMigrationPending = useRef(new Set<string>());
  const [historyCounts, setHistoryCounts] = useState({ undo: 0, redo: 0 });
  const { screenToFlowPosition, fitView, zoomIn, zoomOut } = useReactFlow<CanvasNode, CanvasEdge>();
  const selected = nodes.find(node => node.id === selectedId) ?? null;
  const multiSelectedIds = nodes.filter(node => node.selected && node.data.origin !== 'project').map(node => node.id);
  const activeSelectionIds = multiSelectedIds.length > 1 ? multiSelectedIds : selectedId ? [selectedId] : [];
  const selectedEdgeIds = edges.filter(edge => edge.selected).map(edge => edge.id);
  const renderEdges = useMemo(() => [...edges, ...projectGraph.edges], [edges, projectGraph.edges]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  const queueDocumentSave = useCallback((targetProjectId: string, document: PersistedCanvasDocument, serialized: string, announce: boolean) => {
    saveQueue.current = saveQueue.current.then(async () => {
      if (serialized === lastSavedDocuments.current.get(targetProjectId)) return;
      if (announce) { setSaveFailed(false); setMessage('正在保存…'); }
      const expectedRevision = projectRevisions.current.get(targetProjectId); if (expectedRevision === undefined) throw new Error('画布版本尚未载入');
      const knownDocumentRevision = canvasDocumentRevisions.current.get(targetProjectId);
      if (knownDocumentRevision === undefined) throw new Error('画布文档版本尚未载入');
      const result = await saveCanvasWithReconciliation(ports.canvasDocuments, targetProjectId, expectedRevision, knownDocumentRevision, document);
      projectRevisions.current.set(targetProjectId, Math.max(projectRevisions.current.get(targetProjectId) ?? 0, result.projectRevision));
      canvasDocumentRevisions.current.set(targetProjectId, result.documentRevision);
      lastSavedDocuments.current.set(targetProjectId, serialized);
      let draftCleanupFailed = false;
      try { reconcileCanvasDraftAfterSave(window.localStorage, targetProjectId, document, result.documentRevision); }
      catch { draftCleanupFailed = true; }
      if (legacyMigrationPending.current.delete(targetProjectId)) {
        try { removeLegacyCanvasDocument(targetProjectId); }
        catch { draftCleanupFailed = true; }
      }
      if (announce) setMessage(draftCleanupFailed ? '服务器已保存，但本地草稿清理失败，请检查浏览器存储' : latestDocuments.current.get(targetProjectId)?.serialized === serialized ? '已保存' : '较早版本已保存，最新更改仍在保存…');
    }).catch(error => { if (announce) { setSaveFailed(true); setMessage(`画布尚未保存：${error instanceof Error ? error.message : '未知错误'}；请点击“重试保存”，暂勿关闭页面。`); } });
    return saveQueue.current;
  }, []);
  const renderNodes = useMemo(() => {
    const allNodes = [...nodes, ...projectGraph.nodes];
    const references = indexCanvasReferences(allNodes, renderEdges);
    return allNodes.map(node => ({ ...node, className: node.id === dragConnectTargetId ? 'is-auto-connect-target' : undefined, data: { ...node.data, expanded: expandedNodeIds.has(node.id), references: references.get(node.id) ?? [] } }));
  }, [dragConnectTargetId, expandedNodeIds, nodes, projectGraph.nodes, renderEdges]);

  useEffect(() => {
    let active = true;
    setReadyProjectId(null);
    setSaveFailed(false);
    setDraftReview(null);
    setDraftStorageFailed(false);
    setMessage('正在载入画布…');
    setSelectedId(null);
    setInspectorOpen(false);
    setExpandedNodeIds(new Set());
    undoStack.current = [];
    redoStack.current = [];
    setHistoryCounts({ undo: 0, redo: 0 });
    void ports.canvasDocuments.load(projectId).then(snapshot => {
      if (!active) return;
      const legacy = loadCanvasDocument(projectId);
      let pending: CanvasDraftReview = { state: 'none' };
      try {
        pending = inspectCanvasDraft(window.localStorage, projectId, snapshot);
        if (pending.state === 'saved') { discardCanvasDraft(window.localStorage, projectId); pending = { state: 'none' }; }
      } catch { setDraftStorageFailed(true); }
      let document: CanvasDocument;
      try { document = restoreRegisteredCanvasResults(resolveLoadedCanvasDocument(snapshot.document, legacy), snapshot.document, snapshot.registeredArtifacts ?? []); }
      catch (error) {
        if (pending.state === 'conflict' || pending.state === 'invalid' || pending.state === 'recoverable') {
          setDraftReview({ ...pending, state: pending.state === 'invalid' ? 'invalid' : 'conflict' });
          setMessage('服务器画布无法解析；已阻止自动保存和覆盖，本机草稿可下载备份。');
          return;
        }
        throw error;
      }
      const normalizedNodes = hydrateCanvasPreviewUrls(projectId, document.nodes);
      projectRevisions.current.set(projectId, Math.max(projectRevisions.current.get(projectId) ?? 0, snapshot.projectRevision));
      canvasDocumentRevisions.current.set(projectId, snapshot.documentRevision);
      lastSavedDocuments.current.set(projectId, snapshot.document ? JSON.stringify(snapshot.document) : '');
      if (!snapshot.document) legacyMigrationPending.current.add(projectId);
      lastSnapshot.current = serializeCanvasDocument(document);
      setNodes(normalizedNodes);
      setEdges(document.edges);
      if (pending.state !== 'none') {
        setDraftReview(pending);
        setMessage(pending.state === 'recoverable' ? '发现本机未保存草稿，等待你决定是否恢复' : '本机草稿与服务器画布不一致，已暂停自动保存以防覆盖');
      } else {
        setMessage(snapshot.document ? '已从项目载入' : '正在迁移本机画布…');
        setReadyProjectId(projectId);
      }
    }).catch(error => {
      if (!active) return;
      setNodes([]);
      setEdges([]);
      try {
        const stored = readCanvasDraft(window.localStorage, projectId);
        if (stored.state !== 'none') setDraftReview({ ...stored, state: stored.state === 'invalid' ? 'invalid' : 'conflict' });
      } catch { setDraftStorageFailed(true); }
      setMessage(error instanceof Error ? error.message : '画布载入失败');
    });
    return () => { active = false; };
  }, [projectId, setEdges, setNodes]);

  useEffect(() => {
    if (readyProjectId !== projectId) return;
    const document = toPersistedCanvasDocument({ nodes, edges }); const serialized = JSON.stringify(document); latestDocuments.current.set(projectId, { document, serialized });
    if (serialized === lastSavedDocuments.current.get(projectId)) { setMessage('已保存'); return; }
    try {
      storeCanvasDraft(window.localStorage, projectId, document, canvasDocumentRevisions.current.get(projectId) ?? null, lastSavedDocuments.current.get(projectId) ?? '');
      setDraftStorageFailed(false);
    } catch { setDraftStorageFailed(true); }
    const handle = window.setTimeout(() => { void queueDocumentSave(projectId, document, serialized, true); }, 180);
    return () => window.clearTimeout(handle);
  }, [edges, nodes, projectId, queueDocumentSave, readyProjectId]);

  useEffect(() => () => {
    const latest = latestDocuments.current.get(projectId); if (latest && latest.serialized !== lastSavedDocuments.current.get(projectId)) void queueDocumentSave(projectId, latest.document, latest.serialized, false);
  }, [projectId, queueDocumentSave]);
  useEffect(() => {
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      const latest = latestDocuments.current.get(projectId);
      if (!latest || latest.serialized === lastSavedDocuments.current.get(projectId)) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnUnsaved);
    return () => window.removeEventListener('beforeunload', warnUnsaved);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void Promise.all([ports.models.search('image'), ports.models.search('video')]).then(([image, video]) => {
      if (active) setModelCatalog({ image, video });
    }).catch(() => { if (active) setModelCatalog({ image: [], video: [] }); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const missing = [...new Set(nodes.map(node => node.data.model).filter((name): name is string => typeof name === 'string' && name.length > 0).filter(name => !modelSchemas[name]))];
    if (!missing.length) return;
    let active = true;
    void Promise.all(missing.map(async name => [name, await ports.models.schema(name)] as const)).then(entries => {
      if (active) setModelSchemas(current => ({ ...current, ...Object.fromEntries(entries) }));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [modelSchemas, nodes]);
useEffect(() => {
    const handle = window.setTimeout(() => {
      const snapshot = serializeCanvasDocument({ nodes, edges });
      if (applyingHistory.current) {
        applyingHistory.current = false;
        lastSnapshot.current = snapshot;
        return;
      }
      if (snapshot === lastSnapshot.current) return;
      undoStack.current = [...undoStack.current.slice(-49), lastSnapshot.current];
      redoStack.current = [];
      lastSnapshot.current = snapshot;
      setHistoryCounts({ undo: undoStack.current.length, redo: 0 });
    }, 260);
    return () => window.clearTimeout(handle);
  }, [edges, nodes]);

  useEffect(() => { onSaveStateChange?.(message); }, [message, onSaveStateChange]);
  useEffect(() => { const updateRevision = (event: Event) => { const detail = (event as CustomEvent<{ projectId?: string; revision?: number }>).detail; if (detail?.projectId === projectId && Number.isInteger(detail.revision)) projectRevisions.current.set(projectId, Math.max(projectRevisions.current.get(projectId) ?? 0, detail.revision!)); }; window.addEventListener('qiyin:project-revision', updateRevision); return () => window.removeEventListener('qiyin:project-revision', updateRevision); }, [projectId]);
  useEffect(() => { onNodeCatalogChange?.(nodes.filter(node => node.data.origin !== 'project').map(node => ({ id: node.id, label: node.data.label }))); }, [nodes, onNodeCatalogChange]);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refreshProjectFacts = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}`);
        if (!response.ok) return;
        const snapshot = await response.json() as AgentProjectSnapshot;
        if (!active) return;
        const graph = agentProjectGraph(projectId, snapshot);
        setProjectGraph(previous => JSON.stringify(previous) === JSON.stringify(graph) ? previous : graph);
        if (graph.nodes.length > 0 && seeded.nodes.length === 0 && !projectFactsFitted.current) {
          projectFactsFitted.current = true;
          window.requestAnimationFrame(() => void fitView({ nodes: graph.nodes.slice(0, 4), padding: 0.13, maxZoom: 0.82, duration: 220 }));
        }
      } catch { /* 项目事实暂不可用时不伪造节点；等待下一轮同步。 */ }
      finally { inFlight = false; }
    };
    void refreshProjectFacts();
    const timer = window.setInterval(() => void refreshProjectFacts(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [fitView, projectId, seeded.nodes.length]);
  useEffect(() => { if (openInsertSignal > 0) setInsertMenu({ mode: 'toolbar' }); }, [openInsertSignal]);

  const createNode = useCallback((kind: CanvasNodeType, position?: { x: number; y: number }) => {
    const id = `node-${crypto.randomUUID()}`;
    const rightmost = nodes.reduce((right, item) => {
      const width = typeof item.style?.width === 'number' ? item.style.width : 320;
      return Math.max(right, item.position.x + width);
    }, 40);
    const top = nodes.length ? Math.min(...nodes.map(item => item.position.y)) : 120;
    const draft = makeCanvasNode(kind, { x: 0, y: 0 }, id);
    const newWidth = typeof draft.style?.width === 'number' ? draft.style.width : 320;
    const stageWidth = document.querySelector('.canvas-real-stage')?.getBoundingClientRect().width ?? 1000;
    const flowWidth = stageWidth / Math.max(.2, zoom / 100);
    const minX = nodes.length ? Math.min(...nodes.map(item => item.position.x)) : 120;
    const candidateX = rightmost + 80;
    const maxBottom = nodes.reduce((bottom, item) => Math.max(bottom, item.position.y + (item.measured?.height ?? (isCanvasGenerationNode(item.data.kind) ? 292 : 250))), top);
    const fallback = nodes.length ? (candidateX + newWidth <= minX + flowWidth - 60 ? { x: candidateX, y: top } : { x: minX, y: maxBottom + 70 }) : { x: 120, y: 120 };
    const node = { ...draft, position: position ?? fallback };
    node.type = 'qtv';
    setNodes(current => current.concat(node));
    setSelectedId(id);
    setInspectorOpen(false);
    setInsertMenu(null);
    setMessage('正在保存…');
    if (!position) window.requestAnimationFrame(() => void fitView({ padding: 0.16, maxZoom: 0.9, duration: 260 }));
  }, [fitView, nodes, setNodes, zoom]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const source = nodes.find(node => node.id === connection.source);
    const target = nodes.find(node => node.id === connection.target);
    if (target && isUnresolvedPaidCanvasNode(target.data)) { setMessage('待核查付费任务的引用已冻结，请先核查状态'); return; }
    const result = validateCanvasConnection(connection.source, connection.target, source?.data.kind, target?.data.kind, edges);
    if (!result.valid) { setMessage(result.message ?? '这两个节点不能连接'); return; }
    setEdges(current => addEdge({ ...connection, id: `edge-${connection.source}-${connection.target}`, data: { role: defaultReferenceRole(source!.data.kind, target!.data.kind) }, label: referenceRoleLabels[defaultReferenceRole(source!.data.kind, target!.data.kind)], style: edgeStyle }, current));
    setMessage('正在保存…');
  }, [edges, nodes, setEdges]);

  const autoConnectTarget = useCallback((moving: CanvasNode) => {
    const width = moving.measured?.width ?? 300; const height = moving.measured?.height ?? 180; const center = { x: moving.position.x + width / 2, y: moving.position.y + height / 2 };
    return nodesRef.current.find(candidate => candidate.id !== moving.id && !isUnresolvedPaidCanvasNode(candidate.data) && center.x >= candidate.position.x && center.x <= candidate.position.x + (candidate.measured?.width ?? 300) && center.y >= candidate.position.y && center.y <= candidate.position.y + (candidate.measured?.height ?? 180) && validateCanvasConnection(moving.id, candidate.id, moving.data.kind, candidate.data.kind, edgesRef.current).valid) ?? null;
  }, []);
  const onNodeDragStart = useCallback((_event: unknown, node: CanvasNode) => { nodeDragOrigins.current.set(node.id, { ...node.position }); }, []);
  const onNodeDrag = useCallback((_event: unknown, node: CanvasNode) => { setDragConnectTargetId(autoConnectTarget(node)?.id ?? null); }, [autoConnectTarget]);
  const onNodeDragStop = useCallback((_event: unknown, node: CanvasNode) => { const target = autoConnectTarget(node); setDragConnectTargetId(null); if (!target) { nodeDragOrigins.current.delete(node.id); return; } const origin = nodeDragOrigins.current.get(node.id); nodeDragOrigins.current.delete(node.id); if (origin) setNodes(current => current.map(item => item.id === node.id ? { ...item, position: origin } : item)); const role = defaultReferenceRole(node.data.kind, target.data.kind); setEdges(current => addEdge({ source: node.id, target: target.id, id: `edge-${node.id}-${target.id}`, data: { role }, label: referenceRoleLabels[role], style: edgeStyle }, current)); setMessage(`已自动连接为${referenceRoleLabels[role]}`); }, [autoConnectTarget, setEdges, setNodes]);

  const onDragStart = (event: DragEvent<HTMLButtonElement>, kind: CanvasNodeType) => {
    event.dataTransfer.setData('application/x-qtv-node', kind);
    event.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes('application/x-qtv-asset') ? 'copy' : 'move'; };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const rawAsset = event.dataTransfer.getData('application/x-qtv-asset');
    if (rawAsset) {
      try {
        const asset = JSON.parse(rawAsset) as { id?: unknown; name?: unknown; kind?: unknown; previewUrl?: unknown };
        if (typeof asset.id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.id) || typeof asset.name !== 'string' || !['image', 'video', 'audio'].includes(String(asset.kind))) return;
        const node = makeCanvasNode(CANVAS_NODE_TYPES.upload, position, `node-${crypto.randomUUID()}`);
        const mediaKind = asset.kind as 'image' | 'video' | 'audio';
        node.type = 'qtv';
        node.data = { ...node.data, label: asset.name.slice(0, 120), artifactId: asset.id, mediaKind, status: 'ready', ...(typeof asset.previewUrl === 'string' && mediaKind === 'image' ? { previewUrl: asset.previewUrl } : {}), ...(typeof asset.previewUrl === 'string' && mediaKind === 'video' ? { videoUrl: asset.previewUrl } : {}) };
        setNodes(current => current.concat(node));
        setSelectedId(node.id); setInsertMenu(null); setMessage('素材已放入画布');
      } catch { setMessage('素材数据无效，无法放入画布'); }
      return;
    }
    const kind = event.dataTransfer.getData('application/x-qtv-node') as CanvasNodeType;
    if (!palette.some(item => item.kind === kind)) return;
    createNode(kind, position);
  };
  const onPaneClick = () => {
    setSelectedId(null);
    setInspectorOpen(false);
    setInsertMenu(null);
    setContextMenu(null);
  };
  const onStageDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (!target.closest('.react-flow__pane')) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    setContextMenu(null);
    setInsertMenu({ mode: 'cursor', x: event.clientX - bounds.left, y: event.clientY - bounds.top, position: screenToFlowPosition({ x: event.clientX, y: event.clientY }) });
  };
  const contextCoordinates = (event: MouseEvent<Element> | globalThis.MouseEvent) => {
    const bounds = document.querySelector('.canvas-real-stage')?.getBoundingClientRect();
    const rawX = event.clientX - (bounds?.left ?? 0);
    const rawY = event.clientY - (bounds?.top ?? 0);
    return { x: Math.max(8, Math.min(rawX, (bounds?.width ?? rawX + 210) - 208)), y: Math.max(8, Math.min(rawY, (bounds?.height ?? rawY + 250) - 246)) };
  };
  const onPaneContextMenu = (event: MouseEvent<Element> | globalThis.MouseEvent) => {
    event.preventDefault();
    const point = contextCoordinates(event);
    setInsertMenu(null);
    setContextMenu({ kind: 'pane', ...point, position: screenToFlowPosition({ x: event.clientX, y: event.clientY }) });
  };
  const onNodeContextMenu = (event: MouseEvent<Element>, node: CanvasNode) => {
    if (node.data.origin === 'project') return;
    event.preventDefault();
    const point = contextCoordinates(event);
    setSelectedId(node.id);
    setInspectorOpen(false);
    setInsertMenu(null);
    setContextMenu({ kind: 'node', ...point, nodeId: node.id });
  };

  const openNodeSettings = useCallback((id: string) => {
    setSelectedId(id);
    setInspectorOpen(true);
    setInsertMenu(null);
  }, []);
  const updateNode = useCallback((id: string, patch: Partial<CanvasNodeData>) => {
    const target = nodesRef.current.find(node => node.id === id);
    if (target && isUnresolvedPaidCanvasNode(target.data)) {
      setMessage('该节点的付费任务结果尚未核实，配置已冻结；请先核查任务状态，或复制节点另建任务。');
      return;
    }
    setNodes(current => current.map(node => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node));
    setMessage('正在保存…');
  }, [setNodes]);
  const modelsFor = useCallback((kind: CanvasNodeType) => kind === CANVAS_NODE_TYPES.imageEdit ? modelCatalog.image : kind === CANVAS_NODE_TYPES.aiVideo ? modelCatalog.video : [], [modelCatalog]);
  const schemaFor = useCallback((modelName?: string) => modelName ? modelSchemas[modelName] : undefined, [modelSchemas]);
  useEffect(() => {
    for (const modelName of new Set(nodes.map(node => node.data.model).filter((name): name is string => !!name))) {
      if (modelSchemas[modelName] || loadingSchemas.current.has(modelName)) continue;
      loadingSchemas.current.add(modelName);
      void ports.models.schema(modelName).then(schema => setModelSchemas(current => ({ ...current, [modelName]: schema })))
        .catch(() => undefined).finally(() => loadingSchemas.current.delete(modelName));
    }
  }, [nodes, modelSchemas]);
  const selectModel = useCallback((id: string, modelName: string) => {
    const target = nodesRef.current.find(node => node.id === id);
    if (target && isUnresolvedPaidCanvasNode(target.data)) {
      setMessage('该节点的付费任务结果尚未核实；请先核查任务状态。');
      return;
    }
    updateNode(id, { model: modelName || undefined, settings: undefined, modeType: undefined, status: 'draft', jobId: undefined, progress: undefined });
    if (!modelName) return;
    void ports.models.schema(modelName).then(schema => {
      setModelSchemas(current => ({ ...current, [modelName]: schema }));
      const node = nodesRef.current.find(candidate => candidate.id === id);
      if (!node || node.data.model !== modelName || isUnresolvedPaidCanvasNode(node.data)) return;
      updateNode(id, { model: modelName, ...schemaDefaults(schema, node.data.kind) });
      setMessage(`已载入 ${modelName} 的真实模型参数`);
    }).catch(error => setMessage(error instanceof Error ? error.message : '模型参数载入失败'));
  }, [updateNode]);
  const toggleExpanded = useCallback((id: string) => {
    let opening = false;
    setExpandedNodeIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else { next.add(id); opening = true; }
      return next;
    });
    setSelectedId(id);
    setInspectorOpen(false);
    setInsertMenu(null);
    if (opening) window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(`[data-node-id="${CSS.escape(id)}"] textarea`)?.focus();
      void fitView({ nodes: nodes.filter(node => node.id === id), padding: 0.22, maxZoom: 0.9, duration: 220 });
    });
  }, [fitView, nodes]);
  const removeReference = useCallback((targetId: string, sourceId: string) => {
    const target = nodesRef.current.find(node => node.id === targetId);
    if (target && isUnresolvedPaidCanvasNode(target.data)) { setMessage('待核查付费任务的引用已冻结，请先核查状态'); return; }
    setEdges(current => current.filter(edge => !(edge.target === targetId && edge.source === sourceId)));
    setMessage('已移除上游引用');
  }, [setEdges]);
  const disconnectSelected = useCallback(() => {
    if (!selectedId) return;
    const frozenIds = new Set(nodesRef.current.filter(node => isUnresolvedPaidCanvasNode(node.data)).map(node => node.id));
    if (frozenIds.has(selectedId) || edgesRef.current.some(edge => edge.source === selectedId && frozenIds.has(edge.target))) { setMessage('不能断开待核查付费任务的引用，请先核查状态'); return; }
    setEdges(current => current.filter(edge => edge.source !== selectedId && edge.target !== selectedId));
    setContextMenu(null);
    setMessage('已断开节点的全部连线');
  }, [selectedId, setEdges]);
  const updateSelected = (patch: Partial<CanvasNodeData>) => { if (selectedId) updateNode(selectedId, patch); };
  const replaceRuntimeNode = (id: string, update: (node: CanvasNode) => CanvasNode) => {
    const next = nodesRef.current.map(node => node.id === id ? update(node) : node);
    nodesRef.current = next;
    setNodes(next);
  };
  const executeGeneration = async (id: string): Promise<boolean> => {
    const node = nodesRef.current.find(candidate => candidate.id === id);
    if (!node || !isRunnableGenerationNode(node.data.kind) || !node.data.prompt.trim() || !node.data.model) return false;
    const referenceNodes = edgesRef.current.filter(edge => edge.target === id && edge.data?.role !== 'text-input').map(edge => nodesRef.current.find(candidate => candidate.id === edge.source)).filter((item): item is CanvasNode => Boolean(item) && item?.data.kind !== CANVAS_NODE_TYPES.aiText);
    const referenceIds = referenceNodes.map(item => item.data.artifactId).filter((artifactId): artifactId is string => Boolean(artifactId));
    if (node.data.kind === CANVAS_NODE_TYPES.aiVideo) {
      const feedback = videoReferenceFeedback(modelSchemas[node.data.model], node.data.modeType ?? (referenceNodes.length ? 'singleImage2video' : 'text2video'), referenceNodes.map(item => ({ label: item.data.label, ...(item.data.artifactId ? { artifactId: item.data.artifactId } : {}), ...(item.data.mediaKind ? { mediaKind: item.data.mediaKind } : {}) })));
      if (feedback) { setMessage(feedback); return false; }
    }
    let recoveryRequestId: string | undefined;
    if (node.data.status === 'unknown' && node.data.jobId) {
      setMessage(`正在核查「${node.data.label}」的真实任务状态…`);
      try {
        const state = await ports.generation.status(projectId, node.data.jobId);
        if (state.phase === 'completed' && state.job?.asset) {
          const job = state.job; replaceRuntimeNode(id, item => ({ ...item, data: { ...item.data, status: 'ready', progress: 100, jobId: job.id, ...canvasJobResult(job) } })); setMessage(`「${node.data.label}」已从真实任务记录恢复`); return true;
        }
        if (state.phase === 'provider_finished') recoveryRequestId = state.requestId;
        else { setMessage(state.phase === 'failed' ? (state.error ?? '真实生成已明确失败') : '付费调用结果仍不明确，已保持冻结且不会自动重试'); return false; }
      } catch (error) { setMessage(error instanceof Error ? error.message : '无法核查真实生成状态'); return false; }
    }
    setGenerationBusy(id);
    replaceRuntimeNode(id, item => ({ ...item, data: { ...item.data, status: 'running', progress: 0 } }));
    setMessage(`正在运行「${node.data.label}」…`);
    try {
      const job = await ports.generation.create(projectId, node.data.prompt.trim(), node.data.kind, { nodeId: id, model: node.data.model, modeType: node.data.modeType, settings: node.data.settings, ratio: node.data.aspectRatio, referenceIds, rightsConfirmed: true, confirmCosts: true, ...(recoveryRequestId ? { requestId: recoveryRequestId } : {}), onStarted: requestId => replaceRuntimeNode(id, item => ({ ...item, data: { ...item.data, jobId: requestId } })) });
      const status = canvasJobStatus(job.status);
      replaceRuntimeNode(id, item => ({ ...item, data: { ...item.data, status, progress: job.progress, jobId: job.id, ...canvasJobResult(job) } }));
      if (job.status === 'succeeded' && job.asset) {
        const changed = invalidateCanvasDependents(nodesRef.current, edgesRef.current, id);
        if (changed.some((item, index) => item !== nodesRef.current[index])) { nodesRef.current = changed; setNodes(changed); }
      }
      const cost = job.cost ? `，实际消耗 ${job.cost.amount} ${job.cost.unit === 'credit' ? '积分' : '分'}` : '';
      setMessage(job.status === 'failed' ? '真实生成失败' : `「${node.data.label}」生成完成${cost}${job.notes?.length ? `；${job.notes.join('；')}` : ''}`);
      return job.status === 'succeeded';
    } catch (error) {
      const ambiguous = error instanceof Error && error.message.includes('GENERATION_STATUS_UNKNOWN');
      replaceRuntimeNode(id, item => ({ ...item, data: { ...item.data, status: ambiguous ? 'unknown' : 'failed', progress: 0 } }));
      setMessage(ambiguous ? '付费调用结果不明确，任务已冻结且不会自动重试' : error instanceof Error ? error.message : '真实生成失败');
      return false;
    }
  };
  const runGenerationPlan = async (targetId?: string) => {
    if (generationRunActive.current) return;
    let plan: string[];
    try { plan = canvasExecutionPlan(nodesRef.current, edgesRef.current, targetId); }
    catch (error) { setMessage(error instanceof Error ? error.message : '无法生成执行计划'); return; }
    if (!plan.length) { setMessage('没有需要运行的生成节点'); return; }
    const invalid = plan.map(id => nodesRef.current.find(node => node.id === id)!).find(node => !node.data.prompt.trim() || !node.data.model);
    if (invalid) { setMessage(`请先完成「${invalid.data.label}」的提示词和真实模型配置`); return; }
    if (plan.length > 1 && !window.confirm(`本轮计划按依赖顺序运行 ${plan.length} 个真实生成节点；每次外部模型调用前都会再次展示节点、模型与未知费用提示，逐项征得同意。取消后不会启动任何调用。`)) return;
    generationRunActive.current = true;
    try {
      for (const [index, id] of plan.entries()) {
        const node = nodesRef.current.find(item => item.id === id)!;
        if (!window.confirm(canvasNodeConsentText(node, index + 1, plan.length))) {
          setMessage(index === 0 ? '未授权真实生成，未发起新的生成任务' : '已停止后续生成；此前已完成的任务及费用不受影响');
          break;
        }
        if (!await executeGeneration(id)) { if (index < plan.length - 1) setMessage(previous => `${previous}；已停止后续生成`); break; }
      }
    } finally { generationRunActive.current = false; setGenerationBusy(null); }
  };
  useEffect(() => {
    if (readyProjectId !== projectId) return;
    for (const node of nodes.filter(item => item.data.jobId && ['queued', 'running', 'unknown'].includes(item.data.status))) {
      const requestId = node.data.jobId!; if (recoveringGenerationIds.current.has(requestId)) continue; recoveringGenerationIds.current.add(requestId);
      void ports.generation.status(projectId, requestId).then(async state => {
        if (state.phase === 'completed' && state.job?.asset) { replaceRuntimeNode(node.id, item => ({ ...item, data: { ...item.data, status: 'ready', progress: 100, ...canvasJobResult(state.job!) } })); return; }
        if (state.phase === 'provider_finished') { const referenceIds = edgesRef.current.filter(edge => edge.target === node.id).map(edge => nodesRef.current.find(item => item.id === edge.source)?.data.artifactId).filter((id): id is string => Boolean(id)); const job = await ports.generation.create(projectId, node.data.prompt.trim(), node.data.kind, { requestId, nodeId: node.id, model: node.data.model!, modeType: node.data.modeType, settings: node.data.settings, ratio: node.data.aspectRatio, referenceIds, rightsConfirmed: true, confirmCosts: true }); if (job.asset) replaceRuntimeNode(node.id, item => ({ ...item, data: { ...item.data, status: 'ready', progress: 100, ...canvasJobResult(job) } })); return; }
        replaceRuntimeNode(node.id, item => ({ ...item, data: { ...item.data, status: state.phase === 'failed' ? 'failed' : 'unknown', progress: 0 } }));
      }).catch(() => replaceRuntimeNode(node.id, item => ({ ...item, data: { ...item.data, status: 'unknown', progress: 0 } })));
    }
  }, [nodes, projectId, readyProjectId]);

  const removeSelected = useCallback(() => {
    if (!activeSelectionIds.length && !selectedEdgeIds.length) return;
    const ids = new Set(activeSelectionIds);
    const edgeIds = new Set(selectedEdgeIds);
    const frozenIds = new Set(nodesRef.current.filter(node => isUnresolvedPaidCanvasNode(node.data)).map(node => node.id));
    if ([...ids].some(id => frozenIds.has(id)) || edgesRef.current.some(edge => frozenIds.has(edge.target) && (ids.has(edge.source) || edgeIds.has(edge.id)))) { setMessage('不能删除待核查付费任务或其引用，请先核查状态'); return; }
    const description = activeSelectionIds.length ? (activeSelectionIds.length > 1 ? `${activeSelectionIds.length} 个节点及其连线` : '这个节点及其全部连线') : `${selectedEdgeIds.length} 条连线`;
    if (!window.confirm(`删除${description}？`)) return;
    setNodes(current => current.filter(node => !ids.has(node.id)));
    setEdges(current => current.filter(edge => !edgeIds.has(edge.id) && !ids.has(edge.source) && !ids.has(edge.target)));
    setExpandedNodeIds(current => { const next = new Set(current); for (const id of ids) next.delete(id); return next; });
    setSelectedId(null);
    setMessage(activeSelectionIds.length ? `已删除 ${ids.size} 个节点` : `已删除 ${edgeIds.size} 条连线`);
  }, [activeSelectionIds, selectedEdgeIds, setEdges, setNodes]);
  const duplicateSelected = useCallback(() => {
    if (!activeSelectionIds.length) return;
    const ids = new Set(activeSelectionIds);
    const selectedNodes = nodes.filter(node => ids.has(node.id));
    const idMap = new Map(selectedNodes.map(node => [node.id, `node-${crypto.randomUUID()}`]));
    const copies = selectedNodes.map(node => duplicateCanvasNode(node, idMap.get(node.id)!));
    setNodes(current => [...current.map(node => ({ ...node, selected: false })), ...copies]);
    setEdges(current => current.concat(current.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => ({ ...edge, id: `edge-${crypto.randomUUID()}`, source: idMap.get(edge.source)!, target: idMap.get(edge.target)! }))));
    setSelectedId(copies[copies.length - 1]?.id ?? null);
    setMessage(`已复制 ${copies.length} 个节点`);
  }, [activeSelectionIds, nodes, setEdges, setNodes]);
  const clearCanvas = () => {
    if (nodes.some(node => isUnresolvedPaidCanvasNode(node.data))) { setMessage('仍有待核查的付费任务，不能清空画布'); return; }
    if (nodes.length && !window.confirm('清空当前画布的全部节点与连线？你可以随后使用撤销恢复。')) return;
    setNodes([]); setEdges([]); setExpandedNodeIds(new Set()); setSelectedId(null); setInsertMenu(null);
  };
  const restoreDemo = () => {
    if (nodes.some(node => isUnresolvedPaidCanvasNode(node.data))) { setMessage('仍有待核查的付费任务，不能恢复初始结构'); return; }
    const document: CanvasDocument = initialCanvas(projectId);
    setNodes(document.nodes.map(node => ({ ...node, type: 'qtv' })));
    setEdges(document.edges);
    setSelectedId(document.nodes[0]?.id ?? null);
    setInsertMenu(null);
    window.requestAnimationFrame(() => void fitView({ padding: 0.22, duration: 240, maxZoom: 1 }));
  };
  const submitInspector = (event: FormEvent) => event.preventDefault();
  const onMove = (_: unknown, viewport: Viewport) => setZoom(Math.round(viewport.zoom * 100));
  const restoreSnapshot = useCallback((snapshot: string, notice: string) => {
    if (nodesRef.current.some(node => isUnresolvedPaidCanvasNode(node.data))) { setMessage('有待核查付费任务时暂停撤销与重做，以免丢失任务编号'); return false; }
    const document = parseCanvasDocument(snapshot);
    if (!document) return false;
    applyingHistory.current = true;
    lastSnapshot.current = snapshot;
    setNodes(document.nodes.map(node => ({ ...node, type: 'qtv' })));
    setEdges(document.edges);
    setSelectedId(null);
    setInsertMenu(null);
    setMessage(notice);
    window.requestAnimationFrame(() => { applyingHistory.current = false; });
    return true;
  }, [setEdges, setNodes]);
  const undoCanvas = useCallback(() => {
    if (nodesRef.current.some(node => isUnresolvedPaidCanvasNode(node.data))) { setMessage('有待核查付费任务时暂停撤销与重做，以免丢失任务编号'); return; }
    const current = serializeCanvasDocument({ nodes, edges });
    const target = current !== lastSnapshot.current ? lastSnapshot.current : undoStack.current.pop();
    if (!target) return;
    redoStack.current.push(current);
    if (!restoreSnapshot(target, '已撤销上一步操作')) return;
    setHistoryCounts({ undo: undoStack.current.length, redo: redoStack.current.length });
  }, [edges, nodes, restoreSnapshot]);
  const redoCanvas = useCallback(() => {
    if (nodesRef.current.some(node => isUnresolvedPaidCanvasNode(node.data))) { setMessage('有待核查付费任务时暂停撤销与重做，以免丢失任务编号'); return; }
    const current = serializeCanvasDocument({ nodes, edges });
    const target = redoStack.current.pop();
    if (!target) return;
    undoStack.current = [...undoStack.current.slice(-49), current];
    if (!restoreSnapshot(target, '已重做上一步操作')) return;
    setHistoryCounts({ undo: undoStack.current.length, redo: redoStack.current.length });
  }, [edges, nodes, restoreSnapshot]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (draftReview) return;
      const target = event.target as HTMLElement | null;
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') { setInsertMenu(null); setContextMenu(null); setSelectedId(null); setInspectorOpen(false); setSpaceHeld(false); (target as HTMLElement | null)?.blur?.(); return; }
      if (target?.closest('input,textarea,select,[contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); event.shiftKey ? redoCanvas() : undoCanvas(); return; }
      if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redoCanvas(); return; }
      if ((event.ctrlKey || event.metaKey) && key === 'd' && selectedId) { event.preventDefault(); duplicateSelected(); return; }
      if (event.code === 'Space') { event.preventDefault(); setSpaceHeld(true); return; }
      if (key === 'v') { event.preventDefault(); setMouseMode('select'); return; }
      if (key === 'h') { event.preventDefault(); setMouseMode('hand'); return; }
      if (key === 'c') { event.preventDefault(); setMouseMode('connect'); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { if (activeSelectionIds.length || selectedEdgeIds.length) { event.preventDefault(); removeSelected(); } return; }
      if (key === 'n') { event.preventDefault(); setInsertMenu({ mode: 'toolbar' }); return; }
      if (key === 'f') { event.preventDefault(); void fitView({ padding: 0.18, duration: 240, maxZoom: 1 }); return; }
      if (key === 'm') { event.preventDefault(); setMiniMapOpen(value => !value); return; }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); void zoomIn({ duration: 140 }); return; }
      if (event.key === '-') { event.preventDefault(); void zoomOut({ duration: 140 }); }
    };
    const releaseSpace = (event: KeyboardEvent) => { if (event.code === 'Space') setSpaceHeld(false); };
    const releaseTransientMode = () => setSpaceHeld(false);
    window.addEventListener('keydown', onShortcut);
    window.addEventListener('keyup', releaseSpace);
    window.addEventListener('blur', releaseTransientMode);
    return () => {
      window.removeEventListener('keydown', onShortcut);
      window.removeEventListener('keyup', releaseSpace);
      window.removeEventListener('blur', releaseTransientMode);
    };
  }, [draftReview, duplicateSelected, fitView, redoCanvas, removeSelected, selectedId, undoCanvas, zoomIn, zoomOut]);

  const recoverPendingDraft = async () => {
    if (draftReview?.state !== 'recoverable') return;
    try {
      const snapshot = await ports.canvasDocuments.load(projectId);
      const pending = inspectCanvasDraft(window.localStorage, projectId, snapshot);
      if (pending.state !== 'recoverable' || !pending.draft) {
        setDraftReview(pending.state === 'saved' ? null : pending);
        setMessage('服务器或本机草稿已发生变化，未自动覆盖；请重新检查或导出。');
        if (pending.state === 'saved') window.location.reload();
        return;
      }
      resolveLoadedCanvasDocument(snapshot.document, initialCanvas(projectId));
      const restored = restoreRegisteredCanvasResults(resolveLoadedCanvasDocument(pending.draft.document, initialCanvas(projectId)), pending.draft.document, snapshot.registeredArtifacts ?? []);
      projectRevisions.current.set(projectId, snapshot.projectRevision);
      canvasDocumentRevisions.current.set(projectId, snapshot.documentRevision);
      lastSavedDocuments.current.set(projectId, snapshot.document ? JSON.stringify(snapshot.document) : '');
      lastSnapshot.current = serializeCanvasDocument(restored);
      setNodes(hydrateCanvasPreviewUrls(projectId, restored.nodes));
      setEdges(restored.edges);
      setDraftReview(null);
      setReadyProjectId(projectId);
      setMessage('本机草稿已恢复，正在写入服务器…');
    } catch (error) { setMessage(error instanceof Error ? error.message : '草稿核对失败，未覆盖服务器'); }
  };
  const downloadPendingDraft = () => {
    if (!draftReview?.raw) return;
    const url = URL.createObjectURL(new Blob([draftReview.raw], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `xiaoq-canvas-draft-${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const discardPendingDraft = () => {
    if (!window.confirm('确定丢弃本机未保存草稿？建议先下载备份；此操作不会更改服务器画布。')) return;
    try { discardCanvasDraft(window.localStorage, projectId); window.location.reload(); }
    catch { setMessage('无法删除本机草稿；请先导出并检查浏览器存储'); }
  };
  const handActive = mouseMode === 'hand' || spaceHeld;
  const previewNode = previewNodeId ? nodes.find(node => node.id === previewNodeId) ?? null : null;

  return (
    <CanvasNodeActionsContext.Provider value={{ openSettings: openNodeSettings, toggleExpanded, updateNode, runNode: id => void runGenerationPlan(id), selectModel, modelsFor, schemaFor, removeReference, previewMedia: setPreviewNodeId }}>
    <section className="qtv-canvas-shell" aria-label="故事板画布">
      <div inert={Boolean(draftReview)} className={`canvas-real-stage is-mode-${handActive ? 'hand' : mouseMode}${selected ? ' has-selection' : ''}`} onDragOver={onDragOver} onDrop={onDrop} onDoubleClickCapture={onStageDoubleClick}>
        <ReactFlow<CanvasNode, CanvasEdge>
          nodes={renderNodes} edges={renderEdges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeDragStart={onNodeDragStart} onNodeDrag={onNodeDrag} onNodeDragStop={onNodeDragStop}
          onNodeClick={(_, node) => { if (node.data.origin === 'project') { setSelectedId(null); setInspectorOpen(false); return; } setSelectedId(node.id); setInspectorOpen(!isCanvasGenerationNode(node.data.kind)); setInsertMenu(null); }}
          onSelectionChange={({ nodes: selection }) => { if (selection.length) setSelectedId(selection[selection.length - 1]?.id ?? null); }}
          onNodeDoubleClick={(_, node) => { if (node.data.origin === 'project') return; setSelectedId(node.id); setInspectorOpen(true); }}
          onEdgeClick={() => { setSelectedId(null); setInspectorOpen(false); setContextMenu(null); }}
          onPaneClick={onPaneClick} onPaneContextMenu={onPaneContextMenu} onNodeContextMenu={onNodeContextMenu}
          onMove={onMove}
          fitView fitViewOptions={{ padding: 0.22, maxZoom: 1 }} deleteKeyCode={null}
          nodesConnectable={!handActive} nodesDraggable={!handActive && mouseMode === 'select'} elementsSelectable={!handActive}
          selectionOnDrag={!handActive && mouseMode === 'select'} defaultEdgeOptions={{ style: edgeStyle }} minZoom={0.2} maxZoom={2}
          panOnScroll panOnDrag={handActive}
        >
          <Background variant={BackgroundVariant.Dots} gap={28} size={0.75} color="#202020" />
          {miniMapOpen ? <MiniMap pannable zoomable ariaLabel="画布小地图" nodeColor={node => node.id === selectedId ? 'var(--brand-300)' : 'var(--canvas-minimap-node)'} /> : null}
        </ReactFlow>

        <div className="qtv-canvas-tip"><Sparkles size={13} /><span>双击画布添加节点</span></div>

        {insertMenu ? <div className={`qtv-insert-menu is-${insertMenu.mode}`} style={insertMenu.mode === 'cursor' ? { left: insertMenu.x, top: insertMenu.y } : undefined} role="dialog" aria-label="添加节点"><div className="qtv-insert-head"><div><strong>添加节点</strong><small>点击创建，或拖到画布</small></div><button type="button" aria-label="关闭节点菜单" onClick={() => setInsertMenu(null)}><X size={15} /></button></div><div className="qtv-insert-grid">{palette.map(({ kind, icon: Icon, detail, tone }, index) => <button key={kind} className={`tone-${tone}`} style={{ '--item-index': index } as CSSProperties} draggable onDragStart={event => onDragStart(event, kind)} onClick={() => createNode(kind, insertMenu.position)}><span><Icon size={16} /></span><div><b>{CANVAS_NODE_LABELS[kind]}</b><small>{detail}</small></div></button>)}</div><div className="qtv-insert-foot"><button type="button" onClick={restoreDemo}>恢复初始结构</button><button type="button" className="danger" onClick={clearCanvas}>清空画布</button></div></div> : null}

        {contextMenu ? <div className="qtv-context-menu" role="menu" aria-label={contextMenu.kind === 'pane' ? '画布菜单' : '节点菜单'} style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={event => event.preventDefault()}>{contextMenu.kind === 'pane' ? <><button type="button" role="menuitem" onClick={() => { setInsertMenu({ mode: 'cursor', x: contextMenu.x, y: contextMenu.y, position: contextMenu.position }); setContextMenu(null); }}><Plus size={14} />添加节点</button><button type="button" role="menuitem" onClick={() => { void fitView({ padding: .18, duration: 220, maxZoom: 1 }); setContextMenu(null); }}><LocateFixed size={14} />定位全部</button><span /><button type="button" role="menuitemradio" aria-checked={mouseMode === 'select'} onClick={() => { setMouseMode('select'); setContextMenu(null); }}><MousePointer2 size={14} />选择模式 <kbd>V</kbd></button><button type="button" role="menuitemradio" aria-checked={mouseMode === 'hand'} onClick={() => { setMouseMode('hand'); setContextMenu(null); }}><Hand size={14} />抓手模式 <kbd>H</kbd></button><button type="button" role="menuitemradio" aria-checked={mouseMode === 'connect'} onClick={() => { setMouseMode('connect'); setContextMenu(null); }}><Cable size={14} />连接模式 <kbd>C</kbd></button></> : <><button type="button" role="menuitem" disabled={!selected || !isRunnableGenerationNode(selected.data.kind)} onClick={() => { if (selectedId) void runGenerationPlan(selectedId); setContextMenu(null); }}><Play size={14} />运行 / 重跑</button><button type="button" role="menuitem" onClick={() => { duplicateSelected(); setContextMenu(null); }}><Copy size={14} />复制节点</button><button type="button" role="menuitem" onClick={disconnectSelected}><Unlink size={14} />断开全部连线</button><button type="button" role="menuitem" onClick={() => { if (selectedId) openNodeSettings(selectedId); setContextMenu(null); }}><Settings2 size={14} />检查节点</button><span /><button type="button" role="menuitem" className="danger" onClick={() => { removeSelected(); setContextMenu(null); }}><Trash2 size={14} />删除节点</button></>}</div> : null}

        {selected && inspectorOpen ? <form className="qtv-node-inspector" aria-label="节点属性" onSubmit={submitInspector}><div className="qtv-inspector-head"><div><span>{CANVAS_NODE_LABELS[selected.data.kind]}</span><strong>节点属性</strong></div><button type="button" aria-label="关闭节点属性" onClick={() => { setSelectedId(null); setInspectorOpen(false); }}><X size={15} /></button></div><label><span>名称</span><input name="node-name" autoComplete="off" value={selected.data.label} maxLength={120} disabled={isUnresolvedPaidCanvasNode(selected.data)} onChange={event => updateSelected({ label: event.target.value })} /></label>{isCanvasGenerationNode(selected.data.kind) ? <button type="button" className="qtv-inspector-open-composer" onClick={() => toggleExpanded(selected.id)}>{expandedNodeIds.has(selected.id) ? '收起节点生成配置' : '展开节点生成配置'}</button> : null}<label><span>画幅</span><select name="aspect-ratio" value={selected.data.aspectRatio} disabled={isUnresolvedPaidCanvasNode(selected.data)} onChange={event => updateSelected({ aspectRatio: event.target.value })}>{IMAGE_ASPECT_RATIOS.map(ratio => <option key={ratio}>{ratio}</option>)}</select></label><div className="qtv-inspector-status"><span><i className={selected.data.status} />执行状态</span><b>{canvasStatusLabel(selected.data.status, selected.data.kind === CANVAS_NODE_TYPES.upload)}</b></div><div className="qtv-inspector-actions"><button type="button" onClick={duplicateSelected}><Copy size={14} />复制</button><button type="button" className="danger" onClick={removeSelected}><Trash2 size={14} />删除</button></div></form> : null}

        <div className="qtv-canvas-dock" aria-label="画布工具栏">
          <button className="qtv-dock-primary" type="button" aria-label="添加节点" data-tooltip="添加节点 · 双击画布" onClick={() => setInsertMenu(current => current?.mode === 'toolbar' ? null : { mode: 'toolbar' })}><Plus size={18} /></button>
          <button type="button" aria-label="运行全部" data-tooltip="按依赖顺序运行全部" disabled={generationBusy !== null} onClick={() => void runGenerationPlan()}><Play size={15} /></button>
          {saveFailed && readyProjectId === projectId ? <button type="button" aria-label="重试保存" data-tooltip="重试写入服务器画布" onClick={() => { const latest = latestDocuments.current.get(projectId); if (latest) void queueDocumentSave(projectId, latest.document, latest.serialized, true); }}>重试保存</button> : null}
          <span className="qtv-dock-separator" />
          <button type="button" aria-label="撤销" data-tooltip="撤销 · Ctrl Z" disabled={historyCounts.undo === 0 || nodes.some(node => isUnresolvedPaidCanvasNode(node.data))} onClick={undoCanvas}><Undo2 size={15} /></button>
          <button type="button" aria-label="重做" data-tooltip="重做 · Ctrl Shift Z" disabled={historyCounts.redo === 0 || nodes.some(node => isUnresolvedPaidCanvasNode(node.data))} onClick={redoCanvas}><Redo2 size={15} /></button>
          <span className="qtv-dock-separator" />
          <button type="button" aria-label="选择工具" data-tooltip="选择 · V" aria-pressed={mouseMode === 'select'} className={mouseMode === 'select' ? 'is-active' : ''} onClick={() => setMouseMode('select')}><MousePointer2 size={16} /></button>
          <button type="button" aria-label="抓手工具" data-tooltip="平移 · H / Space" aria-pressed={mouseMode === 'hand'} className={mouseMode === 'hand' ? 'is-active' : ''} onClick={() => setMouseMode('hand')}><Hand size={16} /></button>
          <button type="button" aria-label="连接工具" data-tooltip="连接 · C" aria-pressed={mouseMode === 'connect'} className={mouseMode === 'connect' ? 'is-active' : ''} onClick={() => setMouseMode('connect')}><Cable size={16} /></button>
          <button type="button" aria-label="定位全部节点" data-tooltip="定位全部 · F" onClick={() => void fitView({ padding: 0.22, duration: 240, maxZoom: 1 })}><LocateFixed size={16} /></button>
          <button type="button" aria-label="切换小地图" data-tooltip="小地图 · M" aria-pressed={miniMapOpen} className={miniMapOpen ? 'is-active' : ''} onClick={() => setMiniMapOpen(value => !value)}><Boxes size={16} /></button>
          <span className="qtv-dock-separator" />
          <button type="button" aria-label="缩小画布" data-tooltip="缩小 · −" onClick={() => void zoomOut({ duration: 140 })}><Minus size={15} /></button>
          <output aria-label="当前缩放比例">{zoom}%</output>
          <button type="button" aria-label="放大画布" data-tooltip="放大 · +" onClick={() => void zoomIn({ duration: 140 })}><Plus size={15} /></button>
        </div>
      </div>
      {draftReview ? <div className="qtv-draft-overlay"><div role="dialog" aria-modal="true" aria-label="核对本机未保存草稿" className="qtv-draft-dialog"><h2>发现本机未保存的画布草稿</h2><p>{draftReview.state === 'recoverable' ? '服务器画布未变更。你可以恢复草稿，再由小QTV 保存到服务器。' : draftReview.state === 'invalid' ? '草稿格式无法解析；不会自动应用或覆盖服务器。请先下载原始草稿备份。' : '服务器画布无法核对或已变更；为避免覆盖其他编辑，不能自动合并草稿。请下载备份后人工核对。'}</p><div><button type="button" onClick={downloadPendingDraft}>下载本机草稿</button>{draftReview.state === 'recoverable' ? <button type="button" onClick={() => void recoverPendingDraft()}>恢复并保存</button> : null}<button type="button" onClick={discardPendingDraft}>丢弃草稿并载入服务器</button></div></div></div> : null}
      {draftStorageFailed && !draftReview ? <div className="qtv-draft-storage-warning" role="status">浏览器无法保存本机草稿；在服务器确认“已保存”前请勿关闭页面。</div> : null}
      {previewNode && (previewNode.data.previewUrl || previewNode.data.videoUrl) ? <div className="qtv-media-lightbox" role="dialog" aria-modal="true" aria-label={`${previewNode.data.label}全屏预览`} onClick={() => setPreviewNodeId(null)}><button type="button" aria-label="关闭全屏预览" onClick={() => setPreviewNodeId(null)}><X size={20} /></button>{previewNode.data.videoUrl ? <video controls autoPlay src={previewNode.data.videoUrl} onClick={event => event.stopPropagation()} /> : <img src={previewNode.data.previewUrl} alt={`${previewNode.data.label}大图预览`} onClick={event => event.stopPropagation()} />}</div> : null}
    </section>
    </CanvasNodeActionsContext.Provider>
  );
}

export function Canvas({ projectId, onSaveStateChange, onNodeCatalogChange, openInsertSignal }: { projectId: string; onSaveStateChange?: (state: string) => void; onNodeCatalogChange?: (nodes: Array<{ id: string; label: string }>) => void; openInsertSignal?: number }) {
  return <ReactFlowProvider><CanvasInner key={projectId} projectId={projectId} onSaveStateChange={onSaveStateChange} onNodeCatalogChange={onNodeCatalogChange} openInsertSignal={openInsertSignal} /></ReactFlowProvider>;
}
