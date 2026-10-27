import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';

/**
 * 空间计划（SpatialPlan@1）行为验收。
 *
 * 对应架构 v2.3 §7.5.2 的八条契约规则，以及 Phase 4 验收里与空间控制有关的六条。
 * 这里用两个镜头，是为了每次都能顺带验证那句最容易漏的话：
 * **「本镜失效、其它镜头一个都不能受影响」**。
 */

function shot(id: string, t0: number, t1: number) {
  return {
    shot_id: id, t0_ms: t0, t1_ms: t1, duration_ms: t1 - t0,
    shot_size: 'medium_close_up', camera_position: 'eye_level', camera_move: 'slow_push_in',
    lighting: 'soft_key_from_left', sound: 'dialogue', replacement: '替换人物，保留窗光方向',
    confidence: 0.9, source: 'human', author: 'user:test',
  } as const;
}

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

const ARTIFACT = `sha256:${'d'.repeat(64)}`;
const OTHER_ARTIFACT = `sha256:${'e'.repeat(64)}`;

/** 建到「G1 已批准、两个镜头就位」为止；返回项目 id 与下一次写操作需要的 revision。 */
function setup(service: ProjectService): { projectId: string; revision: number } {
  const created = service.execute(command('project.create', { name: '空间计划项目', max_budget_cents: 2000, rights_confirmed: true }));
  const projectId = created.project_id!;
  service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  service.execute(command('shot-fields.replace', { breakdown_revision: 1, shots: [shot('shot-01', 0, 2100), shot('shot-02', 2100, 4200)] }, { project_id: projectId, expected_revision: 2 }));
  service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
  return { projectId, revision: 4 };
}

function planWith(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'replica.spatial-plan@1',
    shot_id: 'shot-01',
    enabled: true,
    subjects: [{
      subject_ref: 'character:hero',
      proxy: 'mannequin',
      position: [1.2, 0, -0.4],
      rotation_deg: [0, 15, 0],
      pose: 'standing',
      scale: 1,
    }],
    camera: { position: [3, 1.6, 2.2], target: [1.2, 1.5, -0.4], lens_mm: 50, pitch_deg: -3 },
    ...overrides,
  };
}

describe('SpatialPlan@1·空对象与未启用', () => {
  it('空对象表示未启用空间控制：放行、不报错、不产生额外付费请求', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);

    const result = service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01', plan: {}, expected_spatial_revision: 0,
    }, { project_id: projectId, expected_revision: revision }));

    const payload = result.payload as { enabled: boolean; invalidated_candidates: number };
    expect(payload.enabled).toBe(false);
    expect(payload.invalidated_candidates).toBe(0);

    // 未启用空间控制时，后续流程与没有这个功能时完全一致
    const project = service.getProject(projectId) as { gate_status: Record<string, string> };
    expect(project.gate_status.G1).toBe('APPROVED');
  });

  it('enabled=false 却带着站位，会被拒绝而不是被静默忽略', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    expect(() => service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01',
      plan: { ...planWith(), enabled: false },
      expected_spatial_revision: 0,
    }, { project_id: projectId, expected_revision: revision }))).toThrow(/未通过校验/);
  });
});

