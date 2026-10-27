import type {
  BackendImageRequest,
  BackendImageUpscaleRequest,
  BackendAudioRequest,
  BackendMedia,
  BackendVideoEditRequest,
  BackendVideoRequest,
  GenerationBackend,
  ProviderCost,
} from '@qiyin/generation-backend';
import { UnsupportedCapabilityError, describeParameterNotes } from '@qiyin/generation-backend';
import { ImageGenAdapter, isTerminal, type ImageGenQueryResult, type ImageGenSubmit } from './adapter.js';
import { ImageGenCommandError } from './errors.js';

/* ============================================================
   期音科技 · 图像生成服务生成后端
   ------------------------------------------------------------
   图像生成服务是异步任务：提交只是「被受理」，不是「成功」。因此这个后端里
   最要紧的两件事是——

     1. **不把 submit 当结果**。`gen_status=querying` 只说明收下了，
        真正的结论要等 success / fail；
     2. **等不到终态要如实报出来**，带上 submit_id——那个 id 是用户
        之后自己去 `imagegen query_result` 追问的唯一线索。

   与 小QTV 后端相比，它多报一样东西：**真实花费**。图像生成服务在返回体里给
   `credit_count`，所以账目不用再靠调用方猜。单位是「积分」——
   积分与人民币的换算官方没有公开，因此这里原样报积分，
   而不是假装知道汇率去凑一个「分」。
   ============================================================ */

export interface ImageGenBackendOptions {
  /** 图片任务等待终态的上限。 */
  imageTimeoutMs?: number;
  /** 视频任务等待终态的上限；视频经常要几分钟。 */
  videoTimeoutMs?: number;
  pollIntervalMs?: number;
  /** 提交时让 CLI 自己先等一会儿，减少往返次数。 */
  submitPollSeconds?: number;
  /** 仅供测试注入。 */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  imageTimeoutMs: 5 * 60_000,
  videoTimeoutMs: 15 * 60_000,
  pollIntervalMs: 5_000,
  submitPollSeconds: 20,
} as const;

/** 我们把清晰度统一写成 `1K`/`2K`；图像生成服务要的是小写 `1k`/`2k`。 */
function normalizeQuality(quality: string | undefined): string {
  if (quality === undefined) return '2k';
  return quality.toLowerCase();
}

/**
 * 图生图那一路的清晰度。
 *
 * 与文生图**不能共用**一个函数：`imagegen image2image -h` 写明
 * 4.0–5.0 只认 `2k|4k`，而文生图那条路我们允许写 `1K`。
 * 那时候用户已经等了一轮。所以这里按模型的合法集合夹一次，默认 `2k`。
 */
function normalizeImage2ImageQuality(quality: string | undefined, modelVersion: string | undefined): string {
  const allowed = modelVersion === '5.0Pro' ? ['1.5k', '2k', '4k'] : ['2k', '4k'];
  const wanted = quality === undefined ? '2k' : quality.toLowerCase();
  return allowed.includes(wanted) ? wanted : '2k';
}

/**
 * 高清放大的档位。
 *
 * `imagegen image_upscale -h` 写明只支持 `2k / 4k / 8k`，
 * 所以这里按同一套规矩夹一次，认不出来就退回 `2k`（最便宜的一档）。
 */
export const UPSCALE_RESOLUTIONS = ['2k', '4k', '8k'] as const;

function normalizeUpscaleResolution(resolution: string | undefined): string {
  const wanted = resolution === undefined ? '2k' : resolution.toLowerCase();
  return (UPSCALE_RESOLUTIONS as readonly string[]).includes(wanted) ? wanted : '2k';
}

