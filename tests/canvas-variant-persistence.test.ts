import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES } from '../apps/web/src/domain/canvas.js';
import { fromPersistedCanvasDocument, isUnresolvedPaidCanvasNode, makeCanvasNode, resolveLoadedCanvasDocument, restoreRegisteredCanvasResults, toPersistedCanvasDocument } from '../apps/web/src/features/canvas/canvasDocument.js';
const one = `sha256:${'1'.repeat(64)}`;
const two = `sha256:${'2'.repeat(64)}`;
const foreign = `sha256:${'3'.repeat(64)}`;
function fixture() {
  const node = makeCanvasNode(CANVAS_NODE_TYPES.imageEdit, { x: 10, y: 20 }, 'image-node');
  node.data = { ...node.data, status: 'ready', artifactId: two, mediaKind: 'image', jobId: 'req-1', variants: [{ artifactId: one, mediaKind: 'image', name: '首张' }, { artifactId: two, mediaKind: 'image', name: '保留项' }, { artifactId: foreign, mediaKind: 'image', name: '其他项目素材' }] };
  return toPersistedCanvasDocument({ nodes: [node], edges: [] });
}
describe('画布多候选持久化及来源验证', () => {
  it('服务端文档损坏时绝不以空画布或旧缓存替代并覆盖', () => {
    const legacy = { nodes: [makeCanvasNode(CANVAS_NODE_TYPES.imageEdit, { x: 1, y: 1 }, 'legacy')], edges: [] };
    const invalid = fixture(); invalid.nodes[0]!.data.kind = 'unrecognized-node';
    expect(resolveLoadedCanvasDocument(null, legacy)).toBe(legacy);
    expect(() => resolveLoadedCanvasDocument(invalid, legacy)).toThrow('已阻止自动保存');
  });
  it('待核查付费任务冻结配置，明确完成或失败后才允许编辑', () => {
    const data = makeCanvasNode(CANVAS_NODE_TYPES.aiVideo, { x: 0, y: 0 }, 'paid').data;
    for (const status of ['queued', 'running', 'unknown'] as const) expect(isUnresolvedPaidCanvasNode({ ...data, jobId: 'paid-request', status })).toBe(true);
    expect(isUnresolvedPaidCanvasNode({ ...data, status: 'unknown' })).toBe(false);
    expect(isUnresolvedPaidCanvasNode({ ...data, status: 'ready', jobId: 'paid-request' })).toBe(false);
  });
  it('V2 往返保留 keeper 与候选，刷新时清除未登记候选', () => {
    const saved = fixture();
    const hydrated = fromPersistedCanvasDocument(saved)!;
    const restored = restoreRegisteredCanvasResults(hydrated, saved, [one, two].map(artifactId => ({ artifactId, mediaType: 'image/png', nodeId: 'image-node', requestId: 'req-1' })));
    expect(restored.nodes[0]?.data).toMatchObject({ status: 'ready', artifactId: two, variants: [{ artifactId: one }, { artifactId: two }] });
  });
  it('keeper 不属于原请求时清除产物和全部候选，不伪装为成功', () => {
    const saved = fixture();
    const restored = restoreRegisteredCanvasResults(fromPersistedCanvasDocument(saved)!, saved, [{ artifactId: two, mediaType: 'image/png', nodeId: 'another-node', requestId: 'req-1' }]);
    expect(restored.nodes[0]?.data.artifactId).toBeUndefined(); expect(restored.nodes[0]?.data.variants).toBeUndefined();
  });
  it('待核查任务里的过期候选不能从文档恢复为可点击结果', () => {
    const saved = fixture(); saved.nodes[0]!.data.status = 'running'; saved.nodes[0]!.data.jobId = 'new-request';
    const restored = restoreRegisteredCanvasResults(fromPersistedCanvasDocument(saved)!, saved, [{ artifactId: two, mediaType: 'image/png', nodeId: 'image-node', requestId: 'old-request' }]);
    expect(restored.nodes[0]?.data.status).toBe('unknown'); expect(restored.nodes[0]?.data.artifactId).toBeUndefined(); expect(restored.nodes[0]?.data.variants).toBeUndefined(); expect(restored.nodes[0]?.data.jobId).toBe('new-request');
  });
  it('旧文档无候选时仍能恢复单产物', () => {
    const saved = fixture(); delete saved.nodes[0]!.data.variants;
    const restored = restoreRegisteredCanvasResults(fromPersistedCanvasDocument(saved)!, saved, [{ artifactId: two, mediaType: 'image/png', nodeId: 'image-node', requestId: 'req-1' }]);
    expect(restored.nodes[0]?.data.artifactId).toBe(two); expect(restored.nodes[0]?.data.variants).toBeUndefined();
  });
});
