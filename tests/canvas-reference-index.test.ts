import { expect, it } from 'vitest';
import { indexCanvasReferences, makeCanvasNode, type CanvasNode } from '../apps/web/src/features/canvas/canvasDocument.js';
import { CANVAS_NODE_TYPES } from '../apps/web/src/domain/canvas.js';

it('索引维持原连线顺序与媒体语义，忽略外部悬空边', () => {
  const source = makeCanvasNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, 'source');
  const second = makeCanvasNode(CANVAS_NODE_TYPES.aiVideo, { x: 0, y: 0 }, 'second');
  source.data.artifactId = `sha256:${'a'.repeat(64)}`; source.data.mediaKind = 'image';
  const indexed = indexCanvasReferences([source, second], [
    { id: 'b', source: 'second', target: 'target' },
    { id: 'a', source: 'source', target: 'target', data: { role: 'first-frame' } },
    { id: 'orphan', source: 'missing', target: 'target' },
  ]);
  expect(indexed.get('target')).toEqual([
    { sourceId: 'second', label: second.data.label, kind: second.data.kind },
    { sourceId: 'source', label: source.data.label, kind: source.data.kind, mediaKind: 'image', artifactId: source.data.artifactId, role: 'first-frame' },
  ]);
});

it('大量节点只为有入边的目标建立索引', () => {
  const nodes: CanvasNode[] = Array.from({ length: 500 }, (_, index) => makeCanvasNode(CANVAS_NODE_TYPES.imageEdit, { x: index, y: 0 }, String(index)));
  const references = indexCanvasReferences(nodes, Array.from({ length: 499 }, (_, index) => ({ id: `e${index}`, source: String(index), target: String(index + 1) })));
  expect(references.size).toBe(499);
  expect(references.get('499')?.[0]?.sourceId).toBe('498');
});
