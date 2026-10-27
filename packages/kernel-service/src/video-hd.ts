import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { extname } from 'node:path';
import {
  VIDEO_HD_FORMATS,
  VIDEO_HD_FPS,
  VIDEO_HD_FPS_HEADROOM,
  VIDEO_HD_MAX_SOURCE_BYTES,
  VIDEO_HD_MAX_SOURCE_LONG_SIDE,
  VIDEO_HD_SCALES,
  videoHdTierList,
} from '@qiyin/contracts';
import {
  planVideoPipeline,
  runVideoPipeline,
  type VideoPipelinePlan,
  type VideoPipelineRunner,
  type VideoPipelineStepTiming,
} from './video-pipeline.js';

/* ============================================================
  期音科技 · 视频高清（VID-005）
  ------------------------------------------------------------
    矩阵给这一条的原文是：

      「视频高清：**2/4/6 倍放大 + 30/60/90fps 提帧**」
      「输出分辨率为请求倍数的整数倍，帧率精确等于请求值（误差 0）；
        规格不符时明确报错而非静默降级」

  所以这个模块做三件事，缺一不可：

    · `planVideoHd()`    —— **承诺**输出规格，并在开工前把不能做的情况挡住；
    · `runVideoHd()`     —— 复用 VID-001 那条管线真跑，把每一步耗时记下来；
    · `compareVideoHdSpec()` —— **零容差**核对（这一条与 VID-001 的口径不同，
      那边帧率容差 0.5、时长容差 4 帧；这里分辨率要与源成整数倍、帧率要精确相等）。

  ### 为什么 2/4/6 这三档是"能用"的

  H.264 要偶数宽高，所以管线里有一道偶数对齐（`even()`）。如果档位里有奇数，
  `301 × 3 = 903` 会被对齐成 904——那就**不是整数倍**了，
  矩阵那句"输出分辨率为请求倍数的整数倍"当场不成立。
  2 / 4 / 6 全是偶数，`偶数 × 偶数` 还是偶数，对齐这一步就成了恒等变换。
  换句话说：**档位的选法本身保证了"整数倍"这条口径不会与编码器约束打架**，
  这不是巧合，是要写下来的一条约束（见 `SCALES_ARE_EVEN` 的断言）。

  ### 挡住的四种情况，文案尽量用 小QTV 的原话


    upscaleFormatUnsupported    当前视频格式暂不支持超分，支持格式：mp4 / flv / ts / avi / mov / wmv / mkv
    upscaleResolutionExceed2K   视频分辨率超过 2K，暂不支持超分
    upscaleSizeExceed10GB       视频文件超过 10GB，暂不支持超分
    upscaleFpsTips              默认输出视频将保持与原始片源一致的帧率，建议不超过原片的 4 倍

  前三条是**拒绝**（做不到就说做不到，不做静默降级）；
  最后一条是**警告**（它自己也只写到"可能影响输出效果"，那就不该反过来拦住用户）。
  档位之外的值同样拒绝——小QTV 只给这三档，我们给第四档就是自己发明功能。
  ============================================================ */

/*
  档位表与几条边界值住在 `@qiyin/contracts`（`video-hd-tiers.ts`）：
  界面要拿它画那排按钮，内核要拿它判"这个档存在吗"。住在这里的话，
  渲染层为了读它就得把 `node:child_process` 拖进浏览器 bundle。
*/
export {
  VIDEO_HD_FORMATS,
  VIDEO_HD_FPS,
  VIDEO_HD_FPS_HEADROOM,
  VIDEO_HD_MAX_SOURCE_BYTES,
  VIDEO_HD_MAX_SOURCE_LONG_SIDE,
  VIDEO_HD_SCALES,
  videoHdNodeName,
} from '@qiyin/contracts';

/**
 * 档位必须全是偶数。

 * 理由见文件顶上那段：奇数档位会与 H.264 的偶数对齐打架，
 * 把"整数倍"这条口径打成"约等于"。它是**运行期断言**而不是注释，
 * 因为改档位的人不会每次都重读这段注释。
 */
