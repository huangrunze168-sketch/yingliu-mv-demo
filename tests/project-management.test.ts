import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '../apps/web/src/adapters/web/memoryAdapter.js';

describe('工作区与画布双层端口', () => {
  it('工作区和画布使用不同 id，并按容器关系归档与恢复', async () => {
    const { workspace, project } = await memoryAdapter.workspaces.create('测试工作区');
    expect(workspace).toMatchObject({ name: '测试工作区', canvasCount: 1, primaryProjectId: project.id });
    expect(project).toMatchObject({ workspaceId: workspace.id, name: '画布 1' });
    expect(project.id).not.toBe(workspace.id);

    const renamed = await memoryAdapter.workspaces.rename(workspace.id, '测试工作区 · 已改名');
    expect(renamed.name).toBe('测试工作区 · 已改名');

    const trashed = await memoryAdapter.workspaces.trash(workspace.id);
    expect(trashed.status).toBe('archived');
    await expect(memoryAdapter.workspaces.listArchived()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: workspace.id })]));
    await expect(memoryAdapter.canvases.get(project.id)).resolves.toMatchObject({ status: 'archived', workspaceId: workspace.id });

    const restored = await memoryAdapter.workspaces.restore(workspace.id);
    expect(restored.status).toBe('active');
    await memoryAdapter.workspaces.trash(workspace.id);
    await memoryAdapter.workspaces.purge(workspace.id, renamed.name);

    await expect(memoryAdapter.workspaces.get(workspace.id)).resolves.toBeUndefined();
    await expect(memoryAdapter.canvases.get(project.id)).resolves.toBeUndefined();
  });
});
