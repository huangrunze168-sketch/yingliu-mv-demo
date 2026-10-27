import {
  FRONTKERNEL_FORMATS,
  type FrontkernelBuildResult,
  type FrontkernelBuildStatus,
  type FrontkernelBuildsReport,
  type FrontkernelCancelReport,
  type FrontkernelCheckReport,
  type FrontkernelErrorReport,
  type FrontkernelGetReport,
  type FrontkernelMediaBoundaries,
  type FrontkernelMediaFrames,
  type FrontkernelMediaProbe,
  type FrontkernelPlanReport,
  type FrontkernelTranscribeReport,
  type FrontkernelVersionReport,
} from './protocol.js';
import {
  FrontkernelCommandError,
  FrontkernelContractDriftError,
  FrontkernelProtocolError,
} from './errors.js';
import type { FrontkernelRunner } from './runner.js';

export interface FrontkernelAdapterOptions {
  /** 命令的工作目录。通常是视频项目目录；省略时用执行器默认值。 */
  cwd?: string;
  /** 普通命令超时（版本、校验、查询）。 */
  timeoutMs?: number;
  /** 长命令超时（build、get）。 */
  longTimeoutMs?: number;
}

export interface CheckOptions {
  workspace?: string;
  assetRoot?: string;
  /** 项目自身的包根目录；用于解析项目引用的 author package。 */
  packageRoot?: string;
}

export interface PlanOptions {
  runtime?: string;
  workspace?: string;
  /**
   * 项目自身的包根目录。
   * 或运行的是仓库内的示例 fixture 时，需要显式指定。
   */
  packageRoot?: string;
}

export interface BuildOptions {
  runtime?: string;
  workspace?: string;
  packageRoot?: string;
  title?: string;
  /** 跟随构建直到出结果；省略时提交后即返回。 */
  follow?: boolean;
  maxWaitMs?: number;
}

export interface StatusOptions {
  runtime?: string;
  workspace?: string;
}

export interface InspectOptions {
  workspace?: string;
  /** 只看某一个输出名。 */
  output?: string;
}

export interface ListBuildsOptions {
  workspace?: string;
  limit?: number;
  before?: string;
}

/**
 * 前置内核 官方 CLI 的稳定 DTO 门面。
 *
 * 依据 docs/前置内核-ADAPTER-SURFACE.md：产品层只通过这里接触 前置内核，
 */
export class FrontkernelAdapter {
  constructor(
    private readonly runner: FrontkernelRunner,
    private readonly options: FrontkernelAdapterOptions = {},
  ) {}

  /** 发行版身份。用于启动自检与状态展示，不打开项目或 Runtime。 */
  version(): Promise<FrontkernelVersionReport> {
    return this.call<FrontkernelVersionReport>(['version', '--json'], FRONTKERNEL_FORMATS.version);
  }

  /**
   * 校验一个 Source。
   *
   * 这是目前唯一完全本地、不花钱、不需要账号的 Source 级入口，
   * 因此也是「前置 agent 能不能用」的第一道自检。
   */
  check(sourcePath: string, options: CheckOptions = {}): Promise<FrontkernelCheckReport> {
    return this.call<FrontkernelCheckReport>(
      [
        'check', sourcePath, '--json',
        ...this.packageArgs(options.packageRoot),
        ...this.workspaceArgs(options.workspace, options.assetRoot),
      ],
      FRONTKERNEL_FORMATS.check,
    );
  }

  /** 规划一个 Run：解析目标、能力与 Provider 绑定，不做任何提交。 */
  plan(runPath: string, options: PlanOptions = {}): Promise<FrontkernelPlanReport> {
    return this.call<FrontkernelPlanReport>(
      [
        'plan', runPath, '--json',
        ...this.runtimeArgs(options.runtime),
        ...this.packageArgs(options.packageRoot),
        ...this.workspaceArgs(options.workspace),
      ],
      FRONTKERNEL_FORMATS.plan,
    );
  }

  /** 提交一次构建。省略 follow 时提交后即返回，由后台 Worker 继续。 */
  async build(runPath: string, options: BuildOptions = {}): Promise<FrontkernelBuildStatus> {
    const args = ['build', runPath, '--json'];
    if (options.follow) args.push('--follow');
    if (options.maxWaitMs !== undefined) args.push('--max-wait-ms', String(options.maxWaitMs));
    if (options.title !== undefined) args.push('--title', options.title);
    args.push(
      ...this.runtimeArgs(options.runtime),
      ...this.packageArgs(options.packageRoot),
      ...this.workspaceArgs(options.workspace),
    );
    const report = await this.call<{ build: FrontkernelBuildStatus }>(args, FRONTKERNEL_FORMATS.build, { long: true });
    return report.build;
  }

