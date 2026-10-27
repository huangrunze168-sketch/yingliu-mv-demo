import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import type { BackendImageRequest, BackendVideoGenerationRequest, GenerationBackend } from '@qiyin/generation-backend';
import type { CanvasAdapter } from '@qiyin/canvas-adapter';
import { validateVideoModeReferences } from '@qiyin/contracts';
import { buildServer } from '../apps/local-api/src/server.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
// 来自 CLI 1.1.3 的 Seedance 2.5 官方 schema 参考规则，测试不触发远端请求。
const videoSchema = { config: { settings: Object.fromEntries(['text2video', 'singleImage2video', 'frames2video', 'image2video', 'mixed2video', 'videoEdit2video'].map(mode => [mode, []])) }, properties: { modeType: { items: { singleImage2video: [1, 1], frames2video: [1, 2], image2video: [1, 30], mixed2video: [1, 50], videoEdit2video: [1, 1] }, mixed2videoConfig: { videoMax: 10, imageMax: 30, audioMax: 10 }, videoEdit2videoConfig: { videoMax: 1, imageMaxWithVideo: 30 } } } };

function setup(failProvider = false, imageCount = 1) {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-canvas-generation-')); roots.push(root);
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '真实画布生成', max_budget_cents: 1000, rights_confirmed: true } }).project_id!;
  let calls = 0; let lastImageRequest: BackendImageRequest | null = null; let lastVideoRequest: BackendVideoGenerationRequest | null = null;
  const backend = {
    id: 'canvas', label: 'LibTV CLI', capabilities: { image: true, videoFromImage: true, videoEdit: false, audio: false, imageShortcut: false, imageUpscale: false },
    generateImage: async (request: BackendImageRequest) => { calls++; lastImageRequest = request; if (failProvider) throw new Error('timeout after submit'); mkdirSync(request.outputDir, { recursive: true }); const files = Array.from({ length: imageCount }, (_item, index) => { const file = join(request.outputDir, `real-${index}.png`); writeFileSync(file, index === 0 ? png : Buffer.concat([png, Buffer.from([index])])); return file; }); return { files, source_url: null, task_ref: 'cli-node-1', cost: { amount: 2, unit: 'credit' as const }, notes: [] }; },
    generateVideo: async (request: BackendVideoGenerationRequest) => { calls++; lastVideoRequest = request; mkdirSync(request.outputDir, { recursive: true }); const file = join(request.outputDir, `real-${request.modeType}.mp4`); writeFileSync(file, mp4); return { files: [file], source_url: null, task_ref: `cli-${request.modeType}`, cost: { amount: 8, unit: 'credit' as const }, notes: [] }; },
    generateVideoFromImage: async (request: { outputDir: string; imageFile: string }) => { calls++; expect(request.imageFile).toMatch(/uploads/); mkdirSync(request.outputDir, { recursive: true }); const file = join(request.outputDir, 'real.mp4'); writeFileSync(file, mp4); return { files: [file], source_url: null, task_ref: 'cli-node-video', cost: { amount: 8, unit: 'credit' as const }, notes: [] }; },
  } as unknown as GenerationBackend;
  const workspaceDir = join(root, projectId); mkdirSync(join(workspaceDir, '.libtv'), { recursive: true }); writeFileSync(join(workspaceDir, '.libtv', 'project.json'), JSON.stringify({ projectUuid: randomUUID() }));
  const adapter = { modelSchema: async () => ({ schema: videoSchema }) } as unknown as CanvasAdapter;
  const app = buildServer(service, undefined, { workspaceRoot: root, makeGenerationBackend: () => backend, makeCanvasAdapter: () => adapter });
  return { app, service, projectId, root, calls: () => calls, lastImageRequest: () => lastImageRequest, lastVideoRequest: () => lastVideoRequest };
}

