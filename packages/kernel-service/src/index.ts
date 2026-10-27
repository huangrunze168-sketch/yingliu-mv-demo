import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ProjectService } from '@qiyin/domain';
import {
  FrontkernelCommandError,
  FrontkernelContractDriftError,
  FrontkernelNotInstalledError,
  FrontkernelProtocolError,
  type FrontkernelAdapter,
  type FrontkernelBuildResult,
  type FrontkernelBuildStatus,
  type FrontkernelCheckReport,
  type FrontkernelGetReport,
  type FrontkernelMediaBoundaries,
  type FrontkernelMediaBoundaryCandidate,
  type FrontkernelMediaProbe,
  type FrontkernelPlanReport,
  type FrontkernelTranscript,
  type FrontkernelTranscribeReport,
} from '@qiyin/frontkernel-adapter';
import {
  buildAuthorSource,
  buildRunSource,
  buildStyleSheet,
  transitionFramesFor,
  totalDurationMs,
  type FilmCanvas,
  type FilmShot,
} from './film-source.js';

export * from './film-source.js';
export * from './eval.js';
export * from './repair.js';
export * from './repair-execute.js';
export * from './loudness.js';
export * from './filmstrip.js';
export * from './audio-extract.js';
export * from './compose-clips.js';
export * from './video-pipeline.js';
export * from './video-hd.js';
export * from './export-film.js';
export * from './voice-over.js';
export * from './source-separation.js';
export * from './frame-extract.js';
export * from './element-compose.js';
import { buildEvalReport, type ShotExpectation } from './eval.js';
import { proposeRepairPlan } from './repair.js';
import { audible, measureLoudness } from './loudness.js';
import { FILMSTRIP_DEFAULT_FRAMES, planFrameTimes } from './filmstrip.js';
import { audioOutputRelativePath, canExtractAudio, extractAudioTrack } from './audio-extract.js';
import type { EvalReport } from '@qiyin/contracts';
import type { RepairPlan } from '@qiyin/contracts';
import type { FilmTransition, TransitionDirection } from '@qiyin/contracts';

/**
 * 确保项目 workspace 里有一份可用的 Runtime Profile。
 *
 * 用户不该关心 Runtime Profile 是什么——那是内核的部署细节。
 * 这份配置选择本地 HyperFrames 与 FFmpeg，不涉及任何生成账号，
 * 因此「成片」这一步在任何环境都可用。已存在时不覆盖，便于用户自行替换。
 */
