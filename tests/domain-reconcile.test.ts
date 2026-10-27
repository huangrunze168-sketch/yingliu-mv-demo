/* ============================================================
  CLI-002「脚本批处理、查询、取消、reconcile」的核心。

  矩阵的验收口径是一句话，但它是一句**关于钱**的话：

    「中断重试不重复付费：100 次故障注入中重复付费请求数 = 0」

  "中断重试"在真实客户端里长两种样子，两种都得挡住：

    ① **同一个 command_id** 重试（客户端自己重发）→ 靠 `processed_commands` 幂等；
    ② **换一个新的 command_id** 重试（很多重试中间件会重新生成请求 id）
       → 靠"在飞去重"（同项目 + 同镜头 + 同 digest 的 ADMITTED 意图只认一次）。

  第②种以前是**没有**的：一次网络抖动就会让同一张图被买两次。这一组用例
  就是钉它，外加上一轮加的对账（`reconcile`）与预算漂移检测。
  ============================================================ */

import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { command } from './acceptance/_acceptance.js';

function setup() {
  const service = new ProjectService(openDatabase(':memory:'));
  const created = service.execute(command('project.create', {
    name: '对账验收', max_budget_cents: 100_000, rights_confirmed: true,
  }));
  const projectId = created.project_id as string;
  const revision = (): number => (service.getProject(projectId) as { revision: number }).revision;
  const reserved = (): number => (service.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents;
  service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: revision() }));
  service.execute(command('shot-fields.seed', {
    breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2000 }],
  }, { project_id: projectId, expected_revision: revision() }));
  service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: revision() }));
  return { service, projectId, revision, reserved };
}

/** 让项目满足 G2 的前置（有候选、已选帧、G2 已批）。 */
function approveG2(ctx: ReturnType<typeof setup>): void {
  const { service, projectId, revision } = ctx;
  service.execute(command('image-candidate.add', {
    shot_id: 'shot-01', candidate_id: 'cand-A', artifact_id: `sha256:${'a'.repeat(64)}`,
  }, { project_id: projectId, expected_revision: revision() }));
  service.execute(command('image-candidate.select', {
    shot_id: 'shot-01', candidate_id: 'cand-A', expected_selection_revision: 0,
  }, { project_id: projectId, expected_revision: revision() }));
  service.execute(command('gate.approve', { gate: 'G2', approved_budget_cents: 50_000 }, {
    project_id: projectId, expected_revision: revision(),
  }));
}

describe('在飞去重：换了 command_id 的重试也不重复付费', () => {
  it('同 digest 的第二发拿到同一个意图，预算只预留一次', () => {
    const ctx = setup();
    const { service, projectId, revision, reserved } = ctx;
    const first = service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'm', prompt: '一只猫', estimated_cost_cents: 50, digest: 'digest-A',
    }, { project_id: projectId, expected_revision: revision() }));
    const reservedAfterFirst = reserved();

    /* 客户端"没收到响应"→ 换了新的 command_id 重发（digest 相同） */
    const second = service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'm', prompt: '一只猫', estimated_cost_cents: 50, digest: 'digest-A',
    }, { project_id: projectId, expected_revision: revision() }));

    const firstId = (first.payload as { intent_id: string }).intent_id;
    const secondPayload = second.payload as { intent_id: string; deduplicated?: boolean };
    expect(secondPayload.intent_id).toBe(firstId);
    expect(secondPayload.deduplicated).toBe(true);
    expect(reserved()).toBe(reservedAfterFirst);
    expect(service.listImageGenerationIntents(projectId)).toHaveLength(1);
  });

  it('digest 不同就是两次真的生成：各自新建、各自预留', () => {
    const ctx = setup();
    const { service, projectId, revision, reserved } = ctx;
    service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'm', prompt: '一只猫', estimated_cost_cents: 50, digest: 'digest-A',
    }, { project_id: projectId, expected_revision: revision() }));
    service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'm', prompt: '一只狗', estimated_cost_cents: 50, digest: 'digest-B',
    }, { project_id: projectId, expected_revision: revision() }));
    expect(service.listImageGenerationIntents(projectId)).toHaveLength(2);
    expect(reserved()).toBe(100);
  });

  it('没给 digest 就不去重——没有意图指纹时不拿"看着像"替用户省钱', () => {
    const ctx = setup();
    const { service, projectId, revision, reserved } = ctx;
    for (let index = 0; index < 2; index += 1) {
      service.execute(command('image-generation.request', {
        shot_id: 'shot-01', model: 'm', prompt: '同一句提示词', estimated_cost_cents: 50,
      }, { project_id: projectId, expected_revision: revision() }));
    }
    /* 模型有随机性：两次真跑本来就该是两张不同的图 */
    expect(service.listImageGenerationIntents(projectId)).toHaveLength(2);
    expect(reserved()).toBe(100);
  });

  it('已经结算过的 digest 不再当成"在飞"：那一笔该走显式复用', () => {
    const ctx = setup();
    const { service, projectId, revision, reserved } = ctx;
    const first = service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'm', prompt: '一只猫', estimated_cost_cents: 50, digest: 'digest-A',
    }, { project_id: projectId, expected_revision: revision() }));
    service.execute(command('image-generation.settle', {
      intent_id: (first.payload as { intent_id: string }).intent_id,
      status: 'COMPLETED', actual_cost_cents: 50, candidate_id: 'cand-A',
    }, { project_id: projectId, expected_revision: revision() }));
    const reservedAfterSettle = reserved();

    service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'm', prompt: '一只猫', estimated_cost_cents: 50, digest: 'digest-A',
    }, { project_id: projectId, expected_revision: revision() }));
    /* 结算是"这一张已经出来了"；想省钱要走 reuse，而不是让写路径猜 */
    expect(service.listImageGenerationIntents(projectId)).toHaveLength(2);
    expect(reserved()).toBe(reservedAfterSettle + 50);
  });

  it('视频那条同样去重', () => {
    const ctx = setup();
    const { service, projectId, revision, reserved } = ctx;
    approveG2(ctx);
    const first = service.execute(command('video-generation.request', {
      shot_id: 'shot-01', model: 'v', duration_seconds: 5, estimated_cost_cents: 80, digest: 'v-A',
    }, { project_id: projectId, expected_revision: revision() }));
    const reservedAfterFirst = reserved();
    const second = service.execute(command('video-generation.request', {
      shot_id: 'shot-01', model: 'v', duration_seconds: 5, estimated_cost_cents: 80, digest: 'v-A',
    }, { project_id: projectId, expected_revision: revision() }));
    expect((second.payload as { intent_id: string }).intent_id).toBe((first.payload as { intent_id: string }).intent_id);
    expect(reserved()).toBe(reservedAfterFirst);
    expect(service.listVideoGenerationIntents(projectId)).toHaveLength(1);
  });
});

