import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';

/**
 * 参考视频登记与拆解草稿播种。
 *
 * 这两步是「从一条参考视频到可编辑拆解」的衔接点，也是最容易悄悄做错的地方：
 * 自动分析只确定得了时长，其余六项必须**显式写成 unknown** 而不是留空，
 * 否则下游会把「还没看」当成「确认没有」。
 */

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

const HASH = `sha256:${'a'.repeat(64)}`;

function setup(service: ProjectService): { projectId: string; revision: number } {
  const created = service.execute(command('project.create', { name: '素材与拆解项目', max_budget_cents: 2000, rights_confirmed: true }));
  const projectId = created.project_id!;
  service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  return { projectId, revision: 2 };
}

describe('参考视频登记', () => {
  it('登记后可按项目查询到相对路径与内容哈希', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    const result = service.execute(command('source.register', {
      relative_path: 'sources/reference.mp4', content_hash: HASH, bytes: 90540, media_type: 'video/mp4',
    }, { project_id: projectId, expected_revision: revision }));
    expect((result.payload as { replaced: boolean }).replaced).toBe(false);

    const sources = service.listSources(projectId) as Array<{ relative_path: string; content_hash: string; bytes: number }>;
    expect(sources).toHaveLength(1);
    expect(sources[0]?.relative_path).toBe('sources/reference.mp4');
    expect(sources[0]?.content_hash).toBe(HASH);
    expect(sources[0]?.bytes).toBe(90540);
  });

  it('拒绝绝对路径：项目事实里不能出现开发机目录', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    for (const bad of ['C:\\videos\\ref.mp4', '/home/user/ref.mp4']) {
      let caught: unknown;
      try {
        service.execute(command('source.register', { relative_path: bad, content_hash: HASH, bytes: 1 }, { project_id: projectId, expected_revision: revision }));
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe('ABSOLUTE_PATH_FORBIDDEN');
    }
  });

  it('同一路径重复登记视为替换同一份素材，而不是新增一条', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('source.register', { relative_path: 'ref.mp4', content_hash: HASH, bytes: 100 }, { project_id: projectId, expected_revision: revision }));
    const second = service.execute(command('source.register', {
      relative_path: 'ref.mp4', content_hash: `sha256:${'b'.repeat(64)}`, bytes: 200,
    }, { project_id: projectId, expected_revision: revision + 1 }));

    expect((second.payload as { replaced: boolean }).replaced).toBe(true);
    const sources = service.listSources(projectId) as Array<{ content_hash: string; bytes: number }>;
    expect(sources).toHaveLength(1);
    expect(sources[0]?.bytes).toBe(200);
    expect(service.listEvents(projectId).map((event) => event.type)).toContain('source.replaced');
  });
});

describe('拆解草稿播种', () => {
  it('七字段齐全，未确定项显式写成 unknown 而不是留空', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('shot-fields.seed', {
      breakdown_revision: 1,
      boundaries: [{ t0_ms: 0, t1_ms: 2100 }, { t0_ms: 2100, t1_ms: 4200, confidence: 0.8 }],
    }, { project_id: projectId, expected_revision: revision }));

    const project = service.getProject(projectId) as {
      shot_fields: { fields_revision: number; shots: Array<Record<string, unknown>> } | null;
    };
    const shots = project.shot_fields?.shots ?? [];
    expect(shots).toHaveLength(2);

    for (const shot of shots) {
      // 缺一不可：任何一项缺失都会被 schema 拦下，这里再确认一次语义
      for (const field of ['duration_ms', 'shot_size', 'camera_position', 'camera_move', 'lighting', 'sound', 'replacement']) {
        expect(shot[field]).toBeDefined();
        expect(shot[field]).not.toBe('');
      }
      for (const unknownable of ['shot_size', 'camera_position', 'camera_move', 'lighting', 'sound', 'replacement']) {
        expect(shot[unknownable]).toBe('unknown');
      }
    }
    expect(shots[0]?.shot_id).toBe('shot-01');
    expect(shots[1]?.shot_id).toBe('shot-02');
    expect(shots[0]?.duration_ms).toBe(2100);
    expect(shots[1]?.duration_ms).toBe(2100);
    expect(shots[1]?.confidence).toBe(0.8);
    expect(shots[0]?.author).toBe('agent:frontkernel');
  });

  it('播种与手工替换走同一条写入路径：草稿质量与 revision 语义一致', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    const seeded = service.execute(command('shot-fields.seed', {
      breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 1000 }],
    }, { project_id: projectId, expected_revision: revision }));
    const seededRevision = (seeded.payload as { fields_revision: number }).fields_revision;

    const replaced = service.execute(command('shot-fields.replace', {
      breakdown_revision: 2,
      shots: [{
        shot_id: 'shot-01', t0_ms: 0, t1_ms: 1000, duration_ms: 1000,
        shot_size: 'medium', camera_position: 'eye_level', camera_move: 'static',
        lighting: 'soft', sound: 'dialogue', replacement: '替换人物',
        confidence: 0.9, source: 'human', author: 'user:test',
      }],
    }, { project_id: projectId, expected_revision: revision + 1 }));

    expect((replaced.payload as { fields_revision: number }).fields_revision).toBe(seededRevision + 1);
    expect(service.listEvents(projectId).map((event) => event.type)).toEqual([
      'project.created', 'gate.approved', 'shot-fields.seeded', 'shot-fields.replaced',
    ]);
  });

  it('播种会让已批准的 G1 失效——上游事实变了，旧批准不再代表当前数据', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('shot-fields.seed', {
      breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 1000 }],
    }, { project_id: projectId, expected_revision: revision }));
    service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: revision + 1 }));

    let approved = service.getProject(projectId) as { gate_status: Record<string, string> };
    expect(approved.gate_status.G1).toBe('APPROVED');

    service.execute(command('shot-fields.seed', {
      breakdown_revision: 2, boundaries: [{ t0_ms: 0, t1_ms: 500 }, { t0_ms: 500, t1_ms: 1000 }],
    }, { project_id: projectId, expected_revision: revision + 2 }));

    approved = service.getProject(projectId) as { gate_status: Record<string, string> };
    expect(approved.gate_status.G1).toBe('SUPERSEDED');
  });

  it('重复播种同一份边界得到完全相同的镜头编号（可重放）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    const boundaries = [{ t0_ms: 0, t1_ms: 1000 }, { t0_ms: 1000, t1_ms: 3000 }];
    service.execute(command('shot-fields.seed', { breakdown_revision: 1, boundaries }, { project_id: projectId, expected_revision: revision }));
    service.execute(command('shot-fields.seed', { breakdown_revision: 2, boundaries }, { project_id: projectId, expected_revision: revision + 1 }));

    const project = service.getProject(projectId) as { shot_fields: { shots: Array<{ shot_id: string }> } | null };
    expect((project.shot_fields?.shots ?? []).map((shot) => shot.shot_id)).toEqual(['shot-01', 'shot-02']);
  });
});
