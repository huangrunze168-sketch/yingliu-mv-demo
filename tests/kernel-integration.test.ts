import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import type { FilmTransition } from '@qiyin/contracts';
import { createFrontkernelAdapter, resolveFrontkernelDistribution } from '@qiyin/frontkernel-adapter';
import { KernelService } from '@qiyin/kernel-service';

/**
 * 前置 agent 的真实链路。
 *
 * 只跑「本地、不花钱、不需要账号」的 Source 校验：它是判断
 * 需要 Runtime Profile 的 plan/build 不在这个测试里——那要求 Provider 配置，
 * 属于接入阶段的事，不该混进自动化测试而让 CI 依赖账号。
 */

function findDistribution(): string | null {
  try {
    const root = resolveFrontkernelDistribution();
    // 测试只认新发行版入口；旧名 hypit.mjs 的兼容在运行时适配层里做。
    return existsSync(join(root, 'bin', 'frontkernel.mjs')) ? root : null;
  } catch {
    return null;
  }
}

const distribution = findDistribution();
const describeReal = distribution === null ? describe.skip : describe;

describeReal('内核服务·真实 Frontkernel 链路', () => {
  const root = distribution as string;

  it('一次调用完成「登记意图 → 真实校验 → 回填事实」', async () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.create',
      payload: { name: '真实链路项目', max_budget_cents: 2000, rights_confirmed: true },
    });
    const projectId = created.project_id!;
    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'gate.approve',
      project_id: projectId, expected_revision: 1, payload: { gate: 'G0' },
    });

    const kernel = new KernelService(projects, createFrontkernelAdapter({
      distributionRoot: root, cwd: root, timeoutMs: 120_000,
    }));

    const outcome = await kernel.checkSource({
      projectId,
      expectedRevision: 2,
      sourcePath: 'examples/interview/reference.svml',
      workspaceDir: root,
      purpose: '真实链路验证',
    });

    expect(outcome.executed).toBe(true);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.report?.format).toBe('frontkernel.cli-check@1');
    expect(outcome.report?.ok).toBe(true);
    expect(outcome.report?.frontend).toBe('@frontkernel/markup@1');
    expect(outcome.report?.outputCount ?? 0).toBeGreaterThan(0);

    // 领域事实必须与内核结论一致
    const tasks = projects.listKernelTasks(projectId) as Array<{ status: string; kind: string; report: { ok?: boolean } | null }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.kind).toBe('check');
    expect(tasks[0]?.status).toBe('COMPLETED');
    expect(tasks[0]?.report?.ok).toBe(true);

    expect(projects.listEvents(projectId).map((event) => event.type)).toEqual([
      'project.created', 'gate.approved', 'kernel-check.requested', 'kernel-check.completed',
    ]);
    expect(outcome.projectRevision).toBe(4);
  }, 180_000);

  it('Source 不存在时仍回填 FAILED，项目事实里能看到原因', async () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.create',
      payload: { name: '失败链路项目', max_budget_cents: 2000, rights_confirmed: true },
    });
    const projectId = created.project_id!;
    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'gate.approve',
      project_id: projectId, expected_revision: 1, payload: { gate: 'G0' },
    });

    const kernel = new KernelService(projects, createFrontkernelAdapter({
      distributionRoot: root, cwd: root, timeoutMs: 120_000,
    }));
    const outcome = await kernel.checkSource({
      projectId, expectedRevision: 2,
      sourcePath: 'examples/__definitely_missing__.svml', workspaceDir: root,
    });

    expect(outcome.executed).toBe(false);
    expect(outcome.failure).toBeTruthy();

    const tasks = projects.listKernelTasks(projectId) as Array<{ status: string; failure: string | null }>;
    expect(tasks[0]?.status).toBe('FAILED');
    expect(tasks[0]?.failure).toBeTruthy();
    expect(projects.listEvents(projectId).map((event) => event.type)).toContain('kernel-check.failed');
  }, 180_000);

  /**
   * 规划链路。
   *
   * plan 同样本地、不花钱、不需要账号，但它比 check 多两个前置条件：
   * 项目要有 Runtime Profile，且项目引用的 author package 必须已构建。
   * 这两个条件属于**项目环境**而不是本产品，因此缺失时跳过而不是让测试变红。
   */
  const planFixture = 'examples/semantic-composition';
  const planReady = distribution !== null
    && existsSync(resolve(root, planFixture, 'frontkernel.runtime.json'))
    && existsSync(resolve(root, planFixture, 'packages/chat-scene/dist/activation.js'));

  it.skipIf(!planReady)('规划一个真实 Run，拿到目标与能力需求清单', async () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.create',
      payload: { name: '规划链路项目', max_budget_cents: 2000, rights_confirmed: true },
    });
    const projectId = created.project_id!;
    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'gate.approve',
      project_id: projectId, expected_revision: 1, payload: { gate: 'G0' },
    });

    const kernel = new KernelService(projects, createFrontkernelAdapter({
      distributionRoot: root, cwd: root, timeoutMs: 120_000,
    }));
    const outcome = await kernel.planRun({
      projectId,
      expectedRevision: 2,
      sourcePath: `${planFixture}/chat.svrun`,
      workspaceDir: root,
      packageRoot: planFixture,
      purpose: '规划链路验证',
    });

    expect(outcome.executed).toBe(true);
    expect(outcome.report?.format).toBe('frontkernel.cli-plan@1');
    expect(outcome.report?.ok).toBe(true);
    expect(outcome.report?.targets).toContain('final.video');
    expect(outcome.report?.requestCount ?? 0).toBeGreaterThan(0);

    const tasks = projects.listKernelTasks(projectId) as Array<{ kind: string; status: string; report: { ok?: boolean } | null }>;
    expect(tasks[0]?.kind).toBe('plan');
    expect(tasks[0]?.status).toBe('COMPLETED');
    expect(tasks[0]?.report?.ok).toBe(true);
    expect(projects.listEvents(projectId).map((event) => event.type)).toEqual([
      'project.created', 'gate.approved', 'kernel-plan.requested', 'kernel-plan.completed',
    ]);
  }, 180_000);

  /**
   * 完整闭环的最后一段：真正执行一次构建并把成片取出来。
   *
   * 示例用的是本地 HyperFrames + FFmpeg，不需要任何生成账号，
   * 因此这一步可以在离线环境完整验证。
   */
  it.skipIf(!planReady)('提交真实构建、等待完成、取回成片', async () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.create',
      payload: { name: '构建链路项目', max_budget_cents: 2000, rights_confirmed: true },
    });
    const projectId = created.project_id!;
    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'gate.approve',
      project_id: projectId, expected_revision: 1, payload: { gate: 'G0' },
    });

    const kernel = new KernelService(projects, createFrontkernelAdapter({
      distributionRoot: root, cwd: root, timeoutMs: 180_000, longTimeoutMs: 600_000,
    }));
    const runPath = `${planFixture}/chat.svrun`;
    const profile = `${planFixture}/frontkernel.runtime.json`;

    const submitted = await kernel.submitBuild({
      projectId,
      expectedRevision: 2,
      sourcePath: runPath,
      workspaceDir: root,
      packageRoot: planFixture,
      runtimeProfile: profile,
    });
    expect(submitted.executed).toBe(true);
    const buildId = submitted.report?.id;
    expect(buildId).toMatch(/^bld_/);

    // 提交是「持久化后即返回」，执行由后台 Worker 继续
    let status = await kernel.buildStatus(buildId!, root, profile);
    for (let attempt = 0; attempt < 40 && status !== null && status.work.state !== 'done'; attempt += 1) {
      await new Promise((r) => setTimeout(r, 2_000));
      status = await kernel.buildStatus(buildId!, root, profile);
    }
    expect(status?.work.state).toBe('done');
    expect(status?.work.outcome).toBe('complete');

    const inspected = await kernel.inspectBuild(buildId!, root);
    expect(inspected.outcome).toBe('complete');
    expect(inspected.outputs.some((output) => output.name === 'final.video')).toBe(true);

    const destination = join(tmpdir(), `qiyin-final-${Date.now()}.mp4`);
    const exported = await kernel.exportOutput(buildId!, 'final.video', destination, root);
    expect(exported.kind).toBe('resource');
    expect(existsSync(destination)).toBe(true);

    // 全局前置 Agent 门控留下 check → plan → build 三段正式事实
    const tasks = projects.listKernelTasks(projectId) as Array<{ kind: string; status: string; report: { id?: string } | null }>;
    expect(tasks.map((task) => task.kind).sort()).toEqual(['build', 'check', 'plan']);
    expect(tasks.every((task) => task.status === 'COMPLETED')).toBe(true);
    expect(tasks.find((task) => task.kind === 'build')?.report?.id).toBe(buildId);
    expect(submitted.preflight.status).toBe('passed');
  }, 300_000);

  /**
   * 参考视频分析 → 拆解草稿。
   *
   * 这是「从一条参考视频到可编辑拆解」的真实衔接：probe 给媒体事实，
   * boundaries 给镜头候选，产品侧切成区间并播种成七字段草稿。
   * 需要一个用于分析的视频文件；没有时跳过（它来自人工或上一次构建）。
   */
  const analysisVideo = process.env.QIYIN_TEST_VIDEO
    ?? resolve(import.meta.dirname, '..', '.data', 'kernel-demo', 'final.mp4');
  const analysisReady = existsSync(analysisVideo);

  it.skipIf(!analysisReady)('分析参考视频并播种出七字段齐全的拆解草稿', async () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.create',
      payload: { name: '分析链路项目', max_budget_cents: 2000, rights_confirmed: true },
    });
    const projectId = created.project_id!;
    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'gate.approve',
      project_id: projectId, expected_revision: 1, payload: { gate: 'G0' },
    });

    // 产品层用相对路径，磁盘位置由服务层决定
    const workspace = mkdtempSync(join(tmpdir(), 'qiyin-ws-'));
    const relative = 'sources/reference.mp4';
    mkdirSync(join(workspace, 'sources'), { recursive: true });
    copyFileSync(analysisVideo, join(workspace, relative));

    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'source.register',
      project_id: projectId, expected_revision: 2,
      payload: {
        relative_path: relative,
        content_hash: `sha256:${'0'.repeat(64)}`,
        bytes: statSync(join(workspace, relative)).size,
        media_type: 'video/mp4',
      },
    });

    const kernel = new KernelService(projects, createFrontkernelAdapter({
      distributionRoot: root, cwd: root, timeoutMs: 120_000,
    }));
    const { analysis, seeded } = await kernel.analyzeAndSeed({
      projectId, expectedRevision: 3, mediaPath: relative, workspaceDir: workspace,
      purpose: '分析链路验证',
    });

    expect(analysis.executed).toBe(true);
    expect(analysis.report?.probe.duration ?? 0).toBeGreaterThan(0);
    expect(analysis.report?.probe.hasVideo).toBe(true);
    expect(Array.isArray(analysis.report?.boundaries.candidates)).toBe(true);

    expect(seeded).not.toBeNull();
    expect(seeded?.shotCount ?? 0).toBeGreaterThan(0);

    const project = projects.getProject(projectId) as {
      shot_fields: { shots: Array<Record<string, unknown>> } | null;
    };
    const shots = project.shot_fields?.shots ?? [];
    expect(shots).toHaveLength(seeded?.shotCount ?? -1);
    // 七字段齐全，未确定项显式为 unknown
    for (const shot of shots) {
      expect(shot.shot_size).toBe('unknown');
      expect(shot.duration_ms).toBeGreaterThan(0);
    }
    expect(projects.listKernelTasks(projectId)[0]).toMatchObject({ kind: 'analyze', status: 'COMPLETED' });
  }, 180_000);

  /**
   * 选帧链路。
   *
   * 用参考视频对应镜头的帧作为首帧候选——这是复刻的语义起点，而且完全本地。
   * 走通之后 G2 就有了它要求的第一个输入（每镜已选帧），
   * 不必等接入付费 Provider 才能验证这条闸门。
   */
  it.skipIf(!analysisReady)('抽帧成为候选、选帧之后可以批准 G2', async () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const revisionNow = (): number => (projects.getProject(projectId) as { revision: number }).revision;

    const created = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.create',
      payload: { name: '选帧链路项目', max_budget_cents: 2000, rights_confirmed: true },
    });
    const projectId = created.project_id!;
    projects.execute({ command_id: randomUUID(), actor: 'user:test', type: 'gate.approve', project_id: projectId, expected_revision: 1, payload: { gate: 'G0' } });

    const workspace = mkdtempSync(join(tmpdir(), 'qiyin-frames-'));
    const relative = 'sources/reference.mp4';
    mkdirSync(join(workspace, 'sources'), { recursive: true });
    copyFileSync(analysisVideo, join(workspace, relative));
    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'source.register',
      project_id: projectId, expected_revision: revisionNow(),
      payload: { relative_path: relative, content_hash: `sha256:${'1'.repeat(64)}`, bytes: statSync(join(workspace, relative)).size, media_type: 'video/mp4' },
    });

    const kernel = new KernelService(projects, createFrontkernelAdapter({ distributionRoot: root, cwd: root, timeoutMs: 120_000 }));
    await kernel.analyzeAndSeed({ projectId, expectedRevision: revisionNow(), mediaPath: relative, workspaceDir: workspace });

    const fields = (projects.getProject(projectId) as { shot_fields: { shots: Array<{ shot_id: string; t0_ms: number }> } | null }).shot_fields;
    const shots = fields?.shots ?? [];
    expect(shots.length).toBeGreaterThan(0);

    // G1 先批准，否则 G2 会被 G1_REQUIRED 拦下
    projects.execute({ command_id: randomUUID(), actor: 'user:test', type: 'gate.approve', project_id: projectId, expected_revision: revisionNow(), payload: { gate: 'G1' } });

    const { candidates } = await kernel.extractShotCandidates({
      projectId, expectedRevision: revisionNow(), mediaPath: relative, workspaceDir: workspace,
      shots: shots.map((shot) => ({ shot_id: shot.shot_id, t0_ms: shot.t0_ms })),
    });
    expect(candidates).toHaveLength(shots.length);
    expect(candidates.every((candidate) => candidate.artifact_id.startsWith('sha256:'))).toBe(true);
    expect(existsSync(candidates[0]?.frame_path ?? '')).toBe(true);

    // 候选已入库且处于 ACTIVE
    const stored = projects.listImageCandidates(projectId) as Array<{ candidate_id: string; status: string }>;
    expect(stored).toHaveLength(shots.length);
    expect(stored.every((candidate) => candidate.status === 'ACTIVE')).toBe(true);

    // G2 在「还没选帧」时必须被拦下——这是它存在的意义
    expect(() => projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'gate.approve',
      project_id: projectId, expected_revision: revisionNow(), payload: { gate: 'G2', approved_budget_cents: 500 },
    })).toThrow(/首帧/);

    for (const candidate of candidates) {
      projects.execute({
        command_id: randomUUID(), actor: 'user:test', type: 'image-candidate.select',
        project_id: projectId, expected_revision: revisionNow(),
        payload: { shot_id: candidate.shot_id, candidate_id: candidate.candidate_id, expected_selection_revision: 0 },
      });
    }

    const approved = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'gate.approve',
      project_id: projectId, expected_revision: revisionNow(), payload: { gate: 'G2', approved_budget_cents: 500 },
    });
    expect((approved.payload as { status: string }).status).toBe('APPROVED');
    expect((projects.getProject(projectId) as { gate_status: Record<string, string> }).gate_status.G2).toBe('APPROVED');

    // 已发布的帧 Artifact 可被查到，说明候选确实有内容而不只是一个 id
    const artifacts = projects.listArtifacts() as Array<{ artifact_id: string; status: string; media_type: string }>;
    expect(artifacts.filter((artifact) => artifact.media_type === 'image/jpeg')).toHaveLength(shots.length);
  }, 240_000);

  /**
   * 生产链路：**软件自己写出 Source，交给内核产出成片**。
   *
   * 生产由内核完成；产出的是一份真实的、可播放的 MP4。
   */
  it.skipIf(!analysisReady)('生成的 Source 经内核渲染出真实成片', async () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const revisionNow = (): number => (projects.getProject(projectId) as { revision: number }).revision;

    const created = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.create',
      payload: { name: '生产链路项目', max_budget_cents: 5000, rights_confirmed: true },
    });
    const projectId = created.project_id!;
    projects.execute({ command_id: randomUUID(), actor: 'user:test', type: 'gate.approve', project_id: projectId, expected_revision: 1, payload: { gate: 'G0' } });

    const workspace = mkdtempSync(join(tmpdir(), 'qiyin-produce-'));
    mkdirSync(join(workspace, 'sources'), { recursive: true });
    copyFileSync(analysisVideo, join(workspace, 'sources/reference.mp4'));
    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'source.register',
      project_id: projectId, expected_revision: revisionNow(),
      payload: { relative_path: 'sources/reference.mp4', content_hash: `sha256:${'2'.repeat(64)}`, bytes: statSync(join(workspace, 'sources/reference.mp4')).size, media_type: 'video/mp4' },
    });

    const kernel = new KernelService(projects, createFrontkernelAdapter({
      distributionRoot: root, cwd: root, timeoutMs: 120_000, longTimeoutMs: 600_000,
    }));
    await kernel.analyzeAndSeed({ projectId, expectedRevision: revisionNow(), mediaPath: 'sources/reference.mp4', workspaceDir: workspace });
    const shots = ((projects.getProject(projectId) as { shot_fields: { shots: Array<Record<string, unknown>> } | null }).shot_fields?.shots) ?? [];
    projects.execute({ command_id: randomUUID(), actor: 'user:test', type: 'gate.approve', project_id: projectId, expected_revision: revisionNow(), payload: { gate: 'G1' } });

    const { candidates } = await kernel.extractShotCandidates({
      projectId, expectedRevision: revisionNow(), mediaPath: 'sources/reference.mp4', workspaceDir: workspace,
      shots: shots.map((shot) => ({ shot_id: String(shot.shot_id), t0_ms: Number(shot.t0_ms) })),
    });
    expect(candidates.length).toBeGreaterThan(0);

    // 产品自己写 Source：把已选首帧按各镜时长铺到时间轴上
    const prepared = kernel.prepareFilmSource({
      workspaceDir: workspace,
      canvas: { width: 540, height: 960 },
      shots: candidates.map((candidate) => ({
        shot_id: candidate.shot_id,
        image_src: relative(workspace, candidate.frame_path).split('\\').join('/'),
        duration_ms: 1500,
      })),
    });
    expect(prepared.durationMs).toBe(1500 * candidates.length);
    expect(existsSync(join(workspace, prepared.svml))).toBe(true);
    expect(existsSync(join(workspace, prepared.svs))).toBe(true);

    // 内核侧需要一个 Runtime Profile；这份选的是本地 HyperFrames 与 FFmpeg
    writeFileSync(join(workspace, 'frontkernel.runtime.json'), JSON.stringify({
      format: 'frontkernel.runtime-local@1',
      dataRoot: '.frontkernel/runtimes/local',
      endpoints: {
        'media.local': { use: '@frontkernel/provider-media-local', config: { defaultConcurrency: 2 } },
        'hyperframes.local': { use: '@frontkernel/provider-hyperframes-local', config: { workers: 2, defaultConcurrency: 1 } },
      },
    }, null, 2), 'utf8');

    const submitted = await kernel.submitBuild({
      projectId, expectedRevision: revisionNow(),
      sourcePath: prepared.svrun, workspaceDir: workspace, runtimeProfile: 'frontkernel.runtime.json',
    });
    if (!submitted.executed) throw new Error(`构建提交失败：${submitted.failure}（${submitted.failureKind}）`);
    expect(submitted.executed).toBe(true);
    const buildId = submitted.report?.id;
    expect(buildId).toMatch(/^bld_/);

    let status = await kernel.buildStatus(buildId!, workspace, 'frontkernel.runtime.json');
    for (let attempt = 0; attempt < 60 && status !== null && status.work.state !== 'done'; attempt += 1) {
      await new Promise((r) => setTimeout(r, 2_000));
      status = await kernel.buildStatus(buildId!, workspace, 'frontkernel.runtime.json');
    }
    expect(status?.work.outcome).toBe('complete');

    const destination = join(workspace, 'final.mp4');
    const exported = await kernel.exportOutput(buildId!, 'final.video', destination, workspace);
    expect(exported.kind).toBe('resource');
    expect(existsSync(destination)).toBe(true);
    // 真实 MP4：文件头是 ftyp box
    expect(readFileSync(destination).subarray(4, 8).toString('ascii')).toBe('ftyp');

    /**
     * 评估：把成片与参考片比对。
     *
     * 这是「成片不像时能定位到某一镜」的落点。第一版只用可计算事实，
     * 因此结论确定、可复现，也不会自作主张去重跑任何镜头。
     */
    const evaluation = await kernel.evaluateFilm({
      projectId,
      expectedRevision: revisionNow(),
      workspaceDir: workspace,
      referencePath: 'sources/reference.mp4',
      resultPath: relative(workspace, destination).split('\\').join('/'),
      referenceArtifact: `sha256:${'2'.repeat(64)}`,
      frameRate: 30,
    });
    expect(evaluation.executed).toBe(true);
    expect(evaluation.report?.dimensions).toHaveLength(4);

    const byName = new Map(evaluation.report?.dimensions.map((dimension) => [dimension.name, dimension]));
    // 画布跟随参考片取，因此必然一致
    expect(byName.get('canvas_match')?.score).toBe(1);
    /**
     * 音轨这一条只断言「如实比对」，不预设结论：
     * 成片是否带音轨由渲染链路决定（实测它会 mux 出音轨），
     * 评估该做的是照实记录两侧事实，而不是替它下判断。
     */
    const audio = byName.get('audio_presence');
    expect(audio).toBeDefined();
    expect(audio?.delta).toHaveProperty('expected');
    expect(audio?.delta).toHaveProperty('actual');
    expect(audio?.confidence).toBe(1);
    // 报告进了项目事实
    expect((projects.getProject(projectId) as { eval_reports: unknown[] }).eval_reports).toHaveLength(1);
  }, 300_000);

  /**
   * 帧文件路径必须能跨进程找回。
   *
   * 这条守的是一个具体事故：路径映射若只活在内存里，用户关掉软件再打开，
   * 成片就会报「首帧不在本次会话中」——而他在界面上完全无从理解这句话。
   * 现在路径以**相对 workspace** 的形式写进 Artifact metadata，重启无碍、项目可迁移。
   */
  it.skipIf(!analysisReady)('抽帧路径写入 Artifact metadata，重新打开数据库仍能找回', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'qiyin-db-')), 'qiyin.db');
    const first = new ProjectService(openDatabase(dbPath));
    const created = first.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.create',
      payload: { name: '持久化项目', max_budget_cents: 2000, rights_confirmed: true },
    });
    const projectId = created.project_id!;
    first.execute({ command_id: randomUUID(), actor: 'user:test', type: 'gate.approve', project_id: projectId, expected_revision: 1, payload: { gate: 'G0' } });

    const workspace = mkdtempSync(join(tmpdir(), 'qiyin-persist-'));
    mkdirSync(join(workspace, 'sources'), { recursive: true });
    copyFileSync(analysisVideo, join(workspace, 'sources/reference.mp4'));
    first.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'source.register',
      project_id: projectId, expected_revision: 2,
      payload: { relative_path: 'sources/reference.mp4', content_hash: `sha256:${'3'.repeat(64)}`, bytes: statSync(join(workspace, 'sources/reference.mp4')).size, media_type: 'video/mp4' },
    });

    const kernel = new KernelService(first, createFrontkernelAdapter({ distributionRoot: root, cwd: root, timeoutMs: 120_000 }));
    await kernel.analyzeAndSeed({ projectId, expectedRevision: 3, mediaPath: 'sources/reference.mp4', workspaceDir: workspace });
    const shots = ((first.getProject(projectId) as { shot_fields: { shots: Array<{ shot_id: string; t0_ms: number }> } | null }).shot_fields?.shots) ?? [];
    await kernel.extractShotCandidates({
      projectId, expectedRevision: (first.getProject(projectId) as { revision: number }).revision,
      mediaPath: 'sources/reference.mp4', workspaceDir: workspace,
      shots: shots.map((shot) => ({ shot_id: shot.shot_id, t0_ms: shot.t0_ms })),
    });

    type ArtifactRow = { artifact_id: string; media_type: string; metadata: { frame_path_relative?: string } | null };
    const recorded = (first.listArtifacts() as ArtifactRow[]).find((artifact) => artifact.metadata?.frame_path_relative);
    expect(recorded).toBeDefined();
    const relativeFrame = recorded?.metadata?.frame_path_relative ?? '';
    expect(relativeFrame.length).toBeGreaterThan(0);
    // 相对路径能在 workspace 下解析成真实文件
    expect(existsSync(join(workspace, relativeFrame))).toBe(true);
    // 且不含盘符——项目才可能被整体搬走
    expect(relativeFrame).not.toMatch(/^[A-Za-z]:/);

    // 模拟「关掉软件再打开」：同一个数据库，全新的 service 实例
    const reopened = new ProjectService(openDatabase(dbPath));
    const again = (reopened.listArtifacts() as ArtifactRow[]).find((artifact) => artifact.artifact_id === recorded?.artifact_id);
    expect(again?.metadata?.frame_path_relative).toBe(relativeFrame);
  }, 240_000);
});

