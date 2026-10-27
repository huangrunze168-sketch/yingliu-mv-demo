import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES } from '../apps/web/src/domain/canvas.js';
import { validateCanvasConnection } from '../apps/web/src/domain/canvasConnections.js';
import { fromPersistedCanvasDocument, initialCanvas, parseCanvasDocument, restoreRegisteredCanvasResults, serializeCanvasDocument, toPersistedCanvasDocument } from '../apps/web/src/features/canvas/canvasDocument.js';
import { agentProjectGraph } from '../apps/web/src/features/canvas/agentProjectGraph.js';

describe('Agent 与同一项目画布', () => {
  it('仅映射真实 Agent 分镜、当前有效图片和真实生成状态，不将领域节点伪存为本地文档', () => {
    const imageId = `sha256:${'a'.repeat(64)}`;
    const snapshot = {
      shot_fields: { shots: [
        { shot_id: 'shot-01', author: 'agent:session-1', replacement: '夕阳海面' },
        { shot_id: 'shot-02', author: 'agent:session-1', replacement: '海鸥飞过' },
        { shot_id: 'shot-03', author: 'user:editor', replacement: '其他作者的镜头' },
      ] },
      candidates: [{ candidate_id: 'candidate-1', shot_id: 'shot-01', artifact_id: imageId, status: 'ACTIVE' }, { shot_id: 'shot-02', artifact_id: `sha256:${'b'.repeat(64)}`, status: 'SUPERSEDED' }],
      selections: [{ shot_id: 'shot-01', candidate_id: 'candidate-1' }],
      image_generations: [{ shot_id: 'shot-02', status: 'ADMITTED' }],
      video_generations: [{ shot_id: 'shot-01', status: 'COMPLETED', clip_artifact_id: imageId }],
    };
    const graph = agentProjectGraph('project-1', snapshot);
    expect(graph.nodes).toHaveLength(6);
    expect(graph.edges).toHaveLength(4);
    expect(graph.nodes[1]!.data).toMatchObject({ origin: 'project', status: 'ready', previewUrl: `/api/v1/agent/projects/project-1/images/${encodeURIComponent(imageId)}` });
    expect(graph.nodes[1]!.data.label).toContain('已选首帧');
    expect(graph.nodes[2]!.data).toMatchObject({ origin: 'project', status: 'ready', videoUrl: `/api/v1/agent/projects/project-1/videos/${encodeURIComponent(imageId)}` });
    expect(graph.nodes[4]!.data).toMatchObject({ origin: 'project', status: 'running' });
    expect(graph.nodes.every(node => node.draggable === false && node.connectable === false)).toBe(true);
    expect(JSON.parse(serializeCanvasDocument(graph))).toEqual({ version: 1, nodes: [], edges: [] });
    expect(agentProjectGraph('project-1', { shot_fields: { shots: [{ shot_id: 'shot-01', author: 'user:editor' }] } }).nodes).toEqual([]);
  });
});

describe('画布连接规则', () => {
  it('拒绝重复、自连和反向成环', () => {
    const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
    expect(validateCanvasConnection('a', 'b', CANVAS_NODE_TYPES.upload, CANVAS_NODE_TYPES.imageEdit, edges).code).toBe('duplicate');
    expect(validateCanvasConnection('a', 'a', CANVAS_NODE_TYPES.upload, CANVAS_NODE_TYPES.imageEdit, edges).code).toBe('self-connection');
    expect(validateCanvasConnection('c', 'a', CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.imageEdit, edges).code).toBe('cycle');
  });

  it('允许素材接入生成节点', () => {
    expect(validateCanvasConnection('source', 'image', CANVAS_NODE_TYPES.upload, CANVAS_NODE_TYPES.imageEdit, [])).toEqual({ valid: true });
  });
});

