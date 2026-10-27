import { expect, it } from 'vitest';
import { CanvasAdapter, createCanvasBackend } from '@qiyin/canvas-adapter';
import { GENERATION_BACKEND_LABELS } from '@qiyin/generation-backends';

it('外部 LibTV 画布生成服务不再冒充小QTV 自有模型', () => {
  const runner = { run: async () => ({ code: 0, stdout: '{}', stderr: '' }) };
  expect(GENERATION_BACKEND_LABELS.canvas).toContain('LibTV');
  expect(GENERATION_BACKEND_LABELS.canvas).toContain('外部服务');
  const backend = createCanvasBackend(new CanvasAdapter(runner));
  expect(backend.label).toBe(GENERATION_BACKEND_LABELS.canvas);
  expect(backend.capabilities.image).toBe(true);
  expect(backend.capabilities.videoFromImage).toBe(true);
});
