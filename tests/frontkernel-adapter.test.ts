import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FrontkernelAdapter,
  FrontkernelCommandError,
  FrontkernelContractDriftError,
  FrontkernelProtocolError,
  createFrontkernelAdapter,
  resolveFrontkernelDistribution,
  type FrontkernelRunRequest,
  type FrontkernelRunner,
} from '@qiyin/frontkernel-adapter';

/**
 *
 * 两层验证：
 *   1. 用可注入的执行器覆盖解析、参数组装与三条失败路径——不需要安装就能跑；
 */

function fakeRunner(responses: ReadonlyArray<{ code?: number; stdout?: string; stderr?: string }>) {
  const calls: FrontkernelRunRequest[] = [];
  let index = 0;
  const runner: FrontkernelRunner = {
    async run(request: FrontkernelRunRequest) {
      calls.push(request);
      const response = responses[Math.min(index, responses.length - 1)] ?? {};
      index += 1;
      return { code: response.code ?? 0, stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
    },
  };
  return { runner, calls };
}

const VERSION_JSON = JSON.stringify({
  format: 'frontkernel.cli-version@1',
  package: '@frontkernel/frontkernel',
  version: '0.2.7',
  distribution: 'C:\\frontkernel',
  launcher: 'C:\\frontkernel\\bin\\frontkernel.mjs',
});

describe('FrontkernelAdapter·协议解析（注入执行器）', () => {
  it('解析 version 报告，并附上 --json', async () => {
    const { runner, calls } = fakeRunner([{ stdout: VERSION_JSON }]);
    const adapter = new FrontkernelAdapter(runner);
    const report = await adapter.version();
    expect(report.version).toBe('0.2.7');
    expect(calls[0]?.args).toEqual(['version', '--json']);
  });

  it('把 workspace 与 asset-root 透传给 check', async () => {
    const { runner, calls } = fakeRunner([{
      stdout: JSON.stringify({ format: 'frontkernel.cli-check@1', ok: true, sourceKind: 'author', source: 'main.svml' }),
    }]);
    const adapter = new FrontkernelAdapter(runner);
    await adapter.check('main.svml', { workspace: 'C:\\proj', assetRoot: 'C:\\assets' });
    expect(calls[0]?.args).toEqual(['check', 'main.svml', '--json', '--workspace', 'C:\\proj', '--asset-root', 'C:\\assets']);
  });

  it('check 能接住 Run Source 的 run/author/targets 形状，供全局构建门控使用', async () => {
    const { runner } = fakeRunner([{
      stdout: JSON.stringify({
        format: 'frontkernel.cli-check@1', ok: true, sourceKind: 'run',
        run: 'production/film.svrun', author: 'production/film.svml', targets: ['film'],
      }),
    }]);
    const report = await new FrontkernelAdapter(runner).check('production/film.svrun');
    expect(report.sourceKind).toBe('run');
    if (report.sourceKind === 'run') {
      expect(report.author).toBe('production/film.svml');
      expect(report.targets).toEqual(['film']);
    }
  });

  it('转录直接使用官方 transcribe，并透传语言、输出、Runtime 与 workspace', async () => {
    const { runner, calls } = fakeRunner([{
      stdout: JSON.stringify({
        format: 'frontkernel.video-cli-transcribe@1', source: 'C:\\proj\\ref.mp4', language: 'zh',
        audio_seconds: 12.5, extracted: true, passages: 2, words: 18, path: 'C:\\proj\\transcript.json',
      }),
    }]);
    const report = await new FrontkernelAdapter(runner).transcribe('C:\\proj\\ref.mp4', {
      to: 'C:\\proj\\transcript.json', language: 'zh', runtime: 'C:\\proj\\frontkernel.runtime.json', workspace: 'C:\\proj',
    });
    expect(report.words).toBe(18);
    expect(calls[0]?.args).toEqual([
      'transcribe', 'C:\\proj\\ref.mp4', '--to', 'C:\\proj\\transcript.json', '--language', 'zh', '--json',
      '--runtime', 'C:\\proj\\frontkernel.runtime.json', '--workspace', 'C:\\proj',
    ]);
  });

  it('响应 format 不符时抛契约漂移，而不是让字段静默变成 undefined', async () => {
    const { runner } = fakeRunner([{
      stdout: JSON.stringify({ format: 'frontkernel.cli-check@2', ok: true }),
    }]);
    const adapter = new FrontkernelAdapter(runner);
    await expect(adapter.check('main.svml')).rejects.toBeInstanceOf(FrontkernelContractDriftError);
    await expect(adapter.check('main.svml')).rejects.toThrow(/漂移|不符/);
  });

  it('上游结构化错误映射成带 code 的命令错误', async () => {
    const { runner } = fakeRunner([{
      code: 2,
      stdout: JSON.stringify({
        format: 'frontkernel.cli-error@1',
        ok: false,
        error: { code: 'RUN_SOURCE_REQUIRED', message: 'plan 需要 Run Source' },
      }),
    }]);
    const adapter = new FrontkernelAdapter(runner);
    const error = await adapter.plan('main.svml').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FrontkernelCommandError);
    expect((error as FrontkernelCommandError).code).toBe('RUN_SOURCE_REQUIRED');
    expect((error as FrontkernelCommandError).exitCode).toBe(2);
  });

  it('输出不是 JSON 时抛协议错误并保留 stderr', async () => {
    const { runner } = fakeRunner([{ code: 1, stdout: '', stderr: 'boom' }]);
    const adapter = new FrontkernelAdapter(runner);
    await expect(adapter.version()).rejects.toBeInstanceOf(FrontkernelProtocolError);
  });

  it('status 对不存在的构建返回 null，而不是抛错', async () => {
    const { runner } = fakeRunner([{
      code: 1,
      stdout: JSON.stringify({ format: 'frontkernel.cli-status@1', build: null }),
    }]);
    const adapter = new FrontkernelAdapter(runner);
    expect(await adapter.status('2026-09-19T00-00-00-abc')).toBeNull();
  });

  it('status 对存在的构建返回工作与结果状态', async () => {
    const { runner } = fakeRunner([{
      stdout: JSON.stringify({
        format: 'frontkernel.cli-status@1',
        build: { id: 'b-1', work: { state: 'working' }, result: { state: 'missing' } },
      }),
    }]);
    const adapter = new FrontkernelAdapter(runner);
    const status = await adapter.status('b-1');
    expect(status?.work.state).toBe('working');
  });
});