  /**
   * 读取构建的持久状态。
   *
   * 返回 null 表示「这个 build id 不存在」，与「存在但状态未知」是两件事：
   * 前者说明调用方拿错了 id，后者说明对账还没完成。
   */
  async status(buildId: string, options: StatusOptions = {}): Promise<FrontkernelBuildStatus | null> {
    const args = ['status', buildId, '--json', ...this.runtimeArgs(options.runtime), ...this.workspaceArgs(options.workspace)];
    const outcome = await this.callTolerant(args);
    if (outcome.payload === null) {
      if (outcome.code !== 0) throw this.toProtocolError(args, outcome);
      return null;
    }
    if (isErrorReport(outcome.payload)) {
      if (outcome.code === 0) return null;
      throw this.toCommandError(outcome.payload, outcome.code);
    }
    assertFormat(outcome.payload, FRONTKERNEL_FORMATS.status, args);
    const build = (outcome.payload as { build?: unknown }).build;
    return (build ?? null) as FrontkernelBuildStatus | null;
  }

  /** 读取一个已结束构建的结果清单（输出名、类型、大小等）。 */
  async inspect(buildId: string, options: InspectOptions = {}): Promise<FrontkernelBuildResult> {
    const args = ['inspect', buildId, '--json'];
    if (options.output !== undefined) args.push('--output', options.output);
    args.push(...this.workspaceArgs(options.workspace));
    const report = await this.call<{ build: FrontkernelBuildResult }>(args, FRONTKERNEL_FORMATS.inspect);
    return report.build;
  }

  /**
   * 请求取消。
   *
   * requested 只表示停止请求已送达，不代表远端已经取消——
   */
  cancel(buildId: string, options: { reason?: string; runtime?: string; workspace?: string } = {}): Promise<FrontkernelCancelReport> {
    const args = ['cancel', buildId, '--json'];
    if (options.reason !== undefined) args.push('--reason', options.reason);
    args.push(...this.runtimeArgs(options.runtime), ...this.workspaceArgs(options.workspace));
    return this.call<FrontkernelCancelReport>(args, FRONTKERNEL_FORMATS.cancel);
  }

  /** 浏览本项目的构建结果（新的在前）。 */
  listBuilds(options: ListBuildsOptions = {}): Promise<FrontkernelBuildsReport> {
    const args = ['builds', '--json'];
    if (options.limit !== undefined) args.push('--limit', String(options.limit));
    if (options.before !== undefined) args.push('--before', options.before);
    args.push(...this.workspaceArgs(options.workspace));
    return this.call<FrontkernelBuildsReport>(args, FRONTKERNEL_FORMATS.builds);
  }

  /**
   * 取出一个输出到指定路径。
   *
   * 标量写成 JSON、资源流式落成单个文件、复合输出落成自包含目录；
   */
  getOutput(buildId: string, outputName: string, toPath: string, options: { workspace?: string } = {}): Promise<FrontkernelGetReport> {
    return this.call<FrontkernelGetReport>(
      ['get', buildId, '--output', outputName, '--to', toPath, '--json', ...this.workspaceArgs(options.workspace)],
      FRONTKERNEL_FORMATS.get,
      { long: true },
    );
  }

  /* ---------------- 媒体分析（本地、不花钱） ----------------
     这三个命令是「参考视频 → 可编辑拆解」这条主线的起点：
     probe 给媒体事实，boundaries 给镜头候选，frames 给可跳回的帧证据。 */

  /** 媒体探测：时长、分辨率、帧率、是否有音轨。 */
  mediaProbe(mediaPath: string): Promise<FrontkernelMediaProbe> {
    return this.callShaped<FrontkernelMediaProbe>(
      ['media', 'probe', mediaPath, '--json'],
      ['path', 'duration', 'hasVideo', 'hasAudio'],
    );
  }

  /**
   * 镜头边界候选。
   *
   * 产品侧也照此理解：这些是候选，不是既成事实。
   */
  mediaBoundaries(mediaPath: string): Promise<FrontkernelMediaBoundaries> {
    return this.callShaped<FrontkernelMediaBoundaries>(
      ['media', 'boundaries', mediaPath, '--json'],
      ['path', 'candidates'],
    );
  }

  /** 按时间点抽帧；产出的 JPEG 就是每个镜头结论的帧证据。 */
  mediaFrames(
    mediaPath: string,
    options: { at: readonly number[]; to: string; labelTime?: boolean },
  ): Promise<FrontkernelMediaFrames> {
    const args = ['media', 'frames', mediaPath, '--at', options.at.join(','), '--to', options.to];
    if (options.labelTime) args.push('--label-time');
    args.push('--json');
    return this.callShaped<FrontkernelMediaFrames>(args, ['directory', 'frames']);
  }

  /**
   * 通过 Runtime Profile 选择的 WhisperX Endpoint 生成词级时间戳。
   *
   * 这是 前置内核 官方 creation tool：一次直接请求，不创建 Build；是否收费取决于 Profile
   * 绑定的 Endpoint，因此调用层必须在界面上明确服务与费用，适配器不替用户选 Provider。
   */
  transcribe(
    mediaPath: string,
    options: { to: string; language: string; runtime?: string; workspace?: string },
  ): Promise<FrontkernelTranscribeReport> {
    return this.call<FrontkernelTranscribeReport>([
      'transcribe', mediaPath,
      '--to', options.to,
      '--language', options.language,
      '--json',
      ...this.runtimeArgs(options.runtime),
      ...this.workspaceArgs(options.workspace),
    ], FRONTKERNEL_FORMATS.transcribe, { long: true });
  }

