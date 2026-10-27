import type { Edge, Node } from '@xyflow/react';
import type { CanvasReferenceRole, PersistedCanvasDocument } from '../../ports/index.js';
import { CANVAS_NODE_LABELS, CANVAS_NODE_TYPES, IMAGE_ASPECT_RATIOS, isCanvasGenerationNode, type CanvasNodeType } from '../../domain/canvas.js';
import { validateCanvasConnection } from '../../domain/canvasConnections.js';

export type CanvasNodeReference = { sourceId: string; label: string; kind: CanvasNodeType; role?: CanvasReferenceRole; mediaKind?: 'image' | 'video' | 'audio'; artifactId?: string };
export type CanvasEdge = Edge<{ role?: CanvasReferenceRole }>;
export type CanvasNodeData = { label: string; kind: CanvasNodeType; aspectRatio: string; prompt: string; model?: string; modeType?: string; count?: number; settings?: Record<string, string | number | boolean>; artifactId?: string; mediaKind?: 'image' | 'video' | 'audio'; jobId?: string; progress?: number; references?: CanvasNodeReference[]; expanded?: boolean; origin?: 'project'; previewUrl?: string; videoUrl?: string; variants?: Array<{ artifactId: string; previewUrl?: string; mediaKind: 'image' | 'video' | 'audio'; name: string }>; status: 'ready' | 'draft' | 'queued' | 'running' | 'failed' | 'unknown' };
export type CanvasNode = Node<CanvasNodeData>;
export type CanvasDocument = { nodes: CanvasNode[]; edges: CanvasEdge[] };
const referenceRoles = new Set<CanvasReferenceRole>(['first-frame', 'last-frame', 'reference-image', 'reference-video', 'reference-audio', 'text-input']);
const STORAGE_PREFIX = 'qiyin.canvas.v1.';
const validKinds = new Set<string>(Object.values(CANVAS_NODE_TYPES));
function nodeWidth(kind: CanvasNodeType) {
  if (isCanvasGenerationNode(kind)) return 500;
  if (kind === CANVAS_NODE_TYPES.upload || kind === CANVAS_NODE_TYPES.video || kind === CANVAS_NODE_TYPES.audio) return 300;
  return 320;
}

export function makeCanvasNode(kind: CanvasNodeType, position: { x: number; y: number }, id: string): CanvasNode {
  return { id, type: 'default', position, data: { label: CANVAS_NODE_LABELS[kind], kind, aspectRatio: IMAGE_ASPECT_RATIOS[1], prompt: '', status: kind === CANVAS_NODE_TYPES.upload ? 'ready' : 'draft' }, style: { width: nodeWidth(kind) } };
}

/** 复制生成节点只复用创作配置，不能把原节点的已验证产物冒充副本的生成结果。 */
export function duplicateCanvasNode(node: CanvasNode, id: string): CanvasNode {
  const copy = makeCanvasNode(node.data.kind, { x: node.position.x + 36, y: node.position.y + 36 }, id);
  copy.type = 'qtv';
  copy.selected = true;
  const generation = isCanvasGenerationNode(node.data.kind);
  const data = { ...node.data };
  delete data.jobId; delete data.progress; delete data.references; delete data.expanded;
  if (generation) { delete data.artifactId; delete data.mediaKind; delete data.previewUrl; delete data.videoUrl; delete data.variants; }
  copy.data = { ...data, label: `${node.data.label} · 副本`, status: generation ? 'draft' : node.data.status };
  return copy;
}

/** 重跑或上游修改时保留的媒体仅是上次成功版本，不是本次任务结果。 */
export function isPreviousCanvasResult(data: CanvasNodeData): boolean {
  return Boolean(data.artifactId && data.status !== 'ready');
}

