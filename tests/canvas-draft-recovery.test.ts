import { describe, expect, it } from 'vitest';
import type { CanvasDocumentSnapshot, PersistedCanvasDocument } from '../apps/web/src/ports/index.js';
import { discardCanvasDraft, inspectCanvasDraft, readCanvasDraft, reconcileCanvasDraftAfterSave, storeCanvasDraft } from '../apps/web/src/features/canvas/canvasDraft.js';

function storage(): Storage {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, clear: () => map.clear(), getItem: key => map.get(key) ?? null, key: index => [...map.keys()][index] ?? null, removeItem: key => { map.delete(key); }, setItem: (key, value) => { map.set(key, value); } };
}
const base: PersistedCanvasDocument = { version: 2, nodes: [], edges: [] };
const changed: PersistedCanvasDocument = { version: 2, nodes: [{ id: 'node', type: 'qtv', position: { x: 0, y: 0 }, data: { kind: 'imageNode', label: '待保存', prompt: '本机草稿' } }], edges: [] };
const snapshot = (document: PersistedCanvasDocument | null, documentRevision: number | null): CanvasDocumentSnapshot => ({ document, documentRevision, projectRevision: (documentRevision ?? 0) + 1 });

describe('项目级未保存画布草稿', () => {
  it('同项目同远端版本方可恢复；远端更改和其他项目均不自动覆盖', () => {
    const local = storage();
    storeCanvasDraft(local, 'one', changed, 3, JSON.stringify(base));
    expect(inspectCanvasDraft(local, 'one', snapshot(base, 3)).state).toBe('recoverable');
    expect(inspectCanvasDraft(local, 'one', snapshot(base, 4)).state).toBe('conflict');
    expect(inspectCanvasDraft(local, 'two', snapshot(base, 3)).state).toBe('none');
    expect(inspectCanvasDraft(local, 'one', snapshot(changed, 4)).state).toBe('saved');
  });
  it('保存旧快照后更新待写入草稿的基线，不抹掉更晚编辑', () => {
    const local = storage();
    const newer = { ...changed, nodes: changed.nodes.map(node => ({ ...node, data: { ...node.data, prompt: '更晚修改' } })) };
    storeCanvasDraft(local, 'one', newer, 3, JSON.stringify(base));
    reconcileCanvasDraftAfterSave(local, 'one', changed, 4);
    expect(inspectCanvasDraft(local, 'one', snapshot(changed, 4)).state).toBe('recoverable');
    expect(readCanvasDraft(local, 'one').draft?.document.nodes[0]?.data.prompt).toBe('更晚修改');
    reconcileCanvasDraftAfterSave(local, 'one', newer, 5);
    expect(readCanvasDraft(local, 'one').state).toBe('none');
  });
  it('服务器文档损坏时，即使版本相同也不能自动恢复覆盖', () => {
    const local = storage();
    storeCanvasDraft(local, 'one', changed, 3, JSON.stringify(base));
    const broken = { ...snapshot(base, 3), document: { version: 2, nodes: '损坏', edges: [] } as unknown as PersistedCanvasDocument };
    expect(inspectCanvasDraft(local, 'one', broken).state).toBe('conflict');
    storeCanvasDraft(local, 'empty', changed, null, '');
    expect(inspectCanvasDraft(local, 'empty', snapshot(null, null)).state).toBe('recoverable');
  });
  it('损坏本地草稿保持原文可导出，不自动应用，也不误删远端', () => {
    const local = storage();
    local.setItem('qtv-canvas-pending:v1:one', '{invalid-json');
    expect(inspectCanvasDraft(local, 'one', snapshot(base, 3))).toEqual({ state: 'invalid', raw: '{invalid-json' });
    discardCanvasDraft(local, 'one');
    expect(readCanvasDraft(local, 'one').state).toBe('none');
  });
});
