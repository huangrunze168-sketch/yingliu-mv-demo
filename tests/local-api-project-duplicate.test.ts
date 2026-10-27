import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Local API·项目副本的真实媒体文件', () => {
  it('project.duplicate 同步复制项目工作目录与媒体文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qiyin-duplicate-files-'));
    roots.push(root);
    const service = new ProjectService(openDatabase(':memory:'));
    const app = buildServer(service, undefined, { workspaceRoot: root });

    const created = service.execute({
      command_id: randomUUID(),
      actor: 'user:test',
      type: 'project.create',
      payload: { name: '媒体项目', max_budget_cents: 0, rights_confirmed: true },
    });
    const sourceId = created.project_id!;
    mkdirSync(join(root, sourceId, 'uploads'), { recursive: true });
    writeFileSync(join(root, sourceId, 'uploads', 'reference.mp4'), Buffer.from('real-media'));

    const targetId = randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      payload: {
        command_id: randomUUID(),
        actor: 'user:test',
        type: 'project.duplicate',
        project_id: sourceId,
        expected_revision: 1,
        payload: { name: '媒体副本', target_project_id: targetId },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(readFileSync(join(root, targetId, 'uploads', 'reference.mp4'), 'utf8')).toBe('real-media');
    expect(existsSync(join(root, targetId))).toBe(true);

    const trash = await app.inject({ method: 'GET', url: '/api/v1/projects/trash' });
    expect(trash.statusCode).toBe(200);
    await app.close();
  });
});
