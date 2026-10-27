import { existsSync } from 'node:fs';
import {
  UnsupportedCapabilityError,
  type BackendAudioRequest,
  type BackendImageRequest,
  type BackendMedia,
  type BackendSettings,
  type BackendVideoEditRequest,
  type BackendVideoRequest,
  type GenerationBackend,
  type GenerationCapabilities,
  type ProviderCost,
} from '@qiyin/generation-backend';
import type { PluginProviderDescriptor } from '@qiyin/plugin-host';

/* ============================================================
  期音科技 · 插件 Provider → 生成后端
   ------------------------------------------------------------
  这一层把"签名插件注册的 Provider"接到真实生成链路上：
  `GenerationService` 只认 `GenerationBackend` 这个端口，插件 Provider
  在这一层被包装成同一个端口，所以下游**一行都不用改**。

  三条口径：

    ① **能力来自清单声明，不来自运行**。`capabilities` 用插件清单里写的那些
       （清单是被签名覆盖的），所以界面在**不执行第三方代码**的前提下就能知道
       这个插件能不能出图、能不能重拍；
    ② **懒加载**：第一次真正用到这个后端时才 `import()` 插件。
       装了一堆插件不等于每次启动都把它们跑一遍；
    ③ **产物必须真的存在**。插件返回的文件路径我们会逐个 `existsSync` 检查，
       对不上就报错并点名是哪个插件——"报成功但其实没有文件"是这条链路上最贵的错误。
   ============================================================ */

export const PLUGIN_BACKEND_PREFIX = 'plugin:';

/**/
export function pluginBackendId(providerId: string): `plugin:${string}` {
  return `${PLUGIN_BACKEND_PREFIX}${providerId}`;
}

export function isPluginBackendId(id: string): id is `plugin:${string}` {
  return id.startsWith(PLUGIN_BACKEND_PREFIX) && id.length > PLUGIN_BACKEND_PREFIX.length;
}

export interface PluginBackendSource {
  /** 插件 id（错误信息里要说清是谁） */
  pluginId: string;
  providerId: string;
  label: string;
  /** 清单里声明的能力（`image.generate` / `video.fromImage` / …） */
  capabilities: readonly string[];
  /**
   * 清单里声明的鉴权方式（BYOK-004）。

   * 这里是 `string[]` 而不是 `AuthMethod[]`：装配层**不认识鉴权实现**，
   * 它只负责把清单里的声明原样带到界面能读到的地方。
   * 真要用它去换请求头，那是 `@qiyin/provider-auth` 的事。
   */
  authMethods: readonly string[];
  /** 真正要用的时候才去把插件加载起来，拿到它注册的那个 Provider */
  resolve: () => Promise<PluginProviderDescriptor | undefined>;
}

/** 清单能力 → 后端能力位。清单里没有的两项（音色/音乐）在这个端口上没有对应位，见文档。 */
export function capabilitiesFromDeclaration(declared: readonly string[]): GenerationCapabilities {
  return {
    image: declared.includes('image.generate'),
    videoFromImage: declared.includes('video.fromImage'),
    videoEdit: declared.includes('video.edit'),
    imageShortcut: declared.includes('image.shortcut'),
    imageUpscale: declared.includes('image.upscale'),
    audioSpeech: declared.includes('audio.tts'),
    audioMusic: declared.includes('audio.music'),
  };
}

interface PluginCallResult {
  files?: unknown;
  notes?: unknown;
  cost?: unknown;
  task_ref?: unknown;
  source_url?: unknown;
}

function normalizeCost(raw: unknown): ProviderCost | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const row = raw as { unit?: unknown; amount?: unknown };
  if ((row.unit !== 'credit' && row.unit !== 'cent') || typeof row.amount !== 'number') return null;
  return { unit: row.unit, amount: row.amount };
}

