import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { FrontkernelAdapter, type FrontkernelRunRequest, type FrontkernelRunner } from '@qiyin/frontkernel-adapter';
import { KernelService } from '@qiyin/kernel-service';
import { buildServer } from '../apps/local-api/src/server.js';

/**
 * 本地 API 的内核端点。
 *
 * 关心的是**接线是否正确**：未接入内核时给出明确拒绝而不是假装成功；
 * 接入之后，请求与结果都要落进项目事实，调用方一次调用就能拿到结论。
 */

const CHECK_OK = JSON.stringify({
  format: 'frontkernel.cli-check@1',
  sourceKind: 'author',
  ok: true,
  source: 'main.svml',
  frontend: '@frontkernel/markup@1',
  outputCount: 42,
});

function fakeRunner(stdout: string): FrontkernelRunner {
  return {
    async run(_request: FrontkernelRunRequest) {
      return { code: 0, stdout, stderr: '' };
    },
  };
}

/** 按子命令分发的假执行器：一个实例可以同时支撑 plan / build / status / inspect / get。 */
function dispatcherRunner(handlers: Record<string, () => string>): FrontkernelRunner {
  return {
    async run(request: FrontkernelRunRequest) {
      const handler = handlers[request.args[0] ?? ''];
      if (!handler) {
        return {
          code: 1, stderr: '',
          stdout: JSON.stringify({ format: 'frontkernel.cli-error@1', ok: false, error: { code: 'UNEXPECTED', message: `未预期的命令 ${request.args[0]}` } }),
        };
      }
      return { code: 0, stdout: handler(), stderr: '' };
    },
  };
}

function seedProject(service: ProjectService): { projectId: string; revision: number } {
  const created = service.execute({
    command_id: randomUUID(), actor: 'user:test', type: 'project.create',
    payload: { name: 'API 内核项目', max_budget_cents: 1000, rights_confirmed: true },
  });
  const projectId = created.project_id!;
  service.execute({
    command_id: randomUUID(), actor: 'user:test', type: 'gate.approve',
    project_id: projectId, expected_revision: 1, payload: { gate: 'G0' },
  });
  return { projectId, revision: 2 };
}

