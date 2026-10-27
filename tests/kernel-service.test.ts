import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { FrontkernelAdapter, type FrontkernelRunRequest, type FrontkernelRunner } from '@qiyin/frontkernel-adapter';
import { KernelService, parseFrontkernelTranscript } from '@qiyin/kernel-service';

/**
 *
 * 因此解析、格式校验与错误分类全都走真实代码路径——
 * 与「生产 adapter + 本地 fake 传输」的原则一致，不另写一套平行实现。
 */

function runner(responses: ReadonlyArray<{ code?: number; stdout?: string; stderr?: string }>) {
  const calls: FrontkernelRunRequest[] = [];
  let index = 0;
  const fake: FrontkernelRunner = {
    async run(request) {
      calls.push(request);
      const response = responses[Math.min(index, responses.length - 1)] ?? {};
      index += 1;
      return { code: response.code ?? 0, stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
    },
  };
  return { fake, calls };
}

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

const CHECK_OK = JSON.stringify({
  format: 'frontkernel.cli-check@1',
  sourceKind: 'author',
  ok: true,
  source: 'productions/explainer/authors/main.svml',
  frontend: '@frontkernel/markup@1',
  units: 4,
  assets: 7,
  modules: 34,
  outputCount: 42,
});

const RUN_CHECK_OK = JSON.stringify({
  format: 'frontkernel.cli-check@1', sourceKind: 'run', ok: true,
  run: 'production/film.svrun', author: 'production/film.svml', targets: ['film'],
});
const PLAN_OK = JSON.stringify({
  format: 'frontkernel.cli-plan@1', ok: true, run: 'production/film.svrun',
  targetCount: 1, targets: ['film'], steps: 3, requestCount: 0, providers: [],
});
const BUILD_OK = JSON.stringify({
  format: 'frontkernel.cli-build@1',
  build: {
    id: 'bld_gate_1', targets: ['film'],
    work: { state: 'submitting', requests: { total: 0, completed: 0 } },
    result: { state: 'open', outputCount: 0 },
  },
});

function setup(kernelResponses: ReadonlyArray<{ code?: number; stdout?: string; stderr?: string }>) {
  const projects = new ProjectService(openDatabase(':memory:'));
  const created = projects.execute(command('project.create', { name: '内核服务项目', max_budget_cents: 1000, rights_confirmed: true }));
  const projectId = created.project_id!;
  projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  const { fake, calls } = runner(kernelResponses);
  const kernel = new KernelService(projects, new FrontkernelAdapter(fake));
  return { projects, projectId, revision: 2, kernel, calls };
}

describe('KernelService·成功路径', () => {
  it('先登记意图、再执行、最后回填，事件流留下完整轨迹', async () => {
    const { projects, projectId, revision, kernel, calls } = setup([{ stdout: CHECK_OK }]);
    const outcome = await kernel.checkSource({
      projectId,
      expectedRevision: revision,
      sourcePath: 'productions/explainer/authors/main.svml',
      workspaceDir: 'C:\\projects\\demo',
    });

    expect(outcome.executed).toBe(true);
    expect(outcome.report?.ok).toBe(true);
    expect(outcome.report?.frontend).toBe('@frontkernel/markup@1');

    // 领域事实
    const types = projects.listEvents(projectId).map((event) => event.type);
    expect(types).toEqual(['project.created', 'gate.approved', 'kernel-check.requested', 'kernel-check.completed']);

    /**
     * 真实命令组装。
     *
     * 注意路径约定：产品层传的是**相对 workspace** 的路径，
     * 内核那边收到的必须是可以直接打开的绝对路径——这层换算在服务层完成，
     * 否则内核会按自己的 cwd 去解析，找不到文件。
     */
    expect(calls[0]?.args).toEqual([
      'check', join('C:\\projects\\demo', 'productions/explainer/authors/main.svml'), '--json',
      '--workspace', 'C:\\projects\\demo',
    ]);

    const tasks = projects.listKernelTasks(projectId) as Array<{ status: string; report: { outputCount?: number } | null }>;
    expect(tasks[0]?.status).toBe('COMPLETED');
    expect(tasks[0]?.report?.outputCount).toBe(42);
  });

  it('逐词转录调用官方命令、落盘并把词级证据写回任务', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'qiyin-transcribe-'));
    mkdirSync(join(workspace, 'sources'));
    writeFileSync(join(workspace, 'sources', 'ref.mp4'), '测试输入');
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute(command('project.create', { name: '转录项目', max_budget_cents: 1000, rights_confirmed: true }));
    const projectId = created.project_id!;
    projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
    const calls: FrontkernelRunRequest[] = [];
    const fake: FrontkernelRunner = {
      async run(request) {
        calls.push(request);
        const destination = request.args[request.args.indexOf('--to') + 1]!;
        writeFileSync(destination, JSON.stringify({
          format: 'frontkernel.transcript@1', source: join(workspace, 'sources', 'ref.mp4'), language: 'zh', audio_seconds: 1,
          passages: [{ text: '你好', words: [{ text: '你', start_seconds: 0, end_seconds: 0.4 }, { text: '好', start_seconds: 0.4, end_seconds: 0.8 }] }],
        }));
        return { code: 0, stderr: '', stdout: JSON.stringify({
          format: 'frontkernel.video-cli-transcribe@1', source: join(workspace, 'sources', 'ref.mp4'), language: 'zh',
          audio_seconds: 1, extracted: true, passages: 1, words: 2, path: destination,
        }) };
      },
    };
    const kernel = new KernelService(projects, new FrontkernelAdapter(fake));
    const outcome = await kernel.transcribeSource({
      projectId, expectedRevision: 2, mediaPath: 'sources/ref.mp4', workspaceDir: workspace,
      language: 'zh', executionConfirmed: true, runtimeProfile: 'frontkernel.runtime.json',
    });
    expect(outcome.executed).toBe(true);
    expect(outcome.report?.transcript.passages[0]?.words).toHaveLength(2);
    expect(outcome.report?.transcriptRelativePath).toMatch(/^transcripts\//u);
    expect(calls[0]?.args).toContain('transcribe');
    expect(projects.listKernelTasks(projectId)[0]).toMatchObject({ kind: 'transcribe', status: 'COMPLETED' });
  });
});

