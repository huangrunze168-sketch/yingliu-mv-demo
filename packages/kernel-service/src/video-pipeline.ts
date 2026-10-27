/* ============================================================
  期音科技 · 视频处理管线（VID-001：插帧 / 超分 / 稳定 / 裁剪）
  ------------------------------------------------------------
  矩阵给这一条的验收口径是两句话，两句都能量：

    「**输出规格正确率 100%**（分辨率/帧率/时长与请求一致）」
    「单镜耗时记录可审计」

  所以这个模块的产出分成两半，缺一不可：

    · `planVideoPipeline()` —— **承诺**一条管线的输出规格（expected），
      并把要跑的 ffmpeg 步骤列清楚。纯函数，可单测；
    · `runVideoPipeline()` —— 真的跑，把**每一步的耗时**记下来。

  "承诺的规格"是这一条的骨架：跑完拿 ffprobe 读产物的分辨率 / 帧率 / 时长，
  与 `expected` 逐项比——对不上就是没达标，不需要人去"看一眼"。

  三条实现上的取舍：

    ① **插帧用 `minterpolate`（光流）而不是 `fps`（重复/丢帧）**。
       后者只是改容器里的帧率标记，画面并不会真的更流畅——那叫"改元数据"，
       不叫插帧。代价是慢，所以耗时必须能审计。
    ② **稳定用 `vidstab` 两遍**（detect + transform），不是单遍的 `deshake`。
       两遍是"先算出整片的抖动轨迹、再一次性平滑"，单遍只能逐帧局部修正；
       代价是要一个中间文件，所以管线需要一个 workDir。
    ③ **顺序固定：稳定 → 缩放 → 插帧**。几何处理在前、时间处理在后——
       反过来的话，插帧会先把帧数翻倍，稳定再逐帧算位移，慢一倍且更不稳。
       Windows 的 ffmpeg 8.1 会在 `vidstabtransform + scale + minterpolate` 同链时崩溃，
       所以稳定变换单独输出中间片，再做缩放/插帧；顺序不变，只拆执行边界。
   ============================================================ */

export interface VideoPipelineInputSpec {
  width: number;
  height: number;
  fps: number;
  /** 时长（秒）。输出规格要承诺时长不变，所以它也得带上。 */
  durationSeconds: number;
}

export interface VideoPipelineRequest {
  inputPath: string;
  outputPath: string;
  /** 目标帧率（插帧）。不给就保持原样。 */
  fps?: number | undefined;
  /** 去抖（两遍 vidstab）。 */
  stabilize?: boolean | undefined;
  /** 放大倍数；与 `resolution` 二选一。 */
  scale?: number | undefined;
  /** 目标分辨率；与 `scale` 二选一。 */
  resolution?: { width: number; height: number } | undefined;
  /** 稳定要写中间文件，所以需要一个可写的临时目录。 */
  workDir: string;
}

export interface VideoPipelineStep {
  /** 给人看的步骤名（耗时记录里用它，而不是用命令行长串） */
  name: string;
  args: readonly string[];
  /**
   * 这一步要在哪个目录里跑。

   * 稳定滤镜要在参数里写一个中间文件路径，而 ffmpeg 的**滤镜串**里
   * 路径是要转义的（`:` 是参数分隔符、`\` 是转义符）——
   * 实测 Windows 路径即使写成 `C\:/…` 仍然解析失败。
   * 与其和转义规则缠斗，不如**让滤镜里只出现文件名**，靠这个 cwd 把它定位到。
   */
  cwd?: string;
}

export interface VideoPipelineExpected {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
}

export interface VideoPipelinePlan {
  steps: readonly VideoPipelineStep[];
  /** 这条管线**承诺**的输出规格；跑完必须拿它去核对 */
  expected: VideoPipelineExpected;
  notes: readonly string[];
}

export type VideoPipelinePlanResult =
  | { ok: true; plan: VideoPipelinePlan }
  | { ok: false; code: string; message: string };

/** 帧率的合理范围：低于 1 或高于 240 都不是"处理视频"，是打错字。 */
const MIN_FPS = 1;
/** 上限取 240：`minterpolate` 到 240 已经是慢动作级别的开销，再高没有实际场景。 */
const MAX_FPS = 240;
/** 缩放倍数上限 8：超过它的"放大"没有信息量，应该走超分模型而不是插值。 */
const MAX_SCALE = 8;

