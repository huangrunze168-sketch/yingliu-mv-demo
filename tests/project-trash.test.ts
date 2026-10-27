import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import type { DatabaseSync } from 'node:sqlite';

/* ============================================================
   回收站与删除语义（清单 #8）
   ------------------------------------------------------------
   删除这件事的风险不在"能不能删"，而在**删的范围对不对**：
     · 少删一张子表 → 外键约束报错，或者留下一堆孤儿行；
     · 多删一样东西 → 把跨项目共享的 artifacts 一起删掉，别的项目跟着坏。
   所以这里的断言大部分是"查库看还剩什么"，而不是"看返回值成没成"。

   另一类断言针对"两道闸门"：彻底删除必须①已在回收站 ②项目名逐字一致。
   单独任何一道都有一种失误能穿过去（对着项目列表手滑 / 在回收站里选错行），
   所以两道都要有独立的测试，不能只测"两个都对时能删"。
   ============================================================ */

const shot = {
  shot_id: 'shot-01', t0_ms: 0, t1_ms: 2100, duration_ms: 2100,
  shot_size: 'medium_close_up', camera_position: 'eye_level', camera_move: 'slow_push_in',
  lighting: 'soft_key_from_left', sound: 'dialogue', replacement: '替换人物，保留窗光方向',
  confidence: 0.9, source: 'human', author: 'user:test',
} as const;

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

/** 建一个"有内容"的项目：G0 已批、有镜头表、有一条已发布产物。 */
function seedProject(service: ProjectService, name = '测试项目') {
  const created = service.execute(command('project.create', { name, max_budget_cents: 1000, rights_confirmed: true }));
  const projectId = created.project_id!;
  service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  service.execute(command('shot-fields.replace', { breakdown_revision: 1, shots: [shot] }, { project_id: projectId, expected_revision: 2 }));
  service.execute(command('artifact.publish', {
    artifact_id: `sha256:${'a'.repeat(64)}`,
    media_type: 'image/png',
    bytes: 128,
  }));
  return projectId;
}

function countRows(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as unknown as { n: number } | undefined;
  return row?.n ?? 0;
}

describe('回收站：软删除与恢复', () => {
  it('移入回收站只改一个标记，项目内容一行不动', () => {
    const db = openDatabase(':memory:');
    const service = new ProjectService(db);
    const projectId = seedProject(service);

    const fieldsBefore = countRows(db, 'SELECT COUNT(*) AS n FROM shot_fields WHERE project_id=?', projectId);
    const gatesBefore = countRows(db, 'SELECT COUNT(*) AS n FROM gate_decisions WHERE project_id=?', projectId);

    service.execute(command('project.trash', {}, { project_id: projectId, expected_revision: 3 }));

    /* 列表分开：全部项目里没有它，回收站里有 */
    expect(service.listProjects()).toHaveLength(0);
    expect(service.listTrashedProjects()).toHaveLength(1);
    /* 内容原样保留——这正是"能恢复"的前提 */
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM shot_fields WHERE project_id=?', projectId)).toBe(fieldsBefore);
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM gate_decisions WHERE project_id=?', projectId)).toBe(gatesBefore);
    const snapshot = service.getProject(projectId) as { deleted_at: string | null; shot_fields: { shots: unknown[] } | null };
    expect(snapshot.deleted_at).not.toBeNull();
    expect(snapshot.shot_fields?.shots).toHaveLength(1);
  });

  it('回收站里的项目不能继续写：先恢复再操作', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = seedProject(service);
    service.execute(command('project.trash', {}, { project_id: projectId, expected_revision: 3 }));

    expect(() => service.execute(
      command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 4 }),
    )).toThrow(/回收站/);
    /* 连"再删一次"也要被挡住，而不是静默成功 */
    expect(() => service.execute(
      command('project.trash', {}, { project_id: projectId, expected_revision: 4 }),
    )).toThrow(/回收站/);
  });

  it('恢复之后一切照旧：能继续批准闸门', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = seedProject(service);
    service.execute(command('project.trash', {}, { project_id: projectId, expected_revision: 3 }));
    service.execute(command('project.restore', {}, { project_id: projectId, expected_revision: 4 }));

    expect(service.listProjects()).toHaveLength(1);
    expect(service.listTrashedProjects()).toHaveLength(0);
    service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 5 }));
    /*
      注意列表里没有 `artifact.published`：`artifact.publish` 是**全局命令**
      （内容寻址产物不属于某一个项目），它不写项目事件。这不是漏记，
      是那条命令本来就没有 project_id——顺手把这件事写下来，
      免得下一个人看到"发布了产物却没有事件"以为是 bug。
    */
    expect(service.listEvents(projectId).map((event) => event.type)).toEqual([
      'project.created', 'gate.approved', 'shot-fields.replaced',
      'project.trashed', 'project.restored', 'gate.approved',
    ]);
  });

  it('不在回收站里的项目报"无需恢复"，而不是假装恢复成功', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = seedProject(service);
    expect(() => service.execute(
      command('project.restore', {}, { project_id: projectId, expected_revision: 3 }),
    )).toThrow(/不在回收站/);
  });
});

