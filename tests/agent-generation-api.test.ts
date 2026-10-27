import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import type { GenerationBackend } from '@qiyin/generation-backend';
import { CanvasAdapter, canvasBindingPath, type CanvasRunRequest, type CanvasRunner } from '@qiyin/canvas-adapter';
import { buildServer } from '../apps/local-api/src/server.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');

it('未授权不花费；批准后仅据真实镜头任务与文件输出预览，重试请求幂等且能逐镜重做', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-agent-media-'));
  roots.push(root);
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '创作画布', max_budget_cents: 0, rights_confirmed: false } }).project_id!;
  const otherId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '另一画布', max_budget_cents: 0, rights_confirmed: false } }).project_id!;
  const generated: string[] = [];
  let failNext = false;
  const backend = {
    id: 'test-file-backend', label: '测试文件后端',
    capabilities: { image: true, videoFromImage: false, videoEdit: false, imageShortcut: false, imageUpscale: false, audioSpeech: false, audioMusic: false },
    generateImage: async (request: { outputDir: string; label: string }) => {
      generated.push(request.label);
      if (failNext) { failNext = false; throw new Error('服务商模型暂不可用'); }
      mkdirSync(request.outputDir, { recursive: true });
      const file = join(request.outputDir, `shot-${generated.length}.png`);
      writeFileSync(file, png);
      return { files: [file], source_url: null, task_ref: `verified-${generated.length}`, cost: { amount: 20, unit: 'cent' as const }, notes: [] };
    },
    generateVideoFromImage: async () => { throw new Error('测试不支持视频'); },
    editVideo: async () => { throw new Error('测试不支持重拍视频'); },
    generateAudio: async () => { throw new Error('测试不支持音频'); },
    applyImageShortcut: async () => { throw new Error('测试不支持图片快捷能力'); },
    upscaleImage: async () => { throw new Error('测试不支持图片放大'); },
  } satisfies GenerationBackend;
  const canvasCommands: CanvasRunRequest[] = [];
  const canvasRunner: CanvasRunner = { async run(request) {
    canvasCommands.push(request);
    if (request.args[0] === 'project' && request.args[1] === 'create') return { code: 0, stderr: '', stdout: JSON.stringify({ projectMeta: { uuid: 'agent-canvas-uuid', name: request.args[2] } }) };
    if (request.args[0] === 'project' && request.args[1] === 'use') {
      const cwd = request.cwd ?? root;
      mkdirSync(dirname(canvasBindingPath(cwd)), { recursive: true });
      writeFileSync(canvasBindingPath(cwd), JSON.stringify({ projectUuid: request.args[2] }), 'utf8');
      return { code: 0, stderr: '', stdout: JSON.stringify({ projectUuid: request.args[2], name: 'Agent 画布' }) };
    }
    return { code: 1, stdout: '', stderr: `未预期的 LibTV 命令：${request.args.join(' ')}` };
  } };
  const app = buildServer(service, undefined, {
    workspaceRoot: root,
    makeGenerationBackend: () => backend,
    makeCanvasAdapter: cwd => new CanvasAdapter(canvasRunner, { cwd }),
  });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const sessionId = created.json().id as string;
    const url = `/api/v1/agent/sessions/${sessionId}`;
    const plan = { kind: 'plan', title: '一镜电影', direction: '日落暖光', aspectRatio: '16:9', shots: [{ id: 'shot-01', title: '开场', visual: '日落海面，宽银幕', narration: '', durationSeconds: 5 }] };
    // 直接将经过服务端方案校验的消息写入测试会话，不经过模型，也不伪造生成结果。
    const { readSession, saveSession } = await import('../apps/local-api/src/agent/agent-sessions.js');
    const workspace = join(root, projectId);
    const session = readSession(workspace, sessionId)!;
    saveSession(workspace, { id: session.id, title: session.title, messages: [...session.messages, { id: 'plan-1', role: 'plan', text: JSON.stringify(plan) }] });
    const base = { project_id: projectId, plan_id: 'plan-1', backend: 'canvas', model: '测试文件模型', budget_cap_cents: 100, estimated_cost_cents_per_shot: 20, rights_confirmed: true, confirm_costs: true };
    const start = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `${url}/generate/images`, payload: { ...base, request_id: randomUUID(), expected_session_revision: payload.expected_session_revision ?? 1, ...payload } });
    expect((await start({})).statusCode).toBe(409);
    const approved = await app.inject({ method: 'POST', url: `${url}/plan/approve`, payload: { project_id: projectId, plan_id: 'plan-1', expected_session_revision: 1 } });
    expect(approved.statusCode).toBe(200);
    const revision = approved.json().session_revision as number;
    expect((await start({ expected_session_revision: revision, confirm_costs: false })).statusCode).toBe(422);
    expect((await start({ expected_session_revision: revision, budget_cap_cents: 1 })).statusCode).toBe(409);
    expect(generated).toEqual([]);
    expect((service.getProject(projectId) as { rights_confirmed: boolean; max_budget_cents: number }).max_budget_cents).toBe(0);
    const requestId = randomUUID();
    const accepted = await start({ request_id: requestId, expected_session_revision: revision });
    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(() => expect(generated).toHaveLength(1));
    await vi.waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` });
      expect(response.json().messages.some((message: { role: string; text: string }) => message.role === 'progress' && message.text.includes('"phase":"completed"'))).toBe(true);
    });
    const result = (await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` })).json();
    expect(canvasCommands.map(command => command.args.slice(0, 2).join(' '))).toEqual(['project create', 'project use']);
    expect(result.messages.some((message: { role: string; text: string }) => message.role === 'agent' && message.text === '已新建并绑定 LibTV 画布：https://www.liblib.tv/canvas?projectId=agent-canvas-uuid')).toBe(true);
    expect(canvasBindingPath(workspace)).toContain(`${join('.libtv', 'project.json')}`);
    const asset = result.messages.find((message: { role: string }) => message.role === 'asset');
    expect(asset).toBeTruthy();
    const urlForAsset = JSON.parse(asset.text).url as string;
    const preview = await app.inject({ method: 'GET', url: urlForAsset });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toMatch(/^image\/png/);
    expect(preview.rawPayload).toEqual(png);
    const otherPreview = await app.inject({ method: 'GET', url: urlForAsset.replace(projectId, otherId) });
    expect(otherPreview.statusCode).toBe(404);
    const duplicate = await start({ request_id: requestId, expected_session_revision: revision });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
    expect(generated).toHaveLength(1);
    const overSpent = await start({ request_id: randomUUID(), expected_session_revision: result.session_revision, budget_cap_cents: 20, shot_id: 'shot-01' });
    expect(overSpent.statusCode).toBe(409);
    expect(overSpent.json().error.code).toBe('BUDGET_EXCEEDED');
    expect(generated).toHaveLength(1);
    const artifactId = JSON.parse(asset.text).artifactId as string;
    const select = (artifact_id: string, session_revision: number) => app.inject({ method: 'POST', url: `${url}/frames/select`, payload: {
      project_id: projectId, plan_id: 'plan-1', shot_id: 'shot-01', artifact_id, expected_session_revision: session_revision,
    } });
    expect((await select(`sha256:${'0'.repeat(64)}`, result.session_revision)).statusCode).toBe(409);
    const published = (service.listArtifacts() as Array<{ artifact_id: string; metadata: { frame_path_relative: string } }>).find(item => item.artifact_id === artifactId)!;
    const verifiedFile = join(workspace, published.metadata.frame_path_relative);
    writeFileSync(verifiedFile, '已损坏的图片');
    expect((await select(artifactId, result.session_revision)).json().error.code).toBe('ASSET_INVALID');
    expect((service.getProject(projectId) as { selections: unknown[] }).selections).toHaveLength(0);
    writeFileSync(verifiedFile, png);
    const selected = await select(artifactId, result.session_revision);
    expect(selected.statusCode).toBe(200);
    expect((await select(artifactId, selected.json().session_revision)).json().session_revision).toBe(selected.json().session_revision);
    expect((service.getProject(projectId) as { selections: Array<{ shot_id: string }> }).selections[0]?.shot_id).toBe('shot-01');
    failNext = true;
    const rerun = await start({ request_id: randomUUID(), expected_session_revision: selected.json().session_revision, shot_id: 'shot-01' });
    expect(rerun.statusCode).toBe(202);
    await vi.waitFor(() => expect(generated).toHaveLength(2));
    await vi.waitFor(async () => {
      const state = (await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` })).json();
      expect(state.messages.some((message: { role: string; text: string }) => message.role === 'progress' && message.text.includes('"phase":"failed"'))).toBe(true);
    });
    expect((await app.inject({ method: 'GET', url: urlForAsset })).statusCode).toBe(200);
    const failed = (await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` })).json();
    const recovery = await start({ request_id: randomUUID(), expected_session_revision: failed.session_revision, shot_id: 'shot-01' });
    expect(recovery.statusCode).toBe(202);
    await vi.waitFor(() => expect(generated).toHaveLength(3));
    const project = service.getProject(projectId) as { rights_confirmed: boolean; max_budget_cents: number; image_generations: unknown[] };
    expect(project).toMatchObject({ rights_confirmed: true, max_budget_cents: 100 });
    expect(project.image_generations.length).toBeGreaterThanOrEqual(2);
    expect(canvasCommands).toHaveLength(2);
    const latest = readSession(workspace, sessionId)!;
    saveSession(workspace, { id: latest.id, title: latest.title, messages: [...latest.messages, ...Array.from({ length: 220 }, (_, index) => ({ id: `archive-${index}`, role: 'note' as const, text: '测试历史裁剪' }))] });
    const trimmed = (await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` })).json();
    const replay = await start({ request_id: requestId, expected_session_revision: trimmed.session_revision });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('GENERATION_STATUS_UNKNOWN');
    expect(generated).toHaveLength(3);
  } finally { await app.close(); }
});