/** 仅依据服务端同项目已发布的、与原任务绑定的产物，恢复刷新前的成功状态。 */
export function restoreRegisteredCanvasResults(
  document: CanvasDocument,
  saved: PersistedCanvasDocument | null,
  registered: Array<{ artifactId: string; mediaType: string; nodeId: string; requestId?: string }>,
): CanvasDocument {
  if (!saved) return document;
  const original = new Map(saved.nodes.map(node => [node.id, node]));
  const nodes = document.nodes.map(node => {
    const { artifactId, jobId, mediaKind, kind } = node.data;
    const expectedMedia = kind === CANVAS_NODE_TYPES.imageEdit ? 'image/' : kind === CANVAS_NODE_TYPES.aiVideo ? 'video/' : null;
    const prior = original.get(node.id)?.data;
    if (!expectedMedia) return node;
    const belongsToJob = (id: string, type: string) => Boolean(jobId && registered.some(item => item.artifactId === id && item.mediaType.startsWith(type) && (item.requestId === jobId && item.nodeId === node.id || item.requestId === undefined && item.nodeId === `web-${jobId}`)));
    const matched = Boolean(artifactId && mediaKind === expectedMedia.slice(0, -1) && belongsToJob(artifactId, expectedMedia));
    const data = { ...node.data };
    if (matched) {
      if (data.variants) data.variants = data.variants.filter(item => item.mediaKind === mediaKind && belongsToJob(item.artifactId, expectedMedia));
    } else {
      delete data.artifactId; delete data.mediaKind; delete data.previewUrl; delete data.videoUrl; delete data.variants;
      if (prior?.status !== 'running' && prior?.status !== 'queued' && prior?.status !== 'unknown') delete data.jobId;
    }
    if (prior?.status === 'running' || prior?.status === 'queued' || prior?.status === 'unknown') data.status = 'unknown';
    else if (prior?.status === 'ready' && matched) data.status = 'ready';
    return { ...node, data };
  });
  return { ...document, nodes };
}

export function isUnresolvedPaidCanvasNode(data: CanvasNodeData): boolean {
  return Boolean(data.jobId && (data.status === 'unknown' || data.status === 'queued' || data.status === 'running'));
}

export function indexCanvasReferences(nodes: CanvasNode[], edges: CanvasEdge[]): Map<string, CanvasNodeReference[]> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const references = new Map<string, CanvasNodeReference[]>();
  for (const edge of edges) {
    const source = byId.get(edge.source);
    if (!source) continue;
    const items = references.get(edge.target) ?? [];
    items.push({ sourceId: source.id, label: source.data.label, kind: source.data.kind, ...(source.data.mediaKind ? { mediaKind: source.data.mediaKind } : {}), ...(source.data.artifactId ? { artifactId: source.data.artifactId } : {}), ...(edge.data?.role ? { role: edge.data.role } : {}) });
    references.set(edge.target, items);
  }
  return references;
}

export function initialCanvas(projectId: string): CanvasDocument {
  if (projectId !== 'p-demo') return { nodes: [], edges: [] };
  const source = makeCanvasNode(CANVAS_NODE_TYPES.upload, { x: 60, y: 150 }, 'p-demo-source');
  source.data.label = '雨夜街道参考';
  const shot = makeCanvasNode(CANVAS_NODE_TYPES.imageEdit, { x: 440, y: 130 }, 'p-demo-shot');
  shot.data.label = '02 · 橱窗倒影';
  shot.data.prompt = '雨夜街道，橱窗倒影中的电影感人物镜头';
  return { nodes: [source, shot], edges: [{ id: 'p-demo-source-shot', source: source.id, target: shot.id }] };
}

