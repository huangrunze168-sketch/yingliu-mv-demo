import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';
import type { CanvasAdapter } from '@qiyin/canvas-adapter';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-models-'));
  roots.push(root);
  const searchModels = vi.fn(async ({ type, name }: { type?: string; name?: string } = {}) => ({
    ...(type ? { nodeType: type } : {}),
    query: name ?? '',
    matchKind: 'all' as const,
    matches: [{ modelKey: 'z-image', modelName: 'Z-image Turbo', description: '真实模型目录', supportModality: 'image' }],
  }));
  const modelSchema = vi.fn(async (name: string) => ({
    nameOrId: name,
    modelName: 'z-image',
    modelKey: 'z-image',
    modality: 'image' as const,
    schema: { modelName: 'Z Image', modelKey: 'z-image', properties: { ratio: { default: '16:9' } }, config: { settings: ['ratio'] }, rules: [] },
  }));
  const app = buildServer(new ProjectService(openDatabase(':memory:')), undefined, {
    workspaceRoot: root,
    makeCanvasAdapter: () => ({ searchModels, modelSchema }) as unknown as CanvasAdapter,
  });
  return { app, searchModels, modelSchema };
}

describe('本地 API·LibTV 模型目录', () => {
  it('把类型检索和模型 schema 原样交给 LibTV 适配器', async () => {
    const { app, searchModels, modelSchema } = setup();
    const list = await app.inject({ method: 'GET', url: '/api/v1/canvas/models?type=image&name=Turbo' });
    expect(list.statusCode).toBe(200);
    expect(list.json().matches[0]).toMatchObject({ modelKey: 'z-image', modelName: 'Z-image Turbo' });
    expect(searchModels).toHaveBeenCalledWith({ type: 'image', name: 'Turbo' });
    await app.inject({ method: 'GET', url: '/api/v1/canvas/models?type=image&name=Turbo' });
    expect(searchModels).toHaveBeenCalledTimes(1);

    const schema = await app.inject({ method: 'GET', url: '/api/v1/canvas/models/Z-image%20Turbo' });
    expect(schema.statusCode).toBe(200);
    expect(schema.json().schema.properties.ratio.default).toBe('16:9');
    expect(modelSchema).toHaveBeenCalledWith('Z-image Turbo');
    await app.inject({ method: 'GET', url: '/api/v1/canvas/models/Z-image%20Turbo' });
    expect(modelSchema).toHaveBeenCalledTimes(1);
  });

  it('拒绝未知模型类型，不调用 CLI', async () => {
    const { app, searchModels } = setup();
    const response = await app.inject({ method: 'GET', url: '/api/v1/canvas/models?type=unknown' });
    expect(response.statusCode).toBe(400);
    expect(searchModels).not.toHaveBeenCalled();
  });
});