  private runtimeArgs(runtime?: string): string[] {
    return runtime === undefined ? [] : ['--runtime', runtime];
  }

  private workspaceArgs(workspace?: string, assetRoot?: string): string[] {
    const args: string[] = [];
    if (workspace !== undefined) args.push('--workspace', workspace);
    if (assetRoot !== undefined) args.push('--asset-root', assetRoot);
    return args;
  }

  private packageArgs(packageRoot?: string): string[] {
    return packageRoot === undefined ? [] : ['--package-root', packageRoot];
  }

  private async call<T>(
    args: readonly string[],
    expectedFormat: string,
    options: { long?: boolean } = {},
  ): Promise<T> {
    const outcome = await this.callTolerant(args, options);
    if (outcome.payload === null) throw this.toProtocolError(args, outcome);
    if (isErrorReport(outcome.payload)) throw this.toCommandError(outcome.payload, outcome.code);
    if (outcome.code !== 0) {
      throw new FrontkernelCommandError(
        `frontkernel ${args[0]} 以退出码 ${outcome.code} 结束且未给出结构化错误`,
        'FRONTKERNEL_EXIT_NONZERO',
        outcome.code,
      );
    }
    assertFormat(outcome.payload, expectedFormat, args);
    return outcome.payload as T;
  }

  private async callTolerant(
    args: readonly string[],
    options: { long?: boolean } = {},
  ): Promise<{ code: number; payload: Record<string, unknown> | null; stderr: string }> {
    const timeoutMs = options.long
      ? this.options.longTimeoutMs ?? 900_000
      : this.options.timeoutMs ?? 120_000;
    const result = await this.runner.run({
      args,
      timeoutMs,
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
    });
    return { code: result.code, payload: tryParseJson(result.stdout), stderr: result.stderr };
  }

  /**
   * 供没有 format 标识的命令使用：校验必需字段是否齐全。
   *
   * media 系列的输出不带版本化格式标识，因此无法用 format 判定漂移。
   * 退而求其次：只要本适配器依赖的字段还在，就认为可以继续；
   * 一旦缺字段，立刻按契约漂移处理，而不是让调用方拿到一堆 undefined。
   */
  private async callShaped<T>(
    args: readonly string[],
    requiredKeys: readonly string[],
    options: { long?: boolean } = {},
  ): Promise<T> {
    const outcome = await this.callTolerant(args, options);
    if (outcome.payload === null) throw this.toProtocolError(args, outcome);
    if (isErrorReport(outcome.payload)) throw this.toCommandError(outcome.payload, outcome.code);
    if (outcome.code !== 0) {
      throw new FrontkernelCommandError(
        `frontkernel ${args[0]} ${args[1] ?? ''} 以退出码 ${outcome.code} 结束且未给出结构化错误`,
        'FRONTKERNEL_EXIT_NONZERO',
        outcome.code,
      );
    }
    const missing = requiredKeys.filter((key) => outcome.payload?.[key] === undefined);
    if (missing.length > 0) {
      throw new FrontkernelContractDriftError(
        `frontkernel ${args[0]} ${args[1] ?? ''} 的输出缺少必需字段：${missing.join('、')}`,
        `required:${requiredKeys.join(',')}`,
        Object.keys(outcome.payload ?? {}).join(','),
      );
    }
    return outcome.payload as T;
  }

  private toProtocolError(
    args: readonly string[],
    outcome: { code: number; stderr: string },
  ): FrontkernelProtocolError {
    const detail = outcome.stderr.trim().slice(0, 500);
    return new FrontkernelProtocolError(
      `frontkernel ${args[0]} 未返回可解析的 JSON（退出码 ${outcome.code}）${detail ? `：${detail}` : ''}`,
      { args, code: outcome.code, stderr: detail },
    );
  }

  private toCommandError(report: FrontkernelErrorReport, exitCode: number): FrontkernelCommandError {
    return new FrontkernelCommandError(report.error.message, report.error.code, exitCode, report.error.help);
  }
}

/**
 * 校验响应格式。
 *
 * 但只要它连 format 都换了，就必须当场失败，
 * 而不是让后续字段静默变成 undefined。
 */
function assertFormat(payload: Record<string, unknown>, expectedFormat: string, args: readonly string[]): void {
  const actual = payload.format;
  if (actual !== expectedFormat) {
    throw new FrontkernelContractDriftError(
      `frontkernel ${args[0]} 的响应格式与适配器假设不符：期望 ${expectedFormat}，实际 ${String(actual)}`,
      expectedFormat,
      actual,
    );
  }
}

function isErrorReport(payload: Record<string, unknown>): payload is Record<string, unknown> & FrontkernelErrorReport {
  return payload.format === FRONTKERNEL_FORMATS.error;
}

/** CLI 保证 --json 输出为单个 JSON 文档；这里只容忍 BOM 与首尾空白。 */
function tryParseJson(stdout: string): Record<string, unknown> | null {
  const text = stdout.replace(/^\uFEFF/, '').trim();
  if (text.length === 0) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