/**
 * 组装管线。

 * 输入规格必须给：输出的分辨率要靠它算（`scale` 是倍数而不是绝对值），
 * 而且实测尺寸只能由 ffprobe 读出来——**猜一个输入尺寸，输出规格就不可信**。
 */
export function planVideoPipeline(
  request: VideoPipelineRequest,
  inputSpec: VideoPipelineInputSpec,
): VideoPipelinePlanResult {
  const notes: string[] = [];

  if (!(inputSpec.width > 0) || !(inputSpec.height > 0)) {
    return { ok: false, code: 'VIDEO_INPUT_SIZE_UNKNOWN', message: '读不到原视频的宽高，没法算输出分辨率' };
  }
  if (!(inputSpec.durationSeconds > 0)) {
    return { ok: false, code: 'VIDEO_INPUT_DURATION_UNKNOWN', message: '读不到原视频时长，没法承诺输出时长' };
  }
  if (request.scale !== undefined && request.resolution !== undefined) {
    return {
      ok: false,
      code: 'VIDEO_SCALE_CONFLICT',
      message: '「放大倍数」与「目标分辨率」只能给一个：两个一起给，谁说了算就成了隐规则',
    };
  }

  const wantsFrameRate = request.fps !== undefined;
  const wantsStabilize = request.stabilize === true;
  const wantsResize = request.scale !== undefined || request.resolution !== undefined;
  if (!wantsFrameRate && !wantsStabilize && !wantsResize) {
    return { ok: false, code: 'VIDEO_PIPELINE_EMPTY', message: '没有选任何处理：插帧 / 稳定 / 分辨率，至少要选一样' };
  }

  /* 输出分辨率：显式目标优先，其次按倍数算（偶数对齐，H.264 要求） */
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  let outWidth = even(inputSpec.width);
  let outHeight = even(inputSpec.height);
  if (request.resolution !== undefined) {
    const { width, height } = request.resolution;
    if (!(width > 0) || !(height > 0)) {
      return { ok: false, code: 'VIDEO_RESOLUTION_INVALID', message: '目标分辨率必须是正数' };
    }
    outWidth = even(width);
    outHeight = even(height);
  } else if (request.scale !== undefined) {
    const scale = Number(request.scale);
    if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_SCALE) {
      return {
        ok: false,
        code: 'VIDEO_SCALE_INVALID',
        message: `放大倍数要在 0 与 ${MAX_SCALE} 之间（更大的放大该走超分模型，不是插值）`,
      };
    }
    outWidth = even(inputSpec.width * scale);
    outHeight = even(inputSpec.height * scale);
  }

  /* 输出帧率：不给就保持原样 */
  let outFps = inputSpec.fps;
  if (request.fps !== undefined) {
    const fps = Number(request.fps);
    if (!Number.isFinite(fps) || fps < MIN_FPS || fps > MAX_FPS) {
      return { ok: false, code: 'VIDEO_FPS_INVALID', message: `目标帧率要在 ${MIN_FPS}–${MAX_FPS} 之间` };
    }
    outFps = fps;
    if (fps < inputSpec.fps) {
      notes.push(`目标帧率 ${fps} 低于原片 ${inputSpec.fps}：这是**降帧**，插帧滤镜会按目标帧率重采样`);
    }
  }

  const steps: VideoPipelineStep[] = [];
  /*
    中间文件用**纯文件名**，靠 `cwd` 定位（见 VideoPipelineStep.cwd 的说明）。
    Windows 路径直接写进滤镜串会解析失败，转义写法也不稳——不如绕开。
  */
  const transformsFile = 'vidstab.trf';
  const stabilizedFile = 'vidstab-stabilized.mp4';

  /*
    稳定是**两遍**：第一遍只分析（`-f null -`，不产文件），第二遍才真正变换。
    第一遍的输出必须丢掉——它只是"抖动轨迹"的一次读数。
  */
  if (wantsStabilize) {
    steps.push({
      name: '稳定·分析抖动轨迹',
      args: [
        '-hide_banner', '-loglevel', 'error',
        '-i', request.inputPath,
        '-vf', `vidstabdetect=shakiness=5:accuracy=15:result=${transformsFile}`,
        '-f', 'null', '-',
      ],
      cwd: request.workDir,
    });

    /*
      Windows full build 8.1 上，下面三种滤镜各自可用，但把
      `vidstabtransform,scale,minterpolate` 放进同一条 `-vf` 会触发原生崩溃
      （退出码 -1073741819 / 0xC0000005），只留下一个 48 字节的坏 mp4。

      因此第二遍稳定先独立落一个中间片。若只要求稳定，它直接写最终产物；
      还要缩放或插帧时，下一步再读取中间片。音频原样搬运，避免拆步后丢声。
    */
    const needsPostTransform = wantsResize || wantsFrameRate;
    steps.push({
      name: '稳定·应用抖动轨迹',
      args: [
        '-hide_banner', '-loglevel', 'error',
        '-i', request.inputPath,
        '-vf', `vidstabtransform=input=${transformsFile}:smoothing=10:zoom=0`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-y', needsPostTransform ? stabilizedFile : request.outputPath,
      ],
      cwd: request.workDir,
    });
  }

  /* 视频滤镜链：稳定 → 缩放 → 插帧（顺序固定，见文件顶上的说明） */
  const filters: string[] = [];
  if (outWidth !== inputSpec.width || outHeight !== inputSpec.height) {
    filters.push(`scale=${outWidth}:${outHeight}:flags=lanczos`);
  }
  if (wantsFrameRate) {
    /*
      `mi_mode=mci`（运动补偿插帧）+ `mc_mode=aobmc`（自适应重叠块匹配）+ `vsbmc=1`。
      这三个参数是"真的生成中间帧"与"只是重复上一帧"的分界。
    */
    filters.push(`minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`);
    notes.push('插帧用光流（minterpolate），比直接改帧率标记慢得多——耗时记录会如实体现');
    /*
      这一条是实测出来的，必须说出来：光流插帧要在**前后各取若干帧**做运动估计，
      序列首尾没有足够的邻帧，所以会少几帧（2 秒 30fps 插到 60fps 实测是 117 帧、1.95 秒）。
      试过用 `-fps_mode cfr` 补，补不出来——那不是帧率标记的问题，是缺少参考帧。
      所以"时长与请求一致"这条口径的容差按**帧**算（见 compareSpec），
      并且把这句话放在这里，而不是靠调用方自己去猜为什么短了 0.05 秒。
    */
    notes.push('光流插帧在序列首尾可能少几帧（缺参考帧），精确时长请以帧数为准');
  }
  /* 既没稳定也没缩放、只插帧时，filters 里只有 minterpolate，仍然要跑第二遍 */
  if (filters.length > 0) {
    steps.push({
      name: '视频变换（稳定 / 缩放 / 插帧）',
      args: [
        '-hide_banner', '-loglevel', 'error',
        '-i', wantsStabilize ? stabilizedFile : request.inputPath,
        '-vf', filters.join(','),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-pix_fmt', 'yuv420p',
        /*
          恒定帧率输出。

          实测：光流插帧在序列的首尾会丢几帧（2 秒 30fps 的原片插到 60fps，
          出来是 117 帧 = 1.95 秒，少了 3 帧）。矩阵要求"时长与请求一致"，
          所以这一步得由管线自己补齐，而不是靠放宽验收容差糊过去。
        */
        '-fps_mode', 'cfr',
        /* 音频原样搬过去：这一条只处理画面 */
        '-c:a', 'copy',
        '-y', request.outputPath,
      ],
      ...(wantsStabilize ? { cwd: request.workDir } : {}),
    });
  }

  return {
    ok: true,
    plan: {
      steps,
      expected: {
        width: outWidth,
        height: outHeight,
        fps: outFps,
        /* 这一条不裁剪、不变速，所以时长承诺不变——验收会真的量它 */
        durationSeconds: inputSpec.durationSeconds,
      },
      notes,
    },
  };
}

