import type {
  BackendAudioRequest,
  BackendImageRequest,
  BackendImageShortcutRequest,
  BackendImageUpscaleRequest,
  BackendMedia,
  BackendVideoEditRequest,
  BackendVideoRequest,
  GenerationBackend,
  GenerationCapabilities,
} from '@qiyin/generation-backend';
import { UnsupportedCapabilityError } from '@qiyin/generation-backend';
import { VideogenAdapter, type VideogenArtifact, type VideogenChatResult } from './adapter.js';

/* ============================================================
  期音科技 · 视频生成服务 生成后端
   ------------------------------------------------------------
   与另两家最大的不同：**视频生成服务 是 agent 驱动的**——我们交出去的不是
   "模型 + 一串参数"，而是**一句话**；它自己决定调哪些工具。

   这带来一条必须写在明面上的限制：

     参数（比例 / 清晰度 / 时长）在这里是**拼进那句话**的，不是按字段透传的。
     agent 有可能不照做（它可能换模型、可能只做一部分）。
     所以这一层把这些参数列进 `notes`，并如实说"是当自然语言交给它的"——
     悄悄当成功，正是这个仓库最反对的事。

   另外两处如实转达：
     · 它那边"跑完但没有产物"是用 `generation_succeeded: false` 说的（内容审核拒了
       / 超时 / 模型没调生成工具都可能），我们不抹平；
     · 它不报花费（`cost` 一律 null）——这与"花费为 0"是两件事。
   ============================================================ */

export interface VideogenBackendOptions {
  /** 图片任务的上限；视频生成服务 是 agent，比单模型慢，默认给足 8 分钟。 */
  imageTimeoutMs?: number;
  /** 视频任务的上限。 */
  videoTimeoutMs?: number;
  /** 让它优先用哪些模型（它自己的 `--prefer-models`）。 */
  preferModels?: readonly string[];
  /** 复用同一条 thread（多镜同一场景时上下文连续）。 */
  threadId?: string;
}

const DEFAULTS = {
  imageTimeoutMs: 8 * 60_000,
  videoTimeoutMs: 20 * 60_000,
} as const;

/** 把请求里的结构化参数拼成一句人话（agent 驱动后端的参数就是这么给的）。 */
function describeRequest(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.trim() !== '').join('，');
}

/** 把它的产物按类型挑出来：挑不到就如实说，不拿别的类型凑数。 */
function pickByType(artifacts: readonly VideogenArtifact[], kinds: readonly string[], label: string): VideogenArtifact[] {
  const matched = artifacts.filter((artifact) => kinds.includes(artifact.type));
  if (matched.length === 0) {
    const seen = [...new Set(artifacts.map((artifact) => artifact.type))].join('、') || '（没有产物）';
    throw new Error(`${label}：视频生成服务 交回来的产物类型是「${seen}」，没有我们要的那种`);
  }
  return matched;
}

/** 把一次 chat 的结果翻成后端要的形状。 */
function toMedia(result: VideogenChatResult, artifacts: readonly VideogenArtifact[], notes: string[]): BackendMedia {
  const files = artifacts
    .map((artifact) => artifact.localPath)
    .filter((path): path is string => path !== null);
  if (files.length === 0) {
    throw new Error('视频生成服务 给了产物但没有落盘文件：检查 --download 与 --output-dir 是否生效');
  }
  return {
    files: [...files],
    source_url: artifacts[0]?.url ?? null,
    /* thread_id 是人工追查的唯一线索（可以去 视频生成服务 里接着聊） */
    task_ref: result.threadId === '' ? null : result.threadId,
    /* 它不报花费——null 与"0 元"是两件事，别混 */
    cost: null,
    notes: [...notes, ...(result.warning === null ? [] : [result.warning])],
  };
}

