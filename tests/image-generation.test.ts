import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { createCanvasBackend, CanvasAdapter, type CanvasRunRequest, type CanvasRunner } from '@qiyin/canvas-adapter';
import { GenerationService } from '@qiyin/generation-service';

/**
 * 图片生成（S5）——产品里**第一个真正花钱的动作**。
 *
 * 因此这里盯得比别处紧：G1 未批准不得开工、预算必须当场预留、
 * 实际成本必须结清（否则预留永不释放）、单镜失败不得拖累其它镜头。
 */

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

/**/
const modelFixturePath = new URL('./fixtures/canvas-model-star-video-2.5.json', import.meta.url);

/**/
function canvasRunner(options: { failShots?: readonly string[] } = {}) {
  const calls: CanvasRunRequest[] = [];
  const runner: CanvasRunner = {
    async run(request: CanvasRunRequest) {
      calls.push(request);
      const [commandName, second] = request.args;
      /* 参考图要先上传成资源节点（`--left` 连的是节点不是文件） */
      if (commandName === 'upload') {
        return { code: 0, stdout: JSON.stringify({ nodeKey: `ref-${request.args[1]}` }), stderr: '' };
      }
      if (commandName === 'node' && second === 'create') {
        return { code: 0, stdout: JSON.stringify({ nodeKey: 'n1', nodeType: 'image' }), stderr: '' };
      }
      /*
        不收敛整条 create 会被拒）。这里回真实夹具，让那条路径也走真实数据。
      */
      if (commandName === 'model') {
        return { code: 0, stdout: readFileSync(modelFixturePath, 'utf8'), stderr: '' };
      }
      if (commandName === 'node') {
        const nodeName = second ?? '';
        if ((options.failShots ?? []).some((shot) => nodeName.includes(shot))) {
          return { code: 1, stdout: '', stderr: 'error: 模型繁忙，请稍后重试\n' };
        }
        return {
          code: 0, stderr: '',
          stdout: '[run] task=t1 status=2 progress=100%\n'
            + JSON.stringify({ nodeKey: 'n1', status: 2, data: { url: ['https://example.test/a.png'] } }),
        };
      }
      if (commandName === 'download') {
        // 与真实 CLI 一致：产物落点由 `--out` 决定，而不是工作目录
        const outIndex = request.args.indexOf('--out');
        const dir = (outIndex >= 0 ? request.args[outIndex + 1] : undefined) ?? request.cwd ?? tmpdir();
        const nodeName = request.args[2] ?? 'node';
        const file = join(dir, `${nodeName}.png`);
        // 每个节点写不同内容，保证内容哈希不同（= 不同 artifact）
        writeFileSync(file, Buffer.from(`PNG:${nodeName}`), 'utf8');
        return { code: 0, stdout: `${file}\n`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'error: unexpected\n' };
    },
  };
  return { runner, calls };
}

function setup(options: { failShots?: readonly string[]; budgetCents?: number; approveG1?: boolean } = {}) {
  const projects = new ProjectService(openDatabase(':memory:'));
  const created = projects.execute(command('project.create', {
    name: '生成项目', max_budget_cents: options.budgetCents ?? 1000, rights_confirmed: true,
  }));
  const projectId = created.project_id!;
  projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  projects.execute(command('shot-fields.seed', {
    breakdown_revision: 1,
    boundaries: [{ t0_ms: 0, t1_ms: 2100 }, { t0_ms: 2100, t1_ms: 4200 }],
  }, { project_id: projectId, expected_revision: 2 }));
  if (options.approveG1 !== false) {
    projects.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
  }
  const { runner, calls } = canvasRunner({ ...(options.failShots === undefined ? {} : { failShots: options.failShots }) });
  const service = new GenerationService(projects, createCanvasBackend(new CanvasAdapter(runner)));
  const workspace = mkdtempSync(join(tmpdir(), 'qiyin-gen-'));
  return { projects, projectId, service, calls, workspace, revision: () => (projects.getProject(projectId) as { revision: number }).revision };
}

/**
 * 给某镜挂一张"已发布的构图蓝图"，并真的在 workspace 里写一个文件。
 *
 * 三处都要对得上，少一处生成时就会拒绝：
 *   · 空间方案里写 `blueprint.artifact_id`（领域事实）
 *   · artifacts 元数据里有 `artifact_path_relative` + `project_id`（按项目过滤要靠它）
 *   · 磁盘上那个文件真的存在
 */
function attachBlueprint(
  ctx: ReturnType<typeof setup>, shotId: string,
): { artifactId: string; relativePath: string } {
  const relativePath = `blueprints/blueprint-${shotId}.png`;
  mkdirSync(join(ctx.workspace, 'blueprints'), { recursive: true });
  writeFileSync(join(ctx.workspace, relativePath), Buffer.from(`PNG:blueprint:${shotId}`), 'utf8');
  const artifactId = `sha256:${'b'.repeat(64)}`;
  ctx.projects.execute(command('artifact.publish', {
    artifact_id: artifactId, media_type: 'image/png', bytes: 20,
    metadata: { artifact_path_relative: relativePath, project_id: ctx.projectId, source: 'director-blueprint' },
  }));
  ctx.projects.execute(command('spatial-plan.set', {
    shot_id: shotId,
    plan: {
      schema: 'replica.spatial-plan@1',
      shot_id: shotId,
      enabled: true,
      subjects: [],
      camera: { position: [0, 1.35, 9], target: [0, 0.85, 0], lens_mm: 50, pitch_deg: 0 },
      blueprint: { artifact_id: artifactId, published_at: new Date().toISOString(), captured_from_revision: 1 },
    },
    expected_spatial_revision: 0,
  }, { project_id: ctx.projectId, expected_revision: ctx.revision() }));
  return { artifactId, relativePath };
}

describe('图片生成', () => {
  /*
    参数透传（画布参数面板 → 生成服务 → 后端 → CLI）。

    这条路径以前是断的：面板收了一整包参数，提交时只发 model / costCents / shots，
    于是"我明明设了却没生效"。现在整包走到这里。

    判据取**命令行上真的出现了参数**，而不是"请求对象里有那个字段"——
    中间任何一层把它吃掉（服务层漏传、后端只挑几个字段）都会在这里露出来。
  */
  it('参数包一路透传到 CLI：node create 上出现对应的 -s key=value', async () => {
    const ctx = setup();
    const outcome = await ctx.service.generateShotImages({
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      canvasCwd: ctx.workspace,
      workspaceDir: ctx.workspace,
      shots: [{ shot_id: 'shot-01', prompt: '按参数生成' }],
      model: 'Z-image Turbo',
      estimatedCostCents: 10,
      actualCostCents: 10,
      /*
        键是后端字段名（画布那侧的 generationParams 负责映射到这里），
        而且要**是该模型 schema 里真有的那些**——夹具回的是 Seedance 2.5 的 schema，
        不在里面的键会被收敛掉（那条行为由下面"取值规范化"的用例专门验）。
      */
      settings: { resolution: '720p', duration: 5, enableSound: 'on' },
    });

    const create = ctx.calls.find((call) => call.args[0] === 'node' && call.args[1] === 'create');
    expect(create).toBeTruthy();
    const args = create?.args ?? [];
    /* `-s` 与 `key=value` 是相邻两个参数（适配器就是这么拼的） */
    expect(args).toContain('resolution=720p');
    expect(args).toContain('duration=5');
    expect(args).toContain('enableSound=on');
    /* 结构性参数仍然在——透传不该把它们顶掉（模型名是 `-s model=…` 这种形态） */
    expect(args).toContain('model=Z-image Turbo');
    expect(outcome.generated).toHaveLength(1);
  });

  /*
    下载必须带 `--without-ai-watermark`。

    而它**会 404**；后果是"生成成功、下载失败"——钱已经花了，
    用户拿到的却是一句跟生成无关的报错。

    所以判据落在**命令行上真的出现了这个开关**：后端换了写法、或者以后有人
    "顺手清理掉多余的参数"，这条会立刻红。
  */
  it('下载产物时固定带 --without-ai-watermark（不带的话上游水印接口会 404）', async () => {
    const ctx = setup();
    await ctx.service.generateShotImages({
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      canvasCwd: ctx.workspace,
      workspaceDir: ctx.workspace,
      shots: [{ shot_id: 'shot-01', prompt: '下载开关' }],
      model: 'Z-image Turbo',
      estimatedCostCents: 10,
      actualCostCents: 10,
    });

    const download = ctx.calls.find((call) => call.args[0] === 'download');
    expect(download).toBeTruthy();
    expect(download?.args).toContain('--without-ai-watermark');
    /* 落点还是 `--out` 指定的目录（这条一并锁住，别在改开关时动了它） */
    expect(download?.args).toContain('--out');
  });

  /*
    参数被**收敛**时，两件事都要发生：
      ① 发出去的取值是 CLI 认的那个写法（1080P → 1080p），否则整条 create 会被拒；
      ② 回执里带上"改过什么"——用户设的和他用的不一样，必须让他看见。
  */
  it('取值按模型 schema 规范化，并把改动写进回执', async () => {
    const ctx = setup();
    const outcome = await ctx.service.generateShotImages({
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      canvasCwd: ctx.workspace,
      workspaceDir: ctx.workspace,
      shots: [{ shot_id: 'shot-01', prompt: '按参数生成' }],
      /* 这个名字在夹具 schema 里（Seedance 2.5），所以收敛会真的发生 */
      model: 'Seedance 2.5',
      estimatedCostCents: 10,
      actualCostCents: 10,
      settings: {
        resolution: '1080P',   // 网页端写法（大写）
        duration: 99,          // 超出夹具里的 max: 30
        sequential: 1,         // 这个模型没有这个键
      },
    });

    const args = ctx.calls.find((call) => call.args[0] === 'node' && call.args[1] === 'create')?.args ?? [];
    /* ① 发出去的是规范化后的值；不认识的键没发出去 */
    expect(args).toContain('resolution=1080p');
    expect(args).toContain('duration=30');
    expect(args).not.toContain('sequential=1');

    /* ② 回执里逐条说清楚 */
    const notes = outcome.generated[0]?.parameter_notes ?? [];
    expect(notes.some((note) => note.includes('resolution'))).toBe(true);
    expect(notes.some((note) => note.includes('1099') || note.includes('夹到 30') || note.includes('30'))).toBe(true);
    expect(notes.some((note) => note.includes('sequential'))).toBe(true);
  });

  /*
    执行摘要与结果复用（FLOW-006）。

    同一套输入第二次跑，不该再花一次钱——这是"可控成本"这条主线的关键一段。
    判据不靠"返回里写着 reused"，而是**数后端被调用了几次**：
    复用最坏的错误形态是"账上说省了钱、其实又跑了一遍"。
  */
  it('输入完全相同：第二次复用上一次的结果，一次后端调用都不发生', async () => {
    const ctx = setup();
    const request = {
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      canvasCwd: ctx.workspace,
      workspaceDir: ctx.workspace,
      shots: [{ shot_id: 'shot-01', prompt: '同一段提示词' }],
      model: 'Z-image Turbo',
      quality: '1K',
      ratio: '1:1',
      estimatedCostCents: 10,
      actualCostCents: 8,
    };
    const before = ctx.calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;
    const first = await ctx.service.generateShotImages(request);
    expect(first.generated[0]?.reused).toBeUndefined();
    const afterFirst = ctx.calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;
    expect(afterFirst - before).toBe(1);

    const second = await ctx.service.generateShotImages({
      ...request,
      expectedRevision: ctx.revision(),
    });
    const afterSecond = ctx.calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;
    /* 关键判据：第二次没有再调后端 */
    expect(afterSecond - afterFirst).toBe(0);
    expect(second.generated[0]?.reused).toBe(true);
    expect(second.generated[0]?.reused_from_intent_id).toBeTruthy();
    /* 复用来的候选指向同一个产物（内容寻址，本来就是同一张图） */
    expect(second.generated[0]?.artifact_id).toBe(first.generated[0]?.artifact_id);
    /* 而它确实没花钱：账上这一笔是 0（事实），不是"不知道" */
    const intents = ctx.projects.listImageGenerationIntents(ctx.projectId) as Array<{
      intent_id: string; actual_cost_cents: number | null; reused_from_intent_id: string | null;
    }>;
    const reusedIntent = intents.find((item) => item.reused_from_intent_id !== null);
    expect(reusedIntent).toBeTruthy();
    expect(reusedIntent?.actual_cost_cents).toBe(0);
    /* 复用来源指向**一次真实生成**（而不是指向另一次复用）——省的哪一笔有据可查 */
    const realIntents = intents.filter((item) => item.reused_from_intent_id === null);
    expect(realIntents.some((item) => item.intent_id === reusedIntent?.reused_from_intent_id)).toBe(true);
  });

  it('提示词变了一个字：不复用，老老实实再跑一次', async () => {
    const ctx = setup();
    const base = {
      projectId: ctx.projectId, canvasCwd: ctx.workspace, workspaceDir: ctx.workspace,
      shots: [{ shot_id: 'shot-01', prompt: '第一版提示词' }],
      model: 'Z-image Turbo', estimatedCostCents: 10,
    };
    await ctx.service.generateShotImages({ ...base, expectedRevision: ctx.revision() });
    const afterFirst = ctx.calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;
    await ctx.service.generateShotImages({
      ...base,
      shots: [{ shot_id: 'shot-01', prompt: '第二版提示词' }],
      expectedRevision: ctx.revision(),
    });
    const afterSecond = ctx.calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;
    expect(afterSecond - afterFirst).toBe(1);
  });

  it('显式关掉复用时，同样的输入也会真的再跑一次（模型有随机性的场景）', async () => {
    const ctx = setup();
    const base = {
      projectId: ctx.projectId, canvasCwd: ctx.workspace, workspaceDir: ctx.workspace,
      shots: [{ shot_id: 'shot-01', prompt: '同一段提示词' }],
      model: 'Z-image Turbo', estimatedCostCents: 10,
      reuseResults: false,
    };
    await ctx.service.generateShotImages({ ...base, expectedRevision: ctx.revision() });
    const afterFirst = ctx.calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;
    await ctx.service.generateShotImages({ ...base, expectedRevision: ctx.revision() });
    const afterSecond = ctx.calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;
    expect(afterSecond - afterFirst).toBe(1);
  });

  it('上一次的产物文件已被删掉：不复用，重新生成', async () => {
    const ctx = setup();
    const request = {
      projectId: ctx.projectId, canvasCwd: ctx.workspace, workspaceDir: ctx.workspace,
      shots: [{ shot_id: 'shot-01', prompt: '同一段提示词' }],
      model: 'Z-image Turbo', estimatedCostCents: 10, actualCostCents: 8,
    };
    const first = await ctx.service.generateShotImages({ ...request, expectedRevision: ctx.revision() });
    const relativeFrame = first.generated[0]?.frame_path_relative ?? '';
    rmSync(join(ctx.workspace, relativeFrame));
    const afterFirst = ctx.calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;
    const second = await ctx.service.generateShotImages({ ...request, expectedRevision: ctx.revision() });
    const afterSecond = ctx.calls.filter((call) => call.args[0] === 'node' && call.args.includes('--run')).length;
    /* 登记还在、文件没了：复用会得到一张打不开的图，所以要重新生成 */
    expect(afterSecond - afterFirst).toBe(1);
    expect(second.generated[0]?.reused).toBeUndefined();
  });

  /*
    构图蓝图 → 生成参考图。

    导演台截的蓝图如果不影响出图，它就只是留档；接上之后，
    "谁站在哪、体形什么样、机位在哪里"才真的进了画面。
    这条链路在 CLI 上是两段：先把参考图**上传成资源节点**，
    再建生成节点时用 `--left` 连上它（`--left` 连的是节点，不是文件路径）。
  */
  it('这一镜有构图蓝图时，蓝图会作为参考图传给后端（upload + --left）', async () => {
    const ctx = setup();
    const { relativePath } = attachBlueprint(ctx, 'shot-01');
    const outcome = await ctx.service.generateShotImages({
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      canvasCwd: ctx.workspace,
      workspaceDir: ctx.workspace,
      shots: [
        { shot_id: 'shot-01', prompt: '这一镜有蓝图' },
        { shot_id: 'shot-02', prompt: '这一镜没有蓝图' },
      ],
      model: 'Z-image Turbo',
      quality: '1K',
      ratio: '1:1',
      estimatedCostCents: 10,
      actualCostCents: 8,
    });
    /* 失败原因打出来：只说"节点数不对"看不出是哪一镜为什么没生成 */
    if (outcome.failures.length > 0) throw new Error(JSON.stringify(outcome.failures));

    const uploads = ctx.calls.filter((call) => call.args[0] === 'upload');
    expect(uploads).toHaveLength(1);
    /*
      比的是**完整路径**而不是"包含文件名"：`--resource` 要的是一个真实文件，
      只对上文件名的话，传到别的目录下也会通过——那正是最容易出的错。
    */
    const uploadArgs = uploads[0]?.args ?? [];
    expect(uploadArgs[uploadArgs.indexOf('--resource') + 1]).toBe(join(ctx.workspace, relativePath));

    const imageCreates = ctx.calls.filter((call) => call.args[0] === 'node' && call.args[1] === 'create');
    expect(imageCreates).toHaveLength(2);
    /* 有蓝图那一镜连了参考节点，另一镜没有——否则等于给所有镜头都塞了同一张参考图 */
    const withReference = imageCreates.filter((call) => call.args.includes('--left'));
    expect(withReference).toHaveLength(1);
    expect(withReference[0]?.args[2]).toContain('shot-01');
  });

  it('蓝图文件不在了：直接报错，不静默按纯提示词生成', async () => {
    const ctx = setup();
    const { relativePath } = attachBlueprint(ctx, 'shot-01');
    /* 把文件删掉，模拟"产物被清理掉" */
    rmSync(join(ctx.workspace, relativePath));

    const outcome = await ctx.service.generateShotImages({
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      canvasCwd: ctx.workspace,
      workspaceDir: ctx.workspace,
      shots: [{ shot_id: 'shot-01', prompt: '蓝图丢了' }],
      model: 'Z-image Turbo',
      estimatedCostCents: 10,
    });

    expect(outcome.generated).toEqual([]);
    expect(outcome.failures[0]?.reason).toContain('构图蓝图');
    /* 一分钱都不该花：这一镜的意图要结清，且没提交给后端 */
    expect(ctx.calls.some((call) => call.args[0] === 'node' && call.args.includes('--run'))).toBe(false);
  });

  it('显式关掉参考图时，即使有蓝图也不上传（对照用）', async () => {
    const ctx = setup();
    attachBlueprint(ctx, 'shot-01');
    await ctx.service.generateShotImages({
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      canvasCwd: ctx.workspace,
      workspaceDir: ctx.workspace,
      shots: [{ shot_id: 'shot-01', prompt: '不要蓝图' }],
      model: 'Z-image Turbo',
      estimatedCostCents: 10,
      useBlueprintAsReference: false,
    });
    expect(ctx.calls.some((call) => call.args[0] === 'upload')).toBe(false);
  });

  it('为每个镜头生成、登记候选，并把预估预留换成实际花费', async () => {
    const { projects, projectId, service, workspace, calls, revision } = setup();
    const outcome = await service.generateShotImages({
      projectId,
      expectedRevision: revision(),
      canvasCwd: workspace,
      workspaceDir: workspace,
      shots: [
        { shot_id: 'shot-01', prompt: '中景，平视，柔和光' },
        { shot_id: 'shot-02', prompt: '近景，仰拍，硬光' },
      ],
      model: 'Z-image Turbo',
      quality: '1K',
      ratio: '1:1',
      estimatedCostCents: 10,
      actualCostCents: 8,
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.generated.map((item) => item.shot_id)).toEqual(['shot-01', 'shot-02']);
    expect(outcome.generated.every((item) => item.artifact_id.startsWith('sha256:'))).toBe(true);
    expect(outcome.generated[0]?.frame_path_relative).toContain('frames/gen-');

    // 候选已入库且是 ACTIVE
    const candidates = projects.listImageCandidates(projectId) as Array<{ status: string }>;
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.status === 'ACTIVE')).toBe(true);

    /**
     * 画幅必须真的传到 CLI 上。
     *
     * 模型的 `ratio` 默认是 16:9，产品侧算出来的画幅如果没落进 `-s`，
     * 生成的构图就会和参考片完全不同——而这件事在返回值里看不出来。
     * 实测对照：未指定画幅时 1024×1024，指定 9:16 后 720×1280。
     */
    const created = calls.filter((call) => call.args[0] === 'node' && call.args[1] === 'create');
    expect(created).toHaveLength(2);
    for (const call of created) {
      expect(call.args.join(' ')).toContain('ratio=1:1');
      expect(call.args.join(' ')).toContain('quality=1K');
    }

    // 预算结清：实际 8 分 × 2，预留不应残留
    const project = projects.getProject(projectId) as { reserved_budget_cents: number };
    expect(project.reserved_budget_cents).toBe(16);

    const intents = projects.listImageGenerationIntents(projectId) as Array<{ status: string; actual_cost_cents: number }>;
    expect(intents).toHaveLength(2);
    expect(intents.every((intent) => intent.status === 'COMPLETED' && intent.actual_cost_cents === 8)).toBe(true);
  }, 60_000);

  /*
    失败那笔预留**不再自动释放**。

    以前的写法是失败结清写 `actual_cost_cents: 0`，于是这行断言是
    "只剩成功那一笔"。但那个 0 是假设——这一镜的请求已经发给供应商了，
    它完全可能已经计费，只是回了个"模型繁忙"。现在如实留着，
    由"拿得出凭据的释放"或人工处置来决定。
  */
  it('单镜失败不拖累其它镜头；失败那笔预留仍占着（是否计费未知）', async () => {
    const { projects, projectId, service, workspace, revision } = setup({ failShots: ['shot-01'] });
    const outcome = await service.generateShotImages({
      projectId,
      expectedRevision: revision(),
      canvasCwd: workspace,
      workspaceDir: workspace,
      shots: [
        { shot_id: 'shot-01', prompt: '这一镜会失败' },
        { shot_id: 'shot-02', prompt: '这一镜会成功' },
      ],
      model: 'Z-image Turbo',
      estimatedCostCents: 10,
      actualCostCents: 10,
    });

    expect(outcome.generated.map((item) => item.shot_id)).toEqual(['shot-02']);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.shot_id).toBe('shot-01');
    expect(outcome.failures[0]?.kind).toBe('command');
    expect(outcome.failures[0]?.reason).toContain('模型繁忙');

    // 成功那笔按实际花费结清（10），失败那笔如实留着（10）→ 一共 20
    const project = projects.getProject(projectId) as { reserved_budget_cents: number };
    expect(project.reserved_budget_cents).toBe(20);
    const intents = projects.listImageGenerationIntents(projectId) as Array<{
      shot_id: string; status: string; reservation_released_reason: string | null;
    }>;
    const failed = intents.find((intent) => intent.shot_id === 'shot-01');
    expect(failed?.status).toBe('FAILED');
    /* 关键：没有释放理由 = 这笔预留还占着，界面会据此如实说明 */
    expect(failed?.reservation_released_reason).toBeNull();
    expect(intents.find((intent) => intent.shot_id === 'shot-02')?.status).toBe('COMPLETED');
  }, 60_000);

  it('未批准 G1 时拒绝生成 —— 拆解没冻结就不该按它花钱', async () => {
    const { service, projectId, workspace, revision } = setup({ approveG1: false });
    let caught: unknown;
    try {
      await service.generateShotImages({
        projectId,
        expectedRevision: revision(),
        canvasCwd: workspace,
        workspaceDir: workspace,
        shots: [{ shot_id: 'shot-01', prompt: 'x' }],
        model: 'Z-image Turbo',
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('G1_REQUIRED');
  }, 60_000);

  it('超出项目预算时拒绝生成，而不是先花了再说', () => {
    const { projects, projectId, revision } = setup({ budgetCents: 20 });
    let caught: unknown;
    try {
      projects.execute(command('image-generation.request', {
        shot_id: 'shot-01', model: 'Z-image Turbo', prompt: 'x', estimated_cost_cents: 999,
      }, { project_id: projectId, expected_revision: revision() }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('PROJECT_BUDGET_EXCEEDED');
    expect((caught as { statusCode?: number }).statusCode).toBe(409);
  });

  it('重复结清同一意图被拒绝', () => {
    const { projects, projectId, revision } = setup();
    const admitted = projects.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'Z-image Turbo', prompt: 'x', estimated_cost_cents: 10,
    }, { project_id: projectId, expected_revision: revision() }));
    const intentId = (admitted.payload as { intent_id: string }).intent_id;
    projects.execute(command('image-generation.settle', {
      intent_id: intentId, status: 'COMPLETED', actual_cost_cents: 10,
    }, { project_id: projectId, expected_revision: revision() }));

    let caught: unknown;
    try {
      projects.execute(command('image-generation.settle', {
        intent_id: intentId, status: 'COMPLETED', actual_cost_cents: 10,
      }, { project_id: projectId, expected_revision: revision() }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('IMAGE_INTENT_ALREADY_SETTLED');
  });
});

/* ============================================================
  逐镜进度：**每跑完一镜报一次**。

  为什么要有它：真后端一镜几十秒到几分钟，而这条调用是阻塞的——没有心跳，
  界面上从头到尾只有「正在生成（3 个节点）」，用户分不清是在跑还是卡死了。

  这里盯三件容易被写错的事：
    · 报的次数等于镜数（不能只在最后报一次）
    · 失败的镜头**也要报**（不报的话 2/5 会卡在中间不动，看起来像卡死）
    · done 是**跑完的累计数**、从 1 开始（不是"还剩几镜"，也不是从 0 开始）
  ============================================================ */
describe('图片生成 · 逐镜进度', () => {
  const threeShots = [
    { shot_id: 'shot-01', prompt: '第一镜' },
    { shot_id: 'shot-02', prompt: '第二镜' },
  ];

  it('两镜就跑两次，done 从 1 数到 2，total 是镜数', async () => {
    const ctx = setup();
    const seen: Array<{ done: number; total: number; shotId: string; ok: boolean }> = [];
    const outcome = await ctx.service.generateShotImages({
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      canvasCwd: ctx.workspace,
      workspaceDir: ctx.workspace,
      shots: threeShots,
      model: 'Z-image Turbo',
      estimatedCostCents: 10,
      actualCostCents: 10,
      onProgress: (progress) => seen.push(progress),
    });
    expect(seen.map((item) => `${item.done}/${item.total}:${item.shotId}`)).toEqual([
      '1/2:shot-01', '2/2:shot-02',
    ]);
    /* 三镜都该成：把失败原因带进断言里，免得只看到一句 false */
    expect(JSON.stringify(outcome.failures)).toBe('[]');
    expect(seen.every((item) => item.ok)).toBe(true);
  });

  it('失败的那一镜也要报（ok:false），否则进度会卡在中间', async () => {
    const ctx = setup({ failShots: ['shot-02'] });
    const seen: Array<{ done: number; total: number; shotId: string; ok: boolean }> = [];
    const outcome = await ctx.service.generateShotImages({
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      canvasCwd: ctx.workspace,
      workspaceDir: ctx.workspace,
      shots: threeShots,
      model: 'Z-image Turbo',
      estimatedCostCents: 10,
      actualCostCents: 10,
      onProgress: (progress) => seen.push(progress),
    });
    expect(outcome.failures.map((item) => item.shot_id)).toEqual(['shot-02']);
    /* 第二镜失败也报了一次（1:true → 2:false），否则进度会卡在 1/2 不动 */
    expect(seen.map((item) => `${item.done}:${item.ok}`)).toEqual(['1:true', '2:false']);
  });

  it('进度是旁路：回调抛错不影响生成', async () => {
    const ctx = setup();
    const outcome = await ctx.service.generateShotImages({
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      canvasCwd: ctx.workspace,
      workspaceDir: ctx.workspace,
      shots: [{ shot_id: 'shot-01', prompt: '随便一镜' }],
      model: 'Z-image Turbo',
      estimatedCostCents: 10,
      actualCostCents: 10,
      onProgress: () => { throw new Error('界面那边炸了'); },
    });
    expect(outcome.generated).toHaveLength(1);
  });
});

