import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(maxBytes = 1024) {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-local-api-'));
  roots.push(root);
  const service = new ProjectService(openDatabase(':memory:'));
  const createProject = (name: string) => service.execute({
    command_id: randomUUID(), actor: 'user:test', type: 'project.create',
    payload: { name, max_budget_cents: 1000, rights_confirmed: true },
  }).project_id!;
  const app = buildServer(service, undefined, { workspaceRoot: root, uploadMaxBytes: maxBytes });
  return { root, service, createProject, app };
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('本地 API·媒体上传', () => {
  it('同时核对扩展名、Content-Type 与 magic bytes，并登记内容寻址 Artifact', async () => {
    const { root, createProject, app } = setup();
    const projectId = createProject('上传项目');
    const response = await app.inject({
      method: 'POST', url: `/api/v1/projects/${projectId}/uploads`,
      headers: { 'content-type': 'image/png', 'x-file-name': 'reference.png' },
      payload: png,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { artifact_id: string; relative_path: string; media_type: string; bytes: number };
    expect(body.artifact_id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(body.media_type).toBe('image/png');
    expect(body.bytes).toBe(png.length);
    const file = resolve(root, projectId, body.relative_path);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file)).toEqual(png);
    const preview = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/assets/${encodeURIComponent(body.artifact_id)}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/png');
    expect(preview.rawPayload).toEqual(png);
    const range = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/assets/${encodeURIComponent(body.artifact_id)}`, headers: { range: 'bytes=0-7' } });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload).toEqual(png.subarray(0, 8));
    const otherProjectId = createProject('其他项目');
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${otherProjectId}/assets/${encodeURIComponent(body.artifact_id)}` })).statusCode).toBe(404);
    await app.close();
  });

  it('接受 LibTV 附件入口声明的 PDF、纯文本与 Markdown 文档', async () => {
    const { createProject, app } = setup(4096); const projectId = createProject('文档附件');
    const fixtures = [
      { name: 'brief.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj') },
      { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('人物：剑客\n场景：雨夜', 'utf8') },
      { name: 'story.md', type: 'text/markdown', bytes: Buffer.from('# 分镜脚本\n\n- 雨夜客栈', 'utf8') },
      { name: 'script.doc', type: 'application/msword', bytes: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('word document')]) },
      { name: 'script.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml word/document.xml')]) },
    ];
    for (const fixture of fixtures) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/uploads`, headers: { 'content-type': fixture.type, 'x-file-name': fixture.name }, payload: fixture.bytes });
      expect(response.statusCode, fixture.name).toBe(201);
      expect((response.json() as { media_type: string }).media_type).toBe(fixture.type);
    }
    await app.close();
  });

  it('素材评级持久化，删除同时清理领域记录与磁盘文件', async () => {
    const { root, service, createProject, app } = setup(); const projectId = createProject('素材管理');
    const upload = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/uploads`, headers: { 'content-type': 'image/png', 'x-file-name': 'rated.png' }, payload: png }); const asset = upload.json() as { artifact_id: string; relative_path: string };
    let project = service.getProject(projectId) as { revision: number };
    const rated = await app.inject({ method: 'POST', url: '/api/v1/commands', payload: { command_id: randomUUID(), actor: 'user:test', type: 'asset.rate', project_id: projectId, expected_revision: project.revision, payload: { artifact_id: asset.artifact_id, stars: 4 } } });
    expect(rated.statusCode).toBe(200); expect((service.getProject(projectId) as { asset_ratings: Array<{ artifact_id: string; stars: number }> }).asset_ratings).toContainEqual(expect.objectContaining({ artifact_id: asset.artifact_id, stars: 4 }));
    project = service.getProject(projectId) as { revision: number };
    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/projects/${projectId}/assets/${encodeURIComponent(asset.artifact_id)}`, payload: { expected_revision: project.revision } });
    expect(removed.statusCode).toBe(204); expect(existsSync(resolve(root, projectId, asset.relative_path))).toBe(false); expect((service.listArtifacts() as Array<{ artifact_id: string }>).some(item => item.artifact_id === asset.artifact_id)).toBe(false);
    await app.close();
  });

  it('伪装扩展名或声明类型不一致时 100% 拒绝', async () => {
    const { root, createProject, app } = setup();
    const projectId = createProject('伪装文件');
    const exe = Buffer.from('MZ this is not png');
    const fake = await app.inject({
      method: 'POST', url: `/api/v1/projects/${projectId}/uploads`,
      headers: { 'content-type': 'image/png', 'x-file-name': 'malware.png' }, payload: exe,
    });
    expect(fake.statusCode).toBe(415);
    expect(fake.json().error.code).toBe('UPLOAD_TYPE_MISMATCH');
    const wrongExtension = await app.inject({
      method: 'POST', url: `/api/v1/projects/${projectId}/uploads`,
      headers: { 'content-type': 'image/png', 'x-file-name': 'picture.exe' }, payload: png,
    });
    expect(wrongExtension.statusCode).toBe(415);
    expect(existsSync(join(root, projectId, 'uploads'))).toBe(false);
    await app.close();
  });

  it('超过单文件上限时返回 413 且不落盘', async () => {
    const { root, createProject, app } = setup(8);
    const projectId = createProject('大小限制');
    const response = await app.inject({
      method: 'POST', url: `/api/v1/projects/${projectId}/uploads`,
      headers: { 'content-type': 'image/png', 'x-file-name': 'large.png' }, payload: png,
    });
    expect(response.statusCode).toBe(413);
    expect(existsSync(join(root, projectId, 'uploads'))).toBe(false);
    await app.close();
  });
});

describe('本地 API·项目上下文绑定', () => {
  it('连续切换 5 次都使用 binding revision，冲突请求不覆盖新项目', async () => {
    const { createProject, app } = setup();
    const projects = Array.from({ length: 6 }, (_item, index) => createProject(`项目 ${index}`));
    const created = await app.inject({ method: 'POST', url: '/api/v1/contexts', payload: { project_id: projects[0] } });
    expect(created.statusCode).toBe(201);
    let context = created.json() as { id: string; project_id: string; binding_revision: number };
    for (let index = 1; index < projects.length; index += 1) {
      const response = await app.inject({
        method: 'PUT', url: `/api/v1/contexts/${context.id}/project`,
        payload: { project_id: projects[index], expected_binding_revision: context.binding_revision },
      });
      expect(response.statusCode).toBe(200);
      context = response.json();
      expect(context.project_id).toBe(projects[index]);
      expect(context.binding_revision).toBe(index + 1);
    }
    const stale = await app.inject({
      method: 'PUT', url: `/api/v1/contexts/${context.id}/project`,
      payload: { project_id: projects[0], expected_binding_revision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    const current = await app.inject({ method: 'GET', url: `/api/v1/contexts/${context.id}` });
    expect(current.json().project_id).toBe(projects[5]);
    await app.close();
  });
});