describe('KernelService·全局构建前置 Agent 门控', () => {
  it('所有 build 都严格执行 check → plan → build，并留下三段项目事实', async () => {
    const { projects, projectId, revision, kernel, calls } = setup([
      { stdout: RUN_CHECK_OK }, { stdout: PLAN_OK }, { stdout: BUILD_OK },
    ]);
    const outcome = await kernel.submitBuild({
      projectId, expectedRevision: revision, sourcePath: 'production/film.svrun',
      workspaceDir: 'C:\\projects\\demo', runtimeProfile: 'frontkernel.runtime.json', purpose: '成片',
    });

    expect(outcome.executed).toBe(true);
    expect(outcome.report?.id).toBe('bld_gate_1');
    expect(outcome.preflight.status).toBe('passed');
    expect(calls.map((call) => call.args[0])).toEqual(['check', 'plan', 'build']);
    expect(calls[1]?.args).toContain('--runtime');
    expect(calls[1]?.args).toContain(join('C:\\projects\\demo', 'frontkernel.runtime.json'));
    expect(calls[2]?.args).toContain(join('C:\\projects\\demo', 'frontkernel.runtime.json'));

    const kinds = (projects.listKernelTasks(projectId) as Array<{ kind: string }>).map((task) => task.kind);
    expect([...kinds].sort()).toEqual(['build', 'check', 'plan']);
    expect(projects.listEvents(projectId).map((event) => event.type).slice(-6)).toEqual([
      'kernel-check.requested', 'kernel-check.completed',
      'kernel-plan.requested', 'kernel-plan.completed',
      'kernel-build.requested', 'kernel-build.completed',
    ]);
  });

  it('check 未通过时 fail closed：不 plan、不 build，也不登记 build task', async () => {
    const { projects, projectId, revision, kernel, calls } = setup([{
      stdout: JSON.stringify({
        format: 'frontkernel.cli-check@1', sourceKind: 'run', ok: false,
        run: 'production/film.svrun', author: 'production/film.svml', targets: ['film'],
        diagnostics: [{ severity: 'error', message: 'Source 不合法' }],
      }),
    }]);
    const outcome = await kernel.submitBuild({
      projectId, expectedRevision: revision, sourcePath: 'production/film.svrun', workspaceDir: 'C:\\projects\\demo',
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.preflight.blockedAt).toBe('check');
    expect(outcome.failure).toContain('Source 不合法');
    expect(calls.map((call) => call.args[0])).toEqual(['check']);
    expect((projects.listKernelTasks(projectId) as Array<{ kind: string }>).map((task) => task.kind)).toEqual(['check']);
  });

  it('plan 未通过时 fail closed：不调用 build，不登记 build task', async () => {
    const { projects, projectId, revision, kernel, calls } = setup([
      { stdout: RUN_CHECK_OK },
      { stdout: JSON.stringify({
        format: 'frontkernel.cli-plan@1', ok: false, run: 'production/film.svrun',
        targetCount: 1, targets: ['film'], requestCount: 1,
        diagnostics: [{ severity: 'error', message: 'Provider 未解析' }],
      }) },
    ]);
    const outcome = await kernel.submitBuild({
      projectId, expectedRevision: revision, sourcePath: 'production/film.svrun', workspaceDir: 'C:\\projects\\demo',
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.preflight.blockedAt).toBe('plan');
    expect(outcome.failure).toContain('Provider 未解析');
    expect(calls.map((call) => call.args[0])).toEqual(['check', 'plan']);
    expect((projects.listKernelTasks(projectId) as Array<{ kind: string }>).map((task) => task.kind).sort()).toEqual(['check', 'plan']);
  });
});

describe('KernelService·失败路径', () => {
  it('内核命令失败也会回填，并归到 command 类', async () => {
    const { projects, projectId, revision, kernel } = setup([{
      code: 1,
      stdout: JSON.stringify({ format: 'frontkernel.cli-error@1', ok: false, error: { code: 'SOURCE_NOT_FOUND', message: '找不到 Source' } }),
    }]);
    const outcome = await kernel.checkSource({
      projectId, expectedRevision: revision, sourcePath: 'missing.svml', workspaceDir: 'C:\\projects\\demo',
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.failureKind).toBe('command');
    expect(outcome.failure).toContain('SOURCE_NOT_FOUND');

    const types = projects.listEvents(projectId).map((event) => event.type);
    expect(types).toContain('kernel-check.failed');

    const tasks = projects.listKernelTasks(projectId) as Array<{ status: string; failure: string | null }>;
    expect(tasks[0]?.status).toBe('FAILED');
    expect(tasks[0]?.failure).toContain('找不到 Source');
  });

  it('契约漂移被单独归类，便于触发人工复核而不是盲目重试', async () => {
    const { projectId, revision, kernel } = setup([{
      stdout: JSON.stringify({ format: 'frontkernel.cli-check@9', ok: true }),
    }]);
    const outcome = await kernel.checkSource({
      projectId, expectedRevision: revision, sourcePath: 'main.svml', workspaceDir: 'C:\\projects\\demo',
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.failureKind).toBe('contract-drift');
    expect(outcome.failure).toContain('漂移');
  });

  it('非 JSON 输出归为 protocol 类', async () => {
    const { projectId, revision, kernel } = setup([{ code: 3, stdout: 'not json', stderr: 'unexpected' }]);
    const outcome = await kernel.checkSource({
      projectId, expectedRevision: revision, sourcePath: 'main.svml', workspaceDir: 'C:\\projects\\demo',
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.failureKind).toBe('protocol');
  });

  it('CAS 不匹配时拒绝登记，不产生内核任务', async () => {
    const { projects, projectId, kernel } = setup([{ stdout: CHECK_OK }]);
    await expect(kernel.checkSource({
      projectId, expectedRevision: 99, sourcePath: 'main.svml', workspaceDir: 'C:\\projects\\demo',
    })).rejects.toThrow(/revision/);
    expect(projects.listKernelTasks(projectId)).toHaveLength(0);
  });

  it('绝对路径在登记阶段就被拒，内核根本不会被调用', async () => {
    const { projectId, revision, kernel, calls } = setup([{ stdout: CHECK_OK }]);
    await expect(kernel.checkSource({
      projectId, expectedRevision: revision, sourcePath: 'C:\\videos\\main.svml', workspaceDir: 'C:\\projects\\demo',
    })).rejects.toThrow(/相对路径/);
    expect(calls).toHaveLength(0);
  });
});

describe('Frontkernel 逐词转录契约', () => {
  it('保留每个词的秒级起止时间', () => {
    const transcript = parseFrontkernelTranscript(JSON.stringify({
      format: 'frontkernel.transcript@1', source: 'ref.mp4', language: 'zh', audio_seconds: 1.2,
      passages: [{ text: '你好', start_seconds: 0.1, end_seconds: 0.8, words: [
        { text: '你', start_seconds: 0.1, end_seconds: 0.4 },
        { text: '好', start_seconds: 0.4, end_seconds: 0.8 },
      ] }],
    }));
    expect(transcript.passages[0]?.words).toEqual([
      { text: '你', start_seconds: 0.1, end_seconds: 0.4 },
      { text: '好', start_seconds: 0.4, end_seconds: 0.8 },
    ]);
  });

  it('格式漂移或倒置时间戳会被拒绝', () => {
    expect(() => parseFrontkernelTranscript(JSON.stringify({ format: 'frontkernel.transcript@2', passages: [] }))).toThrow(/transcript@1/);
    expect(() => parseFrontkernelTranscript(JSON.stringify({
      format: 'frontkernel.transcript@1', source: 'ref.mp4', language: 'zh', audio_seconds: 1,
      passages: [{ text: '坏时间', words: [{ text: '坏', start_seconds: 0.8, end_seconds: 0.2 }] }],
    }))).toThrow(/结束时间早于开始时间/);
  });
});
