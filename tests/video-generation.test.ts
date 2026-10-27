import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { createCanvasBackend, CanvasAdapter, type CanvasRunRequest, type CanvasRunner } from '@qiyin/canvas-adapter';
import { frameRatio, GenerationService } from '@qiyin/generation-service';

/**
 * 视频生成（S6）。
 *
 * 这一环最要紧的不是「能不能生成」，而是 **G2 有没有真的拦住**：
 * 未选帧的镜头不得产生付费视频请求——这是 G2 存在的全部意义，
 * 也是接上真实付费模型之后唯一能防止漏钱的地方。
 */

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

/**/
function canvasRunner(options: { failShots?: readonly string[] } = {}) {
  const calls: CanvasRunRequest[] = [];
  const runner: CanvasRunner = {
    async run(request: CanvasRunRequest) {
      calls.push(request);
      const [name, second] = request.args;
      if (name === 'upload') {
        return { code: 0, stdout: JSON.stringify({ nodeKey: 'res-1', nodeType: 'image' }), stderr: '' };
      }
      if (name === 'node' && second === 'create') {
        const nodeName = request.args[2] ?? '';
        return { code: 0, stdout: JSON.stringify({ nodeKey: 'v-1', nodeType: 'video', data: { name: nodeName } }), stderr: '' };
      }
      if (name === 'node') {
        const nodeName = second ?? '';
        if ((options.failShots ?? []).some((shot) => nodeName.includes(shot))) {
          return { code: 1, stdout: '', stderr: 'error: 视频模型繁忙\n' };
        }
        return {
          code: 0, stderr: '',
          stdout: '[run] task=t2 status=2 progress=100%\n'
            + JSON.stringify({ nodeKey: 'v-1', status: 2, data: { url: ['https://example.test/clip.mp4'] } }),
        };
      }
      if (name === 'download') {
        const outIndex = request.args.indexOf('--out');
        const dir = (outIndex >= 0 ? request.args[outIndex + 1] : undefined) ?? request.cwd ?? tmpdir();
        const nodeName = request.args[2] ?? 'node';
        const file = join(dir, `${nodeName}.mp4`);
        writeFileSync(file, Buffer.from(`MP4:${nodeName}`), 'utf8');
        return { code: 0, stdout: `${file}\n`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'error: unexpected\n' };
    },
  };
  return { runner, calls };
}

function setup(options: { approveG2?: boolean; selectFirstFrame?: boolean; failShots?: readonly string[] } = {}) {
  const projects = new ProjectService(openDatabase(':memory:'));
  const created = projects.execute(command('project.create', { name: '视频生成项目', max_budget_cents: 5000, rights_confirmed: true }));
  const projectId = created.project_id!;
  projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  projects.execute(command('shot-fields.seed', {
    breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 5000 }],
  }, { project_id: projectId, expected_revision: 2 }));
  projects.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
  projects.execute(command('image-candidate.add', {
    shot_id: 'shot-01', candidate_id: 'cand-01', artifact_id: `sha256:${'a'.repeat(64)}`,
  }, { project_id: projectId, expected_revision: 4 }));
  if (options.selectFirstFrame !== false) {
    projects.execute(command('image-candidate.select', {
      shot_id: 'shot-01', candidate_id: 'cand-01', expected_selection_revision: 0,
    }, { project_id: projectId, expected_revision: 5 }));
  }
  if (options.approveG2 !== false) {
    projects.execute(command('gate.approve', { gate: 'G2', approved_budget_cents: 3000 }, {
      project_id: projectId, expected_revision: options.selectFirstFrame === false ? 5 : 6,
    }));
  }
  const { runner, calls } = canvasRunner({ ...(options.failShots === undefined ? {} : { failShots: options.failShots }) });
  const service = new GenerationService(projects, createCanvasBackend(new CanvasAdapter(runner)));
  const workspace = mkdtempSync(join(tmpdir(), 'qiyin-video-'));
  // 首帧图片得真实存在：上传读的是磁盘文件
  const frameDir = join(workspace, 'frames');
  mkdirSync(frameDir, { recursive: true });
  writeFileSync(join(frameDir, 'first.png'), Buffer.from('PNG'), 'utf8');
  return {
    projects, projectId, service, calls, workspace,
    revision: () => (projects.getProject(projectId) as { revision: number }).revision,
  };
}