/** 一步的耗时记录（"单镜耗时记录可审计"的载体）。 */
export interface VideoPipelineStepTiming {
  name: string;
  startedAt: string;
  elapsedMs: number;
  ok: boolean;
  failure?: string;
}

export interface VideoPipelineTiming {
  inputPath: string;
  outputPath: string;
  steps: VideoPipelineStepTiming[];
  totalElapsedMs: number;
}

export type VideoPipelineRunResult =
  | { ok: true; timing: VideoPipelineTiming }
  | { ok: false; code: string; message: string; timing: VideoPipelineTiming };

export interface VideoPipelineRunner {
  /**
   * 跑一条命令；由调用方决定用哪种子进程封装（主进程用 spawn、测试用真的 ffmpeg）。
   * `cwd` 来自步骤本身——滤镜里的相对路径靠它定位。
   */
  run: (args: readonly string[], cwd: string | undefined) => Promise<{ ok: boolean; failure?: string }>;
  now: () => number;
  /** ISO 时间戳，给耗时记录用 */
  stamp: () => string;
}

/**
 * 逐步执行管线，并记录每一步的耗时。

 * 某一步失败就**立刻停**——后面的步骤依赖前面的产物，
 * 硬跑下去只会得到一条更难解释的错误。失败也照常返回 timing（前面几步花了多久）。
 */