export function createPluginBackend(source: PluginBackendSource): GenerationBackend {
  const capabilities = capabilitiesFromDeclaration(source.capabilities);
  let pending: Promise<PluginProviderDescriptor> | null = null;

  async function provider(): Promise<PluginProviderDescriptor> {
    pending ??= (async () => {
      const resolved = await source.resolve();
      if (resolved === undefined) {
        throw new Error(`插件 ${source.pluginId} 没有注册 Provider ${source.providerId}`);
      }
      return resolved;
    })();
    return pending;
  }

  function refuse(capability: keyof GenerationCapabilities): never {
    throw new UnsupportedCapabilityError(source.label, capability);
  }

  /**
   * 调插件并核对产物。

   * `notes` 原样带上：插件对参数做的调整必须能被用户看见——
   * 悄悄改掉用户设的参数，与内置后端那边是同一条规矩。
   */
  async function call(fn: 'generate' | 'edit', payload: Record<string, unknown>): Promise<BackendMedia> {
    const resolved = await provider();
    const handler = fn === 'edit' ? resolved.edit : resolved.generate;
    if (handler === undefined) {
      throw new Error(`插件 ${source.pluginId} 的 Provider ${source.providerId} 没有实现 ${fn}`);
    }
    const raw = await handler(payload) as PluginCallResult | null;
    const files = Array.isArray(raw?.files)
      ? raw.files.filter((file): file is string => typeof file === 'string' && file !== '')
      : [];
    if (files.length === 0) {
      throw new Error(`插件 ${source.pluginId}（${source.label}）报成功，但没有给出任何产物文件`);
    }
    const missing = files.filter((file) => !existsSync(file));
    if (missing.length > 0) {
      throw new Error(`插件 ${source.pluginId}（${source.label}）给的产物文件不存在：${missing.join('、')}`);
    }
    return {
      files,
      source_url: typeof raw?.source_url === 'string' ? raw.source_url : null,
      task_ref: typeof raw?.task_ref === 'string' ? raw.task_ref : null,
      cost: normalizeCost(raw?.cost),
      notes: Array.isArray(raw?.notes)
        ? raw.notes.filter((note): note is string => typeof note === 'string')
        : [],
    };
  }

  return {
    id: pluginBackendId(source.providerId),
    label: source.label,
    capabilities,
    async generateImage(request: BackendImageRequest): Promise<BackendMedia> {
      if (!capabilities.image) refuse('image');
      return call('generate', {
        kind: 'image',
        prompt: request.prompt,
        model: request.model,
        ...(request.ratio === undefined ? {} : { ratio: request.ratio }),
        ...(request.quality === undefined ? {} : { quality: request.quality }),
        outputDir: request.outputDir,
        label: request.label,
        /*
          多参考槽位（VID-010）：**有序数组原样交给插件**——
          支不支持多张、怎么用，由插件自己决定并在 notes 里说清楚。
          宿主这一层不替它裁剪，也不替它保证。
        */
        ...(() => {
          const files = request.referenceImageFiles ?? (request.referenceImageFile === undefined ? [] : [request.referenceImageFile]);
          if (files.length === 0) return {};
          return files.length === 1
            ? { referenceImageFile: files[0] }
            : { referenceImageFiles: [...files] };
        })(),
        ...(request.settings === undefined ? {} : { settings: request.settings }),
      });
    },
    async generateVideoFromImage(request: BackendVideoRequest): Promise<BackendMedia> {
      if (!capabilities.videoFromImage) refuse('videoFromImage');
      return call('generate', {
        kind: 'video',
        prompt: request.prompt,
        model: request.model,
        durationSeconds: request.durationSeconds,
        outputDir: request.outputDir,
        label: request.label,
        ...(request.ratio === undefined ? {} : { ratio: request.ratio }),
        ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
        /* 首帧就是参考图（后端这一层的表述是 `imageFile`） */
        referenceImageFile: request.imageFile,
        ...(request.settings === undefined ? {} : { settings: request.settings as BackendSettings }),
      });
    },
    /**
     * 音频生成（配音 / 音乐）。

     * 音色与风格通过 `settings` 原样交给插件——各家参数名不同，
     * 我们不做中间翻译（翻译错了会静默出成另一个音色）。
     */
    async generateAudio(request: BackendAudioRequest): Promise<BackendMedia> {
      if (request.kind === 'music' ? !capabilities.audioMusic : !capabilities.audioSpeech) {
        refuse(request.kind === 'music' ? 'audioMusic' : 'audioSpeech');
      }
      return call('generate', {
        kind: request.kind === 'music' ? 'music' : 'speech',
        prompt: request.prompt,
        model: request.model,
        durationSeconds: request.durationSeconds,
        outputDir: request.outputDir,
        label: request.label,
        ...(request.settings === undefined ? {} : { settings: request.settings }),
      });
    },
    async editVideo(request: BackendVideoEditRequest): Promise<BackendMedia> {
      if (!capabilities.videoEdit) refuse('videoEdit');
      return call('edit', {
        kind: 'edit',
        prompt: request.prompt,
        model: request.model,
        videoFile: request.videoFile,
        outputDir: request.outputDir,
        label: request.label,
        ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
      });
    },
    async upscaleImage(request: { imageFile: string; scale: number; model: string; outputDir: string; label: string }): Promise<BackendMedia> {
      if (!capabilities.imageUpscale) refuse('imageUpscale');
      return call('generate', {
        kind: 'upscale',
        imageFile: request.imageFile,
        scale: request.scale,
        model: request.model,
        outputDir: request.outputDir,
        label: request.label,
      });
    },
    async applyImageShortcut(request: {
      imageFile: string; scene: string; model: string; outputDir: string; label: string;
    }): Promise<BackendMedia> {
      if (!capabilities.imageShortcut) refuse('imageShortcut');
      return call('generate', {
        kind: 'shortcut',
        scene: request.scene,
        imageFile: request.imageFile,
        model: request.model,
        outputDir: request.outputDir,
        label: request.label,
      });
    },
  };
}