export function createVideogenBackend(
  adapter: VideogenAdapter,
  options: VideogenBackendOptions = {},
): GenerationBackend {
  const imageTimeoutMs = options.imageTimeoutMs ?? DEFAULTS.imageTimeoutMs;
  const videoTimeoutMs = options.videoTimeoutMs ?? DEFAULTS.videoTimeoutMs;

  /** 参数是以自然语言交出去的——如实说出来，别让用户以为它们按字段生效了。 */
  function settingNotes(request: { settings?: Record<string, string | number | boolean> }): string[] {
    const keys = Object.keys(request.settings ?? {});
    if (keys.length === 0) return [];
    return [`这些参数是拼进提示词交给 视频生成服务 的（它是 agent 驱动，不按字段透传）：${keys.join('、')}`];
  }

  const capabilities: GenerationCapabilities = {
    image: true,
    videoFromImage: true,
    /*
      视频重拍：官方能力清单里写的是"图片/视频编辑（放大、重构图、风格转移）"，
      **没有**写"以已有片段为输入按提示词局部重生成"这件事。没验证过就不宣称支持——
      宣称了却做不到，用户会以为改动生效了。
    */
    videoEdit: false,
    /* 场景化能力（多机位九宫格 / 三视图 / 光影校正）是 小QTV 的 tool_spec 概念，视频生成服务 没有 */
    imageShortcut: false,
    imageUpscale: true,
    /*
      视频生成服务 是 agent 驱动的（我们发提示词、它自己决定调什么工具），
      这条路上**没法保证**它一定产出音频，也没法指定音色——
      "可能偶尔会做"不等于支持，所以如实声明 false。
    */
    audioSpeech: false, audioMusic: false,
  };

  return {
    id: 'videogen',
    label: 'Videogen',
    capabilities,

    async generateAudio(request: BackendAudioRequest): Promise<BackendMedia> {
      throw new UnsupportedCapabilityError(this.label, request.kind === 'music' ? 'audioMusic' : 'audioSpeech');
    },

    async generateImage(request: BackendImageRequest): Promise<BackendMedia> {
      const prompt = describeRequest([
        request.prompt,
        request.ratio === undefined ? undefined : `画幅 ${request.ratio}`,
        request.quality === undefined ? undefined : `清晰度 ${request.quality}`,
      ]);
      const result = await adapter.chat({
        prompt,
        outputDir: request.outputDir,
        ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
        /*
          多参考槽位（VID-010）：视频生成服务 这条路**真的能收多张**——
          它的 CLI 本来就有 `--attachments`（可以给多次），所以按顺序全部传下去，
          顺序也就是提示词里说的"第 1 张 / 第 2 张"。
        */
        ...(() => {
          const files = request.referenceImageFiles ?? (request.referenceImageFile === undefined ? [] : [request.referenceImageFile]);
          return files.length === 0 ? {} : { attachments: [...files] };
        })(),
        ...(options.preferModels === undefined ? {} : { preferModels: options.preferModels }),
        timeoutMs: imageTimeoutMs,
      });
      const artifacts = pickByType(result.artifacts, ['image'], '出图');
      return toMedia(result, artifacts, settingNotes(request));
    },

    async generateVideoFromImage(request: BackendVideoRequest): Promise<BackendMedia> {
      const prompt = describeRequest([
        request.prompt,
        `时长 ${request.durationSeconds} 秒`,
        request.ratio === undefined ? undefined : `画幅 ${request.ratio}`,
        request.resolution === undefined ? undefined : `清晰度 ${request.resolution}`,
      ]);
      const result = await adapter.chat({
        prompt,
        outputDir: request.outputDir,
        /* 首帧是**必须**传下去的：不给它，出来的就不是"这段画面动起来" */
        attachments: [request.imageFile],
        ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
        ...(options.preferModels === undefined ? {} : { preferModels: options.preferModels }),
        timeoutMs: videoTimeoutMs,
      });
      const artifacts = pickByType(result.artifacts, ['video'], '图生视频');
      return toMedia(result, artifacts, settingNotes(request));
    },

    async upscaleImage(request: BackendImageUpscaleRequest): Promise<BackendMedia> {
      const prompt = describeRequest([
        '把这张图做高清放大',
        request.resolution === undefined ? undefined : `目标 ${request.resolution}`,
      ]);
      const result = await adapter.chat({
        prompt,
        outputDir: request.outputDir,
        attachments: [request.imageFile],
        ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
        timeoutMs: imageTimeoutMs,
      });
      const artifacts = pickByType(result.artifacts, ['image'], '高清放大');
      return toMedia(result, artifacts, []);
    },

    editVideo(_request: BackendVideoEditRequest): Promise<BackendMedia> {
      return Promise.reject(new UnsupportedCapabilityError('Videogen', 'videoEdit'));
    },

    applyImageShortcut(_request: BackendImageShortcutRequest): Promise<BackendMedia> {
      return Promise.reject(new UnsupportedCapabilityError('Videogen', 'imageShortcut'));
    },
  };
}
