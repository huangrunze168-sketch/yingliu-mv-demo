import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import type { GenerationBackend } from '@qiyin/generation-backend';
import { buildServer } from '../apps/local-api/src/server.js';
import { readSession, saveSession } from '../apps/local-api/src/agent/agent-sessions.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
// ffmpeg 本地生成的真实 MPEG-4 一秒片段；只供注入后端验证，不访问付费服务。
const mp4 = Buffer.from('AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAA0Ftb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACa3RyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAABAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAA+gAAAAAAAEAAAAAAeNtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAABAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAGObWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABTnN0YmwAAADqc3RzZAAAAAAAAAABAAAA2m1wNHYAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAETTGF2YzYyLjI4LjEwMCBtcGVnNAAAAAAAAAAAAAAAAAAY//8AAABgZXNkcwAAAAADgICATwABAASAgIBBIBEAAAAAAw1AAAAAiAWAgIAvAAABsAEAAAG1iRMAAAEAAAABIADEjYgADQCEAhRjAAABskxhdmM2Mi4yOC4xMDAGgICAAQIAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAMNQAAAAIgAAAAYc3R0cwAAAAAAAAABAAAAAQAAQAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAAAEQAAAAEAAAAUc3RjbwAAAAAAAAABAAADbQAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjIuMTIuMTAwAAAACGZyZWUAAAAZbWRhdAAAAbMAEAcAAAG2Fj8Ysbfv', 'base64');

