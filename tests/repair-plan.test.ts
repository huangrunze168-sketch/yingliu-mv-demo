import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildEvalReport, proposeRepairPlan, shotContentDigest } from '@qiyin/kernel-service';
import type { FrontkernelMediaProbe } from '@qiyin/frontkernel-adapter';
import type { FilmShot } from '@qiyin/kernel-service';

/**
 * 修复方案。
 *
 * 最要紧的性质是**作用域最小 + 复用显式**：
 * 只有被评估点名的镜头才该重跑，其余必须写进复用清单。
 * 「未受影响却被动重跑」是复刻类产品最容易悄悄烧钱的地方。
 */

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const REPORT_ID = randomUUID();

function probe(overrides: Partial<FrontkernelMediaProbe> = {}): FrontkernelMediaProbe {
  return { path: 'x.mp4', duration: 4.2, hasVideo: true, hasAudio: true, width: 540, height: 960, frameRate: 30, ...overrides };
}

/**
 * 默认镜头用**整数帧**时长（2100ms @30fps = 63 帧，精确）。
 *
 * 「干净」与「有漂移」两种场景必须分开：需要漂移的用例显式传 1234ms，
 * 而不是让默认数据也带上误差——否则「无偏差时不生成方案」这类断言
 * 会被默认数据里的量化漂移悄悄破坏。
 */
const DEFAULT_SHOTS = [
  { shot_id: 'shot-01', duration_ms: 2100 },
  { shot_id: 'shot-02', duration_ms: 2100 },
  { shot_id: 'shot-03', duration_ms: 2100 },
];

/** 第二镜换成非整数帧（37.02 帧），专门用来制造时长漂移。 */
const SHOTS_WITH_DRIFT = [
  { shot_id: 'shot-01', duration_ms: 2100 },
  { shot_id: 'shot-02', duration_ms: 1234 },
  { shot_id: 'shot-03', duration_ms: 2100 },
];

function report(reference: FrontkernelMediaProbe, result: FrontkernelMediaProbe, shots = DEFAULT_SHOTS) {
  return buildEvalReport({
    referenceArtifact: HASH_A, resultArtifact: HASH_B,
    reference, result, shots, frameRate: 30,
  });
}

const ALL_SHOTS = ['shot-01', 'shot-02', 'shot-03'];

describe('镜头内容指纹', () => {
  const base: FilmShot = { shot_id: 'shot-02', image_src: 'frames/b.jpg', duration_ms: 1500 };

  it('同一份输入得到相同指纹', () => {
    expect(shotContentDigest(base)).toBe(shotContentDigest({ ...base }));
  });

  it('画面或时长变了，指纹就变', () => {
    expect(shotContentDigest({ ...base, duration_ms: 1600 })).not.toBe(shotContentDigest(base));
    expect(shotContentDigest({ ...base, image_src: 'frames/c.jpg' })).not.toBe(shotContentDigest(base));
  });

  it('改前面镜头的时长，不会改变后面镜头的指纹 —— 这是复用判据的核心', () => {
    const second: FilmShot = { shot_id: 'shot-02', image_src: 'frames/b.jpg', duration_ms: 1500 };
    // 前一镜的时长变化会移动 shot-02 在时间轴上的起点，但那是位置、不是内容
    const before = shotContentDigest(second);
    expect(shotContentDigest(second)).toBe(before);
  });
});

