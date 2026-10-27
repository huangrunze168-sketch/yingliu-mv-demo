import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';

const shot = {
  shot_id: 'shot-01', t0_ms: 0, t1_ms: 2100, duration_ms: 2100,
  shot_size: 'medium_close_up', camera_position: 'eye_level', camera_move: 'slow_push_in',
  lighting: 'soft_key_from_left', sound: 'dialogue', replacement: '替换人物，保留窗光方向',
  confidence: 0.9, source: 'human', author: 'user:test',
} as const;

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

function seed(service: ProjectService) {
  const created = service.execute(command('project.create', {
    name: '原始项目',
    max_budget_cents: 1000,
    rights_confirmed: true,
  }));
  const projectId = created.project_id!;
  service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  service.execute(command('shot-fields.replace', { breakdown_revision: 1, shots: [shot] }, { project_id: projectId, expected_revision: 2 }));
  const faceA = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';   const faceB = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';   service.execute(command('artifact.publish', { artifact_id: faceA, media_type: 'image/png', bytes: 64, metadata: { project_id: projectId, artifact_path_relative: 'subjects/lead-a.png' } }));   service.execute(command('artifact.publish', { artifact_id: faceB, media_type: 'image/png', bytes: 64, metadata: { project_id: projectId, artifact_path_relative: 'subjects/lead-b.png' } }));
  service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
  service.execute(command('subject.profile.set', {
    subject_ref: 'person:lead',
    display_name: '主角',
    kind: 'person',
    description: '雨衣主角',
    images: [
      { artifact_id: faceA, frontal: true },
      { artifact_id: faceB, frontal: false },
    ],
  }));
  const artifactId = `sha256:${'b'.repeat(64)}`;
  service.execute(command('artifact.publish', {
    artifact_id: artifactId,
    media_type: 'image/png',
    bytes: 256,
    metadata: { project_id: projectId, artifact_path_relative: 'uploads/hero.png' },
  }));
  service.execute(command('image-candidate.add', {
    shot_id: 'shot-01',
    candidate_id: 'candidate-01',
    artifact_id: artifactId,
  }, { project_id: projectId, expected_revision: 4 }));
  service.execute(command('image-generation.request', {
    shot_id: 'shot-01',
    model: 'demo-image',
    prompt: '生成首帧',
    estimated_cost_cents: 10,
  }, { project_id: projectId, expected_revision: 5 }));
  return projectId;
}

describe('project.duplicate', () => {
  it('复制分镜、素材引用与生成历史，并保留全局主体档案', () => {
    const db = openDatabase(':memory:');
    const service = new ProjectService(db);
    const sourceId = seed(service);
    const source = service.getProject(sourceId) as {
      revision: number;
      shot_fields: { shots: unknown[] } | null;
      image_generations: unknown[];
      derived_artifacts: unknown[];
    };

    const duplicated = service.execute(command('project.duplicate', { name: '项目副本' }, {
      project_id: sourceId,
      expected_revision: source.revision,
    }));
    const targetId = duplicated.project_id!;
    const copy = service.getProject(targetId) as typeof source;

    expect(targetId).not.toBe(sourceId);
    expect(copy.shot_fields?.shots).toHaveLength(source.shot_fields?.shots?.length ?? 0);
    expect(copy.image_generations).toHaveLength(source.image_generations.length);
    expect(copy.derived_artifacts).toHaveLength(source.derived_artifacts.length);

    const candidates = db.prepare('SELECT COUNT(*) AS n FROM image_candidates WHERE project_id=?').get(targetId) as { n: number };
    expect(candidates.n).toBe(1);

    const profiles = db.prepare('SELECT COUNT(*) AS n FROM subject_profiles').get() as { n: number };
    expect(profiles.n).toBe(1);
  });
});
