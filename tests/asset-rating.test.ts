import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';

/* ============================================================

   这一层的三条判断都值得钉死：
     ① 打分对象必须是**已发布的产物**——编造的 id 会在库里留一条
        永远对不上任何东西的评分；
     ② `0` 是**清除**，不是"打 0 星"；
     ③ 评级**按项目存**：artifact 是全局内容寻址的，但"这张图好不好"
        是就这个项目而言的判断，A 项目里的废片在 B 项目里可能是要的素材。
   ============================================================ */

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

/** 建一个项目并发布一份产物，返回项目 id 与产物 id。 */
function setupProject(service: ProjectService, name: string) {
  const created = service.execute(command('project.create', { name, max_budget_cents: 1000, rights_confirmed: true }));
  const projectId = created.project_id!;
  const artifactId = `sha256:${'a'.repeat(64)}`;
  service.execute(command('artifact.publish', { artifact_id: artifactId, media_type: 'image/png', bytes: 10 }));
  return { projectId, artifactId, revision: () => (service.getProject(projectId) as { revision: number }).revision };
}

describe('资产评级', () => {
  it('打分之后项目快照里能看到', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, artifactId, revision } = setupProject(service, '打分项目');
    service.execute(command('asset.rate', { artifact_id: artifactId, stars: 4 }, {
      project_id: projectId, expected_revision: revision(),
    }));
    const snapshot = service.getProject(projectId) as {
      asset_ratings?: Array<{ artifact_id: string; stars: number }>;
    };
    expect(snapshot.asset_ratings).toEqual([
      expect.objectContaining({ artifact_id: artifactId, stars: 4 }),
    ]);
  });

  it('改分是更新，不是多出一条', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, artifactId, revision } = setupProject(service, '改分项目');
    service.execute(command('asset.rate', { artifact_id: artifactId, stars: 2 }, {
      project_id: projectId, expected_revision: revision(),
    }));
    service.execute(command('asset.rate', { artifact_id: artifactId, stars: 5 }, {
      project_id: projectId, expected_revision: revision(),
    }));
    const snapshot = service.getProject(projectId) as { asset_ratings?: Array<{ stars: number }> };
    expect(snapshot.asset_ratings).toHaveLength(1);
    expect(snapshot.asset_ratings?.[0]?.stars).toBe(5);
  });

  it('0 分是"清除评分"：清完之后它回到未评分，而不是留下一条 0 星', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, artifactId, revision } = setupProject(service, '清除项目');
    service.execute(command('asset.rate', { artifact_id: artifactId, stars: 3 }, {
      project_id: projectId, expected_revision: revision(),
    }));
    service.execute(command('asset.rate', { artifact_id: artifactId, stars: 0 }, {
      project_id: projectId, expected_revision: revision(),
    }));
    const snapshot = service.getProject(projectId) as { asset_ratings?: unknown[] };
    expect(snapshot.asset_ratings).toEqual([]);
  });

  it('同一个产物在两个项目里各有各的分（A 项目的废片可能是 B 项目要的素材）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const first = setupProject(service, '项目甲');
    const second = setupProject(service, '项目乙');
    /* 两个项目发布的是**同一个内容哈希**——这正是"全局内容寻址"的常态 */
    expect(first.artifactId).toBe(second.artifactId);

    service.execute(command('asset.rate', { artifact_id: first.artifactId, stars: 5 }, {
      project_id: first.projectId, expected_revision: first.revision(),
    }));
    service.execute(command('asset.rate', { artifact_id: second.artifactId, stars: 1 }, {
      project_id: second.projectId, expected_revision: second.revision(),
    }));

    const a = service.getProject(first.projectId) as { asset_ratings?: Array<{ stars: number }> };
    const b = service.getProject(second.projectId) as { asset_ratings?: Array<{ stars: number }> };
    expect(a.asset_ratings?.[0]?.stars).toBe(5);
    expect(b.asset_ratings?.[0]?.stars).toBe(1);
  });

  it('给不存在的产物打分会被拒——编造的 id 不该在库里留下评分', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setupProject(service, '拒绝项目');
    expect(() => service.execute(command('asset.rate', {
      artifact_id: `sha256:${'f'.repeat(64)}`, stars: 5,
    }, { project_id: projectId, expected_revision: revision() }))).toThrow(/资产不存在|不存在/);
  });

  it('越界的星数在契约层就被拒（0–5 之外没有意义）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, artifactId, revision } = setupProject(service, '越界项目');
    expect(() => service.execute(command('asset.rate', { artifact_id: artifactId, stars: 6 }, {
      project_id: projectId, expected_revision: revision(),
    }))).toThrow();
  });

  it('回收站里的项目不能打分（与其它写命令同一条规矩）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, artifactId, revision } = setupProject(service, '回收站项目');
    service.execute(command('project.trash', {}, { project_id: projectId, expected_revision: revision() }));
    expect(() => service.execute(command('asset.rate', { artifact_id: artifactId, stars: 5 }, {
      project_id: projectId, expected_revision: revision(),
    }))).toThrow(/回收站/);
  });

  it('打分留下审计事件（谁在什么时候打了多少分）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, artifactId, revision } = setupProject(service, '审计项目');
    service.execute(command('asset.rate', { artifact_id: artifactId, stars: 4 }, {
      project_id: projectId, expected_revision: revision(),
    }));
    const rated = service.listEvents(projectId).filter((event) => event.type === 'asset.rated');
    expect(rated).toHaveLength(1);
    expect((rated[0]?.payload as { stars?: number } | undefined)?.stars).toBe(4);
  });
});
