import {
  ImageGenAuthError,
  ImageGenCommandError,
  ImageGenComplianceError,
  ImageGenProtocolError,
} from './errors.js';
import type { ImageGenRunRequest, ImageGenRunner } from './runner.js';

/* ============================================================
   期音科技 · 图像生成服务（图像生成服务）CLI 门面
   ------------------------------------------------------------
   与 小QTV 最大的不同：图像生成服务是**异步任务**模型，不是画布节点。

     提交 → 拿到 submit_id（此时只是「被受理」）
          → query_result 轮询到 success / fail
          → query_result --download_dir 落盘（返回体里带本地 path）

   「被受理」不等于「成功」，这一点必须写在类型上：submit 返回
   `gen_status=querying` 只是收条，不是结果。把它当成成功，
   就是最常见的「假装成功」。

   返回体形状来自真实调用（`list_task` / `query_result` 实测，未消耗额度）：

     query_result → { submit_id, gen_status, result_json: { images: [{ path | image_url, width, height }], videos: [...] },
                      credit_count, queue_info }
   ============================================================ */

export interface ImageGenAdapterOptions {
  cwd?: string;
  timeoutMs?: number;
  /** 生成类命令的长超时（视频可能数分钟）。 */
  longTimeoutMs?: number;
}

export interface ImageGenSubmit {
  submit_id: string;
  gen_status: string;
  fail_reason?: string;
  credit_count?: number;
}

export interface ImageGenResultMedia {
  /** 只有传了 --download_dir 才有。 */
  path?: string;
  image_url?: string;
  video_url?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface ImageGenQueryResult {
  submit_id: string;
  prompt?: string;
  gen_status: string;
  fail_reason?: string;
  credit_count?: number;
  result_json?: {
    images?: ImageGenResultMedia[];
    videos?: ImageGenResultMedia[];
  };
}

/** 终态判定集中在一处：别让每个调用点各写一遍字符串比较。 */
export function isTerminal(status: string): boolean {
  return status === 'success' || status === 'fail';
}

export class ImageGenAdapter {
  constructor(
    private readonly runner: ImageGenRunner,
    private readonly options: ImageGenAdapterOptions = {},
  ) {}

  version(): Promise<{ version: string; commit: string; build_time: string }> {
    return this.call(['version']);
  }

  /** 账号余额。也只读，可以随时用来确认「这台机器确实登录了」。 */
  userCredit(): Promise<{ total_credit: number; user_id: number; vip_level?: string }> {
    return this.call(['user_credit']);
  }

  /**
   * 提交文生图。
   *
   * `3.0/3.1 → 1k|2k`，`4.x/5.0 → 2k|4k`，`5.0Pro → 1.5k|2k|4k`。
   */
  submitText2Image(options: {
    prompt: string;
    modelVersion?: string;
    resolutionType: string;
    ratio?: string;
    generateNum?: number;
    session?: number;
    pollSeconds?: number;
  }): Promise<ImageGenSubmit> {
    const args = ['text2image', `--prompt=${options.prompt}`, `--resolution_type=${options.resolutionType}`];
    if (options.modelVersion !== undefined) args.push(`--model_version=${options.modelVersion}`);
    if (options.ratio !== undefined) args.push(`--ratio=${options.ratio}`);
    if (options.generateNum !== undefined) args.push(`--generate_num=${options.generateNum}`);
    if (options.session !== undefined) args.push(`--session=${options.session}`);
    args.push(`--poll=${options.pollSeconds ?? 0}`);
    return this.call<ImageGenSubmit>(args, { long: true });
  }

  /**
   * 提交图生图（参考图 → 图）。
   *
   * 与文生图的两处差别，都是从 `imagegen image2image -h` 的实测输出里来的：
   *   · 输入是 1–10 张本地图片（`--images`），我们只给一张参考图；
   *   · `resolution_type` 的合法值随模型不同：4.0–5.0 只认 `2k|4k`
   *     （**没有 1k**），5.0Pro 认 `1.5k|2k|4k`。
   */
  submitImage2Image(options: {
    images: readonly string[];
    prompt: string;
    modelVersion?: string;
    resolutionType: string;
    ratio?: string;
    generateNum?: number;
    session?: number;
    pollSeconds?: number;
  }): Promise<ImageGenSubmit> {
    if (options.images.length === 0) {
      throw new Error('图生图至少需要一张参考图');
    }
    const args = ['image2image', `--prompt=${options.prompt}`, `--resolution_type=${options.resolutionType}`];
    for (const image of options.images) args.push(`--images=${image}`);
    if (options.modelVersion !== undefined) args.push(`--model_version=${options.modelVersion}`);
    if (options.ratio !== undefined) args.push(`--ratio=${options.ratio}`);
    if (options.generateNum !== undefined) args.push(`--generate_num=${options.generateNum}`);
    if (options.session !== undefined) args.push(`--session=${options.session}`);
    args.push(`--poll=${options.pollSeconds ?? 0}`);
    return this.call<ImageGenSubmit>(args, { long: true });
  }

