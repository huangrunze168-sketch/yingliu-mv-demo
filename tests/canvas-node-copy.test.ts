import { expect, it } from 'vitest';
import { CANVAS_NODE_TYPES } from '../apps/web/src/domain/canvas.js';
import { duplicateCanvasNode, isPreviousCanvasResult, makeCanvasNode } from '../apps/web/src/features/canvas/canvasDocument.js';

const artifactId = `sha256:${'a'.repeat(64)}`;

it('复制生成节点不将原产物冒充为副本成功结果', () => {
  const original = makeCanvasNode(CANVAS_NODE_TYPES.imageEdit, { x: 12, y: 34 }, 'original');
  original.data = { ...original.data, prompt: '大海', model: '真实模型', status: 'ready', artifactId, mediaKind: 'image', previewUrl: '/api/v1/projects/p1/assets/original', jobId: 'job-1', progress: 100, variants: [{ artifactId, name: '候选', mediaKind: 'image' }] };
  const copied = duplicateCanvasNode(original, 'copy');
  expect(copied.position).toEqual({ x: 48, y: 70 });
  expect(copied.data).toMatchObject({ prompt: '大海', model: '真实模型', status: 'draft' });
  expect(copied.data.artifactId).toBeUndefined();
  expect(copied.data.mediaKind).toBeUndefined();
  expect(copied.data.previewUrl).toBeUndefined();
  expect(copied.data.jobId).toBeUndefined();
  expect(copied.data.variants).toBeUndefined();
  expect(copied.data.progress).toBeUndefined();
  expect(original.data.artifactId).toBe(artifactId);
  expect(isPreviousCanvasResult(original.data)).toBe(false);
  expect(isPreviousCanvasResult({ ...original.data, status: 'running' })).toBe(true);
  expect(isPreviousCanvasResult({ ...original.data, status: 'failed' })).toBe(true);
  expect(isPreviousCanvasResult(copied.data)).toBe(false);
});

it('复制上传素材保留原来可引用的资产身份，但不复用运行中任务', () => {
  const source = makeCanvasNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, 'source');
  source.data = { ...source.data, status: 'ready', artifactId, mediaKind: 'image', previewUrl: '/api/v1/projects/p1/assets/source' };
  const copied = duplicateCanvasNode(source, 'source-copy');
  expect(copied.data).toMatchObject({ status: 'ready', artifactId, mediaKind: 'image', previewUrl: source.data.previewUrl });
});
