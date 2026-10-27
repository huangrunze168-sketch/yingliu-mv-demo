import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

const document = {
  version: 2 as const,
  nodes: [
    { id: 'source', type: 'qtv', position: { x: 20, y: 40 }, data: { kind: 'upload', label: '参考图', prompt: '', aspectRatio: '16:9', status: 'ready' } },
    { id: 'image', type: 'qtv', position: { x: 420, y: 40 }, data: { kind: 'image-edit', label: '图像生成', prompt: '雨夜街道', aspectRatio: '16:9', status: 'draft' } },
  ],
  edges: [{ id: 'source-image', source: 'source', target: 'image', referenceRole: 'reference-image' as const }],
};

describe('CanvasDocumentV2 持久化', () => {
  it('按项目 revision 写入并从项目快照完整读回', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = service.execute(command('project.create', { name: '画布项目', max_budget_cents: 0, rights_confirmed: false }));
    const projectId = created.project_id!;
    const saved = service.execute(command('canvas-document.replace', { document }, { project_id: projectId, expected_revision: 1 }));

    expect(saved.project_revision).toBe(2);
    expect(saved.payload).toEqual({ document_revision: 2 });
    expect((service.getProject(projectId) as { canvas_document: unknown }).canvas_document).toMatchObject({ document_revision: 2, document });
    expect(service.listEvents(projectId).at(-1)?.type).toBe('canvas-document.replaced');
  });

  it('拒绝旧 revision，避免另一个窗口被静默覆盖', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = service.execute(command('project.create', { name: '冲突项目', max_budget_cents: 0, rights_confirmed: false }));
    const projectId = created.project_id!;
    service.execute(command('canvas-document.replace', { document }, { project_id: projectId, expected_revision: 1 }));
    expect(() => service.execute(command('canvas-document.replace', { document }, { project_id: projectId, expected_revision: 1 }))).toThrow(/版本|revision/i);
  });

  it('限制候选列表长度与素材身份，拒绝任意 URL 冒充产物', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = service.execute(command('project.create', { name: '候选约束', max_budget_cents: 0, rights_confirmed: false })).project_id!;
    const node = document.nodes[1]!;
    for (const variants of [[{ artifactId: 'https://example.com/fake.png', mediaKind: 'image', name: '伪产物' }], Array.from({ length: 9 }, (_, index) => ({ artifactId: `sha256:${index.toString(16).repeat(64)}`, mediaKind: 'image', name: String(index) }))]) {
      expect(() => service.execute(command('canvas-document.replace', { document: { ...document, nodes: [document.nodes[0], { ...node, data: { ...node.data, variants } }] } }, { project_id: projectId, expected_revision: 1 }))).toThrow();
    }
  });

  it('拒绝重复节点、悬空连线和自连接', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = service.execute(command('project.create', { name: '非法文档', max_budget_cents: 0, rights_confirmed: false }));
    const projectId = created.project_id!;
    const invalid = { version: 2, nodes: [document.nodes[0], document.nodes[0]], edges: [{ id: 'bad', source: 'source', target: 'missing' }] };
    expect(() => service.execute(command('canvas-document.replace', { document: invalid }, { project_id: projectId, expected_revision: 1 }))).toThrow();
  });
});