const SCALES_ARE_EVEN = VIDEO_HD_SCALES.every((scale) => scale % 2 === 0);

export interface VideoHdFacts {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  /** 字节数。读不到文件时为 null——那时调用方按"读不出"处理，而不是当 0 处理。 */
  bytes: number | null;
  /** 小写扩展名，不带点。 */
  extension: string;
}

export interface VideoHdRequest {
  inputPath: string;
  outputPath: string;
  /** 倍数档，只能取 `VIDEO_HD_SCALES` 里的值。 */
  scale: number;
  /**
   * 目标帧率。

   * 给了就必须落在 `VIDEO_HD_FPS` 三档里；**不给表示线上那个「自适应(原帧率)」**
   * ——只放大、不碰帧率。它不能写成"等于原帧率"，因为原片可能是 24fps，
   * 而 24 不在三档里：那样"自适应"会被自己的档位校验拒掉，正好把最省事的默认挡在门外。
   */
  fps?: number | undefined;
  /** 稳定滤镜要写中间文件，所以管线需要一个可写的目录。 */
  workDir: string;
}

export interface VideoHdPlan {
  pipeline: VideoPipelinePlan;
  scale: number;
  /** 承诺的输出帧率：显式请求的就是它，没请求就是原片帧率。 */
  fps: number;
  /** 承诺的输出分辨率（= 源宽高 × 倍数，**逐像素的整数倍**） */
  expectedWidth: number;
  expectedHeight: number;
}

export type VideoHdPlanResult =
  | { ok: true; plan: VideoHdPlan }
  | { ok: false; code: string; message: string };

const refuse = (code: string, message: string): VideoHdPlanResult => ({ ok: false, code, message });

/**
 * 开工前把不能做的情况挡住。

 * 顺序是**从"这条素材根本不适合"到"这次请求填错了"**：
 * 素材层面的问题（格式 / 体积 / 分辨率）先报——它比档位填错更根本，
 * 用户拿到的第一句话就该是"这条片子做不了超分"，而不是"你档位选错了"。
 */