describe('本地 API·内核端点', () => {
  it('转录未明确授权时拒绝，不登记任务也不调用 Provider', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = seedProject(service);
    let calls = 0;
    const adapter = new FrontkernelAdapter({ async run() { calls += 1; throw new Error('不应执行'); } });
    const app = buildServer(service, { service: new KernelService(service, adapter), workspaceRoot: 'C:\\tmp\\qiyin-ws' });
    for (const confirmation of [undefined, false, 'true', 1]) {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/kernel/transcribe',
        payload: { project_id: projectId, expected_revision: revision, media_path: 'ref.mp4', language: 'zh', execution_confirmed: confirmation },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('EXECUTION_CONFIRMATION_REQUIRED');
    }
    expect(calls).toBe(0);
    expect(service.listKernelTasks(projectId)).toHaveLength(0);
    await app.close();
  });

  it('未接入内核时返回 501，而不是静默成功', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const app = buildServer(service);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/kernel/check',
      payload: { project_id: randomUUID(), expected_revision: 1, source_path: 'main.svml' },
    });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe('KERNEL_UNAVAILABLE');
    await app.close();
  });

  it('缺少必要字段时返回 400', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const app = buildServer(service, {
      service: new KernelService(service, new FrontkernelAdapter(fakeRunner(CHECK_OK))),
      workspaceRoot: 'C:\\tmp\\qiyin-ws',
    });
    const response = await app.inject({ method: 'POST', url: '/api/v1/kernel/check', payload: { source_path: 'main.svml' } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('接入内核后一次调用即完成「登记 → 执行 → 回填」', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = seedProject(service);
    const app = buildServer(service, {
      service: new KernelService(service, new FrontkernelAdapter(fakeRunner(CHECK_OK))),
      workspaceRoot: 'C:\\tmp\\qiyin-ws',
    });

    const response = await app.inject({
      method: 'POST', url: '/api/v1/kernel/check',
      payload: { project_id: projectId, expected_revision: revision, source_path: 'main.svml' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { executed: boolean; report?: { ok?: boolean } };
    expect(body.executed).toBe(true);
    expect(body.report?.ok).toBe(true);

    const project = service.getProject(projectId) as { revision: number };
    expect(project.revision).toBe(revision + 2);
    expect((service.listKernelTasks(projectId) as unknown[])).toHaveLength(1);
    expect(service.listEvents(projectId).map((event) => event.type)).toEqual([
      'project.created', 'gate.approved', 'kernel-check.requested', 'kernel-check.completed',
    ]);
    await app.close();
  });

  it('项目 revision 过期时返回 409，不会把结果写到已前进的项目上', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId } = seedProject(service);
    const app = buildServer(service, {
      service: new KernelService(service, new FrontkernelAdapter(fakeRunner(CHECK_OK))),
      workspaceRoot: 'C:\\tmp\\qiyin-ws',
    });
    const response = await app.inject({
      method: 'POST', url: '/api/v1/kernel/check',
      payload: { project_id: projectId, expected_revision: 99, source_path: 'main.svml' },
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it('plan 端点返回目标与能力需求', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = seedProject(service);
    const app = buildServer(service, {
      service: new KernelService(service, new FrontkernelAdapter(dispatcherRunner({
        plan: () => JSON.stringify({
          format: 'frontkernel.cli-plan@1', ok: true, run: 'chat.svrun',
          targetCount: 1, targets: ['final.video'], requestCount: 3,
        }),
      }))),
      workspaceRoot: 'C:\\tmp\\qiyin-ws',
    });
    const response = await app.inject({
      method: 'POST', url: '/api/v1/kernel/plan',
      payload: { project_id: projectId, expected_revision: revision, source_path: 'chat.svrun' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { executed: boolean; report?: { targets?: string[]; requestCount?: number } };
    expect(body.executed).toBe(true);
    expect(body.report?.targets).toContain('final.video');
    expect(body.report?.requestCount).toBe(3);
    await app.close();
  });

  it('build 端点提交后即返回 build id 与 working 状态', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const { projectId, revision } = seedProject(service);
    const app = buildServer(service, {
      service: new KernelService(service, new FrontkernelAdapter(dispatcherRunner({
        check: () => JSON.stringify({
          format: 'frontkernel.cli-check@1', sourceKind: 'run', ok: true,
          run: 'chat.svrun', author: 'chat.svml', targets: ['final.video'],
        }),
        plan: () => JSON.stringify({
          format: 'frontkernel.cli-plan@1', ok: true, run: 'chat.svrun',
          targetCount: 1, targets: ['final.video'], requestCount: 0, providers: [],
        }),
        build: () => JSON.stringify({
          format: 'frontkernel.cli-build@1',
          build: { id: 'bld_test_1', targets: ['final.video'], work: { state: 'working' }, result: { state: 'missing' } },
        }),
      }))),
      workspaceRoot: 'C:\\tmp\\qiyin-ws',
    });
    const response = await app.inject({
      method: 'POST', url: '/api/v1/kernel/build',
      payload: { project_id: projectId, expected_revision: revision, source_path: 'chat.svrun' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { executed: boolean; report?: { id?: string; work?: { state?: string } }; preflight?: { status?: string } };
    expect(body.executed).toBe(true);
    expect(body.preflight?.status).toBe('passed');
    expect(body.report?.id).toBe('bld_test_1');
    expect(body.report?.work?.state).toBe('working');
    expect((service.listKernelTasks(projectId) as unknown[])).toHaveLength(3);
    await app.close();
  });

  it('status 端点对不存在的 build 返回 404', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const app = buildServer(service, {
      service: new KernelService(service, new FrontkernelAdapter(dispatcherRunner({
        status: () => JSON.stringify({ format: 'frontkernel.cli-status@1', build: null }),
      }))),
      workspaceRoot: 'C:\\tmp\\qiyin-ws',
    });
    const response = await app.inject({
      method: 'GET', url: `/api/v1/kernel/status/bld_missing?project_id=${randomUUID()}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('BUILD_NOT_FOUND');
    await app.close();
  });

  it('get 端点拒绝把输出写到 workspace 之外', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const app = buildServer(service, {
      service: new KernelService(service, new FrontkernelAdapter(dispatcherRunner({}))),
      workspaceRoot: 'C:\\tmp\\qiyin-ws',
    });
    const response = await app.inject({
      method: 'POST', url: '/api/v1/kernel/get',
      payload: {
        project_id: randomUUID(), build_id: 'bld_1', output: 'final.video',
        to: 'C:\\Windows\\Temp\\escaped.mp4',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('PATH_OUTSIDE_WORKSPACE');
    await app.close();
  });
});