export function createImageGenBackend(
  adapter: ImageGenAdapter,
  options: ImageGenBackendOptions = {},
): GenerationBackend {
  const imageTimeoutMs = options.imageTimeoutMs ?? DEFAULTS.imageTimeoutMs;
  const videoTimeoutMs = options.videoTimeoutMs ?? DEFAULTS.videoTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const submitPollSeconds = options.submitPollSeconds ?? DEFAULTS.submitPollSeconds;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /**
   * 图像生成服务这条后端**目前不按参数透传**：它用的是自己那套命令参数
   * （`resolutionType` / `ratio` / `durationSeconds` …），画布下来的那一包会被忽略。
   *
   * 所以这里如实说一句"忽略了哪些"。悄悄忽略正是最坏的那种——
   * 用户会以为面板上那些设置生效了。
   * （把这一包**映射**到图像生成服务的命令参数是下一步，那时这段注释与这句话一起改。）
   */
  function ignoredSettingsNote(settings: Record<string, string | number | boolean> | undefined): string[] {
    const keys = Object.keys(settings ?? {});
    return describeParameterNotes({ ignored: keys });
  }

  /** 轮询到终态；期间任何一次查询失败都不改变「任务是否还在跑」这个事实。 */
  async function settle(submit: ImageGenSubmit, timeoutMs: number): Promise<ImageGenQueryResult> {
    let current: ImageGenQueryResult = {
      submit_id: submit.submit_id,
      gen_status: submit.gen_status,
      ...(submit.fail_reason === undefined ? {} : { fail_reason: submit.fail_reason }),
      ...(submit.credit_count === undefined ? {} : { credit_count: submit.credit_count }),
    };
    const deadline = Date.now() + timeoutMs;
    while (!isTerminal(current.gen_status)) {
      if (Date.now() >= deadline) {
        /**
         * 超出等待上限**不是失败**：任务可能还在跑。所以错误里必须带 submit_id，
         * 让调用方能接着追问，而不是把它当成一次白花钱的失败丢掉。
         */
        throw new ImageGenCommandError(
          `图像生成服务任务 ${submit.submit_id} 在 ${Math.round(timeoutMs / 1000)}s 内没有到达终态（当前 ${current.gen_status}）；`
          + `可用 imagegen query_result --submit_id=${submit.submit_id} 继续追问`,
          0,
          { submit_id: submit.submit_id, gen_status: current.gen_status },
        );
      }
      await sleep(pollIntervalMs);
      current = await adapter.queryResult({ submitId: submit.submit_id });
    }
    if (current.gen_status !== 'success') {
      throw new ImageGenCommandError(
        `图像生成服务任务失败：${current.fail_reason ?? '上游未给出原因'}`,
        1,
        { submit_id: current.submit_id, fail_reason: current.fail_reason ?? null },
      );
    }
    return current;
  }

  /** 终态成功之后才下载；`path` 是 CLI 写回的本地绝对路径。 */
  async function collect(submitId: string, outputDir: string): Promise<{ files: string[]; result: ImageGenQueryResult }> {
    const result = await adapter.queryResult({ submitId, downloadDir: outputDir });
    const files = [
      ...(result.result_json?.images ?? []).map((item) => item.path),
      ...(result.result_json?.videos ?? []).map((item) => item.path),
    ].filter((path): path is string => typeof path === 'string' && path.length > 0);
    if (files.length === 0) {
      throw new ImageGenCommandError(
        `图像生成服务任务 ${submitId} 报成功，但没有落盘任何文件`,
        1,
        { submit_id: submitId },
      );
    }
    return { files, result };
  }

  function costOf(...readings: Array<number | undefined>): ProviderCost | null {
    for (const value of readings) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return { amount: value, unit: 'credit' };
      }
    }
    return null;
  }

  function sourceUrlOf(result: ImageGenQueryResult): string | null {
    const image = result.result_json?.images?.[0]?.image_url;
    if (typeof image === 'string' && image.length > 0) return image;
    const video = result.result_json?.videos?.[0]?.video_url;
    return typeof video === 'string' && video.length > 0 ? video : null;
  }

  return {
    id: 'imagegen',
    label: '图像生成服务',
    /*
      图像生成服务这套 CLI 的能力面里**没有**"以视频为输入的重生成"
      （它只有 text2image / image2video 两条提交路径，见 adapter 的 submit* 方法）。
      所以 videoEdit 如实声明为 false——界面据此让按钮不可用并说明原因，
      而不是让用户点下去、等到一个 CLI 报的"未知参数"。
    */
    /*
      图像生成服务这套 CLI 也没有"场景化图片能力"那一排（多机位九宫格 / 三视图 / 光影校正）
      ——它只有 text2image 与 image2video 两条提交路径。所以如实声明为 false。
    */
    /*
      图片高清放大是**图像生成服务这边唯一独占的能力**：小QTV CLI 的 16 个图片场景里
      没有放大项，根命令也没有对应子命令。所以这一档只有它声明 true。
    */
    capabilities: {
      image: true, videoFromImage: true, videoEdit: false,
      imageShortcut: false, imageUpscale: true,
      /* 图像生成服务的 CLI 能面里没有音频生成：如实声明 false（界面据此不给入口） */
      audioSpeech: false, audioMusic: false,
    },

    async generateAudio(request: BackendAudioRequest): Promise<BackendMedia> {
      throw new UnsupportedCapabilityError(this.label, request.kind === 'music' ? 'audioMusic' : 'audioSpeech');
    },

    async generateImage(request: BackendImageRequest): Promise<BackendMedia> {
      /*
        有参考图走图生图（`image2image`），没有就走文生图（`text2image`）。
        两者在图像生成服务那边是**两个子命令**，参数也不完全一样，
        所以分支写在这里而不是让调用方去选。
      */
      /*
        多参考槽位（VID-010）：图像生成服务的 `image2image` 这里只提交一张参考图
        （我们的适配器就是这么接的），所以只送第 1 张，并把这件事写进 notes。
      */
      const referenceFiles = request.referenceImageFiles ?? (request.referenceImageFile === undefined ? [] : [request.referenceImageFile]);
      const referenceNotes = referenceFiles.length > 1
        ? [`图像生成服务这条通路只提交 1 张参考图，只用了第 1 张（共给了 ${referenceFiles.length} 张）`]
        : [];
      const submit = referenceFiles[0] === undefined
        ? await adapter.submitText2Image({
          prompt: request.prompt,
          modelVersion: request.model,
          resolutionType: normalizeQuality(request.quality),
          // 省略 ratio 时图像生成服务默认 16:9；我们总是在有参考片时显式给出画幅
          ...(request.ratio === undefined ? {} : { ratio: request.ratio }),
          pollSeconds: submitPollSeconds,
        })
        : await adapter.submitImage2Image({
          images: [referenceFiles[0]],
          prompt: request.prompt,
          modelVersion: request.model,
          resolutionType: normalizeImage2ImageQuality(request.quality, request.model),
          ...(request.ratio === undefined ? {} : { ratio: request.ratio }),
          pollSeconds: submitPollSeconds,
        });
      const settled = await settle(submit, imageTimeoutMs);
      const { files, result } = await collect(submit.submit_id, request.outputDir);
      return {
        files,
        source_url: sourceUrlOf(result),
        task_ref: submit.submit_id,
        cost: costOf(result.credit_count, settled.credit_count, submit.credit_count),
        notes: [...ignoredSettingsNote(request.settings), ...referenceNotes],
      };
    },

    /**
     * 图像生成服务不支持视频重拍。
     *
     * 抛错而不是"退化成像图生视频"：那会产出**一段完全不同的视频**，
     * 而用户在界面上点的是"重拍这一小段"——两者差别大到不能互相顶替。
     */
    async editVideo(_request: BackendVideoEditRequest): Promise<BackendMedia> {
      throw new UnsupportedCapabilityError('图像生成服务', 'videoEdit');
    },

    /** 图像生成服务不支持场景化图片能力。 */
    async applyImageShortcut(): Promise<BackendMedia> {
      throw new UnsupportedCapabilityError('图像生成服务', 'imageShortcut');
    },

    /** 图片高清放大（`imagegen image_upscale`）。 */
    async upscaleImage(request: BackendImageUpscaleRequest): Promise<BackendMedia> {
      const submit = await adapter.submitImageUpscale({
        image: request.imageFile,
        resolutionType: normalizeUpscaleResolution(request.resolution),
        pollSeconds: submitPollSeconds,
      });
      const settled = await settle(submit, imageTimeoutMs);
      const { files, result } = await collect(submit.submit_id, request.outputDir);
      return {
        files,
        source_url: sourceUrlOf(result),
        task_ref: submit.submit_id,
        cost: costOf(result.credit_count, settled.credit_count, submit.credit_count),
        /* 放大这条路不接受画布参数（参数由后端自己决定：只挑清晰度） */
        notes: [],
      };
    },

    async generateVideoFromImage(request: BackendVideoRequest): Promise<BackendMedia> {
      const submit = await adapter.submitImage2Video({
        image: request.imageFile,
        prompt: request.prompt ?? '',
        videoResolution: request.resolution ?? '720p',
        modelVersion: request.model,
        // 省略即「跟随首帧」；seedance2.5 由适配器判断后不会传
        ...(request.ratio === undefined ? {} : { ratio: request.ratio }),
        durationSeconds: request.durationSeconds,
        pollSeconds: submitPollSeconds,
      });
      const settled = await settle(submit, videoTimeoutMs);
      const { files, result } = await collect(submit.submit_id, request.outputDir);
      return {
        files,
        source_url: sourceUrlOf(result),
        task_ref: submit.submit_id,
        cost: costOf(result.credit_count, settled.credit_count, submit.credit_count),
        notes: ignoredSettingsNote(request.settings),
      };
    },
  };
}