export function planVideoHd(request: VideoHdRequest, facts: VideoHdFacts): VideoHdPlanResult {
  if (!SCALES_ARE_EVEN) {
    return refuse(
      'VIDEO_HD_TIERS_INVALID',
      `内部档位表坏了：${videoHdTierList(VIDEO_HD_SCALES, ' 倍')} 里有奇数档，`
        + '与 H.264 的偶数对齐会打架，"整数倍"这条口径保证不了',
    );
  }

  const extension = facts.extension.toLowerCase();
  if (!(VIDEO_HD_FORMATS as readonly string[]).includes(extension)) {
    return refuse(
      'VIDEO_HD_FORMAT_UNSUPPORTED',
      `当前视频格式暂不支持超分，支持格式：${VIDEO_HD_FORMATS.join(' / ')}`,
    );
  }

  if (facts.bytes !== null && facts.bytes > VIDEO_HD_MAX_SOURCE_BYTES) {
    return refuse('VIDEO_HD_SOURCE_TOO_LARGE', '视频文件超过 10GB，暂不支持超分');
  }

  if (Math.max(facts.width, facts.height) > VIDEO_HD_MAX_SOURCE_LONG_SIDE) {
    return refuse('VIDEO_HD_SOURCE_OVER_2K', '视频分辨率超过 2K，暂不支持超分');
  }

  if (!(facts.width > 0) || !(facts.height > 0) || !(facts.fps > 0) || !(facts.durationSeconds > 0)) {
    return refuse(
      'VIDEO_HD_SOURCE_UNREADABLE',
      '读不出这条素材的宽高 / 帧率 / 时长。承诺不了输出规格就不开工——'
        + '凭猜的规格跑完，产物到底是多少也就说不清了',
    );
  }

  if (!(VIDEO_HD_SCALES as readonly number[]).includes(request.scale)) {
    return refuse(
      'VIDEO_HD_SCALE_UNSUPPORTED',
      `视频高清只提供 ${videoHdTierList(VIDEO_HD_SCALES, ' 倍')} 三档放大，`
        + `请求的 ${request.scale} 倍不在其中`,
    );
  }

  if (request.fps !== undefined && !(VIDEO_HD_FPS as readonly number[]).includes(request.fps)) {
    return refuse(
      'VIDEO_HD_FPS_UNSUPPORTED',
      `帧率只提供 ${videoHdTierList(VIDEO_HD_FPS, 'fps')} 三档（另有"自适应(原帧率)"即不传帧率），`
        + `请求的 ${request.fps}fps 不在其中`,
    );
  }

  /*
    整数倍在这里**先算一遍**，再交给管线跑。
    管线那边会做偶数对齐；如果对齐真的改动了尺寸，说明尺寸不再是整数倍——
    与其等到产物出来才发现，不如当场拒绝并说清是哪一步动了手脚。
  */
  const expectedWidth = facts.width * request.scale;
  const expectedHeight = facts.height * request.scale;

  const planned = planVideoPipeline({
    inputPath: request.inputPath,
    outputPath: request.outputPath,
    scale: request.scale,
    ...(request.fps === undefined ? {} : { fps: request.fps }),
    workDir: request.workDir,
  }, {
    width: facts.width,
    height: facts.height,
    fps: facts.fps,
    durationSeconds: facts.durationSeconds,
  });
  if (!planned.ok) return refuse(planned.code, planned.message);

  if (planned.plan.expected.width !== expectedWidth || planned.plan.expected.height !== expectedHeight) {
    return refuse(
      'VIDEO_HD_MULTIPLE_BROKEN',
      `管线承诺的 ${planned.plan.expected.width}×${planned.plan.expected.height} `
        + `不是源片 ${facts.width}×${facts.height} 的 ${request.scale} 倍整数倍`
        + `（应为 ${expectedWidth}×${expectedHeight}）`,
    );
  }

  const notes = [...planned.plan.notes];
  const targetFps = request.fps ?? facts.fps;
  if (request.fps === undefined) {
    notes.push(`帧率选的是「自适应(原帧率)」：保持 ${facts.fps}fps 不动，这一步只放大`);
  } else if (request.fps === facts.fps) {
    notes.push(
      `请求帧率与原片一致（都是 ${request.fps}fps）：这一步不会插帧，只是把帧率写上`,
    );
  } else if (request.fps > facts.fps * VIDEO_HD_FPS_HEADROOM) {
    notes.push('建议不超过原视频帧率的 4 倍，可能影响输出效果');
  }
  if (request.fps !== undefined && request.fps < facts.fps) {
    notes.push(`目标帧率 ${request.fps}fps 低于原片 ${facts.fps}fps：这是降帧，不是提帧`);
  }
  if (Math.max(expectedWidth, expectedHeight) > VIDEO_HD_MAX_SOURCE_LONG_SIDE * VIDEO_HD_SCALES[VIDEO_HD_SCALES.length - 1]!) {
    /*
      6 倍之后长边会到 12288。走的是本机插值而不是超分模型，
      说清楚它是什么：把像素插上去，不会凭空长出新细节。
    */
    notes.push('6 倍已经超过本机插值的合理范围：它是插值放大（不会长出新细节），真要补细节得走超分模型');
  }
  notes.push('这一条走本机 ffmpeg（插值放大 + 光流插帧），不花钱、不改项目事实');

  return {
    ok: true,
    plan: {
      pipeline: { steps: planned.plan.steps, expected: planned.plan.expected, notes },
      scale: request.scale,
      fps: targetFps,
      expectedWidth,
      expectedHeight,
    },
  };
}

/**
 * 真跑一条视频高清。

 * 直接转交给 VID-001 那条管线：**处理动作是同一套**（缩放 + 光流插帧），
 * 两处各写一份只会让"视频高清插帧"和"管线插帧"在某次改动后悄悄分叉。
 * 这里只多一件事——把失败也带上前面几步的耗时（定位哪一步慢、哪一步炸）。
 */