describe('SpatialPlan@1·参数域与引用完整性', () => {
  it('越界的焦距 / 俯仰角 / 光强一律在提交前拒绝', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('subject.register', { subject_ref: 'character:hero', display_name: '主角' }));

    const outOfRange: Array<Record<string, unknown>> = [
      { camera: { position: [3, 1.6, 2.2], target: [1.2, 1.5, -0.4], lens_mm: 5000, pitch_deg: 0 } },
      { camera: { position: [3, 1.6, 2.2], target: [1.2, 1.5, -0.4], lens_mm: 50, pitch_deg: -120 } },
      { camera: { position: [3, 1.6, 2.2], target: [1.2, 1.5, -0.4], lens_mm: 50, fov_deg: 200 } },
      { lighting: { key: { pos: [2, 2.4, 1], color: '#ffd9b3', intensity: 99 } } },
    ];
    for (const override of outOfRange) {
      expect(() => service.execute(command('spatial-plan.set', {
        shot_id: 'shot-01', plan: planWith(override), expected_spatial_revision: 0,
      }, { project_id: projectId, expected_revision: revision }))).toThrow();
    }
  });

  it('未登记的主体引用被拒绝', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);

    let caught: unknown;
    try {
      service.execute(command('spatial-plan.set', {
        shot_id: 'shot-01', plan: planWith(), expected_spatial_revision: 0,
      }, { project_id: projectId, expected_revision: revision }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('SPATIAL_PLAN_INVALID');
    expect(JSON.stringify((caught as { details?: unknown }).details)).toContain('SUBJECT_NOT_REGISTERED');
  });

  it('登记主体后即可通过引用校验', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('subject.register', { subject_ref: 'character:hero', display_name: '主角' }));
    const result = service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01', plan: planWith(), expected_spatial_revision: 0,
    }, { project_id: projectId, expected_revision: revision }));
    expect((result.payload as { enabled: boolean }).enabled).toBe(true);
    expect(service.listSubjects()).toHaveLength(1);
  });

  it('临时 URL 与凭据材料不得出现在空间计划里', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('subject.register', { subject_ref: 'character:hero', display_name: '主角' }));
    const poisoned = planWith({
      stage: {
        geometry_refs: [{
          kind: 'floor',
          id: 'https://cdn.example.com/floor.png?X-Amz-Signature=deadbeef',
        }],
        panorama_artifact: null,
      },
    });
    let caught: unknown;
    try {
      service.execute(command('spatial-plan.set', {
        shot_id: 'shot-01', plan: poisoned, expected_spatial_revision: 0,
      }, { project_id: projectId, expected_revision: revision }));
    } catch (error) {
      caught = error;
    }
    expect(JSON.stringify((caught as { details?: unknown }).details)).toContain('CREDENTIAL_MATERIAL');
  });
});

describe('SpatialPlan@1·失效传播', () => {
  it('改站位只作废本镜候选，其它镜头不受影响', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('subject.register', { subject_ref: 'character:hero', display_name: '主角' }));

    service.execute(command('image-candidate.add', { shot_id: 'shot-01', candidate_id: 'cand-01', artifact_id: ARTIFACT }, { project_id: projectId, expected_revision: revision }));
    service.execute(command('image-candidate.add', { shot_id: 'shot-02', candidate_id: 'cand-02', artifact_id: ARTIFACT }, { project_id: projectId, expected_revision: revision + 1 }));

    const result = service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01', plan: planWith(), expected_spatial_revision: 0,
    }, { project_id: projectId, expected_revision: revision + 2 }));
    expect((result.payload as { invalidated_candidates: number }).invalidated_candidates).toBe(1);

    const candidates = service.listImageCandidates(projectId) as Array<{ shot_id: string; candidate_id: string; status: string }>;
    expect(candidates.find((item) => item.candidate_id === 'cand-01')?.status).toBe('SUPERSEDED');
    expect(candidates.find((item) => item.candidate_id === 'cand-02')?.status).toBe('ACTIVE');
  });

  it('同一份计划重复提交不推进 revision，也不产生失效传播', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('subject.register', { subject_ref: 'character:hero', display_name: '主角' }));

    const first = service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01', plan: planWith(), expected_spatial_revision: 0,
    }, { project_id: projectId, expected_revision: revision }));
    const second = service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01', plan: planWith(), expected_spatial_revision: 1,
    }, { project_id: projectId, expected_revision: (first.project_revision ?? 0) }));

    expect((second.payload as { reused: boolean }).reused).toBe(true);
    expect(second.project_revision).toBe(first.project_revision);
  });

  it('首帧作废后不得再提交视频请求', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('subject.register', { subject_ref: 'character:hero', display_name: '主角' }));

    service.execute(command('image-candidate.add', { shot_id: 'shot-01', candidate_id: 'cand-01', artifact_id: ARTIFACT }, { project_id: projectId, expected_revision: revision }));
    service.execute(command('image-candidate.select', { shot_id: 'shot-01', candidate_id: 'cand-01', expected_selection_revision: 0 }, { project_id: projectId, expected_revision: revision + 1 }));
    // G2 要求每个镜头都已选帧，因此 shot-02 也要走一遍
    service.execute(command('image-candidate.add', { shot_id: 'shot-02', candidate_id: 'cand-02', artifact_id: ARTIFACT }, { project_id: projectId, expected_revision: revision + 2 }));
    service.execute(command('image-candidate.select', { shot_id: 'shot-02', candidate_id: 'cand-02', expected_selection_revision: 0 }, { project_id: projectId, expected_revision: revision + 3 }));
    service.execute(command('gate.approve', { gate: 'G2', approved_budget_cents: 500 }, { project_id: projectId, expected_revision: revision + 4 }));

    // 改站位 → 首帧候选作废 → G2 被 supersede
    service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01', plan: planWith(), expected_spatial_revision: 0,
    }, { project_id: projectId, expected_revision: revision + 5 }));

    let caught: unknown;
    try {
      service.execute(command('video.request', { shot_id: 'shot-01', estimated_cost_cents: 100 }, { project_id: projectId, expected_revision: revision + 6 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('G2_REQUIRED');

    const project = service.getProject(projectId) as { gate_status: Record<string, string> };
    expect(project.gate_status.G2).toBe('SUPERSEDED');
  });
});

