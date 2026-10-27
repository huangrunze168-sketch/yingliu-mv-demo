import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';

/**
 *
 * 领域层不执行内核，只登记意图与回填结果。这里守住三件事：
 *   · 意图先落库再执行——内核或界面当场崩掉，审计里仍有这条记录；
 *   · 领域协议不接受绝对路径（架构 v2.3 §7.1）；
 *   · 「执行是否成功」与「校验是否通过」是两个不同的结论，不得混为一谈。
 */

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

function setup(service: ProjectService): { projectId: string; revision: number } {
  const created = service.execute(command('project.create', { name: '内核任务项目', max_budget_cents: 1000, rights_confirmed: true }));
  const projectId = created.project_id!;
  service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  return { projectId, revision: 2 };
}

describe('内核任务·登记', () => {
  it('登记校验意图后处于 ADMITTED，且尚未启动内核', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    const result = service.execute(command('kernel.check', { source_path: 'productions/explainer/authors/main.svml' }, { project_id: projectId, expected_revision: revision }));
    const payload = result.payload as { task_id: string; status: string; kernel_started: boolean };
    expect(payload.status).toBe('ADMITTED');
    expect(payload.kernel_started).toBe(false);

    const tasks = service.listKernelTasks(projectId) as Array<{ task_id: string; status: string; kind: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.kind).toBe('check');
    expect(tasks[0]?.status).toBe('ADMITTED');
  });

  it('逐词转录作为正式内核任务登记，不绕过审计轨迹', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    const result = service.execute(command('kernel.transcribe', {
      source_path: 'sources/reference.mp4', purpose: '中文逐词转录',
    }, { project_id: projectId, expected_revision: revision }));
    expect(result.payload).toMatchObject({ kind: 'transcribe', status: 'ADMITTED', kernel_started: false });
    expect(service.listKernelTasks(projectId)[0]).toMatchObject({ kind: 'transcribe', source_path: 'sources/reference.mp4' });
    expect(service.listEvents(projectId).at(-1)?.type).toBe('kernel-transcribe.requested');
  });

  it('拒绝绝对路径，避免把开发机目录写进项目事实', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    for (const bad of ['C:\\videos\\main.svml', '/home/user/main.svml', '\\\\server\\share\\main.svml']) {
      let caught: unknown;
      try {
        service.execute(command('kernel.check', { source_path: bad }, { project_id: projectId, expected_revision: revision }));
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe('ABSOLUTE_PATH_FORBIDDEN');
      expect((caught as { statusCode?: number }).statusCode).toBe(422);
    }
  });
});

describe('内核任务·回填', () => {
  it('回填成功结果并保留完整报告', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    const requested = service.execute(command('kernel.check', { source_path: 'main.svml' }, { project_id: projectId, expected_revision: revision }));
    const taskId = (requested.payload as { task_id: string }).task_id;

    const report = { format: 'frontkernel.cli-check@1', ok: true, frontend: '@frontkernel/markup@1', units: 4, outputCount: 42 };
    const recorded = service.execute(command('kernel.result.record', { task_id: taskId, status: 'COMPLETED', report }, { project_id: projectId, expected_revision: revision + 1 }));
    expect((recorded.payload as { status: string }).status).toBe('COMPLETED');

    const tasks = service.listKernelTasks(projectId) as Array<{ status: string; report: { ok?: boolean } | null }>;
    expect(tasks[0]?.status).toBe('COMPLETED');
    expect(tasks[0]?.report?.ok).toBe(true);
  });

  it('校验不通过是「成功执行的失败结论」，仍然记为 COMPLETED', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    const requested = service.execute(command('kernel.check', { source_path: 'broken.svml' }, { project_id: projectId, expected_revision: revision }));
    const taskId = (requested.payload as { task_id: string }).task_id;

    service.execute(command('kernel.result.record', {
      task_id: taskId, status: 'COMPLETED',
      report: { format: 'frontkernel.cli-check@1', ok: false, diagnosticCount: 2 },
    }, { project_id: projectId, expected_revision: revision + 1 }));

    const tasks = service.listKernelTasks(projectId) as Array<{ status: string; report: { ok?: boolean } | null }>;
    expect(tasks[0]?.status).toBe('COMPLETED');
    expect(tasks[0]?.report?.ok).toBe(false);
  });

  it('内核自身崩溃记为 FAILED 并保留原因', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    const requested = service.execute(command('kernel.check', { source_path: 'main.svml' }, { project_id: projectId, expected_revision: revision }));
    const taskId = (requested.payload as { task_id: string }).task_id;

    service.execute(command('kernel.result.record', { task_id: taskId, status: 'FAILED', failure: '未找到 Frontkernel 发行版' }, { project_id: projectId, expected_revision: revision + 1 }));
    const tasks = service.listKernelTasks(projectId) as Array<{ status: string; failure: string | null }>;
    expect(tasks[0]?.status).toBe('FAILED');
    expect(tasks[0]?.failure).toContain('Frontkernel');
  });

  it('成功回填缺报告被拒，失败回填缺原因被拒', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    const requested = service.execute(command('kernel.check', { source_path: 'main.svml' }, { project_id: projectId, expected_revision: revision }));
    const taskId = (requested.payload as { task_id: string }).task_id;

    expect(() => service.execute(command('kernel.result.record', { task_id: taskId, status: 'COMPLETED' }, { project_id: projectId, expected_revision: revision + 1 }))).toThrow(/报告/);
    expect(() => service.execute(command('kernel.result.record', { task_id: taskId, status: 'FAILED' }, { project_id: projectId, expected_revision: revision + 1 }))).toThrow(/原因/);
  });

  it('重复回填被拒，且不存在的任务返回 404', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    const requested = service.execute(command('kernel.check', { source_path: 'main.svml' }, { project_id: projectId, expected_revision: revision }));
    const taskId = (requested.payload as { task_id: string }).task_id;
    service.execute(command('kernel.result.record', { task_id: taskId, status: 'COMPLETED', report: { ok: true } }, { project_id: projectId, expected_revision: revision + 1 }));

    let caught: unknown;
    try {
      service.execute(command('kernel.result.record', { task_id: taskId, status: 'COMPLETED', report: { ok: true } }, { project_id: projectId, expected_revision: revision + 2 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('KERNEL_TASK_ALREADY_SETTLED');

    let missing: unknown;
    try {
      service.execute(command('kernel.result.record', { task_id: randomUUID(), status: 'COMPLETED', report: { ok: true } }, { project_id: projectId, expected_revision: revision + 2 }));
    } catch (error) {
      missing = error;
    }
    expect((missing as { code?: string }).code).toBe('KERNEL_TASK_NOT_FOUND');
    expect((missing as { statusCode?: number }).statusCode).toBe(404);
  });

  it('事件流记录请求与完成两件事，便于重启后对账', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = setup(service);
    const requested = service.execute(command('kernel.check', { source_path: 'main.svml', purpose: '核对拆解底稿' }, { project_id: projectId, expected_revision: revision }));
    const taskId = (requested.payload as { task_id: string }).task_id;
    service.execute(command('kernel.result.record', { task_id: taskId, status: 'COMPLETED', report: { ok: true } }, { project_id: projectId, expected_revision: revision + 1 }));

    const types = service.listEvents(projectId).map((event) => event.type);
    expect(types).toEqual([
      'project.created',
      'gate.approved',
      'kernel-check.requested',
      'kernel-check.completed',
    ]);
  });
});
