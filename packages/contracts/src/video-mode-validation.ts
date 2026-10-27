/* 依据 LibTV 官方 model schema 验证视频引用；规则缺失时拒绝付费调用。 */
export const canvasVideoModes = ['text2video', 'singleImage2video', 'frames2video', 'image2video', 'mixed2video', 'videoEdit2video'] as const;
export type CanvasVideoMode = typeof canvasVideoModes[number];
type ModeSchema = { properties?: { modeType?: { items?: Record<string, unknown>; mixed2videoConfig?: Record<string, unknown>; videoEdit2videoConfig?: Record<string, unknown> } }; config?: { settings?: Record<string, unknown> | string[] } };

export function validateVideoModeReferences(schema: unknown, mode: string, mediaTypes: string[]): string | null {
  if (!schema || typeof schema !== 'object') return '无法读取模型参考素材规则';
  const input = schema as ModeSchema;
  if (!(canvasVideoModes as readonly string[]).includes(mode)) return `视频模式 ${mode} 尚未由小QTV 接入真实后端`;
  const range = input.properties?.modeType?.items?.[mode];
  if (!input.config?.settings || typeof input.config.settings !== 'object' || Array.isArray(input.config.settings) || !Object.prototype.hasOwnProperty.call(input.config.settings, mode) || (mode !== 'text2video' && (!Array.isArray(range) || range.length !== 2 || range.some(value => !Number.isInteger(value) || value < 0)))) return `模型 schema 未提供 ${mode} 的完整参考素材规则`;
  const images = mediaTypes.filter(type => type.startsWith('image/')).length;
  const videos = mediaTypes.filter(type => type.startsWith('video/')).length;
  const audios = mediaTypes.filter(type => type.startsWith('audio/')).length;
  if (images + videos + audios !== mediaTypes.length) return '包含模型不支持的参考素材格式';
  if (mode === 'text2video') return mediaTypes.length === 0 ? null : '文生视频不能连接参考素材';
  const [minimum, maximum] = range as [number, number];
  // videoEdit2video 的 items 限制视频数量；额外图片由 imageMaxWithVideo 单独规定。
  const counted = mode === 'videoEdit2video' ? videos : mediaTypes.length;
  if (counted < minimum || counted > maximum) return `${mode} 需要 ${minimum}–${maximum} 个${mode === 'videoEdit2video' ? '视频' : '参考素材'}`;
  if (mode === 'singleImage2video' || mode === 'frames2video' || mode === 'image2video') return images === mediaTypes.length ? null : `${mode} 仅接受图片素材`;
  if (mode === 'mixed2video') {
    const limits = input.properties?.modeType?.mixed2videoConfig;
    if (!limits || !['imageMax', 'videoMax', 'audioMax'].every(key => Number.isInteger(limits[key]))) return '模型 schema 未提供混合模式的素材类型上限';
    return images <= Number(limits.imageMax) && videos <= Number(limits.videoMax) && audios <= Number(limits.audioMax) ? null : '混合模式参考素材超过模型按类型规定的上限';
  }
  const limits = input.properties?.modeType?.videoEdit2videoConfig;
  if (!limits || !Number.isInteger(limits.videoMax) || !Number.isInteger(limits.imageMaxWithVideo)) return '模型 schema 未提供视频重拍的素材类型上限';
  return videos === Number(limits.videoMax) && images <= Number(limits.imageMaxWithVideo) && audios === 0 ? null : '视频重拍需要一段视频，可额外连接 schema 允许数量的图片';
}
