import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '../apps/web/src/features/canvas/canvasDocument.js';
import { canvasExecutionPlan, canvasNodeConsentText, CanvasDagError, invalidateCanvasDependents } from '../apps/web/src/features/canvas/canvasDag.js';
import { CANVAS_NODE_TYPES } from '../apps/web/src/domain/canvas.js';

function node(id: string, kind: CanvasNode['data']['kind'], status: CanvasNode['data']['status'] = 'draft', artifactId?: string): CanvasNode {
  return { id, type: 'qtv', position: { x: 0, y: 0 }, data: { label: id, kind, status, aspectRatio: '16:9', prompt: `${id} prompt`, ...(artifactId ? { artifactId, mediaKind: 'image' as const } : {}) } };
}
function edge(source: string, target: string): CanvasEdge { return { id: `${source}-${target}`, source, target, data: { role: 'reference-image' } }; }

const hash = `sha256:${'a'.repeat(64)}`;
describe('画布 DAG 执行计划', () => {
  it('目标节点自动包含未完成的生成依赖，并跳过已完成产物', () => {
    const nodes = [node('upload', CANVAS_NODE_TYPES.upload, 'ready', hash), node('image-a', CANVAS_NODE_TYPES.imageEdit), node('image-b', CANVAS_NODE_TYPES.imageEdit, 'ready', hash), node('video', CANVAS_NODE_TYPES.aiVideo)];
    const edges = [edge('upload', 'image-a'), edge('image-a', 'image-b'), edge('image-b', 'video')];
    expect(canvasExecutionPlan(nodes, edges, 'video')).toEqual(['image-a', 'image-b', 'video']);
  });

  it('每个外部生成节点的授权文字包含具体模型、序号和未知费用', () => {
    const target = node('video', CANVAS_NODE_TYPES.aiVideo);
    target.data.label = '镜头三';
    target.data.model = '官方视频模型';
    expect(canvasNodeConsentText(target, 2, 3)).toContain('第 2/3 个');
    expect(canvasNodeConsentText(target, 2, 3)).toContain('镜头三');
    expect(canvasNodeConsentText(target, 2, 3)).toContain('官方视频模型');
    expect(canvasNodeConsentText(target, 2, 3)).toContain('无法核实服务商准确单价');
    target.data.status = 'unknown';
    expect(canvasNodeConsentText(target, 2, 3)).toContain('可能重复计费');
  });

  it('已完成的目标镜头可主动重拍，只复用已核验的上游产物', () => {
    const nodes = [node('first-frame', CANVAS_NODE_TYPES.imageEdit, 'ready', hash), node('video', CANVAS_NODE_TYPES.aiVideo, 'ready', hash)];
    const edges = [edge('first-frame', 'video')];
    expect(canvasExecutionPlan(nodes, edges, 'video')).toEqual(['video']);
    expect(canvasExecutionPlan(nodes, edges, 'first-frame')).toEqual(['first-frame']);
    expect(canvasExecutionPlan(nodes, edges)).toEqual([]);
  });

  it('重拍上游后下游旧预览标记待重做，保留原产物供用户核对', () => {
    const first = node('first', CANVAS_NODE_TYPES.imageEdit, 'ready', hash);
    const video = node('video', CANVAS_NODE_TYPES.aiVideo, 'ready', hash);
    video.data.previewUrl = '/api/v1/projects/p1/assets/old';
    video.data.jobId = 'old-run';
    const unrelated = node('unrelated', CANVAS_NODE_TYPES.imageEdit, 'ready', hash);
    const edges = [edge('first', 'video')];
    const updated = invalidateCanvasDependents([first, video, unrelated], edges, 'first');
    expect(updated[0]).toBe(first);
    expect(updated[2]).toBe(unrelated);
    expect(updated[1]?.data).toMatchObject({ status: 'draft', artifactId: hash, previewUrl: '/api/v1/projects/p1/assets/old' });
    expect(updated[1]?.data.jobId).toBeUndefined();
    expect(canvasExecutionPlan(updated, edges)).toEqual(['video']);
  });

  it('运行全部保持稳定拓扑顺序，不把文本与上传节点送去生成', () => {
    const nodes = [node('text', CANVAS_NODE_TYPES.aiText), node('upload', CANVAS_NODE_TYPES.upload, 'ready', hash), node('image', CANVAS_NODE_TYPES.imageEdit), node('video', CANVAS_NODE_TYPES.aiVideo)];
    expect(canvasExecutionPlan(nodes, [edge('text', 'image'), edge('upload', 'image'), edge('image', 'video')])).toEqual(['image', 'video']);
  });

  it('检测环路并硬拒绝运行', () => {
    const nodes = [node('a', CANVAS_NODE_TYPES.imageEdit), node('b', CANVAS_NODE_TYPES.aiVideo)];
    expect(() => canvasExecutionPlan(nodes, [edge('a', 'b'), edge('b', 'a')])).toThrow(CanvasDagError);
  });
});
