import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';

/* ============================================================
   删除产物。

   起因很直白：上传错了、生成废了，**没有地方删**——产物只进不出。
   但它比"删一个文件"重得多：`artifacts` 表是全局内容寻址的，
   同一份内容可能被别的项目引用，也可能在本项目里已经是某一镜的首帧候选。

   所以这个文件盯的主要不是"能不能删"，而是**什么时候必须拒绝**：
   删掉被引用的产物，界面上只会看到"某张图突然空了"，报错点在很远的地方。
   ============================================================ */

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

const ARTIFACT = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;

function setup() {
  const service = new ProjectService(openDatabase(':memory:'));
  const created = service.execute(command('project.create', {
    name: '删除产物项目', max_budget_cents: 1000, rights_confirmed: true,
  }));
  const projectId = created.project_id!;
  service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  service.execute(command('shot-fields.seed', { breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2100 }] }, {
    project_id: projectId, expected_revision: 2,
  }));
  service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
  return { service, projectId, revision: () => (service.getProject(projectId) as { revision: number }).revision };
}

describe('删除产物', () => {
  it('没被引用的产物：删掉记录，并把磁盘路径带回去（主进程据此删文件）', () => {
    const { service, projectId, revision } = setup();
    service.execute(command('artifact.publish', {
      artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10,
      metadata: { artifact_path_relative: 'uploads/x.png', project_id: projectId, source: 'upload' },
    }));

    const deleted = service.execute(command('artifact.delete', { artifact_id: ARTIFACT }, {
      project_id: projectId, expected_revision: revision(),
    }));
    const payload = deleted.payload as { artifact_path_relative: string | null };
    /* 路径要回给主进程——领域层不碰磁盘，这条分界从第一天就立着 */
    expect(payload.artifact_path_relative).toBe('uploads/x.png');
    expect((service.listArtifacts() as Array<{ artifact_id: string }>)
      .some((item) => item.artifact_id === ARTIFACT)).toBe(false);
  });

  it('其他项目画布的非 keeper 候选保护全局产物', () => {
    const { service, projectId, revision } = setup();
    const otherId = service.execute(command('project.create', { name: '引用它的项目', max_budget_cents: 0, rights_confirmed: false })).project_id!;
    service.execute(command('artifact.publish', { artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10 }));
    const node = { id: 'image-node', type: 'qtv', position: { x: 0, y: 0 }, data: { kind: 'image-edit', label: '首帧', aspectRatio: '16:9', prompt: '参考', status: 'ready', artifactId: OTHER, variants: [{ artifactId: ARTIFACT, mediaKind: 'image', name: '备选项' }] } };
    service.execute(command('canvas-document.replace', { document: { version: 2, nodes: [node], edges: [] } }, { project_id: otherId, expected_revision: 1 }));
    let caught: unknown;
    try { service.execute(command('artifact.delete', { artifact_id: ARTIFACT }, { project_id: projectId, expected_revision: revision() })); } catch (error) { caught = error; }
    expect((caught as { code?: string }).code).toBe('ARTIFACT_STILL_REFERENCED');
    expect((caught as { message?: string }).message).toContain('另一个项目的画布节点或候选');
  });

  it('其他项目时间线的片段引用也保护全局产物', () => {
    const { service, projectId, revision } = setup();
    const otherId = service.execute(command('project.create', { name: '时间线引用项目', max_budget_cents: 0, rights_confirmed: false })).project_id!;
    service.execute(command('artifact.publish', { artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10 }));
    service.execute(command('timeline-document.replace', { document: { version: 1, ripple: true, clips: [{ id: 'clip-other', track: 'V1', label: '参考素材', startMs: 0, durationMs: 1000, sourceOffsetMs: 0, artifactId: ARTIFACT }] } }, { project_id: otherId, expected_revision: 1 }));
    let caught: unknown;
    try { service.execute(command('artifact.delete', { artifact_id: ARTIFACT }, { project_id: projectId, expected_revision: revision() })); } catch (error) { caught = error; }
    expect((caught as { code?: string }).code).toBe('ARTIFACT_STILL_REFERENCED');
    expect((caught as { message?: string }).message).toContain('另一个项目的时间线片段');
  });

  it('还是某一镜的首帧候选：拒绝，并说清是"哪一镜的什么"', () => {
    const { service, projectId, revision } = setup();
    service.execute(command('artifact.publish', { artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10 }));
    service.execute(command('image-candidate.add', {
      shot_id: 'shot-01', candidate_id: 'cand-1', artifact_id: ARTIFACT,
    }, { project_id: projectId, expected_revision: revision() }));

    let caught: unknown;
    try {
      service.execute(command('artifact.delete', { artifact_id: ARTIFACT }, {
        project_id: projectId, expected_revision: revision(),
      }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('ARTIFACT_STILL_REFERENCED');
    /* 理由要能照着处理：告诉他是哪一镜、是什么 */
    expect((caught as { message?: string }).message).toContain('shot-01');
    expect((caught as { message?: string }).message).toContain('首帧候选');
  });

  it('**别的项目**在用它：同样拒绝（artifacts 是全局表，只查本项目会删出窟窿）', () => {
    const { service, projectId, revision } = setup();
    /* 另一个项目把同一份内容当候选 */
    const other = service.execute(command('project.create', {
      name: '另一个项目', max_budget_cents: 1000, rights_confirmed: true,
    }));
    const otherId = other.project_id!;
    service.execute(command('gate.approve', { gate: 'G0' }, { project_id: otherId, expected_revision: 1 }));
    service.execute(command('shot-fields.seed', { breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2100 }] }, {
      project_id: otherId, expected_revision: 2,
    }));
    service.execute(command('gate.approve', { gate: 'G1' }, { project_id: otherId, expected_revision: 3 }));
    service.execute(command('artifact.publish', { artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10 }));
    service.execute(command('image-candidate.add', {
      shot_id: 'shot-01', candidate_id: 'cand-other', artifact_id: ARTIFACT,
    }, { project_id: otherId, expected_revision: 4 }));

    let caught: unknown;
    try {
      service.execute(command('artifact.delete', { artifact_id: ARTIFACT }, {
        project_id: projectId, expected_revision: revision(),
      }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('ARTIFACT_STILL_REFERENCED');
    expect((caught as { message?: string }).message).toContain('另一个项目');
  });

  it('被空间方案里的构图蓝图引用：拒绝', () => {
    const { service, projectId, revision } = setup();
    service.execute(command('artifact.publish', { artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10 }));
    service.execute(command('spatial-plan.set', {
      shot_id: 'shot-01',
      plan: {
        schema: 'replica.spatial-plan@1', shot_id: 'shot-01', enabled: true, subjects: [],
        camera: { position: [0, 1.35, 9], target: [0, 0.85, 0], lens_mm: 50, pitch_deg: 0 },
        blueprint: { artifact_id: ARTIFACT, published_at: new Date().toISOString(), captured_from_revision: 1 },
      },
      expected_spatial_revision: 0,
    }, { project_id: projectId, expected_revision: revision() }));

    let caught: unknown;
    try {
      service.execute(command('artifact.delete', { artifact_id: ARTIFACT }, {
        project_id: projectId, expected_revision: revision(),
      }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('ARTIFACT_STILL_REFERENCED');
    expect((caught as { message?: string }).message).toContain('构图蓝图');
  });

  it('没有被引用的那份可以删，删完另一份还在', () => {
    const { service, projectId, revision } = setup();
    service.execute(command('artifact.publish', { artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10 }));
    service.execute(command('artifact.publish', { artifact_id: OTHER, media_type: 'image/png', bytes: 20 }));
    service.execute(command('image-candidate.add', {
      shot_id: 'shot-01', candidate_id: 'cand-1', artifact_id: ARTIFACT,
    }, { project_id: projectId, expected_revision: revision() }));

    service.execute(command('artifact.delete', { artifact_id: OTHER }, {
      project_id: projectId, expected_revision: revision(),
    }));
    const left = (service.listArtifacts() as Array<{ artifact_id: string }>).map((item) => item.artifact_id);
    expect(left).toContain(ARTIFACT);
    expect(left).not.toContain(OTHER);
  });

  it('删一份不存在的产物：404，而不是静默成功', () => {
    const { service, projectId, revision } = setup();
    let caught: unknown;
    try {
      service.execute(command('artifact.delete', { artifact_id: OTHER }, {
        project_id: projectId, expected_revision: revision(),
      }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('ARTIFACT_NOT_FOUND');
  });
});

/* ============================================================
  移除候选：把"删不掉"这条路打开。

  这个文件里前面那条用例（"还是某一镜的首帧候选 → 拒绝删除"）是**对的**：
  删掉被引用的产物会留下窟窿。但在 `image-candidate.remove` 之前，
  **没有任何办法把候选摘掉**——一张不满意的图只能永远留在项目里。
  真机上撞到过：验证用的占位图候选删不掉（`artifact.delete` 回
  "它还是「shot-01」的首帧候选"），而产品里没有对应的解绑动作。
  ============================================================ */
describe('移除候选', () => {
  it('摘掉候选之后，这份产物才删得掉', () => {
    const { service, projectId, revision } = setup();
    service.execute(command('artifact.publish', { artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10 }));
    service.execute(command('image-candidate.add', {
      shot_id: 'shot-01', candidate_id: 'cand-1', artifact_id: ARTIFACT,
    }, { project_id: projectId, expected_revision: revision() }));

    const removed = service.execute(command('image-candidate.remove', { candidate_id: 'cand-1' }, {
      project_id: projectId, expected_revision: revision(),
    }));
    /* 没选中的那张：只是清理，不带别的后果 */
    expect((removed.payload as { was_selected: boolean }).was_selected).toBe(false);
    expect((service.getProject(projectId) as { candidates: unknown[] }).candidates).toHaveLength(0);

    /* 现在删得掉了——这正是这条命令存在的理由 */
    const deleted = service.execute(command('artifact.delete', { artifact_id: ARTIFACT }, {
      project_id: projectId, expected_revision: revision(),
    }));
    expect((deleted.payload as { artifact_id: string }).artifact_id).toBe(ARTIFACT);
  });

  it('删掉**当前选中的那张**：选帧一起清掉，G2 作废', () => {
    const { service, projectId, revision } = setup();
    service.execute(command('artifact.publish', { artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10 }));
    service.execute(command('image-candidate.add', {
      shot_id: 'shot-01', candidate_id: 'cand-1', artifact_id: ARTIFACT,
    }, { project_id: projectId, expected_revision: revision() }));
    service.execute(command('image-candidate.select', {
      shot_id: 'shot-01', candidate_id: 'cand-1', expected_selection_revision: 0,
    }, { project_id: projectId, expected_revision: revision() }));
    service.execute(command('gate.approve', { gate: 'G2', approved_budget_cents: 500 }, {
      project_id: projectId, expected_revision: revision(),
    }));
    expect((service.getProject(projectId) as { gate_status: { G2: string | null } }).gate_status.G2).toBe('APPROVED');

    const removed = service.execute(command('image-candidate.remove', { candidate_id: 'cand-1' }, {
      project_id: projectId, expected_revision: revision(),
    }));
    expect((removed.payload as { was_selected: boolean }).was_selected).toBe(true);

    const after = service.getProject(projectId) as {
      selections: unknown[]; gate_status: { G2: string | null }; state: string;
    };
    /* 选帧跟着清掉：留着一条指向不存在候选的选帧，下游会拿着一个永远找不到的 id */
    expect(after.selections).toHaveLength(0);
    /* 第一帧没了，之前批准的视频生产不能照旧 */
    expect(after.gate_status.G2).not.toBe('APPROVED');
    expect(after.state).toBe('G2_PENDING');
  });

  it('移除一张不存在的候选：404，而不是静默成功', () => {
    const { service, projectId, revision } = setup();
    let caught: unknown;
    try {
      service.execute(command('image-candidate.remove', { candidate_id: 'cand-不存在' }, {
        project_id: projectId, expected_revision: revision(),
      }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('CANDIDATE_NOT_FOUND');
  });
});

/* ============================================================
  删产物时要回**磁盘路径**（主进程拿它去删文件）。

  路径在这个仓库里有**两个键**，是既有的约定：
    上传/登记类写 `artifact_path_relative`，生成类写 `frame_path_relative`
  （生成服务里那段解析注释写明了）。别处都是两个都认，只有领域层的删除
  原来只认第一个——真机上撞到过：生成出来的候选删掉记录之后路径回 null，
  主进程连文件都不去删，界面只能写一句"磁盘文件没删掉，可能需要手动清理"，
  **连路径都不给**，用户只能自己去 frames/ 里翻。
  ============================================================ */
describe('删除产物 · 磁盘路径的两个键', () => {
  it('生成类产物（只有 frame_path_relative）也要把路径带回去', () => {
    const { service, projectId, revision } = setup();
    service.execute(command('artifact.publish', {
      artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10,
      metadata: {
        project_id: projectId,
        source: 'stub-generation',
        frame_path_relative: 'frames/gen-2026-09-20T18-31-10-776Z/stub-shot-01-5c3d29bed665.png',
      },
    }));
    const deleted = service.execute(command('artifact.delete', { artifact_id: ARTIFACT }, {
      project_id: projectId, expected_revision: revision(),
    }));
    expect((deleted.payload as { artifact_path_relative: string | null }).artifact_path_relative)
      .toBe('frames/gen-2026-09-20T18-31-10-776Z/stub-shot-01-5c3d29bed665.png');
  });

  it('两个键都在时，上传类那个优先（与别处同一顺序）', () => {
    const { service, projectId, revision } = setup();
    service.execute(command('artifact.publish', {
      artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10,
      metadata: {
        artifact_path_relative: 'uploads/手选的.png',
        frame_path_relative: 'frames/gen-1/生成的那张.png',
      },
    }));
    const deleted = service.execute(command('artifact.delete', { artifact_id: ARTIFACT }, {
      project_id: projectId, expected_revision: revision(),
    }));
    expect((deleted.payload as { artifact_path_relative: string | null }).artifact_path_relative)
      .toBe('uploads/手选的.png');
  });

  it('坏 metadata 不当路径：删记录照做，路径回 null（不因此报错）', () => {
    const { service, projectId, revision } = setup();
    service.execute(command('artifact.publish', {
      artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10,
      metadata: { frame_path_relative: 42 },
    }));
    const deleted = service.execute(command('artifact.delete', { artifact_id: ARTIFACT }, {
      project_id: projectId, expected_revision: revision(),
    }));
    expect((deleted.payload as { artifact_path_relative: string | null }).artifact_path_relative).toBeNull();
    expect((service.listArtifacts() as Array<{ artifact_id: string }>)
      .some((item) => item.artifact_id === ARTIFACT)).toBe(false);
  });
});

/* ============================================================
  **同内容二次发布、落点变了**：旧路径那份要有人管。

  `artifacts` 是内容寻址的——同一份字节第二次发布时 artifact_id 不变，
  但落点可能落在新一批目录里（生成、抽帧都会），于是旧路径那份成了孤儿：
  记录指向新路径、旧文件谁也不认。真机收尾时就在 `frames/gen-…/` 里捡到过一个。

  领域层不碰磁盘，所以它只把"哪一份被顶替了"报出来（钩子）并在回执里带上
  旧路径；删文件由主进程那一处钩子做。
  ============================================================ */
describe('产物 · 落点换了', () => {
  it('同内容二次发布、路径变了：报出被顶替的那一份（含项目 id）', () => {
    const { service, projectId } = setup();
    const seen: Array<{ artifactId: string; projectId: string | null; from: string; to: string }> = [];
    service.onArtifactSuperseded = (info) => seen.push(info);

    service.execute(command('artifact.publish', {
      artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10,
      metadata: { project_id: projectId, frame_path_relative: 'frames/gen-第一批/frame.jpg' },
    }));
    const second = service.execute(command('artifact.publish', {
      artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10,
      metadata: { project_id: projectId, frame_path_relative: 'frames/gen-第二批/frame.jpg' },
    }));

    expect(seen).toEqual([{
      artifactId: ARTIFACT,
      projectId,
      from: 'frames/gen-第一批/frame.jpg',
      to: 'frames/gen-第二批/frame.jpg',
    }]);
    /* 回执里也带一份：调用方不接钩子也能自己处理 */
    expect((second.payload as { superseded_path_relative?: string }).superseded_path_relative)
      .toBe('frames/gen-第一批/frame.jpg');
  });

  it('路径没变（同一次发布重放）不报：这是幂等，不是"换地方"', () => {
    const { projectId, service } = setup();
    const seen: unknown[] = [];
    service.onArtifactSuperseded = (info) => seen.push(info);
    const publish = () => service.execute(command('artifact.publish', {
      artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10,
      metadata: { project_id: projectId, frame_path_relative: 'frames/gen-同一批/frame.jpg' },
    }));
    publish();
    const again = publish();
    expect(seen).toEqual([]);
    expect((again.payload as { superseded_path_relative?: string }).superseded_path_relative).toBeUndefined();
  });

  it('没接钩子时也不出错（钩子是可选的那一侧）', () => {
    const { projectId, service } = setup();
    service.execute(command('artifact.publish', {
      artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10,
      metadata: { project_id: projectId, frame_path_relative: 'frames/a/frame.jpg' },
    }));
    const second = service.execute(command('artifact.publish', {
      artifact_id: ARTIFACT, media_type: 'image/png', bytes: 10,
      metadata: { project_id: projectId, frame_path_relative: 'frames/b/frame.jpg' },
    }));
    expect((second.payload as { superseded_path_relative?: string }).superseded_path_relative)
      .toBe('frames/a/frame.jpg');
  });
});
