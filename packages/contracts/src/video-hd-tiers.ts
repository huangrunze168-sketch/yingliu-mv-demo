/* ============================================================
  期音科技 · 视频高清的档位表（VID-005）
  ------------------------------------------------------------
  这张表**放在 contracts 里**而不是 kernel-service 里，原因是：它同时要给
  界面用（画那排档位按钮）和给内核用（判"请求的档位存不存在"）。

  kernel-service 会 import `node:child_process`，渲染层不能碰它；
  所以凡是要被两边同时读到的常量，都得住在 contracts 这一层。
  两边各抄一份的后果很具体：界面能点 6 倍、内核不认 6 倍，
  而这两种状态**都各自是"对的"**，于是没人会去修。
  ============================================================ */

/**
 * 放大档位。小QTV 视频高清给的是这三档（对标矩阵 + 线上词条 `videoHdWithScale`）。

 * 三档全是偶数不是巧合：H.264 要偶数宽高，管线里有一道偶数对齐，
 * 奇数档位会被对齐改动 1 像素，"输出分辨率为请求倍数的整数倍"当场不成立。
 */
export const VIDEO_HD_SCALES = [2, 4, 6] as const;

/** 提帧档位。对应线上词条 `fps30` / `fps60` / `fps90`。 */
export const VIDEO_HD_FPS = [30, 60, 90] as const;

/** 界面上的帧率选项：三档 + 「自适应(原帧率)」（线上词条 `adaptiveOriginalFps`）。 */
export const VIDEO_HD_FPS_OPTIONS = [
  { value: null, label: '自适应(原帧率)' },
  { value: 30, label: '30帧' },
  { value: 60, label: '60帧' },
  { value: 90, label: '90帧' },
] as const;

/**
 * 2K 门槛按**长边**算。

 * 小QTV 那句提示只写"超过 2K"，没有给数；DCI 2K 的长边是 2048，所以取 2048。
 * 这是**我们自己的取值**，不是从它源码里读来的。
 */
export const VIDEO_HD_MAX_SOURCE_LONG_SIDE = 2048;

/** 10GB。线上 `upscaleSizeExceed10GB` 是原话，数值也是它写的。 */
export const VIDEO_HD_MAX_SOURCE_BYTES = 10 * 1024 * 1024 * 1024;

/** 支持超分的格式。顺序与线上 `upscaleFormatUnsupported` 那句提示一致。 */
export const VIDEO_HD_FORMATS = ['mp4', 'flv', 'ts', 'avi', 'mov', 'mkv', 'wmv'] as const;

/** 提帧的上限倍数关系：超过它只**警告**不拦（小QTV 自己那句也只是"建议"）。 */
export const VIDEO_HD_FPS_HEADROOM = 4;

/**/
export function videoHdNodeName(scale: number): string {
  return `高清（${scale} 倍）`;
}

/** 档位表拼成人话（拒绝信息与界面提示共用）。 */
export function videoHdTierList(values: readonly number[], unit: string): string {
  return values.map((value) => `${value}${unit}`).join(' / ');
}

/**
 * 让人看懂的边界说明。界面与拒绝信息都读这一份，
 * 免得"界面说支持 mkv、内核说只支持 mp4"这种事发生。
 */
export function describeVideoHdLimits(): string {
  return `支持 ${VIDEO_HD_FORMATS.join(' / ')}；源片分辨率不超过 2K、体积不超过 10GB；`
    + `放大 ${videoHdTierList(VIDEO_HD_SCALES, ' 倍')}、提帧 ${videoHdTierList(VIDEO_HD_FPS, 'fps')}`
    + `（另可保持原帧率）；建议目标帧率不超过原片的 ${VIDEO_HD_FPS_HEADROOM} 倍。`
    + '走本机 ffmpeg：插值放大不会长出新细节，要补细节得走超分模型。';
}
