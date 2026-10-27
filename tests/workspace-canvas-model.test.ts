import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '../packages/domain/src/index.js';

function createCanvas(service: ProjectService, payload: { name: string; workspace_id?: string; workspace_name?: string }) {
  return service.execute({
    schema: 'replica.command@1',
    command_id: randomUUID(),
    actor: 'test',
    type: 'project.create',
    payload: { ...payload, max_budget_cents: 0, rights_confirmed: false },
  });
}

describe('LibTV 工作区/画布双层模型', () => {
  it('工作区容纳多张画布，spaceId 与 projectId 始终独立', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const first = createCanvas(service, { name: '画布 1', workspace_name: '未命名工作区' });
    const firstPayload = first.payload as { workspace_id: string; project_id: string };
    expect(firstPayload.workspace_id).not.toBe(firstPayload.project_id);

    const second = createCanvas(service, { name: '画布 2', workspace_id: firstPayload.workspace_id });
    const secondPayload = second.payload as { workspace_id: string; project_id: string };
    expect(secondPayload.workspace_id).toBe(firstPayload.workspace_id);
    expect(secondPayload.project_id).not.toBe(firstPayload.project_id);

    const workspace = service.getWorkspace(firstPayload.workspace_id) as { id: string; canvases: Array<{ id: string; workspace_id: string }> };
    expect(workspace.id).toBe(firstPayload.workspace_id);
    expect(workspace.canvases.map(canvas => canvas.id)).toEqual([firstPayload.project_id, secondPayload.project_id]);
    expect(workspace.canvases.every(canvas => canvas.workspace_id === workspace.id)).toBe(true);
  });

  it('工作区归档、恢复与彻底删除会作用于所属画布', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = createCanvas(service, { name: '画布 1', workspace_name: '容器测试' });
    const { workspace_id: workspaceId, project_id: projectId } = created.payload as { workspace_id: string; project_id: string };

    service.trashWorkspace(workspaceId);
    expect((service.getProject(projectId) as { deleted_at: string | null }).deleted_at).not.toBeNull();
    service.restoreWorkspace(workspaceId);
    expect((service.getProject(projectId) as { deleted_at: string | null }).deleted_at).toBeNull();

    service.trashWorkspace(workspaceId);
    service.purgeWorkspace(workspaceId, '容器测试');
    expect(() => service.getWorkspace(workspaceId)).toThrowError(/工作区不存在/);
    expect(() => service.getProject(projectId)).toThrowError(/项目不存在/);
  });

  it('旧库中的孤立 project 会迁移到独立 workspace，不复用原 project id', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qiyin-workspace-migration-'));
    const path = join(directory, 'legacy.db');
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
        max_budget_cents INTEGER NOT NULL, reserved_budget_cents INTEGER NOT NULL DEFAULT 0,
        rights_confirmed INTEGER NOT NULL, folder_id TEXT, deleted_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      legacy.prepare('INSERT INTO projects(id,name,revision,state,max_budget_cents,rights_confirmed,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('legacy-project', '旧项目', 1, 'EMPTY', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      legacy.close();

      const migrated = openDatabase(path);
      const project = migrated.prepare('SELECT id, workspace_id FROM projects WHERE id=?').get('legacy-project') as unknown as { id: string; workspace_id: string };
      const workspace = migrated.prepare('SELECT id, name FROM workspaces WHERE id=?').get(project.workspace_id) as unknown as { id: string; name: string };
      expect(project.workspace_id).not.toBe(project.id);
      expect(workspace).toEqual({ id: project.workspace_id, name: '旧项目' });
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