export function ensureRuntimeProfileFile(workspaceDir: string): string {
  const file = join(workspaceDir, 'frontkernel.runtime.json');
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify({
      format: 'frontkernel.runtime-local@1',
      dataRoot: '.frontkernel/runtimes/local',
      endpoints: {
        'media.local': { use: '@frontkernel/provider-media-local', config: { defaultConcurrency: 2 } },
        'hyperframes.local': { use: '@frontkernel/provider-hyperframes-local', config: { workers: 2, defaultConcurrency: 1 } },
      },
    }, null, 2)}\n`, 'utf8');
  }
  return file;
}

/* ============================================================
   期音科技 · 内核服务（前置内核 前置 agent）
   ------------------------------------------------------------
   这一层把两件本来分开的事串起来：

     ProjectService（领域层）  —— 只认事实：谁在什么时候请求了什么、结果是什么
     前置内核Adapter（适配层）    —— 只认进程：把 --json 调用结果翻译成 DTO

   顺序是刻意的：**先登记意图，再执行，最后回填**。
   如果反过来（先执行再登记），内核或界面中途崩掉时这次动作就等于没发生过，
   重启后既没有记录也没有线索，只能靠人回忆。
   ============================================================ */

export interface KernelTaskRequest {
  projectId: string;
  /** 调用方看到的项目修订号，用于 CAS——避免把结果回填到已经前进的项目上。 */
  expectedRevision: number;
  /** 项目内的相对路径。绝对路径会被领域层拒绝。 */
  sourcePath: string;
  /** 该项目在磁盘上的目录，作为内核的工作目录与 workspace 边界。 */
  workspaceDir: string;
  /**/
  packageRoot?: string;
  /** plan 与 build 必须读取同一份 Runtime Profile，避免门控与执行解析出不同 Provider。 */
  runtimeProfile?: string;
  purpose?: string;
  actor?: string;
}

/** 分析不走 Source 路径，而是参考视频路径。 */
export type KernelAnalyzeRequest = Omit<KernelTaskRequest, 'sourcePath'> & { mediaPath: string };

/** 逐词转录：语言必须显式给出，Provider 与费用由 Runtime Profile 决定。 */
export type KernelTranscribeRequest = KernelAnalyzeRequest & {
  language: string;
  /** 仅确认本次 Provider 调用授权，不代表预算账本或费用上限已经实现。 */
  executionConfirmed: boolean;
};

export interface KernelTaskOutcome<R> {
  /** 内核是否成功执行（不代表校验通过或规划可行）。 */
  executed: boolean;
  taskId: string;
  projectRevision: number;
  /** 执行成功时存在。 */
  report?: R;
  /** 执行失败时存在，可直接展示给用户。 */
  failure?: string;
  /** 便于界面区分「内核没装」与「输入有问题」这两类截然不同的处置。 */
  failureKind?: 'not-installed' | 'contract-drift' | 'command' | 'protocol' | 'unknown';
}

export type KernelCheckOutcome = KernelTaskOutcome<FrontkernelCheckReport>;

/**
 * 规划结果里额外暴露两个领域关心的量。
 *
 * `ok` 表示规划本身是否成立；`requestCount` 是这次 Run 会向 Provider 发出的
 * 能力请求数——它是「这个方案大概要花多少外部调用」的第一手依据。
 */
export type KernelPlanOutcome = KernelTaskOutcome<FrontkernelPlanReport>;

/**
 * 全局构建前置门控。
 *
 * 任何入口只要最终走到 `submitBuild()`，都必须先依次通过 check → plan；
 * 桌面端、CLI、本地 API 与 Agent 不再各自决定要不要做前置检查。
 */
export interface KernelBuildPreflight {
  status: 'passed' | 'blocked';
  check: KernelCheckOutcome;
  plan?: KernelPlanOutcome;
  blockedAt?: 'check' | 'plan';
  message?: string;
}

/** 构建提交结果：同时带回不可绕过的前置门控证据。 */
export type KernelBuildOutcome = KernelTaskOutcome<FrontkernelBuildStatus> & {
  preflight: KernelBuildPreflight;
};

/** 参考视频分析结果：媒体事实 + 镜头边界候选。 */
export interface SourceAnalysisReport {
  probe: FrontkernelMediaProbe;
  boundaries: FrontkernelMediaBoundaries;
}

export type KernelAnalyzeOutcome = KernelTaskOutcome<SourceAnalysisReport>;

/** 转录摘要与真实逐词结果；全文同时落在 workspace 的 transcripts/ 下。 */
export interface SourceTranscriptionReport {
  command: FrontkernelTranscribeReport;
  transcript: FrontkernelTranscript;
  transcriptRelativePath: string;
}

export type KernelTranscribeOutcome = KernelTaskOutcome<SourceTranscriptionReport>;

export interface ShotRange {
  t0_ms: number;
  t1_ms: number;
}

/** 一个由参考视频抽出的首帧候选。 */
export interface ShotCandidateRef {
  shot_id: string;
  candidate_id: string;
  artifact_id: string;
  /** 抽出的帧文件绝对路径；仅服务层返回，不进入领域事实。 */
  frame_path: string;
  /** 实际取到的帧时间点（秒）。 */
  at_seconds: number;
}

export class KernelService {
  constructor(
    private readonly projects: ProjectService,
    private readonly frontkernel: FrontkernelAdapter,
  ) {}

  /**
   * 校验一个 Source（通常是 `*.svml`）。
   *
   * 这是目前完全本地、不花钱、不需要账号的能力，也是「前置 agent 通不通」的第一道自检。
   */
  checkSource(request: KernelTaskRequest): Promise<KernelCheckOutcome> {
    /**
     * 产品层的 sourcePath 一律相对于 workspace；内核那边要用真实磁盘路径。
     * 这层换算只在这里发生——领域事实里存相对路径（可迁移），内核看到绝对路径（可用）。
     */
    return this.runTask('check', request, request.sourcePath, () => this.frontkernel.check(join(request.workspaceDir, request.sourcePath), {
      workspace: request.workspaceDir,
      ...(request.packageRoot === undefined ? {} : { packageRoot: request.packageRoot }),
    }));
  }

  /**
   * 规划一个 Run（通常是 `*.svrun`）。
   *
   * 规划解析出目标、能力需求与 Provider 绑定，但**不提交任何执行**——
   * 因此它同样不花钱、不需要账号，却能让用户在掏钱之前看清这次复刻要动用什么能力。
   */
  planRun(request: KernelTaskRequest): Promise<KernelPlanOutcome> {
    return this.runTask('plan', request, request.sourcePath, () => this.frontkernel.plan(join(request.workspaceDir, request.sourcePath), {
      workspace: request.workspaceDir,
      ...(request.packageRoot === undefined ? {} : { packageRoot: request.packageRoot }),
      ...(request.runtimeProfile === undefined ? {} : { runtime: resolveRuntime(request.workspaceDir, request.runtimeProfile) }),
    }));
  }

  /**
   * 构建的全局前置 Agent 门控：严格按 check → plan 执行。
   *
   * 两步都会作为正式 kernel task 写进项目事实；任一步执行失败或报告 `ok !== true`，
   * 后面的步骤都不会发生。调用方因此既能展示失败原因，也能审计「为什么没提交 build」。
   */
  async preflightBuild(request: KernelTaskRequest): Promise<KernelBuildPreflight> {
    const check = await this.checkSource({
      ...request,
      purpose: request.purpose === undefined ? '全局构建前置门控·check' : `${request.purpose}·前置 check`,
    });
    if (!check.executed || check.report?.ok !== true) {
      const message = check.failure
        ?? check.report?.diagnostics?.map((item) => item.message).filter(Boolean).join('；')
        ?? '前置内核 check 未通过';
      return { status: 'blocked', check, blockedAt: 'check', message };
    }

    const plan = await this.planRun({
      ...request,
      expectedRevision: check.projectRevision,
      purpose: request.purpose === undefined ? '全局构建前置门控·plan' : `${request.purpose}·前置 plan`,
    });
    const unresolvedProviders = plan.report?.providers?.filter((provider) => provider.status !== 'resolved') ?? [];
    if (!plan.executed || plan.report?.ok !== true || unresolvedProviders.length > 0) {
      const providerMessage = unresolvedProviders.length === 0 ? undefined : unresolvedProviders
        .map((provider) => `${provider.capability}=${provider.status}`)
        .join('、');
      const message = plan.failure
        ?? providerMessage
        ?? plan.report?.diagnostics?.map((item) => item.message).filter(Boolean).join('；')
        ?? '前置内核 plan 未通过';
      return { status: 'blocked', check, plan, blockedAt: 'plan', message };
    }

    return { status: 'passed', check, plan };
  }

  /**
   * 提交一次构建。
   *
   * `submitBuild()` 是桌面端、CLI、本地 API 与 Agent 的共同收口点；这里强制执行
   * `preflightBuild()`，因此没有任何一个上层入口能直接越过 check → plan 提交付费或长时任务。
   *
   * `runtimeProfile` 传的是 Profile 文件路径（项目内的相对路径）。
   */
  async submitBuild(request: KernelTaskRequest & { follow?: boolean }): Promise<KernelBuildOutcome> {
    const preflight = await this.preflightBuild(request);
    if (preflight.status === 'blocked') {
      const blocker = preflight.blockedAt === 'plan' ? preflight.plan! : preflight.check;
      return {
        executed: false,
        taskId: blocker.taskId,
        projectRevision: blocker.projectRevision,
        failure: `全局前置 Agent 门控在 ${preflight.blockedAt} 阶段阻止构建：${preflight.message ?? '未通过'}`,
        failureKind: blocker.failureKind ?? 'command',
        preflight,
      };
    }

    const build = await this.runTask('build', {
      ...request,
      expectedRevision: preflight.plan!.projectRevision,
    }, request.sourcePath, () => this.frontkernel.build(join(request.workspaceDir, request.sourcePath), {
      workspace: request.workspaceDir,
      ...(request.packageRoot === undefined ? {} : { packageRoot: request.packageRoot }),
      ...(request.runtimeProfile === undefined ? {} : { runtime: resolveRuntime(request.workspaceDir, request.runtimeProfile) }),
      ...(request.follow === undefined ? {} : { follow: request.follow }),
    }));
    return { ...build, preflight };
  }

  /**
   * 分析参考视频：媒体探测 + 镜头边界候选。
   *
   * 两个命令都是本地的，不花钱、不需要账号，因此「看片」这一步永远可用。
   */
  analyzeSource(request: KernelAnalyzeRequest): Promise<KernelAnalyzeOutcome> {
    return this.runTask('analyze', request, request.mediaPath, async () => {
      /**
       * 产品层一律用「相对 workspace 的路径」，内核那边要用真实磁盘路径。
       * 这层翻译只在这里发生：领域事实里存的是相对路径（可迁移），
       * 内核看到的是绝对路径（可用），两者不互相污染。
       */
      const absolute = resolveWorkspacePath(request.workspaceDir, request.mediaPath);
      // media 系列不接受 --workspace（实测），路径必须直接给绝对路径
      const probe = await this.frontkernel.mediaProbe(absolute);
      const boundaries = await this.frontkernel.mediaBoundaries(absolute);
      return { probe, boundaries };
    });
  }

  /**
   * 用 前置内核 官方 `transcribe` 为参考音视频生成逐词时间戳。
   *
   * 本方法不替用户选择或准备 Provider：Runtime Profile 可以绑定本地 WhisperX、HypiHub
   * 或其它兼容 Endpoint，费用也由该 Endpoint 决定。输出既写入项目目录，也作为任务报告
   * 回填，保证 Agent、CLI、API 与桌面端看到同一份可审计结果。
   */
  transcribeSource(request: KernelTranscribeRequest): Promise<KernelTranscribeOutcome> {
    if (request.executionConfirmed !== true) throw new Error('转录需要显式确认本次执行授权');
    const language = typeof request.language === 'string' ? request.language.trim().toLowerCase() : '';
    if (!/^[a-z]{2,3}$/u.test(language)) {
      throw new Error(`转录语言必须是两到三位小写语言代码，收到 ${request.language}`);
    }
    const root = realpathSync(request.workspaceDir);
    const absolute = checkedTranscribePath(root, request.mediaPath);
    if (!statSync(absolute).isFile()) throw new Error('转录源必须是普通文件');
    const sourcePath = relative(root, absolute).replaceAll('\\', '/');
    const directory = checkedTranscribePath(root, 'transcripts', true);
    return this.runTask('transcribe', request, sourcePath, async () => {
      mkdirSync(directory, { recursive: true });
      checkedTranscribePath(root, 'transcripts');
      const outputDir = mkdtempSync(join(directory, 'transcribe-'));
      const destination = join(outputDir, 'transcript.json');
      const transcriptRelativePath = relative(root, destination).replaceAll('\\', '/');
      const command = await this.frontkernel.transcribe(absolute, {
        to: destination,
        language,
        workspace: root,
        ...(request.runtimeProfile === undefined ? {} : { runtime: resolveRuntime(root, request.runtimeProfile) }),
      });
      checkedTranscribePath(root, transcriptRelativePath);
      if (!statSync(destination).isFile()) throw new Error('转录输出必须是普通文件');
      const transcript = parseFrontkernelTranscript(readFileSync(destination, 'utf8'));
      transcript.source = sourcePath;
      // 官方输出 source 为绝对路径；落盘与任务报告统一使用可迁移的相对路径。
      writeFileSync(destination, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
      return {
        command: {
          format: command.format, source: sourcePath, path: transcriptRelativePath,
          language: transcript.language, audio_seconds: transcript.audio_seconds,
          extracted: command.extracted, passages: transcript.passages.length,
          words: transcript.passages.reduce((count, passage) => count + passage.words.length, 0),
          ...safeTranscribeProvider(command),
        },
        transcript,
        transcriptRelativePath,
      };
    });
  }

  /**
   * 分析并直接播种拆解草稿：一条命令走完 S1 → S2。
   *
   * 只有分析真正成功、且确实切出了区间才会写字段表——分析失败时不应该
   * 留下一个空壳拆解，让人误以为「已经拆过了」。
   */
  async analyzeAndSeed(request: KernelAnalyzeRequest): Promise<{
    analysis: KernelAnalyzeOutcome;
    seeded: { fieldsRevision: number; shotCount: number } | null;
  }> {
    const analysis = await this.analyzeSource(request);
    if (!analysis.executed || !analysis.report) return { analysis, seeded: null };

    const ranges = boundariesToShotRanges(
      analysis.report.boundaries.candidates,
      analysis.report.probe.duration,
    );
    if (ranges.length === 0) return { analysis, seeded: null };

    const seeded = this.projects.execute({
      command_id: crypto.randomUUID(),
      actor: request.actor ?? 'user:local',
      type: 'shot-fields.seed',
      project_id: request.projectId,
      expected_revision: analysis.projectRevision,
      payload: { breakdown_revision: 1, boundaries: ranges },
    });
    const payload = seeded.payload as { fields_revision: number; shot_count: number };
    return {
      analysis,
      seeded: { fieldsRevision: payload.fields_revision, shotCount: payload.shot_count },
    };
  }

  /**
   * 从参考视频抽出每个镜头的首帧，登记为图片候选。
   *
   * 为什么用参考视频的帧而不是生成图：复刻的语义起点就是「参考片里那个镜头」，
   * 而抽帧完全本地、不花钱、不需要账号——这让 G2 在还没接入付费 Provider 时
   * 也能真正走通，而不是卡在一个迟早要花钱的按钮上。
   *
   * 候选按内容哈希入库：同一张帧重复抽出会得到同一个 artifact_id，
   * 内容寻址天然去重；candidate_id 则带批次号，重复抽帧不会被当成重复提交拒掉。
   */
  async extractShotCandidates(request: {
    projectId: string;
    expectedRevision: number;
    mediaPath: string;
    workspaceDir: string;
    /** 要抽帧的镜头；通常直接来自当前字段表。 */
    shots: ReadonlyArray<{ shot_id: string; t0_ms: number }>;
    actor?: string;
  }): Promise<{ candidates: ShotCandidateRef[]; projectRevision: number }> {
    const actor = request.actor ?? 'user:local';
    if (request.shots.length === 0) return { candidates: [], projectRevision: request.expectedRevision };

    const absolute = join(request.workspaceDir, request.mediaPath);
    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = join(request.workspaceDir, 'frames', batchId);
    const extracted = await this.frontkernel.mediaFrames(absolute, {
      at: request.shots.map((shot) => shot.t0_ms / 1000),
      to: outputDir,
    });

    const candidates: ShotCandidateRef[] = [];
    let revision = request.expectedRevision;
    for (const shot of request.shots) {
      const frame = pickFrameAt(extracted.frames, shot.t0_ms);
      if (!frame) continue;

      const bytes = readFileSync(frame.path);
      const artifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'artifact.publish',
        payload: {
          artifact_id: artifactId,
          media_type: 'image/jpeg',
          bytes: statSync(frame.path).size,
          metadata: {
            source: 'reference-frame',
            /*
              抽帧同样会"同内容二次发布、落点换批次目录"（见 project-service 里
              onArtifactSuperseded 的说明）。主进程那个删旧文件的钩子靠这个键定位项目
              ——`artifact.publish` 是**全局**命令，命令上根本没有 project_id 这个字段，
              所以只能写在 metadata 里（生成类产物也是这么做的）。
            */
            project_id: request.projectId,
            shot_id: shot.shot_id,
            at_seconds: frame.at,
            /**
             * 帧文件相对 workspace 的路径。
             *
             * 存相对路径而不是绝对路径：领域事实必须能跟着项目迁移，
             * 而这张映射一旦只活在内存里，进程重启（或换 CLI 跑）就彻底丢了——
             * 成片会因此报「首帧不在本次会话中」，用户在界面上完全无从理解。
             */
            frame_path_relative: relative(request.workspaceDir, frame.path).split('\\').join('/'),
          },
        },
      });

      const candidateId = `cand-${shot.shot_id}-${batchId}`;
      const added = this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'image-candidate.add',
        project_id: request.projectId,
        expected_revision: revision,
        payload: { shot_id: shot.shot_id, candidate_id: candidateId, artifact_id: artifactId },
      });
      revision = added.project_revision ?? revision + 1;
      candidates.push({
        shot_id: shot.shot_id,
        candidate_id: candidateId,
        artifact_id: artifactId,
        frame_path: frame.path,
        at_seconds: frame.at,
      });
    }
    return { candidates, projectRevision: revision };
  }

  /**
   * 逐帧拉片：把一段素材摊开成若干帧，落成可引用的产物。
   *
   * 与 `extractShotCandidates` 的区别不是"都是抽帧所以合并"：
   *   · 那个是**为选帧服务**的——每镜抽一帧、登记成候选、参与 G2 的判定；
   *   · 这个是**给人看**的——按整段均分抽一屏、登记成产物、不参与任何闸门。
   * 混成一个方法的话，调用方要么多传一堆用不上的参数，要么把候选和拉片帧
   * 混在同一个列表里，最后分不清哪张该被当成"这一镜的首帧"。
   *
   * 帧**登记为产物**（内容寻址 + 记下 workspace 相对路径），因此：
   * 资产页看得到、重开应用还在、以后想拿某一帧去生成也引用得到。
   */
  async extractFilmstrip(request: {
    projectId: string;
    expectedRevision: number;
    workspaceDir: string;
    mediaPath: string;
    /** 抽几帧；不给就用默认值。给了 `at` 时它被忽略。 */
    count?: number;
    /** 直接指定时间点（秒）。留空则按整段时长均分。 */
    at?: readonly number[];
    actor?: string;
  }): Promise<{
    frames: Array<{ artifact_id: string; at_seconds: number; requested_at_seconds: number; relative_path: string }>;
    durationSeconds: number;
    times: number[];
    projectRevision: number;
  }> {
    const actor = request.actor ?? 'user:local';
    const absolute = join(request.workspaceDir, request.mediaPath);
    const probe = await this.frontkernel.mediaProbe(absolute);

    /*
      时间点来源有两条：显式给的、或按时长均分的。
      显式那条不校验是否超出时长——越界时内核自己会报"取不到帧"，
      那句错误比我们在这里编一句"时间点非法"更接近真实原因。
    */
    const times = (request.at ?? planFrameTimes({
      durationSeconds: probe.duration,
      count: request.count ?? FILMSTRIP_DEFAULT_FRAMES,
    })).map((value) => Number(value));
    if (times.length === 0) {
      return { frames: [], durationSeconds: probe.duration, times: [], projectRevision: request.expectedRevision };
    }

    /**/
    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = join(request.workspaceDir, 'frames', `filmstrip-${batchId}`);
    const extracted = await this.frontkernel.mediaFrames(absolute, { at: times, to: outputDir });

    const frames: Array<{ artifact_id: string; at_seconds: number; requested_at_seconds: number; relative_path: string }> = [];
    for (const time of times) {
      /*
        这里**不能用 `pickFrameAt`**：那个函数收的是毫秒（`extractShotCandidates`
        传的是 `shot.t0_ms`），而这里的时间点来自 `planFrameTimes`、单位是秒。
        第一版直接复用了它，于是每次比较都差了 1000 倍——帧一张也没匹配上，
        上层拿到的是一个空数组，而且没有任何报错。抽帧跑了、时间点也对，
        就是"结果为空"，比抛异常难查得多。

      */
      const frame = extracted.frames.find((item) => Math.abs(item.requestedAt - time) < 1e-6) ?? null;
      if (!frame) continue;
      const bytes = readFileSync(frame.path);
      const artifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const relativePath = relative(request.workspaceDir, frame.path).split('\\').join('/');
      this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'artifact.publish',
        payload: {
          artifact_id: artifactId,
          media_type: 'image/jpeg',
          bytes: statSync(frame.path).size,
          metadata: {
            source: 'filmstrip',
            /*
              `project_id` 必须记：artifacts 是全局的（主键是内容哈希），
              "这份产物属于哪个项目"只能靠 metadata 表达，资产页那条查询按项目走。
            */
            project_id: request.projectId,
            at_seconds: frame.at,
            artifact_path_relative: relativePath,
          },
        },
      });
      frames.push({
        artifact_id: artifactId,
        at_seconds: frame.at,
        requested_at_seconds: time,
        relative_path: relativePath,
      });
    }
    /*
      拉片**不推进项目 revision**：它没有改任何项目事实（没有候选、没有闸门、没有预算），
      只是往 workspace 里多了一批可引用的产物。推进 revision 会让所有面板
      跟着重取一遍快照，而这次操作在领域上什么也没改变。
    */
    return {
      frames,
      durationSeconds: probe.duration,
      times,
      projectRevision: request.expectedRevision,
    };
  }

  /**
   * 音视频分离：把一段素材的声音拆成独立产物。

   * 与拉片一样属于"本机加工"：不花钱、不改项目事实（不推进 revision），
   * 只在 workspace 里多一份可引用的产物。
   *
   * 返回 union 而不是抛异常：`ok: false` 时那句 reason 是要**直接显示给用户**的
   * （"这条素材里没有音轨"）。抛异常的话，它会在 IPC 边界被统一成
   * 一句"内部错误"，恰好把唯一有用的信息丢掉。
   */
  async separateAudio(request: {
    projectId: string;
    expectedRevision: number;
    workspaceDir: string;
    mediaPath: string;
    actor?: string;
  }): Promise<
    | {
      ok: true;
      artifactId: string;
      relativePath: string;
      bytes: number;
      durationSeconds: number;
      sourceRelativePath: string;
    }
    | { ok: false; reason: string }
  > {
    const actor = request.actor ?? 'user:local';
    const absolute = join(request.workspaceDir, request.mediaPath);
    const probe = await this.frontkernel.mediaProbe(absolute);

    const verdict = canExtractAudio(probe);
    if (!verdict.ok) return { ok: false, reason: verdict.reason ?? '这条素材不能分离音轨' };

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const relativePath = audioOutputRelativePath(timestamp);
    const target = join(request.workspaceDir, relativePath);
    mkdirSync(join(request.workspaceDir, 'derived'), { recursive: true });

    const extracted = await extractAudioTrack(absolute, target);
    if (!extracted.ok) {
      return { ok: false, reason: extracted.error ?? '抽音轨没有成功' };
    }

    const bytes = readFileSync(target);
    const artifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    this.projects.execute({
      command_id: crypto.randomUUID(),
      actor,
      type: 'artifact.publish',
      payload: {
        artifact_id: artifactId,
        media_type: 'audio/mp4',
        bytes: extracted.bytes,
        metadata: {
          source: 'audio-extract',
          project_id: request.projectId,
          artifact_path_relative: relativePath,
          /* 从哪条素材分离出来的：回看时能对上，而不是只有一个孤零零的音频 */
          from_media_relative: request.mediaPath,
          duration_seconds: probe.duration,
        },
      },
    });

    return {
      ok: true,
      artifactId,
      relativePath,
      bytes: extracted.bytes,
      durationSeconds: probe.duration,
      sourceRelativePath: request.mediaPath,
    };
  }

  /**
   * 把已确认的拆解 + 已选定的首帧写成一份可生产的 Source。
   *
   * 产品在这里的角色是**翻译**而不是实现：把领域事实翻译成 前置内核 的 Source，
   * 生产本身交给内核。生成结果确定性——同一份输入逐字节相同，
   * 因此「改了某个镜头的时长」只会让这一版 Source 变化，可以逐版比对。
   */
  prepareFilmSource(request: {
    workspaceDir: string;
    /** image_src 是相对于 workspace 的路径；写进 Source 时会换算成相对于 Source 的路径。 */
    /**
     * image_src 必填（也用于仍无视频片段的镜头）；video_src 提供时优先走视频。
     * `audio` 表示这一镜的片段是否有**可听**的源声音（用 `probeAudibility` 量出来，
     * 不要拿 `hasAudio` 顶替）。
     */
    shots: ReadonlyArray<{
      shot_id: string; image_src: string; duration_ms: number;
      video_src?: string; audio?: boolean;
      /** 片段与镜头不等长时：`hold`（默认，停最后一帧）或 `stretch`（变速填满） */
      playback?: 'hold' | 'stretch';
    }>;
    canvas: FilmCanvas;
    frameRate?: number;
    /** 镜头之间怎么换；除 `cut` 外都会改写成 Sequence + Member + Handoff */
    transition?: FilmTransition;
    /** 方向性转场往哪边走；crossfade 与 cut 会忽略它 */
    direction?: TransitionDirection;
    /** 相对 workspace 的输出目录，默认 `production`。 */
    outputDir?: string;
  }): { svml: string; svrun: string; svs: string; durationMs: number } {
    const outputDir = request.outputDir ?? 'production';
    const dir = join(request.workspaceDir, outputDir);
    mkdirSync(dir, { recursive: true });

    const shots: FilmShot[] = request.shots.map((shot) => ({
      shot_id: shot.shot_id,
      // Source 里的相对路径以 Source 文件所在目录为基准
      image_src: relative(dir, join(request.workspaceDir, shot.image_src)).split('\\').join('/'),
      duration_ms: shot.duration_ms,
      ...(shot.video_src === undefined ? {} : {
        video_src: relative(dir, join(request.workspaceDir, shot.video_src)).split('\\').join('/'),
      }),
      ...(shot.audio === undefined ? {} : { audio: shot.audio }),
      ...(shot.playback === undefined ? {} : { playback: shot.playback }),
    }));

    writeFileSync(join(dir, 'film.svml'), buildAuthorSource({
      canvas: request.canvas,
      frameRate: request.frameRate ?? 30,
      shots,
      ...(request.transition === undefined ? {} : { transition: request.transition }),
    }), 'utf8');
    writeFileSync(join(dir, 'film.svrun'), buildRunSource('film.svml'), 'utf8');
    /*
      转场配方逐对生成：帧数按相邻两镜的较短者夹出来。
      两份文件（film.svml 里的 recipe 引用、film.svs 里的 recipe 定义）
      必须用**同一个**计算结果，否则对不上——所以只在这里算一次。
    */
    const wantsTransition = request.transition !== undefined && request.transition !== 'cut';
    const transitionFrames = wantsTransition && shots.length >= 2
      ? transitionFramesFor(shots, request.frameRate ?? 30)
      : [];
    writeFileSync(
      join(dir, 'film.svs'),
      buildStyleSheet(transitionFrames, request.transition, request.direction),
      'utf8',
    );

    return {
      svml: `${outputDir}/film.svml`,
      svrun: `${outputDir}/film.svrun`,
      svs: `${outputDir}/film.svs`,
      durationMs: totalDurationMs(shots),
    };
  }

  /* ---------------- 只读查询与取件 ----------------
     这几个动作不改变项目事实，因此不登记内核任务，也不推进 revision。
     把它们也做成「登记 → 执行 → 回填」只会往审计里灌噪音。 */

  /** 查询构建的持久状态；`null` 表示该 build id 在给定 workspace 下不存在。 */
  buildStatus(buildId: string, workspaceDir: string, runtimeProfile?: string): Promise<FrontkernelBuildStatus | null> {
    return this.frontkernel.status(buildId, {
      workspace: workspaceDir,
      ...(runtimeProfile === undefined ? {} : { runtime: resolveRuntime(workspaceDir, runtimeProfile) }),
    });
  }

  /** 读取构建结果清单（输出名、类型、大小）。 */
  inspectBuild(buildId: string, workspaceDir: string, output?: string): Promise<FrontkernelBuildResult> {
    return this.frontkernel.inspect(buildId, {
      workspace: workspaceDir,
      ...(output === undefined ? {} : { output }),
    });
  }

  /**
   * 只读探测媒体事实。
   *
   * 不登记内核任务、不推进 revision——它只是回答「这条素材多长、多大」，
   * 每次成片前都要问一次，不该因此往审计里灌记录。
   */
  probeMedia(request: { workspaceDir: string; mediaPath: string }): Promise<FrontkernelMediaProbe> {
    return this.frontkernel.mediaProbe(join(request.workspaceDir, request.mediaPath));
  }

  /**
   * 这条素材**有没有声音**（实测响度，而不是「容器里有没有音轨」）。
   *
   * 成片是否带上某个片段的声音，取决于这个答案。用 `hasAudio` 判断是不行的：
   * 前置内核 的成片合流时总会写一条音轨，静音也是音轨——
   * 实测三条素材 `hasAudio` 全是 true，真实峰值分别是 -91 / -8.8 / -91 dB。
   *
   * `audible === null` 表示量不出来（ffmpeg 缺失等）。调用方必须把它与
   * 「量出来是静音」区分开，而不是当成 false 混过去。
   */
  async probeAudibility(request: { workspaceDir: string; mediaPath: string }): Promise<{
    hasAudio: boolean;
    max_db: number | null;
    mean_db: number | null;
    audible: boolean | null;
  }> {
    const absolute = join(request.workspaceDir, request.mediaPath);
    const probe = await this.frontkernel.mediaProbe(absolute);
    const reading = await measureLoudness(absolute);
    return {
      hasAudio: probe.hasAudio,
      max_db: reading?.max_db ?? null,
      mean_db: reading?.mean_db ?? null,
      audible: audible(reading),
    };
  }

  /**
   * 偏差评估（S8）：把成片与参考片比对，产出带归因的报告。
   *
   * 评估只用可计算的真实事实（时长、画幅、音轨），因此结论确定、可复现、
   * 且**不花钱**——它不会因为「看起来不太像」就自作主张去重跑任何镜头。
   */
  async evaluateFilm(request: {
    projectId: string;
    expectedRevision: number;
    workspaceDir: string;
    /** 参考视频，相对 workspace。 */
    referencePath: string;
    /** 成片，相对 workspace。 */
    resultPath: string;
    /** 参考视频登记时的内容哈希。 */
    referenceArtifact: string;
    frameRate?: number;
    actor?: string;
  }): Promise<{
    executed: boolean;
    report?: EvalReport;
    reportId?: string;
    projectRevision?: number;
    failure?: string;
  }> {
    const referenceAbs = join(request.workspaceDir, request.referencePath);
    const resultAbs = join(request.workspaceDir, request.resultPath);
    let reference: FrontkernelMediaProbe;
    let result: FrontkernelMediaProbe;
    /**
     * 响度必须实测：`hasAudio` 对「有声」和「数字静音」都返回 true，
     * 光看它这一维度恒为一致，永远发现不了「声音被丢了」。
     * 量不出来时 measureLoudness 返回 null，评估会据此降置信度而不是瞎猜。
     */
    let referenceLoudness = null;
    let resultLoudness = null;
    try {
      [reference, result] = await Promise.all([
        this.frontkernel.mediaProbe(referenceAbs),
        this.frontkernel.mediaProbe(resultAbs),
      ]);
      [referenceLoudness, resultLoudness] = await Promise.all([
        measureLoudness(referenceAbs),
        measureLoudness(resultAbs),
      ]);
    } catch (error) {
      return { executed: false, failure: error instanceof Error ? error.message : String(error) };
    }

    const project = this.projects.getProject(request.projectId) as {
      shot_fields?: { shots?: Array<{ shot_id: string; duration_ms: number }> } | null;
    };
    const shots: ShotExpectation[] = (project.shot_fields?.shots ?? []).map((shot) => ({
      shot_id: shot.shot_id,
      duration_ms: shot.duration_ms,
    }));
    if (shots.length === 0) {
      return { executed: false, failure: '缺少逐镜字段表，无法判断哪一镜有偏差' };
    }

    // 成片是刚导出的文件，用它的内容哈希作为结果侧标识
    const resultArtifact = `sha256:${createHash('sha256').update(readFileSync(resultAbs)).digest('hex')}`;
    const report = buildEvalReport({
      referenceArtifact: request.referenceArtifact,
      resultArtifact,
      reference,
      result,
      referenceLoudness,
      resultLoudness,
      shots,
      frameRate: request.frameRate ?? 30,
    });

    const recorded = this.projects.execute({
      command_id: crypto.randomUUID(),
      actor: request.actor ?? 'user:local',
      type: 'eval.record',
      project_id: request.projectId,
      expected_revision: request.expectedRevision,
      payload: { report: report as unknown as Record<string, unknown> },
    });
    return {
      executed: true,
      report,
      reportId: (recorded.payload as { report_id: string }).report_id,
      projectRevision: recorded.project_revision ?? request.expectedRevision + 1,
    };
  }

  /**
   * 把某个输出取到指定路径。
   *
   * 比直接报错危险得多。
   */
  exportOutput(buildId: string, outputName: string, toPath: string, workspaceDir: string): Promise<FrontkernelGetReport> {
    return this.frontkernel.getOutput(buildId, outputName, toPath, { workspace: workspaceDir });
  }

  /**
   * 由评估报告生成修复方案（S9）。
   *
   * 为什么不塞进 `evaluateFilm` 一起做：
   * 评估是"看清差在哪"，修复是"决定要不要改"——后者要花钱也要过人。
   * 把两件事绑在一起，会让评估这个**只读判断**顺带产生一份带成本的计划，
   * 而人还没看过报告。所以分成两步，由调用方（界面或前置 Agent）显式触发第二步。
   *
   * 全部维度都已一致时 `proposeRepairPlan` 返回 null，这里如实回报"没有需要修复的"，
   * 而不是硬凑一份"顺手改点什么"的方案。
   */
  proposeRepair(request: {
    projectId: string;
    expectedRevision: number;
    /** 指定依据哪份报告；省略时用最新的一份 */
    evalReportId?: string;
    actor?: string;
  }): {
    proposed: boolean;
    reason?: string;
    plan?: RepairPlan;
    planId?: string;
    projectRevision?: number;
  } {
    const project = this.projects.getProject(request.projectId) as {
      /**
       * 注意这里读的是 `report` 而不是 `report_json`。
       *
       * `listEvalReports` 已经把 JSON 解析过一道再返回（见领域层的实现），
       * 数据库里那一列才叫 `report_json`。照列名去取会拿到 undefined，
       * 然后在 `JSON.parse(undefined)` 上炸成一句「内部错误」——
       * 报错点离起因（字段名）很远。写这段时就是先照列名猜的，
       * 后来靠主进程日志才定位到。
       */
      eval_reports?: Array<{ report_id: string; report: EvalReport }>;
      shot_fields?: { shots?: Array<{ shot_id: unknown }> } | null;
      revision?: number;
    };
    /* 报告按 created_at 倒序返回，所以第一条就是最新的 */
    const reports = project.eval_reports ?? [];
    const target = request.evalReportId === undefined
      ? reports[0]
      : reports.find((row) => row.report_id === request.evalReportId);
    if (target === undefined) {
      return {
        proposed: false,
        reason: request.evalReportId === undefined
          ? '还没有评估报告，先生成成片并评估'
          : `找不到这份评估报告：${request.evalReportId}`,
      };
    }

    const plan = proposeRepairPlan({
      evalReportId: target.report_id,
      report: target.report,
      allShots: (project.shot_fields?.shots ?? []).map((shot) => String(shot.shot_id)),
      targetRevision: request.expectedRevision,
    });
    if (plan === null) {
      return { proposed: false, reason: '这次评估没有发现需要修复的维度' };
    }

    const recorded = this.projects.execute({
      command_id: crypto.randomUUID(),
      actor: request.actor ?? 'user:local',
      type: 'repair.propose',
      project_id: request.projectId,
      expected_revision: request.expectedRevision,
      payload: { plan: plan as unknown as Record<string, unknown> },
    });
    return {
      proposed: true,
      plan,
      planId: (recorded.payload as { plan_id: string }).plan_id,
      projectRevision: recorded.project_revision ?? request.expectedRevision + 1,
    };
  }

  /**
   * 通用流程：登记意图 → 调用内核 → 回填结果。
   *
   * 无论内核成功还是失败都会回填——「这次动作失败了」本身就是一条必须留下的
   * 项目事实，否则界面只能反复重试而无人知道为什么。
   */
  private async runTask<R>(
    kind: 'check' | 'plan' | 'build' | 'analyze' | 'transcribe',
    request: Omit<KernelTaskRequest, 'sourcePath'>,
    /** 登记进内核任务事实的源路径：校验/规划/构建是 Source，分析是参考视频。 */
    sourcePath: string,
    execute: () => Promise<R>,
  ): Promise<KernelTaskOutcome<R>> {
    const actor = request.actor ?? 'user:local';
    const registered = this.projects.execute({
      command_id: crypto.randomUUID(),
      actor,
      type: kind === 'check' ? 'kernel.check'
        : kind === 'plan' ? 'kernel.plan'
          : kind === 'build' ? 'kernel.build'
            : kind === 'analyze' ? 'kernel.analyze'
              : 'kernel.transcribe',
      project_id: request.projectId,
      expected_revision: request.expectedRevision,
      payload: {
        source_path: sourcePath,
        ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
      },
    });
    const taskId = (registered.payload as { task_id: string }).task_id;
    const revisionAfterRegister = registered.project_revision ?? request.expectedRevision + 1;

    try {
      const report = await execute();
      const recorded = this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'kernel.result.record',
        project_id: request.projectId,
        expected_revision: revisionAfterRegister,
        payload: { task_id: taskId, status: 'COMPLETED', report: report as unknown as Record<string, unknown> },
      });
      return {
        executed: true,
        taskId,
        projectRevision: recorded.project_revision ?? revisionAfterRegister,
        report,
      };
    } catch (error) {
      const failure = describeFailure(error);
      // Provider、文件系统及协议异常可能包含主机路径，不把原始错误持久化。
      if (kind === 'transcribe') failure.message = `转录执行失败（${failure.kind}），请检查输入、Runtime Profile 与 Provider 配置`;
      const recorded = this.projects.execute({
        command_id: crypto.randomUUID(),
        actor,
        type: 'kernel.result.record',
        project_id: request.projectId,
        expected_revision: revisionAfterRegister,
        payload: { task_id: taskId, status: 'FAILED', failure: failure.message },
      });
      return {
        executed: false,
        taskId,
        projectRevision: recorded.project_revision ?? revisionAfterRegister,
        failure: failure.message,
        failureKind: failure.kind,
      };
    }
  }
}

/** 把项目内相对路径解析成真实路径，并拒绝 `..` 越出 workspace。 */
function resolveWorkspacePath(workspaceDir: string, path: string): string {
  if (path.trim() === '' || isAbsolute(path)) throw new Error('媒体路径必须是项目内的相对路径');
  const root = resolve(workspaceDir);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('媒体路径必须落在项目 workspace 内');
  }
  return target;
}

/** 转录路径逐级拒绝符号链接（包括 Windows junction），并拒绝跨平台绝对路径。 */
function checkedTranscribePath(root: string, path: string, allowMissing = false): string {
  if (typeof path !== 'string' || !path.trim() || /^[\\/]|^[a-z]:/iu.test(path)
    || path.includes('\0') || path.split(/[\\/]/u).some((part) => part === '..' || part.includes(':'))) {
    throw new Error('转录路径必须落在项目 workspace 内');
  }
  const parts = path.split(/[\\/]/u).filter((part) => part && part !== '.');
  if (!parts.length) throw new Error('转录路径不能为空');
  let target = root;
  for (const part of parts) {
    target = join(target, part);
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error('转录路径不得包含符号链接');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return target;
}

function safeTranscribeProvider(command: FrontkernelTranscribeReport): Pick<FrontkernelTranscribeReport, 'endpoint' | 'provider' | 'pricePage'> {
  return {
    ...(command.endpoint && /^[\w.@:-]+$/u.test(command.endpoint) ? { endpoint: command.endpoint } : {}),
    ...(command.provider && /^@?[\w.-]+(?:\/[\w.-]+)?$/u.test(command.provider) ? { provider: command.provider } : {}),
    ...(command.pricePage && /^https?:\/\//u.test(command.pricePage) ? { pricePage: command.pricePage } : {}),
  };
}

/**/
export function parseFrontkernelTranscript(text: string, source = '<transcript>'): FrontkernelTranscript {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FrontkernelProtocolError(`${source} 不是合法 JSON`, { source });
  }
  const root = value as Partial<FrontkernelTranscript> | null;
  if (root === null || typeof root !== 'object' || Array.isArray(root) || root.format !== 'frontkernel.transcript@1' || typeof root.source !== 'string'
    || typeof root.language !== 'string' || typeof root.audio_seconds !== 'number'
    || !Number.isFinite(root.audio_seconds) || root.audio_seconds < 0 || !Array.isArray(root.passages)) {
    throw new FrontkernelContractDriftError(`${source} 不是 frontkernel.transcript@1`, 'frontkernel.transcript@1', root?.format);
  }
  for (const [passageIndex, passage] of root.passages.entries()) {
    if (passage === null || typeof passage !== 'object' || typeof passage.text !== 'string' || !Array.isArray(passage.words)) {
      throw new FrontkernelContractDriftError(`${source} 的第 ${passageIndex + 1} 段缺少 text/words`, 'transcript passage', typeof passage);
    }
    for (const key of ['start_seconds', 'end_seconds'] as const) {
      const time = passage[key];
      if (time !== undefined && (typeof time !== 'number' || !Number.isFinite(time) || time < 0)) {
      throw new FrontkernelContractDriftError('转录段落时间无效', 'non-negative finite number', time);
      }
    }
    if (passage.start_seconds !== undefined && passage.end_seconds !== undefined && passage.end_seconds < passage.start_seconds) {
      throw new FrontkernelContractDriftError('转录段落结束时间早于开始时间', 'end >= start', passage.end_seconds);
    }
    for (const [wordIndex, word] of passage.words.entries()) {
      if (word === null || typeof word !== 'object' || typeof word.text !== 'string') {
        throw new FrontkernelContractDriftError(`${source} 的第 ${passageIndex + 1} 段第 ${wordIndex + 1} 词无效`, 'transcript word', typeof word);
      }
      const score = (word as { score?: unknown }).score;
      if (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score))) {
        throw new FrontkernelContractDriftError('转录词置信度无效', 'finite number', score);
      }
      for (const key of ['start_seconds', 'end_seconds'] as const) {
        const number = word[key];
        if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number < 0)) {
        throw new FrontkernelContractDriftError(`${source} 的 ${key} 无效`, 'non-negative number', number);
        }
      }
      if (word.start_seconds !== undefined && word.end_seconds !== undefined && word.end_seconds < word.start_seconds) {
        throw new FrontkernelContractDriftError(`${source} 的词结束时间早于开始时间`, 'end_seconds >= start_seconds', word.end_seconds);
      }
    }
  }
  const timing = (item: { start_seconds?: number; end_seconds?: number }) => ({
    ...(item.start_seconds === undefined ? {} : { start_seconds: item.start_seconds }),
    ...(item.end_seconds === undefined ? {} : { end_seconds: item.end_seconds }),
  });
  // 不透传未知字段，避免把 Provider 附带的本机路径等元数据写进事实。
  return {
    format: 'frontkernel.transcript@1', source: root.source, language: root.language,
    audio_seconds: root.audio_seconds,
    passages: root.passages.map((passage) => ({
      text: passage.text, ...timing(passage),
      words: passage.words.map((word: FrontkernelTranscript['passages'][number]['words'][number] & { score?: number }) => ({
        text: word.text, ...timing(word),
        ...(word.score === undefined ? {} : { score: word.score }),
      })),
    })),
  };
}

/**
 * 把适配器错误翻译成「用户该做什么」。
 *
 * 契约漂移被单独归类，因为它既不是环境问题也不是输入问题，
 */
function describeFailure(error: unknown): { message: string; kind: NonNullable<KernelTaskOutcome<unknown>['failureKind']> } {
  if (error instanceof FrontkernelNotInstalledError) {
    return { message: `未找到 前置内核：${error.message}`, kind: 'not-installed' };
  }
  if (error instanceof FrontkernelContractDriftError) {
    return { message: `前置内核 接口契约发生漂移，需要复核适配器：${error.message}`, kind: 'contract-drift' };
  }
  if (error instanceof FrontkernelCommandError) {
    return { message: `${error.message}（${error.code}）`, kind: 'command' };
  }
  if (error instanceof FrontkernelProtocolError) {
    return { message: error.message, kind: 'protocol' };
  }
  return { message: error instanceof Error ? error.message : String(error), kind: 'unknown' };
}

/**
 * 把「相邻帧变化候选」切成镜头区间。
 *
 * 并且必须在这里写清楚：
 *   · 0 与视频总长天然构成两条边界；
 *   · 候选点按毫秒去重排序，同一时间只切一次；
 *
 * 没有任何候选时，整段视频就是一个镜头。这让静帧视频得到合法处理，
 * 而不是产出零个镜头、让下游误以为分析失败。
 */
export function boundariesToShotRanges(
  candidates: readonly FrontkernelMediaBoundaryCandidate[],
  durationSeconds: number,
): ShotRange[] {
  const durationMs = Math.round(durationSeconds * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];

  const cuts = Array.from(new Set(
    candidates
      .map((candidate) => candidate.at ?? candidate.time)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .map((seconds) => Math.round(seconds * 1000))
      .filter((ms) => ms > 0 && ms < durationMs),
  )).sort((a, b) => a - b);

  const bounds = [0, ...cuts, durationMs];
  const ranges: ShotRange[] = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const t0 = bounds[index];
    const t1 = bounds[index + 1];
    if (t0 === undefined || t1 === undefined || t1 <= t0) continue;
    ranges.push({ t0_ms: t0, t1_ms: t1 });
  }
  return ranges;
}

/**
 * 按请求时间点找回对应的抽出帧。
 *
 * **参数是毫秒**——名字里的 `t0Ms` 必须留着，它就是这个函数唯一容易用错的地方：
 * 拉片那条路径（`extractFilmstrip`）的时间点是**秒**，直接复用这个函数会让
 * 每次比较差 1000 倍，结果是"抽帧跑了、时间点也对、帧一张都没匹配上"，
 * 而且不抛任何异常。那一处就真的踩过，所以这里把单位写进参数名。
 */
function pickFrameAt(
  frames: ReadonlyArray<{ requestedAt: number; at: number; path: string }>,
  t0Ms: number,
): { requestedAt: number; at: number; path: string } | null {
  const seconds = t0Ms / 1000;
  return frames.find((frame) => Math.abs(frame.requestedAt - seconds) < 1e-6) ?? null;
}

/**
 * Runtime Profile 的路径同样是「产品层相对 workspace，内核收绝对路径」。
 * 已经给出绝对路径时原样透传，便于把 Profile 放在别处复用。
 */
function resolveRuntime(workspaceDir: string, profile: string): string {
  return isAbsolute(profile) ? profile : join(workspaceDir, profile);
}