describeReal('内核服务·成片 Source 的真实校验', () => {
  const root = distribution as string;

  /**
   *
   * 成片 Source 是我们**拼出来的字符串**（film-source.ts），它是不是合法
   * 真提交时才被拒，而那时用户已经等了一轮。
   *
   * 这一条盯的是视频片段那份 recipe（`media.video` 带 `playback: hold-start`）：
   * 它多了一个属主 recipe，静图不能带、视频必须带，两处都容易写错。
   */
  it('视频片段那份 recipe 能被真实 frontkernel 接受', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'qiyin-film-check-'));
    mkdirSync(join(workspace, 'frames'), { recursive: true });
    mkdirSync(join(workspace, 'clips'), { recursive: true });
    /* 素材内容不必是真的：check 只做静态校验，不解码媒体 */
    writeFileSync(join(workspace, 'frames', 'first.png'), Buffer.from('PNG'), 'utf8');
    writeFileSync(join(workspace, 'clips', 'clip.mp4'), Buffer.from('MP4'), 'utf8');

    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.create',
      payload: { name: '成片 Source 校验', max_budget_cents: 2000, rights_confirmed: true },
    });
    const projectId = created.project_id!;
    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'gate.approve',
      project_id: projectId, expected_revision: 1, payload: { gate: 'G0' },
    });

    const kernel = new KernelService(projects, createFrontkernelAdapter({
      distributionRoot: root, cwd: workspace, timeoutMs: 120_000,
    }));

    /*
      stretch 是这一轮新加的 recipe，写完就跑一次真校验——
      光看生成出来的文本对，说明不了它合不合法。
    */
    let revision = 2;
    for (const playback of ['hold', 'stretch'] as const) {
      const prepared = kernel.prepareFilmSource({
        workspaceDir: workspace,
        canvas: { width: 540, height: 960 },
        frameRate: 30,
        shots: [{
          shot_id: 'shot-01',
          image_src: 'frames/first.png',
          video_src: 'clips/clip.mp4',
          duration_ms: 2000,
          audio: false,
          playback,
        }],
      });
      const source = readFileSync(join(workspace, 'production', 'film.svml'), 'utf8');
      const style = readFileSync(join(workspace, 'production', 'film.svs'), 'utf8');
      /**/
      expect(source).toContain(playback === 'stretch' ? 'appearance={style.media.video-stretch}' : 'appearance={style.media.video}');
      expect(style).toContain(playback === 'stretch' ? 'playback: stretch;' : 'playback: hold-start;');

      const outcome = await kernel.checkSource({
        projectId,
        expectedRevision: revision,
        sourcePath: prepared.svrun,
        workspaceDir: workspace,
        purpose: `成片 Source 校验·${playback}`,
      });
      revision = outcome.projectRevision ?? revision + 1;

      if (!outcome.executed || outcome.report?.ok !== true) {
        throw new Error(JSON.stringify({
          playback,
          failure: outcome.failure ?? null,
          report: outcome.report ?? null,
          source,
        }));
      }
      expect(outcome.report?.ok).toBe(true);
    }
  }, 180_000);
});