describe('视频生成', () => {
  /*
    视频的复用（与出图同套机制，但这一段更贵，所以更要紧）。
    判据同样是**数后端被调用了几次**，而不是看返回值里有没有 reused。
  */
  it('同一镜、同一首帧、同一提示词：第二次复用片段，不花第二次钱', async () => {
    const { projectId, service, calls, workspace, revision } = setup();
    const request = {
      projectId,
      canvasCwd: workspace,
      workspaceDir: workspace,
      shots: [{ shot_id: 'shot-01', image_path_relative: 'frames/first.png', duration_seconds: 5, prompt: '缓慢推近' }],
      model: 'Seedance 2.0 Mini',
      resolution: '480p',
      estimatedCostCents: 100,
      actualCostCents: 90,
    };
    const runs = () => calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;

    const first = await service.generateShotVideos({ ...request, expectedRevision: revision() });
    expect(first.generated[0]?.reused).toBeUndefined();
    expect(runs()).toBe(1);

    const second = await service.generateShotVideos({ ...request, expectedRevision: revision() });
    expect(runs()).toBe(1);
    expect(second.generated[0]?.reused).toBe(true);
    /* 复用来的片段与第一次是同一份产物（内容寻址，本来就是同一条） */
    expect(second.generated[0]?.artifact_id).toBe(first.generated[0]?.artifact_id);
  });

  it('提示词变了：不复用，重新生成', async () => {
    const { projectId, service, calls, workspace, revision } = setup();
    const base = {
      projectId, canvasCwd: workspace, workspaceDir: workspace,
      model: 'Seedance 2.0 Mini', resolution: '480p', estimatedCostCents: 100,
    };
    await service.generateShotVideos({
      ...base, expectedRevision: revision(),
      shots: [{ shot_id: 'shot-01', image_path_relative: 'frames/first.png', duration_seconds: 5, prompt: '缓慢推近' }],
    });
    const afterFirst = calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;
    await service.generateShotVideos({
      ...base, expectedRevision: revision(),
      shots: [{ shot_id: 'shot-01', image_path_relative: 'frames/first.png', duration_seconds: 5, prompt: '快速拉远' }],
    });
    expect(calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length - afterFirst).toBe(1);
  });

  it('显式关掉复用：同样的输入也真的再跑一次', async () => {
    const { projectId, service, calls, workspace, revision } = setup();
    const base = {
      projectId, canvasCwd: workspace, workspaceDir: workspace,
      model: 'Seedance 2.0 Mini', resolution: '480p', estimatedCostCents: 100,
      shots: [{ shot_id: 'shot-01', image_path_relative: 'frames/first.png', duration_seconds: 5, prompt: '缓慢推近' }],
      reuseResults: false,
    };
    await service.generateShotVideos({ ...base, expectedRevision: revision() });
    const afterFirst = calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;
    await service.generateShotVideos({ ...base, expectedRevision: revision() });
    expect(calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length - afterFirst).toBe(1);
  });

  it('生成片段、登记入库并结清预算', async () => {
    const { projects, projectId, service, calls, workspace, revision } = setup();
    const outcome = await service.generateShotVideos({
      projectId,
      expectedRevision: revision(),
      canvasCwd: workspace,
      workspaceDir: workspace,
      shots: [{ shot_id: 'shot-01', image_path_relative: 'frames/first.png', duration_seconds: 5, prompt: '缓慢推近' }],
      model: 'Seedance 2.0 Mini',
      resolution: '480p',
      estimatedCostCents: 100,
      actualCostCents: 90,
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.generated).toHaveLength(1);
    expect(outcome.generated[0]?.artifact_id.startsWith('sha256:')).toBe(true);
    expect(outcome.generated[0]?.frame_path_relative).toContain('clips/gen-');
    expect(outcome.generated[0]?.duration_seconds).toBe(5);

    // 上传 → 建节点（带 --left 连参考图）→ 运行 → 下载
    const uploaded = calls.find((call) => call.args[0] === 'upload');
    expect(uploaded?.args).toContain('--resource');
    const created = calls.find((call) => call.args[0] === 'node' && call.args[1] === 'create');
    expect(created?.args).toContain('--left');
    expect(created?.args.join(' ')).toContain('modeType=singleImage2video');

    const intents = projects.listVideoGenerationIntents(projectId) as Array<{ status: string; actual_cost_cents: number }>;
    expect(intents).toHaveLength(1);
    expect(intents[0]?.status).toBe('COMPLETED');
    expect(intents[0]?.actual_cost_cents).toBe(90);
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(90);
  }, 60_000);

  it('未选帧时直接拒绝 —— 这是 G2 存在的全部意义', async () => {
    const { service, projectId, workspace, revision } = setup({ selectFirstFrame: false, approveG2: false });
    let caught: unknown;
    try {
      await service.generateShotVideos({
        projectId, expectedRevision: revision(), canvasCwd: workspace, workspaceDir: workspace,
        shots: [{ shot_id: 'shot-01', image_path_relative: 'frames/first.png', duration_seconds: 5 }],
        model: 'Seedance 2.0 Mini',
      });
    } catch (error) {
      caught = error;
    }
    // 没批准 G2 时先撞 G2；两者都是「不许花钱」的硬闸门
    expect(['G2_REQUIRED', 'FIRST_FRAME_REQUIRED']).toContain((caught as { code?: string }).code);
  }, 60_000);

  it('已批准 G2 但某镜首帧失效时拒绝', () => {
    const { projects, projectId, revision } = setup();
    // 新增候选会让该镜已选首帧的候选保持 ACTIVE，但要验证「首帧失效」这条：
    // 这里直接构造未选帧的镜头
    let caught: unknown;
    try {
      projects.execute(command('video-generation.request', {
        shot_id: 'shot-99', model: 'Seedance 2.0 Mini', duration_seconds: 5, estimated_cost_cents: 100,
      }, { project_id: projectId, expected_revision: revision() }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('FIRST_FRAME_REQUIRED');
  });

  it('超出 G2 批准预算时拒绝，而不是先花了再说', () => {
    const { projects, projectId, revision } = setup();
    let caught: unknown;
    try {
      projects.execute(command('video-generation.request', {
        shot_id: 'shot-01', model: 'Seedance 2.0 Mini', duration_seconds: 5, estimated_cost_cents: 99999,
      }, { project_id: projectId, expected_revision: revision() }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('G2_BUDGET_EXCEEDED');
  });

  /*
    与出图同一条口径：请求已经发给供应商，失败不代表没花钱，
    所以这笔预留**留在预算里**，不再用 `actual_cost_cents: 0` 假装结清。
  */
  it('单镜失败不拖累其它镜头；失败那笔预留仍占着（是否计费未知）', async () => {
    const { projects, projectId, service, workspace, revision } = setup({ failShots: ['shot-01'] });
    const outcome = await service.generateShotVideos({
      projectId, expectedRevision: revision(), canvasCwd: workspace, workspaceDir: workspace,
      shots: [{ shot_id: 'shot-01', image_path_relative: 'frames/first.png', duration_seconds: 5 }],
      model: 'Seedance 2.0 Mini',
      estimatedCostCents: 100,
    });
    expect(outcome.generated).toHaveLength(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.reason).toContain('模型繁忙');
    /*
      预留仍是 100：这一次的请求已经发出去、然后收到"模型繁忙"，
      谁也不能断言这笔没计费。释放要有理由，理由来自"还没提交给后端"。
    */
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(100);
  }, 60_000);
});

/**
 * 画幅。
 *
 * 模型的 `ratio` 默认是 16:9，竖屏参考片若不显式指定就会得到横屏素材——
 * 实测踩到过：首帧 540×960，产出 864×496。这不是「复刻得不像」，
 * 是根本没对齐：按参考画布算的 `canvas_match` 评估会直接判 0。
 */
describe('画幅比派生', () => {
  it('竖屏吸附到 9:16，而不是模型的 16:9 缺省', () => {
    expect(frameRatio(540, 960)).toBe('9:16');
    expect(frameRatio(1080, 1920)).toBe('9:16');
  });

  it('横屏与方形各自收敛到最近的枚举值', () => {
    expect(frameRatio(1920, 1080)).toBe('16:9');
    expect(frameRatio(864, 496)).toBe('16:9');
    expect(frameRatio(1024, 1024)).toBe('1:1');
  });

  it('距离用比值对数衡量，竖屏不会因为「比 1 小」就天然靠近某个值', () => {
    // 4:5 = 0.8：对数值上离 3:4(0.75) 比离 1:1(1.0) 更近
    expect(frameRatio(800, 1000)).toBe('3:4');
    // 3:2 = 1.5：离 4:3(1.333) 比离 16:9(1.778) 更近
    expect(frameRatio(1500, 1000)).toBe('4:3');
  });

  it('尺寸不可信时退回 16:9，而不是抛错挡住整批生成', () => {
    expect(frameRatio(0, 960)).toBe('16:9');
    expect(frameRatio(540, 0)).toBe('16:9');
  });
});

describe('生成时的画幅参数', () => {
  it('未给 ratio 时用 adaptive 跟随首帧，不用模型的 16:9 默认值', async () => {
    const { service, projectId, workspace, revision, calls } = setup();
    await service.generateShotVideos({
      projectId, expectedRevision: revision(), canvasCwd: workspace, workspaceDir: workspace,
      shots: [{ shot_id: 'shot-01', image_path_relative: 'frames/first.png', duration_seconds: 5 }],
      model: 'Seedance 2.0 Mini',
    });
    const created = calls.find((call) => call.args[0] === 'node' && call.args[1] === 'create');
    expect(created?.args.join(' ')).toContain('ratio=adaptive');
  }, 60_000);

  it('给了 ratio 就原样传下去', async () => {
    const { service, projectId, workspace, revision, calls } = setup();
    await service.generateShotVideos({
      projectId, expectedRevision: revision(), canvasCwd: workspace, workspaceDir: workspace,
      shots: [{ shot_id: 'shot-01', image_path_relative: 'frames/first.png', duration_seconds: 5 }],
      model: 'Seedance 2.0 Mini',
      ratio: '9:16',
    });
    const created = calls.find((call) => call.args[0] === 'node' && call.args[1] === 'create');
    expect(created?.args.join(' ')).toContain('ratio=9:16');
    expect(created?.args.join(' ')).not.toContain('ratio=adaptive');
  }, 60_000);
});