export async function runVideoHd(
  plan: VideoHdPlan,
  runner: VideoPipelineRunner,
): Promise<
  | { ok: true; steps: VideoPipelineStepTiming[]; totalElapsedMs: number }
  | { ok: false; code: string; message: string; steps: VideoPipelineStepTiming[]; totalElapsedMs: number }
> {
  const outcome = await runVideoPipeline(plan.pipeline, runner);
  if (outcome.ok) {
    return { ok: true, steps: outcome.timing.steps, totalElapsedMs: outcome.timing.totalElapsedMs };
  }
  return {
    ok: false,
    code: outcome.code,
    message: outcome.message,
    steps: outcome.timing.steps,
    totalElapsedMs: outcome.timing.totalElapsedMs,
  };
}

export interface VideoHdSpecCheck {
  field: 'width' | 'height' | 'fps';
  /** 这一项的口径（人类可读），验收报告里直接显示它 */
  criterion: string;
  expected: number;
  /** 实测值；读了 null 表示量不出来，那也算不达标 */
  actual: number | null;
  ok: boolean;
  /** 实测 ÷ 源，只有宽高有意义（用于核对"整数倍"） */
  multipleOfSource?: number | null;
}

/**
 * 零容差核对。

 * 与 VID-001 的 `compareSpec` 是**两把不同的尺子**，不要混用：

      VID-001  帧率容差 0.5、时长容差 4 帧 —— 那一条的口径里时长也要对得上，
               而光流插帧首尾会丢几帧，容差得按帧算；
      VID-005  分辨率必须**整数倍**、帧率必须**精确相等** —— 矩阵这一条就是这么写的。

  为什么这里能要求零容差：这一条只做缩放与插帧，不改时长、不重采样成 NTSC 那种
  `30000/1001` 的帧率，所以产物的帧率是个整数（实测 60/1）。
  真出现 29.97 之类的值，那说明这条产物的帧率根本不是被请求的那个——
  那正是要报出来的事，而不是靠容差把它盖过去。
 */
export function compareVideoHdSpec(
  facts: Pick<VideoHdFacts, 'width' | 'height'>,
  request: { scale: number; fps?: number | undefined; sourceFps: number },
  actual: { width: number | null; height: number | null; fps: number | null },
): VideoHdSpecCheck[] {
  const multiple = (value: number | null, source: number): number | null =>
    value === null || source <= 0 ? null : value / source;
  const expectedFps = request.fps ?? request.sourceFps;
  return [
    {
      field: 'width',
      criterion: `宽度 = 源宽 ${facts.width} × ${request.scale} 倍（恰为整数倍）`,
      expected: facts.width * request.scale,
      actual: actual.width,
      ok: actual.width === facts.width * request.scale,
      multipleOfSource: multiple(actual.width, facts.width),
    },
    {
      field: 'height',
      criterion: `高度 = 源高 ${facts.height} × ${request.scale} 倍（恰为整数倍）`,
      expected: facts.height * request.scale,
      actual: actual.height,
      ok: actual.height === facts.height * request.scale,
      multipleOfSource: multiple(actual.height, facts.height),
    },
    {
      field: 'fps',
      criterion: request.fps === undefined
        ? `帧率保持原片 ${expectedFps}（没有请求提帧）`
        : `帧率精确等于 ${request.fps}（误差 0）`,
      expected: expectedFps,
      actual: actual.fps,
      ok: actual.fps !== null && Math.abs(actual.fps - expectedFps) < 1e-9,
    },
  ];
}

export type VideoHdSpecVerdict =
  | { ok: true; checks: VideoHdSpecCheck[]; correctRate: string }
  | { ok: false; checks: VideoHdSpecCheck[]; correctRate: string; message: string };

/**
 * 规格不符时**给出可行动的那句话**，而不是返回一个 false 让上层自己编。

 * 这就是矩阵要的"明确报错而非静默降级"：产物已经跑出来了，
 * 但它不是用户要的那一个——那必须说清是宽、是高、还是帧率不对，
 * 以及实测是多少。只说"处理失败"的话，用户唯一能做的就是再点一次。
 */