describe('对账（reconcile）', () => {
  it('列出在飞的付费请求，并核对预算台账', () => {
    const ctx = setup();
    const { service, projectId, revision } = ctx;
    service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'm', prompt: '一只猫', estimated_cost_cents: 30, digest: 'd1',
    }, { project_id: projectId, expected_revision: revision() }));
    service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'm', prompt: '一只狗', estimated_cost_cents: 20, digest: 'd2',
    }, { project_id: projectId, expected_revision: revision() }));

    const report = service.reconcileProject(projectId);
    expect(report.in_flight).toHaveLength(2);
    expect(report.budget.in_flight_cents).toBe(50);
    expect(report.budget.reserved_cents).toBe(50);
    /* 台账与在飞对得上 —— 这是"钱没算错"的那条线 */
    expect(report.budget.drift_cents).toBe(0);
    expect(report.budget.consistent).toBe(true);
    expect(report.suggestions).toHaveLength(2);
    expect(report.suggestions.every((item) => item.action === 'inspect')).toBe(true);
    expect(report.suggestions[0]?.reason).toContain('还在跑');
  });

  it('台账与在飞对不上时把漂移报出来（正负都要）', () => {
    const ctx = setup();
    const { service, projectId, revision } = ctx;
    service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'm', prompt: '一只猫', estimated_cost_cents: 30, digest: 'd1',
    }, { project_id: projectId, expected_revision: revision() }));

    /* 人为制造漂移：台账被多占了 70 分（真实场景是某次释放没走完） */
    service.execute(command('project.create', {
      name: '占位', max_budget_cents: 1, rights_confirmed: true,
    }));
    const db = (service as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.prepare('UPDATE projects SET reserved_budget_cents = reserved_budget_cents + 70 WHERE id=?').run(projectId);

    const report = service.reconcileProject(projectId);
    expect(report.budget.drift_cents).toBe(70);
    expect(report.budget.consistent).toBe(false);
    const driftSuggestion = report.suggestions.find((item) => item.intent_id === '');
    expect(driftSuggestion).toBeDefined();
    expect(driftSuggestion?.reason).toContain('对不上');
    expect(driftSuggestion?.reason).toContain('70');
  });

  it('等太久的悬空请求给的是"释放预留"，不是"再等等"', () => {
    const ctx = setup();
    const { service, projectId, revision } = ctx;
    service.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'm', prompt: '一只猫', estimated_cost_cents: 40, digest: 'd1',
    }, { project_id: projectId, expected_revision: revision() }));
    /* 把它改成 40 分钟前提交的（阈值是 15 分钟） */
    const db = (service as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    const stale = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    db.prepare('UPDATE image_generation_intents SET created_at=?, updated_at=? WHERE project_id=?').run(stale, stale, projectId);

    const report = service.reconcileProject(projectId);
    expect(report.in_flight[0]?.age_seconds).toBeGreaterThan(15 * 60);
    expect(report.suggestions[0]?.action).toBe('release');
    expect(report.suggestions[0]?.reason).toContain('释放');
  });

  it('没有在飞请求时是一份干净的报告（不是 null，也不是报错）', () => {
    const ctx = setup();
    const report = ctx.service.reconcileProject(ctx.projectId);
    expect(report.in_flight).toEqual([]);
    expect(report.suggestions).toEqual([]);
    expect(report.budget).toMatchObject({ reserved_cents: 0, in_flight_cents: 0, drift_cents: 0, consistent: true });
  });

  it('项目不存在：404 的领域错误，不是一个空报告', () => {
    const ctx = setup();
    expect(() => ctx.service.reconcileProject('00000000-0000-4000-8000-000000000000')).toThrow(/不存在/);
  });
});