describe('彻底删除：两道闸门 + 级联范围', () => {
  it('第一道闸门：活跃项目即使名字输对也删不掉', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = seedProject(service, '不能直接删的项目');
    expect(() => service.execute(
      command('project.purge', { confirm_name: '不能直接删的项目' }, { project_id: projectId, expected_revision: 3 }),
    )).toThrow(/回收站/);
    expect(service.listProjects()).toHaveLength(1);
  });

  it('第二道闸门：在回收站里也要把项目名敲对', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = seedProject(service, '需要确认的项目');
    service.execute(command('project.trash', {}, { project_id: projectId, expected_revision: 3 }));

    expect(() => service.execute(
      command('project.purge', { confirm_name: '需要确认的项' }, { project_id: projectId, expected_revision: 4 }),
    )).toThrow(/项目名/);
    /* 名字不对时项目必须完好无损——"拒绝了但也删了一半"是最糟的结果 */
    expect(service.listTrashedProjects()).toHaveLength(1);
    expect(service.getProject(projectId)).toBeTruthy();
  });

  it('两道都过才真的删：子表清干净、projects 行消失，但 artifacts 保留', () => {
    const db = openDatabase(':memory:');
    const service = new ProjectService(db);
    const projectId = seedProject(service, '待彻底删除');
    service.execute(command('project.trash', {}, { project_id: projectId, expected_revision: 3 }));

    const purgeCommandId = randomUUID();
    service.execute({
      command_id: purgeCommandId,
      actor: 'user:test',
      type: 'project.purge',
      project_id: projectId,
      expected_revision: 4,
      payload: { confirm_name: '待彻底删除' },
    });

    expect(service.listTrashedProjects()).toHaveLength(0);
    expect(service.listProjects()).toHaveLength(0);

    /* 该项目名下的每一张子表都不该再有行 */
    for (const table of [
      'shot_fields', 'gate_decisions', 'events', 'image_candidates', 'selections',
      'spatial_plans', 'source_assets', 'eval_reports', 'repair_plans',
      'kernel_tasks', 'prompt_bundles', 'video_intents',
      'image_generation_intents', 'video_generation_intents',
    ]) {
      expect(
        countRows(db, `SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`, projectId),
        `${table} 里还留着这个项目的行`,
      ).toBe(0);
    }
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM projects WHERE id=?', projectId)).toBe(0);

    /*
      artifacts 必须留着：它是全局内容寻址的（主键是内容哈希），
      另一个项目完全可能引用同一个哈希。按项目删它会伤到别的项目。
    */
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM artifacts')).toBe(1);

    /*
      processed_commands 里只剩 purge 自己这一条。
      这不是"漏删"：它在删除动作之后才写入，是这次命令的幂等凭据——
      留着它，同一个 purge 命令重放才会返回 replayed 而不是重跑一遍。
    */
    const remaining = db.prepare('SELECT command_id FROM processed_commands WHERE project_id=?')
      .all(projectId) as unknown as Array<{ command_id: string }>;
    expect(remaining.map((row) => row.command_id)).toEqual([purgeCommandId]);
  });

  it('彻底删除之后重放同一个命令，返回 replayed 而不是报"项目不存在"', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = seedProject(service, '重放测试');
    service.execute(command('project.trash', {}, { project_id: projectId, expected_revision: 3 }));
    const purgeInput = {
      command_id: randomUUID(),
      actor: 'user:test',
      type: 'project.purge',
      project_id: projectId,
      expected_revision: 4,
      payload: { confirm_name: '重放测试' },
    };
    service.execute(purgeInput);
    const replay = service.execute(purgeInput);
    expect(replay.replayed).toBe(true);
  });

  it('彻底删除的是"这一个"项目，别的项目连产物一起完好', () => {
    const db = openDatabase(':memory:');
    const service = new ProjectService(db);
    const doomed = seedProject(service, '删掉这个');
    const keeper = seedProject(service, '留下这个');
    service.execute(command('project.trash', {}, { project_id: doomed, expected_revision: 3 }));
    service.execute(command('project.purge', { confirm_name: '删掉这个' }, { project_id: doomed, expected_revision: 4 }));

    expect(countRows(db, 'SELECT COUNT(*) AS n FROM projects WHERE id=?', keeper)).toBe(1);
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM shot_fields WHERE project_id=?', keeper)).toBe(1);
    /* 两个项目发布的是同一个哈希（夹具里写死），所以 artifacts 仍是 1 行而不是 0 */
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM artifacts')).toBe(1);
  });
});