/** 只接受本应用认识的字段；不信任 localStorage 里的样式、任务状态或连线。 */
export function parseCanvasDocument(raw: string | null): CanvasDocument | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const input = parsed as { version?: unknown; nodes?: unknown; edges?: unknown };
    if (input.version !== 1 || !Array.isArray(input.nodes) || !Array.isArray(input.edges) || input.nodes.length > 500 || input.edges.length > 1000) return null;
    const nodes: CanvasNode[] = [];
    const ids = new Set<string>();
    for (const value of input.nodes) {
      if (!value || typeof value !== 'object') return null;
      const item = value as { id?: unknown; kind?: unknown; label?: unknown; x?: unknown; y?: unknown; aspectRatio?: unknown; prompt?: unknown; model?: unknown; modeType?: unknown; count?: unknown; settings?: unknown; artifactId?: unknown; mediaKind?: unknown; jobId?: unknown; variants?: unknown };
      if (typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id) || typeof item.kind !== 'string' || !validKinds.has(item.kind) || typeof item.label !== 'string' || item.label.length > 120 || typeof item.x !== 'number' || !Number.isFinite(item.x) || typeof item.y !== 'number' || !Number.isFinite(item.y)) return null;
      ids.add(item.id);
      const node = makeCanvasNode(item.kind as CanvasNodeType, { x: item.x, y: item.y }, item.id);
      node.data.label = item.label;
      if (item.prompt !== undefined && (typeof item.prompt !== 'string' || item.prompt.length > 2000)) return null;
      node.data.prompt = typeof item.prompt === 'string' ? item.prompt : isCanvasGenerationNode(node.data.kind) ? item.label : '';
      if (item.model !== undefined && (typeof item.model !== 'string' || item.model.length > 120)) return null;
      if (typeof item.model === 'string' && item.model) node.data.model = item.model;
      if (item.modeType !== undefined && (typeof item.modeType !== 'string' || item.modeType.length > 80)) return null;
      if (typeof item.modeType === 'string' && item.modeType) node.data.modeType = item.modeType;
      if (item.count !== undefined && (typeof item.count !== 'number' || !Number.isInteger(item.count) || item.count < 1 || item.count > 4)) return null;
      if (typeof item.count === 'number') node.data.count = item.count;
      if (item.settings !== undefined) {
        if (!item.settings || typeof item.settings !== 'object' || Array.isArray(item.settings)) return null;
        const entries = Object.entries(item.settings as Record<string, unknown>);
        if (entries.length > 40 || entries.some(([key, setting]) => key.length > 80 || !['string', 'number', 'boolean'].includes(typeof setting))) return null;
        node.data.settings = Object.fromEntries(entries) as Record<string, string | number | boolean>;
      }
      if (item.artifactId !== undefined && (typeof item.artifactId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.artifactId))) return null;
      if (typeof item.artifactId === 'string') node.data.artifactId = item.artifactId;
      if (item.mediaKind !== undefined && item.mediaKind !== 'image' && item.mediaKind !== 'video' && item.mediaKind !== 'audio') return null;
      if (item.mediaKind === 'image' || item.mediaKind === 'video' || item.mediaKind === 'audio') node.data.mediaKind = item.mediaKind;
      if (item.jobId !== undefined && (typeof item.jobId !== 'string' || !item.jobId || item.jobId.length > 120)) return null;
      if (typeof item.jobId === 'string') node.data.jobId = item.jobId;
      if (item.variants !== undefined) {
        if (!Array.isArray(item.variants) || item.variants.length > 8 || item.variants.some(variant => !variant || typeof variant !== 'object' || !/^sha256:[a-f0-9]{64}$/.test(variant.artifactId) || !['image', 'video', 'audio'].includes(variant.mediaKind) || typeof variant.name !== 'string' || variant.name.length > 200)) return null;
        node.data.variants = item.variants.map(variant => ({ artifactId: variant.artifactId as string, mediaKind: variant.mediaKind as 'image' | 'video' | 'audio', name: variant.name as string }));
      }
      if (typeof item.aspectRatio === 'string' && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(item.aspectRatio)) node.data.aspectRatio = item.aspectRatio;
      nodes.push(node);
    }
    const edges: CanvasEdge[] = [];
    for (const value of input.edges) {
      if (!value || typeof value !== 'object') return null;
      const edge = value as { source?: unknown; target?: unknown; role?: unknown };
      if (typeof edge.source !== 'string' || typeof edge.target !== 'string') return null;
      if (edge.role !== undefined && (typeof edge.role !== 'string' || !referenceRoles.has(edge.role as CanvasReferenceRole))) return null;
      const source = nodes.find(node => node.id === edge.source);
      const target = nodes.find(node => node.id === edge.target);
      if (!validateCanvasConnection(edge.source, edge.target, source?.data.kind, target?.data.kind, edges).valid) return null;
      edges.push({ id: `edge-${edge.source}-${edge.target}`, source: edge.source, target: edge.target, ...(typeof edge.role === 'string' ? { data: { role: edge.role as CanvasReferenceRole } } : {}) });
    }
    return { nodes, edges };
  } catch { return null; }
}

export function serializeCanvasDocument(document: CanvasDocument): string {
  const localNodes = document.nodes.filter(node => node.data.origin !== 'project');
  const localIds = new Set(localNodes.map(node => node.id));
  return JSON.stringify({ version: 1, nodes: localNodes.map(node => ({ id: node.id, kind: node.data.kind, label: node.data.label, x: node.position.x, y: node.position.y, aspectRatio: node.data.aspectRatio, prompt: node.data.prompt, ...(node.data.model ? { model: node.data.model } : {}), ...(node.data.modeType ? { modeType: node.data.modeType } : {}), ...(node.data.count ? { count: node.data.count } : {}), ...(node.data.settings ? { settings: node.data.settings } : {}), ...(node.data.artifactId ? { artifactId: node.data.artifactId } : {}), ...(node.data.mediaKind ? { mediaKind: node.data.mediaKind } : {}), ...(node.data.jobId ? { jobId: node.data.jobId } : {}), ...(node.data.variants?.length ? { variants: node.data.variants.map(variant => ({ artifactId: variant.artifactId, mediaKind: variant.mediaKind, name: variant.name })) } : {}) })), edges: document.edges.filter(edge => localIds.has(edge.source) && localIds.has(edge.target)).map(edge => ({ source: edge.source, target: edge.target, ...(edge.data?.role ? { role: edge.data.role } : {}) })) });
}