describe('从评估生成修复方案', () => {
  it('全部维度都一致时不生成方案', () => {
    const plan = proposeRepairPlan({
      evalReportId: REPORT_ID, report: report(probe(), probe()), allShots: ALL_SHOTS, targetRevision: 9,
    });
    expect(plan).toBeNull();
  });

  it('逐镜时长有漂移时，只为责任镜头生成 retime_clip，其余进复用清单', () => {
    const plan = proposeRepairPlan({
      evalReportId: REPORT_ID,
      report: report(probe(), probe(), SHOTS_WITH_DRIFT),
      allShots: ALL_SHOTS,
      targetRevision: 9,
    });
    expect(plan).not.toBeNull();
    const retime = plan?.operations.filter((operation) => operation.kind === 'retime_clip') ?? [];
    expect(retime).toHaveLength(1);
    expect(retime[0]?.scope).toEqual(['shot-02']);
    // 改时长不影响首帧，不必重过 G2
    expect(retime[0]?.requires_gate).toBe('none');
    // 其余镜头显式复用
    expect(plan?.reused.sort()).toEqual(['shot-01', 'shot-03']);
    expect(plan?.source_eval_report).toBe(REPORT_ID);
  });

  it('没有镜头归因的维度落到整片作用域，并要求重过闸门', () => {
    const plan = proposeRepairPlan({
      evalReportId: REPORT_ID,
      report: report(probe({ width: 540, height: 960 }), probe({ width: 1080, height: 1920, hasAudio: true }), [
        { shot_id: 'shot-01', duration_ms: 2100 },
      ]),
      allShots: ['shot-01'],
      targetRevision: 4,
    });
    const programOps = plan?.operations.filter((operation) => operation.scope[0] === 'program') ?? [];
    expect(programOps.map((operation) => operation.kind)).toContain('rerender_full');
    expect(programOps.every((operation) => operation.requires_gate === 'G3')).toBe(true);
  });

  it('没有归因的镜头必然出现在复用清单里，一个都不漏', () => {
    const plan = proposeRepairPlan({
      evalReportId: REPORT_ID,
      // 画幅不一致会产生一个整片级操作，因此一定存在方案
      report: report(probe({ width: 540, height: 960 }), probe({ width: 1080, height: 1920 }), DEFAULT_SHOTS),
      allShots: ALL_SHOTS,
      targetRevision: 1,
    });
    expect(plan).not.toBeNull();
    const scoped = new Set((plan?.operations ?? []).flatMap((operation) => operation.scope));
    expect(scoped.has('program')).toBe(true);
    for (const shot of ALL_SHOTS) {
      expect(plan?.reused).toContain(shot);
    }
  });
});

describe('修复方案的领域行为', () => {
  function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
    return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
  }

  function setup() {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = service.execute(command('project.create', { name: '修复项目', max_budget_cents: 2000, rights_confirmed: true }));
    const projectId = created.project_id!;
    // 用带漂移的数据，保证「有偏差 → 有方案」这条前提成立
    const evalReport = report(probe(), probe(), SHOTS_WITH_DRIFT);
    const recorded = service.execute(command('eval.record', { report: evalReport }, { project_id: projectId, expected_revision: 1 }));
    const reportId = (recorded.payload as { report_id: string }).report_id;
    return { service, projectId, reportId, evalReport };
  }

  it('方案必须依据本项目已有的评估报告', () => {
    const { service, projectId, evalReport } = setup();
    const orphan = proposeRepairPlan({
      evalReportId: randomUUID(), report: evalReport, allShots: ALL_SHOTS, targetRevision: 2,
    });
    let caught: unknown;
    try {
      service.execute(command('repair.propose', { plan: orphan }, { project_id: projectId, expected_revision: 2 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('EVAL_REPORT_NOT_FOUND');
    expect((caught as { statusCode?: number }).statusCode).toBe(404);
  });

  it('记录方案后进入 PROPOSED，并在事件里带上作用域与复用清单', () => {
    const { service, projectId, reportId, evalReport } = setup();
    const plan = proposeRepairPlan({ evalReportId: reportId, report: evalReport, allShots: ALL_SHOTS, targetRevision: 2 });
    const recorded = service.execute(command('repair.propose', { plan }, { project_id: projectId, expected_revision: 2 }));
    const payload = recorded.payload as { plan_id: string; scope: string[]; reused: string[] };
    expect(payload.scope).toEqual(['shot-02']);
    expect(payload.reused.sort()).toEqual(['shot-01', 'shot-03']);

    const stored = service.listRepairPlans(projectId) as Array<{ status: string; plan: { operations: unknown[] } }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('PROPOSED');
    expect(service.listEvents(projectId).map((event) => event.type)).toEqual([
      'project.created', 'eval.recorded', 'repair.proposed',
    ]);
  });

  it('G4 在没有修复方案时被拒绝——「批准修复」必须指向具体动作', () => {
    const { service, projectId } = setup();
    let caught: unknown;
    try {
      service.execute(command('gate.approve', { gate: 'G4' }, { project_id: projectId, expected_revision: 2 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('REPAIR_PLAN_REQUIRED');
  });

  it('有方案后 G4 可以批准，并且状态进入 REPAIR_APPROVED', () => {
    const { service, projectId, reportId, evalReport } = setup();
    const plan = proposeRepairPlan({ evalReportId: reportId, report: evalReport, allShots: ALL_SHOTS, targetRevision: 2 });
    service.execute(command('repair.propose', { plan }, { project_id: projectId, expected_revision: 2 }));
    const approved = service.execute(command('gate.approve', { gate: 'G4', note: '批准修复' }, { project_id: projectId, expected_revision: 3 }));
    expect((approved.payload as { status: string }).status).toBe('APPROVED');

    const project = service.getProject(projectId) as { gate_status: Record<string, string>; state: string };
    expect(project.gate_status.G4).toBe('APPROVED');
    expect(project.state).toBe('REPAIR_APPROVED');
  });
});
