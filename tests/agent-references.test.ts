import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('Agent 只接收项目内有效的显式 @ 引用，并以只读事实加入提示词', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-agent-reference-')); roots.push(root);
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '引用测试', max_budget_cents: 0, rights_confirmed: true } }).project_id!;
  const artifactId = `sha256:${'b'.repeat(64)}`;
  service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'artifact.publish', payload: { artifact_id: artifactId, media_type: 'image/png', bytes: 12, metadata: { project_id: projectId, source: 'test', artifact_path_relative: 'uploads/rain.png' } } });
  const prompts: string[] = [];
  const app = buildServer(service, undefined, { workspaceRoot: root, startAgent: ({ prompt, onEvent }) => { prompts.push(prompt); const runId = randomUUID(); onEvent({ runId, kind: 'done', text: '完成', at: Date.now() }); return { runId, cancel: () => {} }; } });
  try {
    const session = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const id = session.json().id as string;
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${id}/messages`, payload: { project_id: projectId, message_id: randomUUID(), text: '分析这张图', expected_session_revision: 0, references: [{ id: artifactId, kind: 'asset', label: '雨夜参考图' }] } });
    expect(accepted.statusCode).toBe(202);
    expect(prompts[0]).toContain('[用户显式引用的项目事实，只读]');
    expect(prompts[0]).toContain(`asset:${artifactId} · 雨夜参考图 · 工作区文件：uploads/rain.png`);

    const nextSession = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const rejected = await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${nextSession.json().id}/messages`, payload: { project_id: projectId, message_id: randomUUID(), text: '分析', expected_session_revision: 0, references: [{ id: `sha256:${'c'.repeat(64)}`, kind: 'asset', label: '不存在素材' }] } });
    expect(rejected.statusCode).toBe(409); expect(rejected.json().error.code).toBe('AGENT_REFERENCE_NOT_FOUND');
  } finally { await app.close(); }
});
