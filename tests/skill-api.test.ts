import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('Skill 目录支持分页、分类、详情和收藏持久化', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xqtv-skill-api-')); roots.push(root);
  const app = buildServer(new ProjectService(openDatabase(':memory:')), undefined, { workspaceRoot: join(root, 'workspaces') });
  try {
    const first = await app.inject({ method: 'GET', url: '/api/v1/skills?tab=skill&category=%E6%8E%A8%E8%8D%90&limit=3' });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(3);
    expect(first.json().nextCursor).toBe('3');
    const id = first.json().items[0].id as string;
    const detail = await app.inject({ method: 'GET', url: `/api/v1/skills/${id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().source.repository).toMatch(/^https:\/\//);
    expect(detail.json().instructions.length).toBeGreaterThan(100);
    const favorited = await app.inject({ method: 'PUT', url: `/api/v1/skills/${id}/favorite`, payload: { favorite: true } });
    expect(favorited.statusCode).toBe(200);
    expect(favorited.json().favorite).toBe(true);
    const favorites = await app.inject({ method: 'GET', url: '/api/v1/skills?tab=favorite' });
    expect(favorites.json().items.map((item: { id: string }) => item.id)).toContain(id);
  } finally { await app.close(); }
});

it('GitHub 检查拒绝非 GitHub 地址且不发起网络请求', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xqtv-skill-api-invalid-')); roots.push(root);
  const app = buildServer(new ProjectService(openDatabase(':memory:')), undefined, { workspaceRoot: join(root, 'workspaces') });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/skills/imports/github/inspect', payload: { url: 'https://example.com/repo' } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('GITHUB_URL_INVALID');
  } finally { await app.close(); }
});
