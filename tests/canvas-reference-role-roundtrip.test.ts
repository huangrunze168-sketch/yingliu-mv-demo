import { expect, it } from 'vitest';
import { CANVAS_NODE_TYPES } from '../apps/web/src/domain/canvas.js';
import { fromPersistedCanvasDocument, makeCanvasNode, toPersistedCanvasDocument } from '../apps/web/src/features/canvas/canvasDocument.js';

it('画布参考图角色跨版本落盘不丢失，兼容旧 role 字段', () => {
  const source = makeCanvasNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, 'source');
  const target = makeCanvasNode(CANVAS_NODE_TYPES.imageEdit, { x: 500, y: 0 }, 'target');
  const document = { nodes: [source, target], edges: [{ id: 'source-target', source: source.id, target: target.id, data: { role: 'reference-image' as const } }] };
  const persisted = toPersistedCanvasDocument(document);
  expect(persisted.edges[0]?.referenceRole).toBe('reference-image');
  expect(fromPersistedCanvasDocument(persisted)?.edges[0]?.data?.role).toBe('reference-image');
  const legacy = { ...persisted, edges: [{ id: 'old', source: source.id, target: target.id, role: 'reference-image' }] };
  expect(fromPersistedCanvasDocument(legacy)?.edges[0]?.data?.role).toBe('reference-image');
});