describe('画布文档', () => {
  it('演示项目保留示例结构，新建项目从空白画布开始', () => {
    const demo = initialCanvas('p-demo');
    const created = initialCanvas('p-created');
    expect(demo.nodes).toHaveLength(2);
    expect(demo.edges).toHaveLength(1);
    expect(created).toEqual({ nodes: [], edges: [] });
  });

  it('序列化后可以安全恢复已知字段', () => {
    const document = initialCanvas('p-demo');
    document.nodes[0]!.data.label = '我的参考素材';
    document.nodes[1]!.data.prompt = '雨夜电影感人物镜头';
    document.nodes[1]!.data.jobId = 'job-image-001';
    const parsed = parseCanvasDocument(serializeCanvasDocument(document));
    expect(parsed?.nodes[0]!.data.label).toBe('我的参考素材');
    expect(parsed?.nodes[1]!.data.prompt).toBe('雨夜电影感人物镜头');
    expect(parsed?.nodes[1]!.data.jobId).toBe('job-image-001');
    expect(parsed?.edges).toHaveLength(1);
  });

  it('V2 服务端文档可往返且不持久化项目事实只读节点', () => {
    const document = initialCanvas('p-demo');
    document.nodes[0]!.data.artifactId = `sha256:${'c'.repeat(64)}`;
    document.nodes[0]!.data.mediaKind = 'image';
    document.nodes[1]!.data.prompt = '服务端持久化提示词';
    document.edges[0]!.data = { role: 'reference-image' };
    document.nodes.push({ ...document.nodes[0]!, id: 'project-fact', data: { ...document.nodes[0]!.data, origin: 'project' } });
    const persisted = toPersistedCanvasDocument(document);
    expect(persisted.version).toBe(2);
    expect(persisted.nodes.some(node => node.id === 'project-fact')).toBe(false);
    const restored = fromPersistedCanvasDocument(persisted);
    expect(restored?.nodes[0]!.data).toMatchObject({ artifactId: `sha256:${'c'.repeat(64)}`, mediaKind: 'image' });
    expect(restored?.nodes[1]!.data.prompt).toBe('服务端持久化提示词');
    expect(restored?.edges[0]!.data?.role).toBe('reference-image');
  });

  it('只恢复服务端已发布且与原任务绑定的真实镜头成功状态', () => {
    const document = initialCanvas('p-demo');
    const node = document.nodes[1]!;
    const artifactId = `sha256:${'f'.repeat(64)}`;
    node.data = { ...node.data, status: 'ready', artifactId, mediaKind: 'image', jobId: 'request-1' };
    const saved = toPersistedCanvasDocument(document);
    const loaded = fromPersistedCanvasDocument(saved)!;
    expect(loaded.nodes[1]!.data.status).toBe('draft');
    const registered = [{ artifactId, mediaType: 'image/png', nodeId: 'web-request-1' }];
    expect(restoreRegisteredCanvasResults(loaded, saved, registered).nodes[1]!.data.status).toBe('ready');
    expect(restoreRegisteredCanvasResults(loaded, saved, [{ artifactId, mediaType: 'image/png', nodeId: node.id, requestId: 'request-1' }]).nodes[1]!.data.status).toBe('ready');
    expect(restoreRegisteredCanvasResults(loaded, saved, [{ artifactId, mediaType: 'image/png', nodeId: node.id, requestId: 'different-request' }]).nodes[1]!.data.artifactId).toBeUndefined();
    const mismatched = restoreRegisteredCanvasResults(loaded, saved, [{ ...registered[0]!, nodeId: 'other-node' }]).nodes[1]!.data;
    expect(mismatched.status).toBe('draft');
    expect(mismatched.artifactId).toBeUndefined();
    expect(mismatched.jobId).toBeUndefined();
    expect(restoreRegisteredCanvasResults(loaded, saved, [{ ...registered[0]!, artifactId: `sha256:${'e'.repeat(64)}` }]).nodes[1]!.data.artifactId).toBeUndefined();
    saved.nodes[1]!.data.status = 'running';
    expect(restoreRegisteredCanvasResults(loaded, saved, registered).nodes[1]!.data.status).toBe('unknown');
    saved.nodes[1]!.data.status = 'unknown';
    expect(restoreRegisteredCanvasResults(loaded, saved, registered).nodes[1]!.data.status).toBe('unknown');
    saved.nodes[1]!.data.status = 'draft';
    expect(restoreRegisteredCanvasResults(loaded, saved, registered).nodes[1]!.data.status).toBe('draft');
  });

  it('拒绝未知节点类型、悬空边和形成环路的存档', () => {
    const unknown = JSON.stringify({ version: 1, nodes: [{ id: 'a', kind: 'unknown', label: 'x', x: 0, y: 0 }], edges: [] });
    expect(parseCanvasDocument(unknown)).toBeNull();

    const oversizedPrompt = JSON.stringify({ version: 1, nodes: [{ id: 'a', kind: CANVAS_NODE_TYPES.imageEdit, label: 'x', prompt: 'x'.repeat(2001), x: 0, y: 0 }], edges: [] });
    expect(parseCanvasDocument(oversizedPrompt)).toBeNull();
    const invalidJobId = JSON.stringify({ version: 1, nodes: [{ id: 'a', kind: CANVAS_NODE_TYPES.imageEdit, label: 'x', jobId: 42, x: 0, y: 0 }], edges: [] });
    expect(parseCanvasDocument(invalidJobId)).toBeNull();

    const dangling = JSON.stringify({ version: 1, nodes: [{ id: 'a', kind: CANVAS_NODE_TYPES.upload, label: 'x', x: 0, y: 0 }], edges: [{ source: 'a', target: 'missing' }] });
    expect(parseCanvasDocument(dangling)).toBeNull();

    const loop = JSON.stringify({ version: 1, nodes: [
      { id: 'a', kind: CANVAS_NODE_TYPES.imageEdit, label: 'A', x: 0, y: 0 },
      { id: 'b', kind: CANVAS_NODE_TYPES.imageEdit, label: 'B', x: 10, y: 10 },
    ], edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }] });
    expect(parseCanvasDocument(loop)).toBeNull();
  });
});
