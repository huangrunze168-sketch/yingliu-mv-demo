/**
 * 本地能力后端 后端 HTTP 客户端。
 *
 * 只做转发与错误归一化，不复制后端的业务判断；
 */

export interface LocalBackendConfig {
  base_url: string;
  chat_model: string;
  image_model: string;
  chat_models: string[];
  image_models: string[];
  video_models: string[];
  api_providers: Array<Record<string, unknown>>;
  has_api_key: boolean;
  [key: string]: unknown;
}

export interface LocalBackendClientOptions {
  baseUrl: string;
  /** 单次请求超时，毫秒。 */
  timeoutMs?: number;
}

export class LocalBackendClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'LocalBackendClientError';
  }
}

export class LocalBackendClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: LocalBackendClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get url(): string {
    return this.baseUrl;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs?: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new LocalBackendClientError(
          `本地能力后端 请求失败 ${init.method ?? 'GET'} ${path} -> ${response.status}`,
          response.status,
          text.slice(0, 500),
        );
      }
      return response;
    } catch (error) {
      if (error instanceof LocalBackendClientError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new LocalBackendClientError(`本地能力后端请求异常 ${path}: ${message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    const response = await this.request(path, init, timeoutMs);
    return (await response.json()) as T;
  }

  /** 后端配置与模型清单，也用作健康检查。 */
  getConfig(): Promise<LocalBackendConfig> {
    return this.json<LocalBackendConfig>('/api/config');
  }

  /** 已配置的 API 平台。 */
  listProviders(): Promise<{ providers: Array<Record<string, unknown>> }> {
    return this.json('/api/providers');
  }

  /**
   * 媒体预览（缩略图）。后端负责缓存、EXIF 纠正、WebP/PNG 回退与视频抽帧。
   * @param url 后端可识别的本地媒体路径或已登记 URL
   * @param width 目标宽度；后端会夹到 64–2048
   */
  async mediaPreview(url: string, width = 512): Promise<{ bytes: Buffer; contentType: string }> {
    const query = new URLSearchParams({ url, w: String(width) });
    const response = await this.request(`/api/media-preview?${query.toString()}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { bytes: buffer, contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  /** 转 JPEG（给不支持 WebP 的客户端）。 */
  async imageJpeg(url: string, width = 0): Promise<{ bytes: Buffer; contentType: string }> {
    const query = new URLSearchParams({ url, w: String(width) });
    const response = await this.request(`/api/image-jpeg?${query.toString()}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { bytes: buffer, contentType: response.headers.get('content-type') ?? 'image/jpeg' };
  }

  /** 只读连通性测试：验证鉴权与端点是否可达。 */
  testConnection(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json('/api/providers/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /** 异步任务端点探测（用假 task_id 判断协议是否真实存在）。 */
  probeAsync(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json('/api/providers/probe-async', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**/
  fetchModels(providerId: string): Promise<Record<string, unknown>> {
    return this.json(`/api/providers/${encodeURIComponent(providerId)}/fetch-models`);
  }

  /**
   * 保存平台配置（名称、请求地址、协议、Key 引用等）。
   *
   * 这是**写**操作，也是整个 API 设置页唯一会改变后端状态的动作。
   * Key 由后端写入它自己的环境/配置，前端不回显完整值——页面里看到的
   * 永远是「已保存」而不是那串字符。
   */
  saveProviders(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json('/api/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**/
  refreshModels(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json('/api/providers/fetch-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, 120_000);
  }

  /**
   * 一个本地 CLI 的安装与登录状态。
   *
   * 三种 CLI 的路径不同（图像生成服务 / GPT(codex) / Antigravity(gemini)），
   * 但返回的都是「装没装、登录没有」这一组事实，所以共用一个方法。
   */
  cliStatus(kind: LocalBackendCliKind): Promise<Record<string, unknown>> {
    return this.json(`/api/${kind}/status`);
  }

  /** 公开定价源（只读，后端做了 15 分钟缓存与 stale 降级）。 */
  pricing(): Promise<Record<string, unknown>> {
    return this.json('/api/local-backend/pricing');
  }

  /** 资产库。 */
  assetLibrary(): Promise<Record<string, unknown>> {
    return this.json('/api/asset-library');
  }

  /** 本地素材列表。 */
  localAssets(): Promise<Record<string, unknown>> {
    return this.json('/api/local-assets');
  }

  /** 触发一次在线图片生成（会消耗用户自己的额度，调用前须经领域层闸门）。 */
  submitOnlineImage(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json('/api/online-image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, 300_000);
  }

  /** 查询画布异步图片任务。 */
  canvasImageTask(taskId: string): Promise<Record<string, unknown>> {
    return this.json(`/api/canvas-image-tasks/${encodeURIComponent(taskId)}`);
  }
}

/** API 设置页里列出的三种本地 CLI。 */
export type LocalBackendCliKind = 'jimeng' | 'codex' | 'gemini-cli';
