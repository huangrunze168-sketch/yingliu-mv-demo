import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, PROJECT_CHILD_TABLES, ProjectService } from '@qiyin/domain';

/* ============================================================
   彻底删除的完整性。

   起因是一个真实故障：项目里有**资产评级**时，`project.purge` 报「内部错误」，
   项目删不掉。根因是 `asset_ratings` 这张带 `project_id` 的表没进
   `PROJECT_CHILD_TABLES`，于是最后那句 `DELETE FROM projects` 撞外键。

   这个故障的形状值得记住：**加表的时候没人会记得来改这份清单**，
   而漏掉的代价要等到某天某个项目正好用了那张表才出现，
   报出来的还是"内部错误"——离起因非常远。

   所以这里不测"某一个项目能不能删"，而是测**这张清单完不完整**：
   凡是带 `project_id` 的表，要么在清单里，要么在"明确不删"的白名单里并写明理由。
   新增表时这条测试会立刻变红，而且指着那张表的名字。
   ============================================================ */

/** 明确不随项目删除的表。目前为空——加进来的人必须给出理由。 */
const KEPT_ON_PURGE: readonly string[] = [];

function schemaOf(db: ReturnType<typeof openDatabase>) {
  const tables = (db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as Array<{ name: string }>).map((row) => row.name);
  return tables.map((name) => ({
    name,
    columns: (db.prepare(`PRAGMA table_info(${name})`).all() as unknown as Array<{ name: string }>)
      .map((column) => column.name),
  }));
}

describe('彻底删除的完整性', () => {
  it('带 project_id 的表一张都不能漏在清理清单外', () => {
    const db = openDatabase(':memory:');
    const withProjectId = schemaOf(db)
      .filter((table) => table.columns.includes('project_id'))
      .map((table) => table.name);

    const missing = withProjectId.filter((name) => (
      !PROJECT_CHILD_TABLES.includes(name) && !KEPT_ON_PURGE.includes(name)
    ));

    expect(missing, `这些表带 project_id 但没进 PROJECT_CHILD_TABLES：${missing.join(', ')}`).toEqual([]);
  });

  it('清单里的表必须真的存在（防止改名后留下一个删不掉的死名字）', () => {
    const db = openDatabase(':memory:');
    const names = new Set(schemaOf(db).map((table) => table.name));
    const unknown = PROJECT_CHILD_TABLES.filter((table) => !names.has(table));
    expect(unknown, `PROJECT_CHILD_TABLES 里有不存在的表：${unknown.join(', ')}`).toEqual([]);
  });

  it('有资产评级的项目也能彻底删除（这就是当初踩到的那一步）', () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.create',
      payload: { name: '带评级的项目', max_budget_cents: 1000, rights_confirmed: true },
    });
    const projectId = created.project_id!;

    // 造一份产物并给它打分：评级表里会出现一行指向这个项目的记录
    const artifactId = `sha256:${'a'.repeat(64)}`;
    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'artifact.publish',
      payload: { artifact_id: artifactId, media_type: 'image/png', bytes: 12 },
    });
    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'asset.rate',
      project_id: projectId, expected_revision: 1,
      payload: { artifact_id: artifactId, stars: 5 },
    });

    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.trash',
      project_id: projectId, expected_revision: 2, payload: {},
    });
    const purge = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.purge',
      project_id: projectId, expected_revision: 3, payload: { confirm_name: '带评级的项目' },
    });
    expect(purge.payload).toMatchObject({ purged: true });
  });
});
