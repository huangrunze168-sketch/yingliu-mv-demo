import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';
import { buildTimelineFfmpegArgs } from '../apps/local-api/src/timeline-export.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const png = readFileSync(resolve('.audit/canvas-redesign.png'));

it('FFmpeg 计划覆盖 V1/V2/C1/A1/A2 合成语义', () => {
  const media = new Map([['sha256:' + 'a'.repeat(64), { artifactId: 'sha256:' + 'a'.repeat(64), path: 'x.png', mediaType: 'image/png' }]]);
  const args = buildTimelineFfmpegArgs({ version: 1, ripple: true, clips: [
    { id: 'v', track: 'V1', label: '画面', startMs: 0, durationMs: 1000, sourceOffsetMs: 0, artifactId: 'sha256:' + 'a'.repeat(64) },
    { id: 'c', track: 'C1', label: '字幕', startMs: 0, durationMs: 1000, sourceOffsetMs: 0 },
  ] }, media, 'out.mp4');
  expect(args.join(' ')).toContain('overlay='); expect(args.join(' ')).toContain('drawtext='); expect(args.join(' ')).toContain('amix='); expect(args.at(-1)).toBe('out.mp4');
});

it('从持久时间线异步导出真实 MP4、发布 Artifact 并支持 Range 下载', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-timeline-export-')); roots.push(root);
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '导出测试', max_budget_cents: 0, rights_confirmed: true } }).project_id!;
  const app = buildServer(service, undefined, { workspaceRoot: root });
  try {
    const uploaded = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/uploads`, headers: { 'content-type': 'image/png', 'x-file-name': 'frame.png' }, payload: png });
    expect(uploaded.statusCode).toBe(201); const artifactId = uploaded.json().artifact_id as string;
    const document = { version: 1 as const, ripple: true, clips: [{ id: 'v1', track: 'V1' as const, label: '画面', startMs: 0, durationMs: 1000, sourceOffsetMs: 0, artifactId }] };
    const saved = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'timeline-document.replace', project_id: projectId, expected_revision: 1, payload: { document } });
    const requestId = `export-${randomUUID()}`;
    const started = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/timeline-exports`, payload: { request_id: requestId, document_revision: saved.project_revision, width: 1280, height: 720 } });
    expect(started.statusCode).toBe(202);
    let state: { phase: string; artifact_id?: string } = started.json();
    for (let attempt = 0; attempt < 100 && !['completed','failed'].includes(state.phase); attempt += 1) { await new Promise(resolve => setTimeout(resolve, 100)); state = (await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/timeline-exports/${requestId}` })).json(); }
    expect(state.phase, JSON.stringify(state)).toBe('completed'); expect(state.artifact_id).toMatch(/^sha256:/);
    const media = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/assets/${encodeURIComponent(state.artifact_id!)}`, headers: { range: 'bytes=0-11' } });
    expect(media.statusCode).toBe(206); expect(media.headers['content-type']).toBe('video/mp4');
  } finally { await app.close(); }
});

it('导出任务可取消且不会在迟到回调中变回成功', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-timeline-cancel-')); roots.push(root);
  const service = new ProjectService(openDatabase(':memory:')); const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '取消', max_budget_cents: 0, rights_confirmed: true } }).project_id!;
  const app = buildServer(service, undefined, { workspaceRoot: root });
  try {
    const uploaded = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/uploads`, headers: { 'content-type': 'image/png', 'x-file-name': 'frame.png' }, payload: png }); const artifactId = uploaded.json().artifact_id as string;
    const saved = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'timeline-document.replace', project_id: projectId, expected_revision: 1, payload: { document: { version: 1, ripple: true, clips: [{ id: 'v1', track: 'V1', label: '长画面', startMs: 0, durationMs: 60000, sourceOffsetMs: 0, artifactId }] } } });
    const requestId = `export-${randomUUID()}`; await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/timeline-exports`, payload: { request_id: requestId, document_revision: saved.project_revision } });
    const canceled = await app.inject({ method: 'DELETE', url: `/api/v1/projects/${projectId}/timeline-exports/${requestId}` }); expect(canceled.json().phase).toBe('canceled'); await new Promise(resolve => setTimeout(resolve, 200));
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/timeline-exports/${requestId}` })).json().phase).toBe('canceled');
  } finally { await app.close(); }
});