  /**
   * 提交图生视频。
   *
   * 画幅有两条实测规则，都必须照做：
   *   · 省略 `--ratio` 表示**跟随首帧**——这正是我们要的默认行为；
   *   · `seedance2.5` 明确**拒绝**显式 ratio（参考帧生成跟随首帧），
   *     所以对那个模型必须不传。
   */
  submitImage2Video(options: {
    image: string;
    prompt: string;
    videoResolution: string;
    modelVersion?: string;
    ratio?: string;
    durationSeconds?: number;
    session?: number;
    pollSeconds?: number;
  }): Promise<ImageGenSubmit> {
    const args = [
      'image2video',
      `--image=${options.image}`,
      `--prompt=${options.prompt}`,
      `--video_resolution=${options.videoResolution}`,
    ];
    if (options.modelVersion !== undefined) args.push(`--model_version=${options.modelVersion}`);
    if (options.durationSeconds !== undefined) args.push(`--duration=${Math.round(options.durationSeconds)}`);
    const rejectsRatio = options.modelVersion === 'seedance2.5';
    if (options.ratio !== undefined && !rejectsRatio) args.push(`--ratio=${options.ratio}`);
    if (options.session !== undefined) args.push(`--session=${options.session}`);
    args.push(`--poll=${options.pollSeconds ?? 0}`);
    return this.call<ImageGenSubmit>(args, { long: true });
  }

  /**
   * 提交图片高清放大（小QTV 界面里的「高清」）。
   *
   * 参数按 `imagegen image_upscale -h` 实测写：
   *   · `--image` 是**本地**图片路径（CLI 自己上传）；
   *     给别的值会在提交之后被拒，而那时用户已经等了一轮。
   *     所以调用方给什么，先由 backend 那层夹到这三个值里。
   */
  submitImageUpscale(options: {
    image: string;
    resolutionType: string;
    session?: number;
    pollSeconds?: number;
  }): Promise<ImageGenSubmit> {
    const args = [
      'image_upscale',
      `--image=${options.image}`,
      `--resolution_type=${options.resolutionType}`,
    ];
    if (options.session !== undefined) args.push(`--session=${options.session}`);
    args.push(`--poll=${options.pollSeconds ?? 0}`);
    return this.call<ImageGenSubmit>(args, { long: true });
  }

  /** 查询一次任务；给 `downloadDir` 时会把产物落盘，并在返回体里给出本地 `path`。 */
  queryResult(options: { submitId: string; downloadDir?: string }): Promise<ImageGenQueryResult> {
    const args = ['query_result', `--submit_id=${options.submitId}`];
    if (options.downloadDir !== undefined) args.push(`--download_dir=${options.downloadDir}`);
    return this.call<ImageGenQueryResult>(args, { long: true });
  }

  listTasks(options: { limit?: number; status?: string } = {}): Promise<unknown> {
    const args = ['list_task'];
    if (options.limit !== undefined) args.push(`--limit=${options.limit}`);
    if (options.status !== undefined) args.push(`--gen_status=${options.status}`);
    return this.call(args);
  }

  /* ---------------- 内部 ---------------- */

  private async call<T>(args: readonly string[], options: { long?: boolean } = {}): Promise<T> {
    const result = await this.runner.run({
      args,
      timeoutMs: options.long
        ? this.options.longTimeoutMs ?? 600_000
        : this.options.timeoutMs ?? 180_000,
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
    });
    const text = `${result.stderr}\n${result.stdout}`;
    if (result.code !== 0 || /AigcComplianceConfirmationRequired/.test(text)) {
      throw this.toError(args, result);
    }
    const payload = extractJson(result.stdout);
    if (payload === null) {
      throw new ImageGenProtocolError(
        `imagegen ${args[0]} 的输出里找不到可解析的 JSON`,
        { stdout: result.stdout.slice(0, 500) },
      );
    }
    return payload as T;
  }

  /** 把 CLI 的失败翻译成「用户下一步该做什么」。 */
  private toError(args: readonly string[], result: ImageGenRunResultLike) {
    const text = `${result.stderr}\n${result.stdout}`.trim();
    const lastLine = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).pop()
      ?? `imagegen ${args[0]} 退出码 ${result.code}`;
    if (/AigcComplianceConfirmationRequired/.test(text)) {
      return new ImageGenComplianceError(
        `图像生成服务要求先用该模型在 Web 端完成一次生成（首次授权）：${lastLine}`,
      );
    }
    if (/未登录|登录已过期|unauthor|401|token|device.?code/i.test(text)) {
      return new ImageGenAuthError(`图像生成服务凭据无效，请重新登录：${lastLine}`);
    }
    return new ImageGenCommandError(lastLine, result.code);
  }
}

interface ImageGenRunResultLike {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 从可能夹带提示行的 stdout 里取出 JSON。
 *
 * 因为提示行本身也可能以 `[` 开头。逐行尝试才是稳的。
 */
export function extractJson(stdout: string): unknown {
  const text = stdout.replace(/^\uFEFF/, '');
  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const indent = line.length - line.trimStart().length;
      try {
        return JSON.parse(text.slice(offset + indent).trim()) as unknown;
      } catch {
        // 这一行不是 JSON 的起点，继续往下找
      }
    }
    offset += line.length + 1;
  }
  return null;
}

export type { ImageGenRunRequest };