export function resolveLoadedCanvasDocument(input: PersistedCanvasDocument | null, legacy: CanvasDocument): CanvasDocument {
  if (!input) return legacy;
  const parsed = fromPersistedCanvasDocument(input);
  if (!parsed) throw new Error('服务器画布文档无法解析；已阻止自动保存，以免覆盖原内容。请先备份并核对数据。');
  return parsed;
}

export function fromPersistedCanvasDocument(input: PersistedCanvasDocument | null): CanvasDocument | null {
  if (!input || input.version !== 2 || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) return null;
  return parseCanvasDocument(JSON.stringify({
    version: 1,
    nodes: input.nodes.map(node => ({
      id: node.id,
      kind: node.data.kind,
      label: node.data.label,
      x: node.position.x,
      y: node.position.y,
      aspectRatio: node.data.aspectRatio,
      prompt: node.data.prompt,
      ...(typeof node.data.model === 'string' ? { model: node.data.model } : {}),
      ...(typeof node.data.modeType === 'string' ? { modeType: node.data.modeType } : {}),
      ...(typeof node.data.count === 'number' ? { count: node.data.count } : {}),
      ...(node.data.settings && typeof node.data.settings === 'object' ? { settings: node.data.settings } : {}),
      ...(typeof node.data.artifactId === 'string' ? { artifactId: node.data.artifactId } : {}),
      ...(node.data.mediaKind === 'image' || node.data.mediaKind === 'video' || node.data.mediaKind === 'audio' ? { mediaKind: node.data.mediaKind } : {}),
      ...(typeof node.data.jobId === 'string' ? { jobId: node.data.jobId } : {}),
      ...(Array.isArray(node.data.variants) ? { variants: node.data.variants } : {}),
    })),
    edges: input.edges.map(edge => ({
      source: edge.source, target: edge.target,
      ...((edge.referenceRole ?? (edge as typeof edge & { role?: CanvasReferenceRole }).role)
        ? { role: edge.referenceRole ?? (edge as typeof edge & { role?: CanvasReferenceRole }).role }
        : {}),
    })),
  }));
}

export function toPersistedCanvasDocument(document: CanvasDocument): PersistedCanvasDocument {
  const localNodes = document.nodes.filter(node => node.data.origin !== 'project');
  const localIds = new Set(localNodes.map(node => node.id));
  return {
    version: 2,
    nodes: localNodes.map(node => ({
      id: node.id,
      type: 'qtv',
      position: { x: node.position.x, y: node.position.y },
      ...(typeof node.measured?.width === 'number' ? { width: node.measured.width } : {}),
      ...(typeof node.measured?.height === 'number' ? { height: node.measured.height } : {}),
      data: {
        label: node.data.label,
        kind: node.data.kind,
        aspectRatio: node.data.aspectRatio,
        prompt: node.data.prompt,
        status: node.data.status,
        ...(node.data.model ? { model: node.data.model } : {}),
        ...(node.data.modeType ? { modeType: node.data.modeType } : {}),
        ...(node.data.count ? { count: node.data.count } : {}),
        ...(node.data.settings ? { settings: node.data.settings } : {}),
        ...(node.data.artifactId ? { artifactId: node.data.artifactId } : {}), ...(node.data.mediaKind ? { mediaKind: node.data.mediaKind } : {}),
        ...(node.data.jobId ? { jobId: node.data.jobId } : {}), ...(node.data.variants?.length ? { variants: node.data.variants.map(variant => ({ artifactId: variant.artifactId, mediaKind: variant.mediaKind, name: variant.name })) } : {}),
      },
    })),
    edges: document.edges.filter(edge => localIds.has(edge.source) && localIds.has(edge.target)).map(edge => ({ id: edge.id, source: edge.source, target: edge.target, ...(edge.sourceHandle !== undefined ? { sourceHandle: edge.sourceHandle } : {}), ...(edge.targetHandle !== undefined ? { targetHandle: edge.targetHandle } : {}), ...(edge.data?.role ? { referenceRole: edge.data.role } : {}) })),
  };
}

export function removeLegacyCanvasDocument(projectId: string): void {
  try { window.localStorage.removeItem(STORAGE_PREFIX + projectId); } catch { /* 服务端迁移已完成，清理失败不影响使用 */ }
}

export function loadCanvasDocument(projectId: string): CanvasDocument {
  try { return parseCanvasDocument(window.localStorage.getItem(STORAGE_PREFIX + projectId)) ?? initialCanvas(projectId); }
  catch { return initialCanvas(projectId); }
}