describe('画布真实生成 API', () => {
  it('以官方 schema 校验参考数量、媒体类型及未知模式，不会进入供应商', async () => {
    const { app, projectId, calls } = setup();
    const uploaded = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/uploads`, headers: { 'content-type': 'image/png', 'x-file-name': 'reference.png' }, payload: png });
    const imageId = uploaded.json().artifact_id;
    for (const [mode, references] of [['singleImage2video', [imageId, imageId]], ['frames2video', []], ['text2video', [imageId]], ['audio2video', [imageId]]] as const) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { request_id: randomUUID(), node_id: 'invalid-video', kind: 'video', mode_type: mode, model: 'Seedance 2.5', prompt: '测试预检', reference_artifact_ids: references, rights_confirmed: true, confirm_costs: true } });
      expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('VIDEO_REFERENCES_INVALID'); expect(calls()).toBe(0);
    }
    expect(validateVideoModeReferences(videoSchema, 'mixed2video', ['image/png', 'audio/wav'])).toBeNull();
    expect(validateVideoModeReferences(videoSchema, 'videoEdit2video', ['image/png'])).toBeTruthy();
    await app.close();
  });
  it('没有权利与费用确认时不调用后端；确认后登记真实产物且 request_id 幂等', async () => {
    const { app, service, projectId, calls } = setup();
    const requestId = randomUUID();
    const base = { request_id: requestId, node_id: 'node-image-1', kind: 'image', model: 'Z-image Turbo', prompt: '电影感城市夜景', ratio: '16:9', settings: { quality: '1K' } };
    const denied = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: base });
    expect(denied.statusCode).toBe(422); expect(calls()).toBe(0);
    const generated = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { ...base, rights_confirmed: true, confirm_costs: true } });
    expect(generated.statusCode).toBe(201); expect(calls()).toBe(1);
    const body = generated.json();
    expect(body.assets[0]).toMatchObject({ media_type: 'image/png', bytes: png.length });
    expect(body.cost).toEqual({ amount: 2, unit: 'credit' });
    expect(service.listArtifacts()).toEqual(expect.arrayContaining([expect.objectContaining({ artifact_id: body.assets[0].artifact_id, media_type: 'image/png', metadata: expect.objectContaining({ node_id: 'node-image-1', request_id: requestId }) })]));
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { ...base, rights_confirmed: true, confirm_costs: true } });
    expect(duplicate.statusCode).toBe(200); expect(duplicate.json().duplicate).toBe(true); expect(calls()).toBe(1);
    for (const changed of [{ prompt: '不同的付费提示词' }, { model: '另一个模型' }, { settings: { quality: '2K' } }, { node_id: 'different-node' }, { mode_type: 'text2video' }]) {
      const conflict = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { ...base, ...changed, rights_confirmed: true, confirm_costs: true } });
      expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe('GENERATION_INPUT_CONFLICT'); expect(calls()).toBe(1);
    }
    await app.close();
  });

  it('后端返回多张真实候选时全部发布，供画布选择 keeper', async () => {
    const { app, projectId } = setup(false, 3);
    const response = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { request_id: randomUUID(), node_id: 'best-of-three', kind: 'image', model: 'Z-image Turbo', prompt: '三张候选', settings: { count: 3 }, rights_confirmed: true, confirm_costs: true } });
    expect(response.statusCode).toBe(201); expect(response.json().assets).toHaveLength(3); expect(new Set(response.json().assets.map((item: { artifact_id: string }) => item.artifact_id)).size).toBe(3);
    await app.close();
  });

  it('图像节点连接真实图片后切换为官方 CLI 图像编辑引用链路', async () => {
    const { app, projectId, lastImageRequest } = setup();
    const upload = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/uploads`, headers: { 'content-type': 'image/png', 'x-file-name': 'edit-reference.png' }, payload: png });
    const response = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { request_id: randomUUID(), node_id: 'node-image-edit', kind: 'image', model: 'Z-image Turbo', prompt: '保留构图并调整为黄昏', reference_artifact_ids: [upload.json().artifact_id], rights_confirmed: true, confirm_costs: true } });
    expect(response.statusCode).toBe(201); expect(lastImageRequest()?.referenceImageFiles).toHaveLength(1); expect(lastImageRequest()?.referenceImageFiles?.[0]).toMatch(/uploads/);
    await app.close();
  });

  it('视频使用项目内已校验首帧并登记真实 MP4', async () => {
    const { app, projectId, calls } = setup();
    const upload = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/uploads`, headers: { 'content-type': 'image/png', 'x-file-name': 'first-frame.png' }, payload: png });
    expect(upload.statusCode).toBe(201);
    const artifactId = upload.json().artifact_id;
    const response = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { request_id: randomUUID(), node_id: 'node-video-ok', kind: 'video', model: 'Seedance 2.5', prompt: '镜头缓慢向前推进', settings: { duration: 5, resolution: '480p' }, reference_artifact_ids: [artifactId], rights_confirmed: true, confirm_costs: true } });
    expect(response.statusCode).toBe(201); expect(response.json().assets[0].media_type).toBe('video/mp4'); expect(calls()).toBe(1);
    await app.close();
  });

  it('按官方 schema 路由文生、首尾帧、全能参考与视频重拍模式', async () => {
    const { app, projectId, lastVideoRequest } = setup();
    const text = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { request_id: randomUUID(), node_id: 'video-text', kind: 'video', mode_type: 'text2video', model: 'Seedance 2.5', prompt: '镜头推进', rights_confirmed: true, confirm_costs: true } }); expect(text.statusCode).toBe(201); expect(lastVideoRequest()?.modeType).toBe('text2video'); expect(lastVideoRequest()?.references).toHaveLength(0);
    const image = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/uploads`, headers: { 'content-type': 'image/png', 'x-file-name': 'frame.png' }, payload: png }); const imageId = image.json().artifact_id;
    const frames = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { request_id: randomUUID(), node_id: 'video-frames', kind: 'video', mode_type: 'frames2video', model: 'Seedance 2.5', prompt: '首尾过渡', reference_artifact_ids: [imageId, imageId], rights_confirmed: true, confirm_costs: true } }); expect(frames.statusCode).toBe(201); expect(lastVideoRequest()?.modeType).toBe('frames2video'); expect(lastVideoRequest()?.references).toHaveLength(2);
    const video = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/uploads`, headers: { 'content-type': 'video/mp4', 'x-file-name': 'source.mp4' }, payload: mp4 });
    const edit = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { request_id: randomUUID(), node_id: 'video-edit', kind: 'video', mode_type: 'videoEdit2video', model: 'Seedance 2.5', prompt: '保持时序修改环境', reference_artifact_ids: [video.json().artifact_id], rights_confirmed: true, confirm_costs: true } }); expect(edit.statusCode).toBe(201); expect(lastVideoRequest()?.modeType).toBe('videoEdit2video'); expect(lastVideoRequest()?.references[0]?.mediaType).toBe('video/mp4');
    await app.close();
  });

  it('视频没有真实首帧时拒绝且不创建付费请求', async () => {
    const { app, projectId, calls } = setup();
    const response = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { request_id: randomUUID(), node_id: 'node-video-1', kind: 'video', mode_type: 'singleImage2video', model: 'Seedance 2.5', prompt: '向前推进', rights_confirmed: true, confirm_costs: true } });
    expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('VIDEO_REFERENCES_INVALID'); expect(calls()).toBe(0);
    await app.close();
  });

  it('供应商调用一旦开始即将模糊失败冻结为 unknown，禁止自动重试', async () => {
    const { app, projectId, calls } = setup(true); const requestId = randomUUID();
    const payload = { request_id: requestId, node_id: 'ambiguous-node', kind: 'image', model: 'Z-image Turbo', prompt: '一次模糊失败', rights_confirmed: true, confirm_costs: true };
    const failed = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload });
    expect(failed.statusCode).toBe(409); expect(failed.json().error).toMatchObject({ code: 'GENERATION_STATUS_UNKNOWN', phase: 'unknown' }); expect(calls()).toBe(1);
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload });
    expect(duplicate.statusCode).toBe(409); expect(calls()).toBe(1);
    const status = await app.inject({ method: 'GET', url: `/api/v1/canvas/projects/${projectId}/generations/${requestId}` });
    expect(status.statusCode).toBe(200); expect(status.json()).toMatchObject({ request_id: requestId, phase: 'unknown', node_id: 'ambiguous-node' });
    await app.close();
  });

  it('服务重启后从 provider_finished 继续发布，不再次调用付费后端', async () => {
    const { app, service, projectId, root, calls } = setup(); const requestId = randomUUID(); const nodeId = 'recover-node';
    const workspace = join(root, projectId); const outputDir = join(workspace, 'generated', 'canvas'); mkdirSync(outputDir, { recursive: true }); const file = join(outputDir, 'recovered.png'); writeFileSync(file, png);
    const inputDigest = createHash('sha256').update(JSON.stringify({ projectId, nodeId, kind: 'image', model: 'Z-image Turbo', prompt: '恢复发布', ratio: null, modeType: null, settings: {}, references: [] })).digest('hex');
    const stateDir = join(workspace, '.qiyin-canvas', 'generation-requests'); mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, `${requestId}.json`), JSON.stringify({ status: 'provider_finished', projectId, nodeId, inputDigest, media: { files: [file], source_url: null, task_ref: 'finished-before-restart', cost: null, notes: [] } }));
    await app.close();
    const restarted = buildServer(service, undefined, { workspaceRoot: root });
    const response = await restarted.inject({ method: 'POST', url: `/api/v1/canvas/projects/${projectId}/generations`, payload: { request_id: requestId, node_id: nodeId, kind: 'image', model: 'Z-image Turbo', prompt: '恢复发布', rights_confirmed: true, confirm_costs: true } });
    expect(response.statusCode).toBe(201); expect(calls()).toBe(0); expect(response.json().assets[0].media_type).toBe('image/png');
    const status = await restarted.inject({ method: 'GET', url: `/api/v1/canvas/projects/${projectId}/generations/${requestId}` }); expect(status.json().phase).toBe('completed');
    await restarted.close();
  });
});