it('视频须逐镜选帧、另行批准 G2/费用，真实服务生成后支持项目内预览与局部重做', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-agent-video-'));
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '视频画布', max_budget_cents: 0, rights_confirmed: false } }).project_id!;
  const otherId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '另一画布', max_budget_cents: 0, rights_confirmed: false } }).project_id!;
  const videoCalls: string[] = [];
  let invalidVideo = false;
  const backend = {
    id: 'test-file-backend', label: '注入测试后端',
    capabilities: { image: true, videoFromImage: true, videoEdit: false, imageShortcut: false, imageUpscale: false, audioSpeech: false, audioMusic: false },
    generateImage: async (request: { outputDir: string; label: string }) => {
      mkdirSync(request.outputDir, { recursive: true });
      const file = join(request.outputDir, `${request.label}.png`);
      writeFileSync(file, png);
      return { files: [file], source_url: null, task_ref: 'image-receipt', cost: { amount: 10, unit: 'cent' as const }, notes: [] };
    },
    generateVideoFromImage: async (request: { outputDir: string; label: string }) => {
      videoCalls.push(request.label);
      mkdirSync(request.outputDir, { recursive: true });
      const file = join(request.outputDir, `${request.label}-${videoCalls.length}.mp4`);
      writeFileSync(file, invalidVideo ? Buffer.from('无效视频内容') : mp4);
      return { files: [file], source_url: null, task_ref: `video-receipt-${videoCalls.length}`, cost: { amount: 15, unit: 'cent' as const }, notes: [] };
    },
    editVideo: async () => { throw new Error('此测试不支持重拍'); },
    generateAudio: async () => { throw new Error('此测试不支持音频'); },
    applyImageShortcut: async () => { throw new Error('此测试不支持快捷能力'); },
    upscaleImage: async () => { throw new Error('此测试不支持图片放大'); },
  } satisfies GenerationBackend;
  const app = buildServer(service, undefined, { workspaceRoot: root, makeGenerationBackend: () => backend });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const sessionId = created.json().id as string;
    const url = `/api/v1/agent/sessions/${sessionId}`;
    const workspace = join(root, projectId);
    const initial = readSession(workspace, sessionId)!;
    const plan = { kind: 'plan', title: '海岸两镜', direction: '真实暖色纪实', aspectRatio: '16:9', shots: [
      { id: 'shot-01', title: '海面', visual: '夕阳海面，轻推镜头', narration: '', durationSeconds: 5 },
      { id: 'shot-02', title: '飞鸟', visual: '白色海鸥掠过波浪', narration: '', durationSeconds: 5 },
    ] };
    saveSession(workspace, { id: initial.id, title: initial.title, messages: [{ id: 'plan-1', role: 'plan', text: JSON.stringify(plan) }] });
    const approved = await app.inject({ method: 'POST', url: `${url}/plan/approve`, payload: { project_id: projectId, plan_id: 'plan-1', expected_session_revision: 1 } });
    expect(approved.statusCode).toBe(200);
    let revision = approved.json().session_revision as number;
    const image = await app.inject({ method: 'POST', url: `${url}/generate/images`, payload: { project_id: projectId, plan_id: 'plan-1', request_id: randomUUID(), expected_session_revision: revision,
      backend: 'canvas', model: '测试首帧模型', budget_cap_cents: 200, estimated_cost_cents_per_shot: 10, rights_confirmed: true, confirm_costs: true } });
    expect(image.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const snapshot = (await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` })).json();
      expect(snapshot.messages.some((message: { role: string; text: string }) => message.role === 'progress' && message.text.includes('"kind":"image"') && message.text.includes('"phase":"completed"'))).toBe(true);
    });
    const state = async () => (await app.inject({ method: 'GET', url: `${url}?project_id=${projectId}` })).json();
    revision = (await state()).session_revision;
    const requestId = randomUUID();
    const videoPayload = (overrides: Record<string, unknown> = {}) => ({ project_id: projectId, plan_id: 'plan-1', request_id: requestId, expected_session_revision: revision,
      backend: 'canvas', model: '测试视频模型', budget_cap_cents: 200, video_budget_cents: 60, estimated_cost_cents_per_shot: 20, rights_confirmed: true, confirm_costs: true, ...overrides });
    const startVideo = (overrides: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `${url}/generate/videos`, payload: videoPayload(overrides) });
    const beforeFrames = await startVideo();
    expect(beforeFrames.statusCode).toBe(409);
    expect(beforeFrames.json().error.code).toBe('FIRST_FRAME_REQUIRED');
    expect(videoCalls).toEqual([]);
    const assetId = (service.getProject(projectId) as { candidates: Array<{ artifact_id: string }> }).candidates[0]!.artifact_id;
    const select = async (shotId: string) => app.inject({ method: 'POST', url: `${url}/frames/select`, payload: {
      project_id: projectId, plan_id: 'plan-1', shot_id: shotId, artifact_id: assetId, expected_session_revision: revision,
    } });
    const firstFrame = await select('shot-01');
    expect(firstFrame.statusCode).toBe(200);
    revision = firstFrame.json().session_revision;
    expect((await startVideo()).json().error.code).toBe('FIRST_FRAME_REQUIRED');
    const secondFrame = await select('shot-02');
    expect(secondFrame.statusCode).toBe(200);
    revision = secondFrame.json().session_revision;
    expect((await state()).messages.filter((message: { role: string }) => message.role === 'selection')).toHaveLength(2);
    expect((await startVideo({ confirm_costs: false })).statusCode).toBe(422);
    expect((await startVideo({ video_budget_cents: 1 })).statusCode).toBe(409);
    expect((await startVideo({ video_budget_cents: 181 })).json().error.code).toBe('G2_BUDGET_EXCEEDED');
    const accepted = await startVideo();
    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const snapshot = await state();
      expect(snapshot.messages.some((message: { role: string; text: string }) => message.role === 'progress' && message.text.includes('"kind":"video"') && message.text.includes('"phase":"completed"'))).toBe(true);
    });
    expect(videoCalls).toEqual(['shot-01', 'shot-02']);
    const firstG2 = (service.getProject(projectId) as { gates: Array<{ gate: string; approved_budget_cents: number }> }).gates.filter(item => item.gate === 'G2').at(-1)!;
    expect(firstG2.approved_budget_cents).toBe(80); // 已记账的两镜图片 20 分 + 此次单独批准的视频 60 分。
    const complete = await state();
    const videoAssets = complete.messages.filter((message: { role: string; text: string }) => message.role === 'asset' && message.text.includes('"kind":"video"'));
    expect(videoAssets).toHaveLength(2);
    expect(JSON.parse(videoAssets[0].text).firstFrameArtifactId).toBe(assetId);
    const videoUrl = JSON.parse(videoAssets[0].text).url as string;
    const preview = await app.inject({ method: 'GET', url: videoUrl });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toMatch(/^video\/mp4/);
    expect(preview.rawPayload).toEqual(mp4);
    const partial = await app.inject({ method: 'GET', url: videoUrl, headers: { range: 'bytes=0-15' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toBe(`bytes 0-15/${mp4.length}`);
    expect(partial.rawPayload).toEqual(mp4.subarray(0, 16));
    expect((await app.inject({ method: 'GET', url: videoUrl, headers: { range: 'bytes=999999-' } })).statusCode).toBe(416);
    const clipId = JSON.parse(videoAssets[0].text).artifactId as string;
    const registered = (service.listArtifacts() as Array<{ artifact_id: string; metadata: { frame_path_relative: string } }>).find(item => item.artifact_id === clipId)!;
    const clipPath = join(workspace, registered.metadata.frame_path_relative);
    writeFileSync(clipPath, '已被修改的视频内容');
    expect((await app.inject({ method: 'GET', url: videoUrl })).statusCode).toBe(409);
    writeFileSync(clipPath, mp4);
    expect((await app.inject({ method: 'GET', url: videoUrl.replace(projectId, otherId) })).statusCode).toBe(404);
    const duplicate = await startVideo();
    expect(duplicate.json().duplicate).toBe(true);
    expect(videoCalls).toHaveLength(2);
    invalidVideo = true;
    revision = complete.session_revision;
    const selective = await startVideo({ request_id: randomUUID(), shot_id: 'shot-01', video_budget_cents: 60 });
    expect(selective.statusCode, JSON.stringify(selective.json())).toBe(202);
    await vi.waitFor(async () => {
      const snapshot = await state();
      expect(snapshot.messages.some((message: { role: string; text: string }) => message.role === 'progress' && message.text.includes('"kind":"video"') && message.text.includes('"phase":"failed"'))).toBe(true);
    });
    expect(videoCalls).toEqual(['shot-01', 'shot-02', 'shot-01']);
    expect((await app.inject({ method: 'GET', url: videoUrl })).statusCode).toBe(200);
    const project = service.getProject(projectId) as { gate_status: Record<string, string>; video_generations: Array<{ status: string }> };
    expect(project.gate_status.G2).toBe('APPROVED');
    expect(project.video_generations.length).toBeGreaterThanOrEqual(3);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