/**
 * 真实链路。
 *
 * 只跑「本地、不花钱、不需要账号」的命令：版本与 Source 校验。
 * 需要 Runtime Profile 的 plan/build 不在这里跑——它们会要求 Provider 配置，
 * 那是产品接入阶段的事，不该混进单元测试。
 */
function findDistribution(): string | null {
  try {
    const root = resolveFrontkernelDistribution();
    return existsSync(join(root, 'bin', 'frontkernel.mjs')) ? root : null;
  } catch {
    return null;
  }
}

const distribution = findDistribution();
const describeReal = distribution === null ? describe.skip : describe;

describeReal('FrontkernelAdapter·真实 CLI（本地无花费命令）', () => {
  const root = distribution as string;

  it('读取到真实发行版身份', async () => {
    const adapter = createFrontkernelAdapter({ distributionRoot: root, cwd: root, timeoutMs: 60_000 });
    const report = await adapter.version();
    expect(report.format).toBe('frontkernel.cli-version@1');
    expect(report.package).toBe('@frontkernel/frontkernel');
    expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.distribution.toLowerCase()).toBe(root.toLowerCase());
  }, 120_000);

  it('校验官方示例 Source 并拿到真实的结构统计', async () => {
    const adapter = createFrontkernelAdapter({ distributionRoot: root, cwd: root, timeoutMs: 120_000 });
    const sample = 'examples/interview/reference.svml';
    if (!existsSync(resolve(root, sample))) return;
    const report = await adapter.check(sample);
    expect(report.format).toBe('frontkernel.cli-check@1');
    expect(report.ok).toBe(true);
    expect(report.sourceKind).toBe('author');
    expect(report.frontend).toBe('@frontkernel/markup@1');
    expect(report.outputCount ?? 0).toBeGreaterThan(0);
  }, 180_000);

  it('校验一个不存在的文件会得到上游的结构化错误', async () => {
    const adapter = createFrontkernelAdapter({ distributionRoot: root, cwd: root, timeoutMs: 60_000 });
    const error = await adapter.check('examples/__not_here__.svml').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
  }, 120_000);
});