describe('SpatialPlan@1·蓝图 Artifact', () => {
  it('未发布的蓝图被拒绝，发布后通过', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('subject.register', { subject_ref: 'character:hero', display_name: '主角' }));

    const withBlueprint = (artifactId: string) => planWith({
      blueprint: { artifact_id: artifactId, published_at: new Date().toISOString(), captured_from_revision: 1 },
    });

    expect(() => service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01', plan: withBlueprint(ARTIFACT), expected_spatial_revision: 0,
    }, { project_id: projectId, expected_revision: revision }))).toThrow(/未通过校验/);

    service.execute(command('artifact.publish', { artifact_id: ARTIFACT, media_type: 'image/png', bytes: 2048 }));
    const ok = service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01', plan: withBlueprint(ARTIFACT), expected_spatial_revision: 0,
    }, { project_id: projectId, expected_revision: revision }));
    expect(ok.project_revision).toBe(revision + 1);
  });

  it('重新截图产生新 Artifact，旧图归档而不是被覆盖', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('subject.register', { subject_ref: 'character:hero', display_name: '主角' }));
    service.execute(command('artifact.publish', { artifact_id: ARTIFACT, media_type: 'image/png', bytes: 2048 }));
    service.execute(command('artifact.publish', { artifact_id: OTHER_ARTIFACT, media_type: 'image/png', bytes: 4096 }));

    const withBlueprint = (artifactId: string) => planWith({
      blueprint: { artifact_id: artifactId, published_at: new Date().toISOString(), captured_from_revision: 1 },
    });

    service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01', plan: withBlueprint(ARTIFACT), expected_spatial_revision: 0,
    }, { project_id: projectId, expected_revision: revision }));

    service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01', plan: withBlueprint(OTHER_ARTIFACT), expected_spatial_revision: 1,
    }, { project_id: projectId, expected_revision: revision + 1 }));

    const artifacts = service.listArtifacts() as Array<{ artifact_id: string; status: string }>;
    expect(artifacts).toHaveLength(2);
    expect(artifacts.find((item) => item.artifact_id === ARTIFACT)?.status).toBe('ARCHIVED');
    expect(artifacts.find((item) => item.artifact_id === OTHER_ARTIFACT)?.status).toBe('PUBLISHED');
  });

  it('空间计划 revision 冲突被拒绝（CAS）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    service.execute(command('subject.register', { subject_ref: 'character:hero', display_name: '主角' }));
    service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01', plan: planWith(), expected_spatial_revision: 0,
    }, { project_id: projectId, expected_revision: revision }));

    let caught: unknown;
    try {
      service.execute(command('spatial-plan.set', {
        shot_id: 'shot-01', plan: planWith({ camera: { position: [5, 1.6, 2.2], target: [1.2, 1.5, -0.4], lens_mm: 35, pitch_deg: 0 } }),
        expected_spatial_revision: 0,
      }, { project_id: projectId, expected_revision: revision + 1 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('SPATIAL_REVISION_CONFLICT');
  });
});