describeReal('内核服务·转场 Source 的真实校验', () => {
  const root = distribution as string;

  /**
   * 转场不是"换个参数"，是**换一种成片结构**：硬切走"每镜一个 Item"，
   * 转场要换成 `Sequence + Member + Handoff`。
   *
   * 相邻 Member 之间**一个 Handoff 都不能少**、转场配方还有必填的
   * `duration-frames`，这些约束光看生成出来的文本都"像是写对了"。
   */
  it('除硬切之外的每一种转场都能被真实 frontkernel 接受', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'qiyin-film-transition-'));
    mkdirSync(join(workspace, 'frames'), { recursive: true });
    mkdirSync(join(workspace, 'clips'), { recursive: true });
    writeFileSync(join(workspace, 'frames', 'a.png'), Buffer.from('PNG'), 'utf8');
    writeFileSync(join(workspace, 'frames', 'b.png'), Buffer.from('PNG'), 'utf8');
    writeFileSync(join(workspace, 'clips', 'a.mp4'), Buffer.from('MP4'), 'utf8');

    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.create',
      payload: { name: '转场 Source 校验', max_budget_cents: 2000, rights_confirmed: true },
    });
    const projectId = created.project_id!;
    projects.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'gate.approve',
      project_id: projectId, expected_revision: 1, payload: { gate: 'G0' },
    });

    const kernel = new KernelService(projects, createFrontkernelAdapter({
      distributionRoot: root, cwd: workspace, timeoutMs: 120_000,
    }));
    /*
      三镜，专挑边界：
        shot-01  有片段（走 media + 自己的 appearance）
        shot-02  **只有 100ms**（3 帧）——比转场上限还短，那一对必须退成 cut
        shot-03  只有首帧（走 image + extent）
      混合源 + 快切是真实项目里最常见的形态，一起放进来验。
    */
    /*
      而每一种的**方向语义**都不一样（push 要往哪推、wipe 往哪扫）——
    */
    let revision = 2;
    /*
      两段：先五种 operator 各来一次（不指定方向，走默认），
      再对其中一种把四个方向都试一遍。

      为什么要单独试方向：方向是**必填**的（不写会被拒），
    */
    const cases: Array<{ operator: FilmTransition; direction?: 'left' | 'right' | 'up' | 'down'; label: string }> = [
      ...(['crossfade', 'push', 'wipe', 'cover', 'page-turn'] as const)
        .map((operator) => ({ operator, label: operator })),
      ...(['left', 'right', 'up', 'down'] as const)
        .map((direction) => ({ operator: 'push' as const, direction, label: `push·${direction}` })),
    ];
    for (const testCase of cases) {
      const { operator, direction, label } = testCase;
      const prepared = kernel.prepareFilmSource({
        workspaceDir: workspace,
        canvas: { width: 540, height: 960 },
        frameRate: 30,
        transition: operator,
        ...(direction === undefined ? {} : { direction }),
        shots: [
          { shot_id: 'shot-01', image_src: 'frames/a.png', video_src: 'clips/a.mp4', duration_ms: 2000, audio: false },
          { shot_id: 'shot-02', image_src: 'frames/b.png', duration_ms: 2000 },
          /* 最后一镜 100ms（3 帧）：它参与的那一对分不到 2 帧，应当退成硬切 */
          { shot_id: 'shot-03', image_src: 'frames/b.png', duration_ms: 100 },
        ],
      });
      const source = readFileSync(join(workspace, 'production', 'film.svml'), 'utf8');
      const style = readFileSync(join(workspace, 'production', 'film.svs'), 'utf8');
      expect(source).toContain('<track:Sequence id="shots"');
      expect(source).toContain('<track:Member id="member-shot-01"');
      expect(source).toContain('<track:Member id="member-shot-02"');
      expect(source).toContain('<track:Member id="member-shot-03"');
      expect(source).toContain('<track:Handoff id="handoff-1" from="member-shot-01"');
      expect(source).toContain('<track:Handoff id="handoff-2" from="member-shot-02"');
      /*
        转场配方按**对**生成，而且两对的结果不同——这正是这个用例要证明的事：
        第 1 对两镜都够长（取上限 12 帧、operator 就是用户选的那个），
        第 2 对被 100ms 那一镜拉短（**不论选的是哪种转场**都退成 cut）。
      */
      expect(style).toContain('transition.handoff-1 {');
      expect(style).toContain(`operator: ${operator};`);
      expect(style).toContain('duration-frames: 12;');
      if (direction !== undefined) {
        expect(style).toContain(`direction: ${direction};`);
      } else if (operator === 'crossfade') {
        /**/
        expect(style).not.toContain('direction:');
      }
      expect(style).toContain('transition.handoff-2 {');
      expect(style).toContain('operator: cut;');

      const outcome = await kernel.checkSource({
        projectId,
        expectedRevision: revision,
        sourcePath: prepared.svrun,
        workspaceDir: workspace,
        purpose: `转场 Source 校验·${label}`,
      });
      revision = outcome.projectRevision ?? revision + 1;
      if (!outcome.executed || outcome.report?.ok !== true) {
        throw new Error(JSON.stringify({
          case: label,
          failure: outcome.failure ?? null,
          report: outcome.report ?? null,
          source,
        }));
      }
      expect(outcome.report?.ok).toBe(true);
    }
  }, 180_000);
});

