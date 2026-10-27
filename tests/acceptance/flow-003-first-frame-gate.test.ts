/* ============================================================
  FLOW-003「先图选帧后视频」的量化验收。

  矩阵的验收口径是「未选帧的付费请求数 = 0」。
  这里真的去试：12 个镜头一个都不选帧，然后

    ① 试图批准 G2（G2 的语义就是"首帧与视频预算都定了"）→ 必须被拒，
       并且拒的那句话要点名缺哪些镜头；
    ② 补齐 12 帧、批准 G2 之后，对 12 个**从未选帧**的镜头逐个发起视频生成请求
       → 12 次全部被拒；
    ③ 直接查库：预留预算必须还是 0、视频生成意图表必须一行都没有。

  为什么非要查库而不是只看抛没抛错：一次"被拒绝的付费请求"如果已经在库里
  留下了一笔预留或一行意图，那这笔钱在账上就是欠着的。抛错只证明调用没走通，
  库里的数字才证明**钱没动**。
   ============================================================ */

import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { command, recordAcceptance, rejectionCode } from './_acceptance.js';

const SHOT_COUNT = 12;

function shotId(index: number): string {
  return `shot-${String(index + 1).padStart(2, '0')}`;
}

describe('[FLOW-003] 先图选帧后视频', () => {
  it('未选帧时：G2 批不下来、付费请求 0 次、预算与意图表都没动', () => {
    const db = openDatabase(':memory:');
    const service = new ProjectService(db);
    const created = service.execute(command('project.create', {
      name: '首帧闸门验收', max_budget_cents: 100_000, rights_confirmed: true,
    }));
    const projectId = created.project_id as string;
    const rev = () => (service.getProject(projectId) as { revision: number }).revision;

    service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: rev() }));
    const boundaries = Array.from({ length: SHOT_COUNT }, (_unused, index) => ({
      t0_ms: index * 2000, t1_ms: (index + 1) * 2000,
    }));
    service.execute(command('shot-fields.seed', { breakdown_revision: 1, boundaries }, {
      project_id: projectId, expected_revision: rev(),
    }));
    service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: rev() }));

    /* ① 一个镜头都没选帧就批 G2 */
    const approveWithoutFrames = rejectionCode(() => service.execute(command(
      'gate.approve', { gate: 'G2', approved_budget_cents: 80_000 },
      { project_id: projectId, expected_revision: rev() },
    )));

    /* ② 补齐首帧、批准 G2 */
    for (let index = 0; index < SHOT_COUNT; index += 1) {
      service.execute(command('image-candidate.add', {
        shot_id: shotId(index),
        candidate_id: `cand-${String(index + 1).padStart(2, '0')}`,
        artifact_id: `sha256:${String(index % 10).repeat(64)}`,
      }, { project_id: projectId, expected_revision: rev() }));
    }
    for (let index = 0; index < SHOT_COUNT; index += 1) {
      service.execute(command('image-candidate.select', {
        shot_id: shotId(index),
        candidate_id: `cand-${String(index + 1).padStart(2, '0')}`,
        expected_selection_revision: 0,
      }, { project_id: projectId, expected_revision: rev() }));
    }
    service.execute(command('gate.approve', { gate: 'G2', approved_budget_cents: 80_000 }, {
      project_id: projectId, expected_revision: rev(),
    }));

    /* ③ G2 已批准的情况下，对从未选帧的镜头逐个发起付费视频请求 */
    const codes: string[] = [];
    for (let index = 0; index < SHOT_COUNT; index += 1) {
      codes.push(rejectionCode(() => service.execute(command('video-generation.request', {
        shot_id: `ghost-${String(index + 1).padStart(2, '0')}`,
        model: 'acceptance-model',
        duration_seconds: 5,
        estimated_cost_cents: 500,
      }, { project_id: projectId, expected_revision: rev() }))));
    }

    const project = service.getProject(projectId) as { reserved_budget_cents: number; revision: number };
    const intents = db.prepare('SELECT COUNT(*) AS count FROM video_generation_intents').get() as unknown as { count: number };
    const events = db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='video-generation.requested'").get() as unknown as { count: number };

    recordAcceptance('FLOW-003', {
      criterion: '未选帧付费请求数 = 0',
      g2ApproveWithoutFrames: approveWithoutFrames,
      paidAttempts: SHOT_COUNT,
      rejectedCodes: [...new Set(codes)],
      rejected: codes.filter((code) => code === 'FIRST_FRAME_REQUIRED').length,
      reservedBudgetCents: project.reserved_budget_cents,
      videoIntents: intents.count,
      requestedEvents: events.count,
    });

    expect(approveWithoutFrames).toBe('FIRST_FRAME_REQUIRED');
    expect(codes.every((code) => code === 'FIRST_FRAME_REQUIRED')).toBe(true);
    expect(project.reserved_budget_cents).toBe(0);
    expect(intents.count).toBe(0);
    expect(events.count).toBe(0);
  });

  it('G2 的拒绝理由点名缺哪些镜头，而不是只说"条件不满足"', () => {
    const db = openDatabase(':memory:');
    const service = new ProjectService(db);
    const created = service.execute(command('project.create', {
      name: 'G2 缺帧清单', max_budget_cents: 100_000, rights_confirmed: true,
    }));
    const projectId = created.project_id as string;
    const rev = () => (service.getProject(projectId) as { revision: number }).revision;
    service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: rev() }));
    service.execute(command('shot-fields.seed', {
      breakdown_revision: 1,
      boundaries: [{ t0_ms: 0, t1_ms: 2000 }, { t0_ms: 2000, t1_ms: 4000 }, { t0_ms: 4000, t1_ms: 6000 }],
    }, { project_id: projectId, expected_revision: rev() }));
    service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: rev() }));

    let missing: string[] = [];
    try {
      service.execute(command('gate.approve', { gate: 'G2', approved_budget_cents: 1000 }, {
        project_id: projectId, expected_revision: rev(),
      }));
    } catch (error) {
      const details = (error as { details?: { missing_shot_ids?: string[] } }).details;
      missing = details?.missing_shot_ids ?? [];
    }

    recordAcceptance('FLOW-003.missing-list', { missingShotIds: missing });
    expect(missing).toEqual(['shot-01', 'shot-02', 'shot-03']);
  });
});
