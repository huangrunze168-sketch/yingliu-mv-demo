/**
 * 迁移自旧项目 canvasConnectionRules.ts 的网页端版本。
 * 连接规则属于 domain，不能依赖 Electron、Tauri 或 React 组件。
 */
import { CANVAS_NODE_TYPES, type CanvasNodeType } from './canvas.js';
type CanvasConnectionCode = 'missing-node' | 'self-connection' | 'unsupported' | 'duplicate' | 'cycle';
export interface CanvasConnectionResult { valid: boolean; code?: CanvasConnectionCode; message?: string; }
const sources = new Set<CanvasNodeType>([CANVAS_NODE_TYPES.upload, CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.aiVideo, CANVAS_NODE_TYPES.aiText, CANVAS_NODE_TYPES.aiAudio, CANVAS_NODE_TYPES.storyboardGen, CANVAS_NODE_TYPES.blueprint]);
const targets = new Set<CanvasNodeType>([CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.aiVideo, CANVAS_NODE_TYPES.aiText, CANVAS_NODE_TYPES.aiAudio, CANVAS_NODE_TYPES.exportImage, CANVAS_NODE_TYPES.storyboardGen, CANVAS_NODE_TYPES.blueprint]);
export function validateCanvasConnection(sourceId: string, targetId: string, sourceType: CanvasNodeType | undefined, targetType: CanvasNodeType | undefined, edges: Array<{ source: string; target: string }>): CanvasConnectionResult {
  if (!sourceType || !targetType) return { valid: false, code: 'missing-node', message: '源节点或目标节点不存在。' };
  if (sourceId === targetId) return { valid: false, code: 'self-connection', message: '节点不能连接到自身。' };
  if (!sources.has(sourceType) || !targets.has(targetType)) return { valid: false, code: 'unsupported', message: '该节点类型不支持连接。' };
  if (edges.some(edge => edge.source === sourceId && edge.target === targetId)) return { valid: false, code: 'duplicate', message: '连接已经存在。' };
  const seen = new Set<string>();
  const pending = [targetId];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === sourceId) return { valid: false, code: 'cycle', message: '连接会形成循环依赖。' };
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) if (edge.source === current) pending.push(edge.target);
  }
  return { valid: true };
}
