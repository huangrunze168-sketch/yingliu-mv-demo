/* ============================================================
   期音科技 · 前置内核 CLI 机器视图协议
   ------------------------------------------------------------

   ============================================================ */

/**/
export const FRONTKERNEL_FORMATS = {
  version: 'frontkernel.cli-version@1',
  check: 'frontkernel.cli-check@1',
  plan: 'frontkernel.cli-plan@1',
  build: 'frontkernel.cli-build@1',
  status: 'frontkernel.cli-status@1',
  inspect: 'frontkernel.cli-inspect@1',
  cancel: 'frontkernel.cli-cancel@1',
  get: 'frontkernel.cli-get@1',
  builds: 'frontkernel.cli-builds@1',
  /**/
  transcribe: 'frontkernel.video-cli-transcribe@1',
  error: 'frontkernel.cli-error@1',
} as const;

export type FrontkernelFormatKey = keyof typeof FRONTKERNEL_FORMATS;

/**/
export interface FrontkernelVersionReport {
  format: string;
  package: string;
  version: string;
  distribution: string;
  launcher?: string;
  releases?: string;
}

/**/
interface FrontkernelCheckReportBase {
  format: string;
  ok: boolean;
  frontend?: string;
  units?: number;
  assets?: number;
  modules?: number;
  outputCount?: number;
  capabilityCount?: number;
  capabilities?: readonly string[];
  diagnosticCount?: number;
  diagnostics?: readonly FrontkernelDiagnostic[];
}

/** Author 与 Run 都能被 check；构建门控检查 `.svrun` 时走第二种形状。 */
export type FrontkernelCheckReport =
  | (FrontkernelCheckReportBase & { sourceKind: 'author'; source: string; run?: never; author?: never; targets?: never })
  | (FrontkernelCheckReportBase & { sourceKind: 'run'; run: string; author: string; targets: readonly string[]; source?: string });

export interface FrontkernelDiagnostic {
  severity?: string;
  code?: string;
  message?: string;
  path?: string;
}

/**/
export interface FrontkernelPlanReport {
  format: string;
  ok: boolean;
  run: string;
  targetCount: number;
  targets: readonly string[];
  steps?: number;
  requestCount: number;
  capabilityCount?: number;
  providers?: readonly FrontkernelPlanProvider[];
  diagnostics?: readonly FrontkernelDiagnostic[];
}

export interface FrontkernelPlanProvider {
  request: string;
  capability: string;
  status: 'resolved' | 'unresolved' | 'unsupported' | 'ambiguous';
  endpoint?: string;
  binding?: string;
  rejections?: readonly { endpoint: string; message: string }[];
}

/**/
export interface FrontkernelBuildStatus {
  id: string;
  title?: string;
  targets?: readonly string[];
  failure?: string;
  work: {
    state: 'unknown' | 'submitting' | 'working' | 'done';
    outcome?: 'complete' | 'failed' | 'cancelled';
    cancellationRequested?: boolean;
    requests?: { total: number; completed: number };
  };
  result: {
    state: 'missing' | 'open' | 'complete' | 'failed' | 'cancelled' | 'unavailable';
    outputCount?: number;
  };
  attention?: { message: string; action?: string };
}

/**/
export interface FrontkernelBuildResult {
  id: string;
  title?: string;
  note?: string;
  createdAt: string;
  finishedAt?: string;
  outcome: 'open' | 'complete' | 'failed' | 'cancelled';
  source: string;
  run?: string;
  targetCount: number;
  targets: readonly string[];
  outputs: readonly FrontkernelOutputView[];
  outputCount: number;
  otherOutputCount?: number;
  omittedOutputs?: number;
  failure?: string;
}

export interface FrontkernelOutputView {
  name: string;
  type: string;
  kind: string;
  target: boolean;
  highlighted: boolean;
  mediaType?: string;
  size?: number;
}

/**/
export interface FrontkernelCancelReport {
  format: string;
  requested: boolean;
  build: FrontkernelBuildStatus | null;
}

/**/
export interface FrontkernelGetReport {
  format: string;
  build: string;
  output: string;
  type: string;
  kind: 'scalar' | 'resource' | 'composite';
  path: string;
}

/**/
export interface FrontkernelBuildsReport {
  format: string;
  builds: readonly FrontkernelBuildSummary[];
  next?: string;
}

export interface FrontkernelBuildSummary {
  id: string;
  createdAt: string;
  title?: string;
  outcome: string;
  run?: string;
  targetCount: number;
  outputCount: number;
}

/**/
export interface FrontkernelTranscribeReport {
  format: string;
  source: string;
  language: string;
  audio_seconds: number;
  extracted: boolean;
  endpoint?: string;
  provider?: string;
  pricePage?: string;
  passages: number;
  words: number;
  path: string;
}

/**/
export interface FrontkernelTranscript {
  format: 'frontkernel.transcript@1';
  source: string;
  language: string;
  audio_seconds: number;
  passages: readonly FrontkernelTranscriptPassage[];
}

export interface FrontkernelTranscriptPassage {
  text: string;
  start_seconds?: number;
  end_seconds?: number;
  words: readonly FrontkernelTranscriptWord[];
}

export interface FrontkernelTranscriptWord {
  text: string;
  start_seconds?: number;
  end_seconds?: number;
}

/**/
export interface FrontkernelErrorReport {
  format: string;
  ok: false;
  error: {
    code: string;
    message: string;
    help?: string;
    trace?: string;
  };
}

/* ============================================================
   前置内核 media 系列
   ------------------------------------------------------------
   注意：`media probe / boundaries / frames / tiles` 的输出**没有 format 标识**，
   与 cli 系列不同。因此这几个命令不能用 format 做契约漂移检测，
   改用「必需字段存在性」校验——见 adapter 里的 assertShape。

   另一处实测差异：media 系列**不接受 `--workspace`**（会报 unknown option），
   路径必须直接给到命令本身。这与 cli 系列的 `--workspace` 语义不同，
   所以 adapter 里 media 方法不带 workspace 参数。

   应当把这里换成与 cli 系列一致的校验方式。
   ============================================================ */

/**/
export interface FrontkernelMediaProbe {
  path: string;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
}

/**
 *
 * 因此产品侧拿到的是**候选**，是否成为镜头由人工/后续分析决定。
 */
export interface FrontkernelMediaBoundaries {
  path: string;
  sampleRate: number;
  threshold: number;
  candidates: readonly FrontkernelMediaBoundaryCandidate[];
}

export interface FrontkernelMediaBoundaryCandidate {
  /**/
  at?: number;
  time?: number;
  score?: number;
}

/**/
export interface FrontkernelMediaFrames {
  directory: string;
  labeled: boolean;
  frames: readonly FrontkernelMediaFrame[];
}

export interface FrontkernelMediaFrame {
  /** 请求的时间点 */
  requestedAt: number;
  /** 实际取到的帧时间点（可能因关键帧而略有偏移） */
  at: number;
  path: string;
}