export function judgeVideoHdSpec(checks: readonly VideoHdSpecCheck[]): VideoHdSpecVerdict {
  const passed = checks.filter((check) => check.ok).length;
  const correctRate = `${passed}/${checks.length}`;
  const failures = checks.filter((check) => !check.ok);
  if (failures.length === 0) return { ok: true, checks: [...checks], correctRate };
  const detail = failures
    .map((check) => `${check.field}：应为 ${check.expected}，实测 ${check.actual === null ? '读不出' : check.actual}`)
    .join('；');
  return {
    ok: false,
    checks: [...checks],
    correctRate,
    message: `产物规格与请求不符（${correctRate}）：${detail}。这条产物不作为结果入库`,
  };
}

/** 一次问全超分要用到的事实：宽、高、帧率、时长、字节数、扩展名。 */
export function videoHdProbeArgs(path: string): string[] {
  return [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate',
    '-show_entries', 'format=duration',
    '-of', 'json',
    path,
  ];
}

/** 把 `avg_frame_rate`（`60/1` / `30000/1001`）解析成数字；解析不出来返回 null。 */
export function parseFrameRate(raw: unknown): number | null {
  const [numerator, denominator] = String(raw ?? '').split('/').map((part) => Number(part));
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const value = (numerator as number) / (denominator as number);
  return value > 0 ? value : null;
}

/** 解析 ffprobe 的输出。任一项读不出就返回 null——调用方据此拒绝开工。 */
export function parseVideoHdProbe(stdout: string, path: string): VideoHdFacts | null {
  let parsed: {
    streams?: Array<{ width?: unknown; height?: unknown; avg_frame_rate?: unknown }>;
    format?: { duration?: unknown };
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return null;
  }
  const stream = parsed.streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const duration = Number(parsed.format?.duration);
  const fps = parseFrameRate(stream?.avg_frame_rate);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (!Number.isFinite(duration) || duration <= 0 || fps === null) return null;
  let bytes: number | null = null;
  try {
    bytes = statSync(path).size;
  } catch {
    bytes = null;
  }
  return {
    width: Math.round(width),
    height: Math.round(height),
    fps,
    durationSeconds: duration,
    bytes,
    extension: extname(path).replace(/^\./, '').toLowerCase(),
  };
}

/** 真去问一次 ffprobe。 */
export async function probeVideoHdFacts(path: string): Promise<VideoHdFacts | null> {
  const output = await new Promise<{ ok: boolean; stdout: string }>((resolve) => {
    execFile('ffprobe', videoHdProbeArgs(path), { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: error === null, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
  if (!output.ok) return null;
  return parseVideoHdProbe(output.stdout, path);
}

/**
 * 真子进程版的 runner。

 * 主进程用它；验收用例用 `execFileSync` 自己包一个（这样"跑失败"的 stderr
 * 能原样带进断言消息里）。两处都只实现同一个 `VideoPipelineRunner` 接口——
 * 管线本身不知道是谁在跑它，这也是"单镜耗时记录"能跨环境一致的原因。

 * 失败时只留 stderr 的**最后三行**：`-loglevel error` 下真正的原因都在那儿，
 * 而整段 stderr 里前面全是版本号与配置信息，直接甩给用户等于没说。
 */
export function createFfmpegRunner(): VideoPipelineRunner {
  return {
    run: (args, cwd) => new Promise((resolve) => {
      execFile(
        'ffmpeg',
        [...args],
        {
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          ...(cwd === undefined ? {} : { cwd }),
        },
        (error, _stdout, stderr) => {
          if (error === null) return resolve({ ok: true });
          const tail = String(stderr ?? '').trim().split('\n').slice(-3).join(' ').trim();
          resolve({
            ok: false,
            failure: tail === '' ? (error instanceof Error ? error.message : String(error)) : tail,
          });
        },
      );
    }),
    now: () => Date.now(),
    stamp: () => new Date().toISOString(),
  };
}

/** 产物相对路径。放在 `derived/` 下，与别的本机加工产物同一处。 */
export function videoHdOutputRelativePath(stamp: string, scale: number, fps: number): string {
  return `derived/hd-${stamp}-${scale}x-${fps}fps.mp4`;
}