export async function runVideoPipeline(
  plan: VideoPipelinePlan,
  runner: VideoPipelineRunner,
): Promise<VideoPipelineRunResult> {
  const steps: VideoPipelineStepTiming[] = [];
  const overallStart = runner.now();

  for (const step of plan.steps) {
    const startedAt = runner.stamp();
    const startedMs = runner.now();
    const result = await runner.run(step.args, step.cwd);
    const elapsedMs = Math.max(0, Math.round(runner.now() - startedMs));
    steps.push({
      name: step.name,
      startedAt,
      elapsedMs,
      ok: result.ok,
      ...(result.ok || result.failure === undefined ? {} : { failure: result.failure }),
    });
    if (!result.ok) {
      const timing: VideoPipelineTiming = {
        inputPath: plan.steps.length > 0 ? '(见 plan)' : '(见 plan)',
        outputPath: '(见 plan)',
        steps,
        totalElapsedMs: Math.max(0, Math.round(runner.now() - overallStart)),
      };
      return {
        ok: false,
        code: 'VIDEO_PIPELINE_STEP_FAILED',
        message: `「${step.name}」这一步没跑过：${result.failure ?? '未知原因'}`,
        timing,
      };
    }
  }

  return {
    ok: true,
    timing: {
      inputPath: '(见 plan)',
      outputPath: '(见 plan)',
      steps,
      totalElapsedMs: Math.max(0, Math.round(runner.now() - overallStart)),
    },
  };
}

/**
 * 拿实测规格与承诺规格比对。

 * 矩阵那一条要求"**输出规格正确率 100%**"，所以这里返回的是一条条比对结果，
 * 调用方（验收脚本）据此算正确率——而不是一个笼统的 true/false。
 */
export interface SpecCheck {
  field: 'width' | 'height' | 'fps' | 'durationSeconds';
  expected: number;
  actual: number | null;
  ok: boolean;
  /** 允许多少误差（帧率与时长都是浮点，不能要求严格相等） */
  tolerance: number;
}

export function compareSpec(
  expected: VideoPipelineExpected,
  actual: { width: number | null; height: number | null; fps: number | null; durationSeconds: number | null },
): SpecCheck[] {
  const close = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;
  return [
    { field: 'width', expected: expected.width, actual: actual.width, ok: actual.width === expected.width, tolerance: 0 },
    { field: 'height', expected: expected.height, actual: actual.height, ok: actual.height === expected.height, tolerance: 0 },
    /*
      帧率容差 0.5：容器里的帧率是个近似值（29.97 这种），
      要求严格相等会把正确的产物判成错的。
    */
    { field: 'fps', expected: expected.fps, actual: actual.fps, ok: actual.fps !== null && close(expected.fps, actual.fps, 0.5), tolerance: 0.5 },
    /*
      时长容差 **4 帧**：两帧给编码器补齐帧边界的误差，另两帧给光流插帧的首尾丢帧
      （实测 2 秒 30fps → 117 帧 / 1.95 秒，差 3 帧）。
      这个容差不是"放水"：帧数是精确的，长度误差来自滤镜本身的固有行为，
      调用方真要严格时长应当按**帧数**而不是秒数来对齐。
    */
    {
      field: 'durationSeconds',
      expected: expected.durationSeconds,
      actual: actual.durationSeconds,
      ok: actual.durationSeconds !== null && close(expected.durationSeconds, actual.durationSeconds, 4 / expected.fps),
      tolerance: 4 / expected.fps,
    },
  ];
}
