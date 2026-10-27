import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

/* ============================================================
   期音科技 · 智能剪辑（把画布上连进来的片段合成一条）
   ------------------------------------------------------------
   对标 小QTV 画布上的「智能剪辑」节点（`nodeTypeVideoClip`，
   用途那句是它的原话：「多个视频片段合为一个」）。

   多视频轨 / 音轨 / 字幕轨、裁切与分割、变速、转场库、字幕样式、
   人声分离、导出 PR 打包…… 这一轮只做**它的核心那一句**：
   把连进来的片段按顺序合成一条，并支持它那四种转场。

   用它自己的四个转场名（`clipTransition*Name`）：
     淡入淡出 crossfade · 像素溶解 dissolve · 黑场过渡 fadeblack · 白场过渡 fadewhite
   落地到 ffmpeg 的 xfade 就是 fade / pixelize / fadeblack / fadewhite——
   这四个名字是实测本机 ffmpeg 8.1 都在的（`ffmpeg -h filter=xfade`）。

   为什么不用内核：前置内核 的能力面是 check / plan / build / media probe…，
   没有"拼接两条片段"这种节点级操作；而 ffmpeg 本来就是本地渲染的既有依赖
   （`audio-extract.ts` 用它抽音轨）。剪一条片子不该为此多装一个东西。
   ============================================================ */

/** 小QTV `clipTransition*Name` 那四个，加上"不加转场" */
export type ClipTransitionId = 'none' | 'crossfade' | 'dissolve' | 'fadeblack' | 'fadewhite';

export interface ClipTransitionOption {
  id: ClipTransitionId;
  /**/
  label: string;
  /** 对应的 ffmpeg xfade 过渡名；`none` 没有 */
  ffmpeg: string | null;
}

export const CLIP_TRANSITIONS: readonly ClipTransitionOption[] = [
  { id: 'none', label: '不加转场', ffmpeg: null },
  { id: 'crossfade', label: '淡入淡出', ffmpeg: 'fade' },
  { id: 'dissolve', label: '像素溶解', ffmpeg: 'pixelize' },
  { id: 'fadeblack', label: '黑场过渡', ffmpeg: 'fadeblack' },
  { id: 'fadewhite', label: '白场过渡', ffmpeg: 'fadewhite' },
];

export function clipTransitionOption(id: ClipTransitionId | string): ClipTransitionOption | null {
  return CLIP_TRANSITIONS.find((option) => option.id === id) ?? null;
}

/** 合成用的一段素材（时长与有无音轨来自内核 probe，尺寸来自 ffprobe） */
export interface ClipComposeClip {
  /** 绝对路径 */
  path: string;
  /** 视频轨 1–4；同轨串联、不同轨并行。缺省为轨 1。 */
  videoTrack?: 1 | 2 | 3 | 4;
  durationSeconds: number;
  hasAudio: boolean;
  width: number;
  height: number;
  /** 源媒体入点与取用时长；省略时使用整段。 */
  sourceOffsetSeconds?: number;
  sourceDurationSeconds?: number;
  /** 源时间 / 时间轴时间；2 表示二倍速。 */
  speed?: number;
  /**
   * 这一段的**原声**要不要静音。
   *
   * `clipUnmuteVideoTrackAudio = 取消静音视频原声`
   * （带轨号的两个是 `clipMuteVideoTrackAudioN = 静音视频轨 {track} 原声`）。
   *
   * 静音的做法是 `volume=0` 而**不是**把音轨丢掉：丢掉会让段数与时长对不上，
   * 拼接/转场的时长会跟着变；压成 0 则结构不动，只是听不见。
   */
  muteSourceAudio?: boolean;
}

/**
 * 一条**附加油轨**（BGM / 配音）。
 *
 * `clipAudioTrack = 音频轨道`、`clipAudioTitle = 音量`、
 * `clipAudioGain = 音量增益`、`clipAudioGainInput = 输入音量增益（dB）`、
 * `clipMuteAudioTrack = 静音音频轨`（带轨号的 `clipMuteAudioTrackN`）。
 */
export interface ClipComposeAudioTrack {
  /** 绝对路径 */
  path: string;
  /** 音量增益（dB）；0 是原样。 */
  gainDb?: number;
  /** 整轨静音 */
  muted?: boolean;
  /** 回执里怎么说它（用户起的名字，或文件名） */
  label?: string;
}

/** 增益的上下限。线上词条只说了单位是 dB、没给范围，这两个数是**我们定的**： */
export const AUDIO_GAIN_MIN_DB = -60;
export const AUDIO_GAIN_MAX_DB = 24;

/** 增益钳位：不在数字里就当 0（原样），越界钳进上下限 */
export function normalizeAudioGainDb(value: unknown): number {
  const gain = Number(value);
  if (!Number.isFinite(gain) || gain === 0) return 0;
  return Math.min(AUDIO_GAIN_MAX_DB, Math.max(AUDIO_GAIN_MIN_DB, gain));
}

/* ---------------- 字幕 ---------------- */

/** ASS 的时间格式：`H:MM:SS.cc`（百分秒，两位）。 */
export function assTimestamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const whole = Math.floor(rest);
  let centis = Math.round((rest - whole) * 100);
  /* 0.999 秒会舍入成 100，写成 `…:00.100` 就多了一秒，退一位 */
  if (centis >= 100) centis = 99;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(whole)}.${pad(centis)}`;
}

/** 一条字幕的文本收拾干净：换行在 ASS 里写 `\N`，花括号要转义（那是它的样式标记符） */
function assText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N');
}

/**
 * 字幕的预设样式。
 *
 * 六档的名字与"什么色配什么边"逐字来自线上词条：
 *   `clipSubtitlePresetNone = 默认`、`clipSubtitlePresetOutline = 白字黑边`、
 *   `clipSubtitlePresetSoft = 黑字白边`、`clipSubtitlePresetStrong = 黄字黑边`、
 *   `clipSubtitlePresetWarm = 粉字黑边`、`clipSubtitlePresetGlow = 白字粉边`。
 *
 * 具体的色值是我们定的（线上只给了中文描述，没给十六进制）：
 *   白 #FFFFFF、黑 #000000、黄 #FFFF00、粉 #FF69B4。
 * ASS 的颜色写作 `&HAABBGGRR`——注意是 **BGR**，写反了字会变蓝。
 */
export interface SubtitlePreset {
  id: string;
  /**/
  label: string;
  /** 文字色，`&HAABBGGRR` */
  primary: string;
  /** 描边色 */
  outline: string;
  /** 描边粗细（0 = 不描边） */
  outlineWidth: number;
}

export const SUBTITLE_PRESETS: readonly SubtitlePreset[] = [
  { id: 'none', label: '默认', primary: '&H00FFFFFF', outline: '&H00000000', outlineWidth: 0 },
  { id: 'outline', label: '白字黑边', primary: '&H00FFFFFF', outline: '&H00000000', outlineWidth: 2 },
  { id: 'soft', label: '黑字白边', primary: '&H00000000', outline: '&H00FFFFFF', outlineWidth: 2 },
  { id: 'strong', label: '黄字黑边', primary: '&H0000FFFF', outline: '&H00000000', outlineWidth: 3 },
  { id: 'warm', label: '粉字黑边', primary: '&H00B469FF', outline: '&H00000000', outlineWidth: 2 },
  { id: 'glow', label: '白字粉边', primary: '&H00FFFFFF', outline: '&H00B469FF', outlineWidth: 3 },
];

export function subtitlePreset(id: string | undefined): SubtitlePreset {
  return SUBTITLE_PRESETS.find((preset) => preset.id === id) ?? (SUBTITLE_PRESETS[1] as SubtitlePreset);
}

/**
 * 字幕样式（存在剪辑节点上，整轨一套）。
 *
 * `clipSubtitleStrokeWidth = 描边粗细`、`clipSubtitleLetterSpacing = 字间距`。
 * （线上还有**逐条**样式与"应用到全部字幕"，我们这一版先做整轨一套——
 * 差异写在 DEVELOPMENT-STATUS 的 FF 节里。）
 */
export interface ClipComposeSubtitleStyle {
  preset?: string | undefined;
  /** 字号（px）；省略时按画面高的 5% */
  fontSize?: number | undefined;
  /** 描边粗细；省略时用预设的 */
  strokeWidth?: number | undefined;
  /** 字间距 */
  letterSpacing?: number | undefined;
}

/**
 * 生成一份 ASS 字幕文件的内容（主进程把它写到 `derived/` 下，再交给 ffmpeg 的 subtitles 滤镜）。
 *
 * 为什么会写字幕文件而不是一条条 drawtext：
 *   · drawtext 每条要拼一次滤镜，中文还得单独给字体文件，十几条字幕就长到看不清；
 *   · ASS 是约定好的字幕格式，时间轴、换行、描边它自己管，而本机 ffmpeg 带 libass
 *     （实测 `ffmpeg -version` 的配置里有 `--enable-libass`），这条路是通的。
 *
 * 两处是**我们定的**（线上词条只给了功能名，没给版面数值）：
 *   · 字号 = 画面高的 5%（720p 下 36px）；
 *   · 底部留白 = 画面高的 4%（720p 下约 29px），居中 + 一圈黑描边（浅色画面也读得清）。
 */
export function buildAssSubtitleFile(options: {
  subtitles: readonly ClipComposeSubtitle[];
  width: number;
  height: number;
  style?: ClipComposeSubtitleStyle | undefined;
}): string {
  const width = Math.max(2, Math.round(options.width));
  const height = Math.max(2, Math.round(options.height));
  const preset = subtitlePreset(options.style?.preset);
  const requestedSize = Number(options.style?.fontSize);
  const fontSize = Number.isFinite(requestedSize) && requestedSize > 0
    ? Math.round(requestedSize)
    : Math.max(12, Math.round(height * 0.05));
  const marginV = Math.max(8, Math.round(height * 0.04));
  const requestedStroke = Number(options.style?.strokeWidth);
  const strokeWidth = Number.isFinite(requestedStroke) && requestedStroke >= 0
    ? Math.round(requestedStroke)
    : preset.outlineWidth;
  const requestedSpacing = Number(options.style?.letterSpacing);
  const letterSpacing = Number.isFinite(requestedSpacing) ? Math.round(requestedSpacing) : 0;
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, '
      + 'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, '
      + 'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    /* 颜色与描边跟着预设走；底部居中。ASS 的字段序见上面 Format 那行 */
    `Style: Default,Microsoft YaHei,${fontSize},${preset.primary},&H000000FF,${preset.outline},&H80000000,`
      + `-1,0,0,0,100,100,${letterSpacing},0,1,${strokeWidth},1,2,20,20,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...options.subtitles.map((item) => {
      const start = Math.max(0, Number(item.startSeconds) || 0);
      const end = Math.max(start, Number(item.endSeconds) || 0);
      return `Dialogue: 0,${assTimestamp(start)},${assTimestamp(end)},Default,,0,0,0,,${assText(item.text)}`;
    }),
    '',
  ].join('\n');
}

/**
 * ffmpeg 的 `subtitles` 滤镜里怎么写路径。
 *
 * Windows 上这是经典坑：滤镜参数里 `:` 是分隔符，`C:\a\b.ass` 会被截断。
 * 官方写法是把盘符那处冒号转义、反斜杠换成正斜杠：`C\:/a/b.ass`；引号也要处理掉
 * （滤镜自己会再解析一次）。这一条**有真机验证**，见 .data/verify-subtitles.mjs。
 */
export function subtitleFilterArgument(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/'/g, "\\'");
  return `subtitles=filename='${normalized.replace(/^([A-Za-z]):/, '$1\\:')}'`;
}

export type ClipLayoutPreset = 'sequence' | 'pip' | 'three' | 'quad';

export interface ClipComposeRequest {
  clips: readonly ClipComposeClip[];
  transition: { id: ClipTransitionId; durationSeconds: number };
  /** 多视频轨布局；sequence 保持原有单轨串联。 */
  layout?: ClipLayoutPreset;
  outputPath: string;
  /** 输出帧率；省略时 30 */
  fps?: number;
  /**
   * 要烧进成片的字幕（一条字幕轨道）。
   *
   * 为什么传**文件路径**而不是字幕数组本身：`planClipCompose` 是纯函数（只产参数、不碰文件），
   * 而 ffmpeg 的 `subtitles` 滤镜要读一个真实存在的 ASS 文件。
   * 所以由调用方（主进程）先用 `buildAssSubtitleFile` 把内容写好、再把这个路径递进来。
   */
  subtitlesFilePath?: string | undefined;
  /** 字幕轨是否**关闭**（线上词条 `clipHideSubtitle = 关闭字幕` / `clipShowSubtitle = 显示字幕`） */
  hideSubtitles?: boolean | undefined;
  /**
   * 附加油轨（BGM / 配音）。可以独立静音、独立调音量。
   *
   * 混音用 `amix=…:normalize=0`：**不让它按输入路数自动降音量**。
   * 这一条是 AUD-004 那条验收（"对某轨静音后其余轨混音输出逐采样差异 = 0"）的前提——
   * 默认的 amix 会按路数把每一路都衰减一次，那样"静音一条轨"会**改变另一条轨的电平**，
   * 差别就不可能是 0 了。
   */
  audioTracks?: readonly ClipComposeAudioTrack[];
}

/**
 * 一条字幕。
 *
 * `clipSubtitleTextPlaceholder = 输入字幕文本`、`clipSubtitleResizeStart/End = 调整字幕开始/结束时间`、
 * `clipSubtitleEmpty = 暂无字幕`。时间用**秒**（界面上就是两个数字输入框，
 * 取值口径与片段的入点/取用时长一致）。
 */
export interface ClipComposeSubtitle {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface ClipComposePlan {
  args: string[];
  /** 给用户看的回执：转场被改过、声音被丢掉这类事必须说出来 */
  notes: string[];
  /** 实际用上的转场（被降级时会与请求的不一样） */
  appliedTransition: ClipTransitionId;
  /** 成片是否带声音 */
  withAudio: boolean;
}

/** 输出帧率的默认值；与项目里其它本地渲染保持一致 */
export const COMPOSE_FPS = 30;

/**
 * 合成总时长上限（秒）。
 *
 * （20 分钟）。它会拒绝超长的合成请求，我们也一样：一次拼接真要跑二十分钟以上，
 * 出错的代价（磁盘、时间、失败后重来的钱）远大于"先拦下来让用户分段"。
 */
export const MAX_COMPOSE_DURATION_SECONDS = 1200;

/**
 * 这些片段加起来多长（秒）。
 *
 * 只累加片段本身的时长，不减转场重叠：转场只会让成片**更短**，
 * 拿它做上限判断是保守的（宁可早一点提示，也不要跑到一半才发现超了）。
 */
function normalizedVideoTrack(clip: ClipComposeClip): 1 | 2 | 3 | 4 {
  return clip.videoTrack === 2 || clip.videoTrack === 3 || clip.videoTrack === 4 ? clip.videoTrack : 1;
}

export function videoTrackDurations(clips: readonly ClipComposeClip[]): Map<number, number> {
  const durations = new Map<number, number>();
  for (const clip of clips) {
    const track = normalizedVideoTrack(clip);
    durations.set(track, (durations.get(track) ?? 0) + Math.max(0, Number(clip.durationSeconds) || 0));
  }
  return durations;
}

/** 多轨同时播放，因此工程总时长取最长视频轨，不把并行轨重复累加。 */
export function totalClipSeconds(clips: readonly ClipComposeClip[]): number {
  return Math.max(0, ...videoTrackDurations(clips).values());
}

/**
 * 超长就给出**一句能照做的话**；不超返回 null。
 *
 * 单独一个函数而不是塞进 `planClipCompose`：真正该拦的地方是**跑 ffmpeg 之前**
 * （主进程），而规划器只负责算参数。两边共用同一套判断，免得"提示的限度"
 * 与"实际拦的限度"对不上。
 */
export function composeDurationRefusal(
  clips: readonly ClipComposeClip[],
  layout: ClipLayoutPreset = 'sequence',
): string | null {
  const total = layout === 'sequence'
    ? clips.reduce((sum, clip) => sum + Math.max(0, Number(clip.durationSeconds) || 0), 0)
    : totalClipSeconds(clips);
  if (total <= MAX_COMPOSE_DURATION_SECONDS) return null;
  return `这些片段加起来 ${Math.round(total)} 秒，超过一次合成的上限 `
    + `${MAX_COMPOSE_DURATION_SECONDS} 秒（20 分钟）：分两次合成，再把两段接上`;
}
/** 转场时长的上下限：太短看不出来，太长会把短片段吃掉 */
export const TRANSITION_MIN_SECONDS = 0.2;
export const TRANSITION_MAX_SECONDS = 2;

/**
 * ffprobe 参数（拿宽高）。

 * 内核的 `media probe` 只给时长与有无音轨（实测它的 JSON 里就是
 * path / duration / hasVideo / hasAudio），没有尺寸——而拼接必须先知道
 * 统一到多大，所以这里自己问一次 ffprobe。
 */
export function probeVideoArgs(path: string): string[] {
  return [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    path,
  ];
}

/** 解析 ffprobe 的输出；拿不到就返回 null（调用方据此说清"读不出尺寸"） */
export function parseProbeSize(stdout: string): { width: number; height: number } | null {
  try {
    const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: unknown; height?: unknown }> };
    const stream = parsed.streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width: Math.round(width), height: Math.round(height) };
  } catch {
    return null;
  }
}

/**
 * 把一段素材归一化到统一画幅。

 * 三段都必须有：
 *   · `scale=...force_original_aspect_ratio=decrease` + `pad`：不同画幅的片段
 *     直接 concat 会失败（尺寸不一致），拉变形又会让用户觉得"我的片子被改了"，
 *     所以按原比例缩到框内、两侧补黑；
 *   · `setsar=1`：手机竖拍常见非方形像素，不归一化会让 concat 出来的画面被拉宽；
 *   · `fps`：混合帧率拼接会产出时间戳错乱的片子，统一到同一个帧率最省事。
 */
function clipSpeed(clip: ClipComposeClip): number {
  const value = Number(clip.speed);
  return Number.isFinite(value) && value > 0 ? Math.min(8192, Math.max(.0625, value)) : 1;
}
function trimPrefix(clip: ClipComposeClip, audio = false): string {
  const start = Math.max(0, Number(clip.sourceOffsetSeconds) || 0);
  const duration = Number(clip.sourceDurationSeconds);
  const trim = audio ? 'atrim' : 'trim';
  return `${trim}=start=${start.toFixed(3)}${Number.isFinite(duration) && duration > 0 ? `:duration=${duration.toFixed(3)}` : ''},`;
}
function atempoFilters(speed: number): string[] {
  const values: number[] = [];
  let rest = speed;
  while (rest > 2) { values.push(2); rest /= 2; }
  while (rest < .5) { values.push(.5); rest /= .5; }
  values.push(rest);
  return values.map((value) => `atempo=${value.toFixed(6)}`);
}
function normalizeFilter(index: number, output: string, width: number, height: number, fps: number, clip: ClipComposeClip): string {
  const speed = clipSpeed(clip);
  return `[${index}:v]${trimPrefix(clip)}setpts=(PTS-STARTPTS)/${speed.toFixed(6)},scale=${width}:${height}:force_original_aspect_ratio=decrease,`
    + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[${output}]`;
}

interface LayoutSlot { width: number; height: number; x: number; y: number }

function layoutSlots(layout: ClipLayoutPreset, width: number, height: number): LayoutSlot[] {
  if (layout === 'pip') {
    const pipWidth = Math.max(2, Math.round(width * .32 / 2) * 2);
    const pipHeight = Math.max(2, Math.round(height * .32 / 2) * 2);
    const margin = Math.max(12, Math.round(Math.min(width, height) * .025));
    return [
      { width, height, x: 0, y: 0 },
      { width: pipWidth, height: pipHeight, x: width - pipWidth - margin, y: height - pipHeight - margin },
    ];
  }
  if (layout === 'three') {
    const first = Math.floor(width / 3 / 2) * 2;
    const second = Math.floor(width / 3 / 2) * 2;
    return [
      { width: first, height, x: 0, y: 0 },
      { width: second, height, x: first, y: 0 },
      { width: width - first - second, height, x: first + second, y: 0 },
    ];
  }
  if (layout === 'quad') {
    const halfWidth = Math.floor(width / 2 / 2) * 2;
    const halfHeight = Math.floor(height / 2 / 2) * 2;
    return [
      { width: halfWidth, height: halfHeight, x: 0, y: 0 },
      { width: width - halfWidth, height: halfHeight, x: halfWidth, y: 0 },
      { width: halfWidth, height: height - halfHeight, x: 0, y: halfHeight },
      { width: width - halfWidth, height: height - halfHeight, x: halfWidth, y: halfHeight },
    ];
  }
  return [{ width, height, x: 0, y: 0 }];
}

/** 音频同步执行 atrim、变速与采样格式归一化。 */
function normalizeAudioFilter(index: number, output: string, clip: ClipComposeClip): string {
  const speed = clipSpeed(clip);
  /* 这一段原声被静音：压成 0，而不是把音轨丢掉（丢了段数与时长都会变，见 muteSourceAudio 的说明） */
  const mute = clip.muteSourceAudio === true ? 'volume=0,' : '';
  return `[${index}:a]${trimPrefix(clip, true)}asetpts=PTS-STARTPTS,${atempoFilters(speed).join(',')},${mute}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[${output}]`;
}

/**
 * 成片该有多长（秒）：片段总长减去被转场重叠掉的那些。
 *
 * 音频那一路要**精确**对上这个数：附加油轨比它长就裁、比它短就补静音。
 * 不这么做的话，`amix` 出来的时长会跟着最长的那一路走，成片末尾就会多出一段
 * 只有 BGM、没有画面的尾巴。
 */
function composeOutputSeconds(clips: readonly ClipComposeClip[], transitionSeconds: number): number {
  const overlap = transitionSeconds * Math.max(0, clips.length - 1);
  return Math.max(0, totalClipSeconds(clips) - overlap);
}

/** 一条音轨在 filter 里的音量写法：静音就是 0，否则是它自己的增益 */
function volumeFilter(gainDb: number): string {
  return `volume=${gainDb.toFixed(2)}dB`;
}

/**
 * 把「主音频」与附加油轨混成一路 `[outa]`。
 *
 *
 *   ① **静音的轨直接跳过**（不加输入、不进混音）。它与"压成 0"在输出上等价，
 *      但省一路解码；顺带一个好处：某一轨的文件不在了，只要它是静音的，合成照样能跑。
 *   ② `amix=…:duration=first:normalize=0`。`normalize=0` 是**必须**的：
 *      默认的 amix 会按输入路数把每一路都衰减一次，于是"静音一条轨"会连带改变
 *      另一条轨的电平——矩阵里 AUD-004 那条验收要的正是"静音一轨后其余轨逐采样差异 = 0"。
 *   ③ 主音频缺席（片段没音轨）但有附加油轨时，垫一路 `anullsrc` 当主：
 *      这样混音结构不变，BGM 照常出声，成片也不再是"整条没声音"。
 *
 * 每一路都先 `atrim` 到成片时长、再 `apad=whole_dur` 补到成片时长，
 * 于是时长只由视频决定。
 */
function planAudioMix(options: {
  /** 片段那边拼出来的主音频（没有就是 null） */
  mainLabel: string | null;
  audioTracks: readonly ClipComposeAudioTrack[];
  /** 附加油轨在 ffmpeg 输入里的起始下标（= clips.length） */
  inputIndexBase: number;
  durationSeconds: number;
}): { filters: string[]; output: string | null; notes: string[]; inputPaths: string[] } {
  const notes: string[] = [];
  const duration = Math.max(0.04, options.durationSeconds);
  const active = options.audioTracks.filter((track) => track.muted !== true);
  const skipped = options.audioTracks.length - active.length;
  if (skipped > 0) notes.push(`有 ${skipped} 条音轨是静音状态，这次没有混进去`);

  /*
    没有附加油轨时**什么都不做**：主音频本来就与视频等长（每段都 trim/atempo 过），
    直接把它交出去即可。这样"没加音轨"的老行为一个字都没变。
  */
  if (active.length === 0) {
    return { filters: [], output: options.mainLabel, notes, inputPaths: [] };
  }

  const filters: string[] = [];
  if (options.mainLabel === null) {
    /* 片段没音轨，但用户加了 BGM：垫一路静音当主，混音结构就统一了 */
    filters.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS[main]`,
    );
    notes.push('片段本身没有音轨，成片的声音全部来自你加的音轨');
  } else {
    filters.push(`[${options.mainLabel}]atrim=0:${duration.toFixed(3)},apad=whole_dur=${duration.toFixed(3)}[main]`);
  }

  const labels = ['[main]'];
  const loud: string[] = [];
  active.forEach((track, order) => {
    const gain = normalizeAudioGainDb(track.gainDb);
    const label = `bgm${order}`;
    filters.push(
      `[${options.inputIndexBase + order}:a]atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,`
        + `${volumeFilter(gain)},apad=whole_dur=${duration.toFixed(3)},aresample=48000,`
        + `aformat=sample_fmts=fltp:channel_layouts=stereo[${label}]`,
    );
    labels.push(`[${label}]`);
    if (gain !== 0) loud.push(`${track.label ?? `音轨 ${order + 1}`} ${gain > 0 ? '+' : ''}${gain}dB`);
  });

  filters.push(
    `${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0[outa]`,
  );
  notes.push(active.length === 1
    ? '已混入 1 条音轨'
    : `已混入 ${active.length} 条音轨`);
  if (loud.length > 0) notes.push(`音量增益：${loud.join('、')}`);

  return {
    filters,
    output: 'outa',
    notes,
    inputPaths: active.map((track) => track.path),
  };
}

/**
 * 算出"怎么拼"。纯函数：只产出参数与回执，不碰文件、不跑进程——
 * 这样"转场时长被钳到多少""缺音轨时怎么办"这些判断都能用测试钉住。
 */
export function planClipCompose(request: ClipComposeRequest): ClipComposePlan {
  const notes: string[] = [];
  const clips = request.clips;
  if (clips.length === 0) {
    throw new Error('没有可合成的片段');
  }

  const fps = request.fps ?? COMPOSE_FPS;
  const first = clips[0] as ClipComposeClip;
  const editedCount = clips.filter((clip) => (clip.sourceOffsetSeconds ?? 0) > 0 || clip.sourceDurationSeconds !== undefined || clipSpeed(clip) !== 1).length;
  if (editedCount > 0) notes.push(`已应用 ${editedCount} 段裁剪/变速设置`);
  const width = Math.max(2, Math.round(first.width));
  const height = Math.max(2, Math.round(first.height));
  const requestedLayout: ClipLayoutPreset = request.layout ?? 'sequence';
  const tracks = new Map<number, Array<{ clip: ClipComposeClip; inputIndex: number }>>();
  clips.forEach((clip, inputIndex) => {
    const track = normalizedVideoTrack(clip);
    const list = tracks.get(track) ?? [];
    list.push({ clip, inputIndex });
    tracks.set(track, list);
  });
  const activeTrackNumbers = [...tracks.keys()].sort((a, b) => a - b);
  const multiTrack = requestedLayout !== 'sequence' && activeTrackNumbers.length > 1;
  const expectedTracks = requestedLayout === 'pip' ? 2 : requestedLayout === 'three' ? 3 : requestedLayout === 'quad' ? 4 : 1;
  if (requestedLayout !== 'sequence' && (
    activeTrackNumbers.length !== expectedTracks
    || activeTrackNumbers.some((track, index) => track !== index + 1)
  )) {
    throw new Error(`${requestedLayout === 'pip' ? '画中画' : requestedLayout === 'three' ? '三分屏' : '四分屏'}需要视频轨 1–${expectedTracks} 都有素材`);
  }
  const sourceAudioClips = multiTrack ? (tracks.get(1) ?? []).map((item) => item.clip) : clips;

  /*
    声音：**只要主视频轨有一段没音轨，成片主音频就不带声音**。

    为什么不做"给静音段补一段静音"：那会让用户以为"这段本来就有声音"。
    宁可成片无声并如实说一句，也不产出对不上事实的片子。
  */
  const missingAudio = sourceAudioClips.filter((clip) => !clip.hasAudio).length;
  const withAudio = sourceAudioClips.length > 0 && missingAudio === 0;
  if (!withAudio) {
    /*
      先只说"片段这边缺音轨"这件事。

      "成片到底有没有声音"要等混音算完才知道——用户加的 BGM 也能让无声素材出声。
      所以那句话挪到下面（`soundOut === null` 时）再说，免得出现
      "提示说成片不带声音、成片里却在放 BGM"这种自相矛盾。
    */
    notes.push(
      missingAudio === sourceAudioClips.length
        ? (multiTrack ? '主视频轨的片段都没有音轨' : '这些片段都没有音轨')
        : `${multiTrack ? '主视频轨' : ''}有 ${missingAudio} 段没有音轨`,
    );
  }

  /* 转场：单段没有"之间"可言；时长要同时满足下限与"不能把片段吃掉" */
  const requested = clipTransitionOption(request.transition.id);
  let appliedTransition: ClipTransitionId = 'none';
  let transitionSeconds = 0;
  if (!multiTrack && clips.length > 1 && requested !== null && requested.ffmpeg !== null) {
    const shortest = Math.min(...clips.map((clip) => clip.durationSeconds));
    const maxAllowed = shortest / 2;
    if (maxAllowed < TRANSITION_MIN_SECONDS) {
      notes.push(`片段太短（最短 ${shortest.toFixed(1)}s），这次没有加转场`);
    } else {
      const clamped = Math.min(
        Math.max(request.transition.durationSeconds, TRANSITION_MIN_SECONDS),
        TRANSITION_MAX_SECONDS,
        maxAllowed,
      );
      if (Math.abs(clamped - request.transition.durationSeconds) > 0.05) {
        notes.push(
          `转场时长从 ${request.transition.durationSeconds.toFixed(1)}s 收到 ${clamped.toFixed(1)}s`
            + `（不能超过最短片段的一半：${shortest.toFixed(1)}s）`,
        );
      }
      appliedTransition = requested.id;
      transitionSeconds = clamped;
    }
  } else if (clips.length === 1 && requested !== null && requested.ffmpeg !== null) {
    notes.push('只有一个片段，转场没有用武之地（转场加在两段之间）');
  }
  if (multiTrack && requested?.ffmpeg !== null && requested !== null) {
    notes.push('多视频轨布局按轨内顺序硬切；转场仅用于单视频轨串联');
  }

  /*
    音频后处理：把「片段拼出来的主音频」与「用户加的附加油轨」混成一路。
    主音频那一路统一叫 `mainAudioRaw`（下面三个分支都往这个名字上接），
    混音结果叫 `outa` —— 两个名字不能相同：ffmpeg 里同一个 label 不能既当输入又当输出。
  */
  const audioTracks = request.audioTracks ?? [];
  const mainLabel = withAudio ? 'mainAudioRaw' : null;
  const mix = planAudioMix({
    mainLabel,
    audioTracks,
    inputIndexBase: clips.length,
    durationSeconds: multiTrack ? totalClipSeconds(clips) : composeOutputSeconds(clips, transitionSeconds),
  });
  notes.push(...mix.notes);

  const inputs: string[] = [];
  for (const clip of clips) inputs.push('-i', clip.path);
  for (const path of mix.inputPaths) inputs.push('-i', path);

  const filters: string[] = [];
  /*
    字幕：在**拼接/转场之后**再烧，这样它落在最终画面上，不会被后面的拼接冲掉。
    `hideSubtitles` 是线上那个「关闭字幕」开关——关了就当没这条字幕轨。
  */
  const finishVideo = (baseLabel: string): string => {
    if (request.subtitlesFilePath === undefined || request.hideSubtitles === true) return baseLabel;
    filters.push(`[${baseLabel}]${subtitleFilterArgument(request.subtitlesFilePath)}[vWithSubtitles]`);
    return 'vWithSubtitles';
  };
  /* 成片带不带声音，看的是**混音之后**有没有那一路（BGM 也能让无声素材出声） */
  const soundOut = mix.output;
  if (soundOut === null) {
    notes.push('成片不带声音（不给静音片段凭空补声音）');
  }
  const buildTail = (): string[] => {
    const parts = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'];
    if (soundOut === null) parts.push('-an');
    else parts.push('-c:a', 'aac', '-b:a', '192k');
    parts.push('-movflags', '+faststart', '-y', request.outputPath);
    return parts;
  };
  const buildMaps = (videoLabel: string): string[] => (soundOut === null
    ? ['-map', `[${videoLabel}]`]
    : ['-map', `[${videoLabel}]`, '-map', `[${soundOut}]`]);

  if (multiTrack) {
    const slots = layoutSlots(requestedLayout, width, height);
    const trackOutputs: Array<{ label: string; slot: LayoutSlot }> = [];
    activeTrackNumbers.forEach((trackNumber, order) => {
      const items = tracks.get(trackNumber)!;
      const slot = slots[order]!;
      const normalizedLabels: string[] = [];
      items.forEach(({ clip, inputIndex }, clipIndex) => {
        const label = `t${trackNumber}v${clipIndex}`;
        filters.push(normalizeFilter(inputIndex, label, slot.width, slot.height, fps, clip));
        normalizedLabels.push(`[${label}]`);
      });
      const output = `track${trackNumber}`;
      if (normalizedLabels.length === 1) {
        filters.push(`${normalizedLabels[0]}null[${output}]`);
      } else {
        filters.push(`${normalizedLabels.join('')}concat=n=${normalizedLabels.length}:v=1:a=0[${output}]`);
      }
      trackOutputs.push({ label: output, slot });
    });

    const baseAudio = tracks.get(1) ?? [];
    if (withAudio) {
      baseAudio.forEach(({ clip, inputIndex }, index) => filters.push(normalizeAudioFilter(inputIndex, `mtAudio${index}`, clip)));
      if (baseAudio.length === 1) filters.push('[mtAudio0]anull[mainAudioRaw]');
      else filters.push(`${baseAudio.map((_item, index) => `[mtAudio${index}]`).join('')}concat=n=${baseAudio.length}:v=0:a=1[mainAudioRaw]`);
    }

    const duration = Math.max(.04, totalClipSeconds(clips));
    filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${duration.toFixed(3)}[layoutBase]`);
    let canvasLabel = 'layoutBase';
    trackOutputs.forEach(({ label, slot }, index) => {
      const output = index === trackOutputs.length - 1 ? 'outv' : `layout${index + 1}`;
      filters.push(`[${canvasLabel}][${label}]overlay=x=${slot.x}:y=${slot.y}:eof_action=pass:shortest=0[${output}]`);
      canvasLabel = output;
    });
    filters.push(...mix.filters);
    const layoutVideoOut = finishVideo('outv');
    notes.push(`${requestedLayout === 'pip' ? '画中画' : requestedLayout === 'three' ? '三分屏' : '四分屏'}：${activeTrackNumbers.length} 条视频轨同时合成`);
    return {
      args: ['-hide_banner', '-nostdin', ...inputs, '-filter_complex', filters.join(';'), '-t', duration.toFixed(3), ...buildMaps(layoutVideoOut), ...buildTail()],
      notes,
      appliedTransition: 'none',
      withAudio: soundOut !== null,
    };
  }

  /* 单段：不需要拼接，但仍要归一化一次——用户连进来的可能是任何画幅/帧率 */
  if (clips.length === 1) {
    filters.push(normalizeFilter(0, 'v0', width, height, fps, first));
    if (withAudio) filters.push(normalizeAudioFilter(0, 'mainAudioRaw', first));
    filters.push(...mix.filters);
    /* 先把字幕那一层接上，再拼 args——数组字面量是从左往右求值的，
       写成 `[..., filters.join(';'), ...buildMaps(finishVideo('v0'))]` 的话，
       join 会**先**跑，字幕滤镜根本没进 filter_complex（真机上报的是
       "Output with label 'vWithSubtitles' does not exist in any defined filter graph"）。 */
    const singleVideoOut = finishVideo('v0');
    return {
      args: ['-hide_banner', '-nostdin', ...inputs, '-filter_complex', filters.join(';'), ...buildMaps(singleVideoOut), ...buildTail()],
      notes,
      appliedTransition: 'none',
      withAudio: soundOut !== null,
    };
  }

  for (let index = 0; index < clips.length; index += 1) {
    filters.push(normalizeFilter(index, `v${index}`, width, height, fps, clips[index]!));
    if (withAudio) filters.push(normalizeAudioFilter(index, `a${index}`, clips[index]!));
  }

  if (appliedTransition === 'none' || requested?.ffmpeg === null || requested === null) {
    /* 无转场：直接 concat。原版 小QTV 走时间轴拼接，效果与这个一致 */
    const labels = clips.map((_clip, index) => (withAudio ? `[v${index}][a${index}]` : `[v${index}]`)).join('');
    filters.push(`${labels}concat=n=${clips.length}:v=1:a=${withAudio ? 1 : 0}[outv]${withAudio ? '[mainAudioRaw]' : ''}`);
    filters.push(...mix.filters);
    const concatVideoOut = finishVideo('outv');
    return {
      args: ['-hide_banner', '-nostdin', ...inputs, '-filter_complex', filters.join(';'), ...buildMaps(concatVideoOut), ...buildTail()],
      notes,
      appliedTransition: 'none',
      withAudio: soundOut !== null,
    };
  }

  /*
    有转场：xfade 链。

    offset 是"在时间轴的哪一刻开始重叠"。第 k 次转场（把第 k 段接上去）的起点
    = 前 k 段的净时长之和 − 转场时长；净时长要**减去已经重叠掉的每一段转场**，
    否则转场会一次比一次晚，末尾发出黑帧。
  */
  let videoLabel = 'v0';
  let audioLabel = 'a0';
  let offset = clips[0]!.durationSeconds - transitionSeconds;
  for (let index = 1; index < clips.length; index += 1) {
    const nextVideo = index === clips.length - 1 ? 'outv' : `vx${index}`;
    filters.push(
      `[${videoLabel}][v${index}]xfade=transition=${requested.ffmpeg}:`
        + `duration=${transitionSeconds.toFixed(3)}:offset=${Math.max(0, offset).toFixed(3)}[${nextVideo}]`,
    );
    videoLabel = nextVideo;
    if (withAudio) {
      const nextAudio = index === clips.length - 1 ? 'mainAudioRaw' : `ax${index}`;
      filters.push(`[${audioLabel}][a${index}]acrossfade=d=${transitionSeconds.toFixed(3)}[${nextAudio}]`);
      audioLabel = nextAudio;
    }
    offset = offset + clips[index]!.durationSeconds - transitionSeconds;
  }
  filters.push(...mix.filters);
  const xfadeVideoOut = finishVideo('outv');
  return {
    args: ['-hide_banner', '-nostdin', ...inputs, '-filter_complex', filters.join(';'), ...buildMaps(xfadeVideoOut), ...buildTail()],
    notes,
    appliedTransition,
    withAudio: soundOut !== null,
  };
}

/** 用 ffprobe 读一段视频的宽高 */
export async function probeVideoSize(path: string): Promise<{ width: number; height: number } | null> {
  const result = await run('ffprobe', probeVideoArgs(path));
  if (!result.ok) return null;
  return parseProbeSize(result.stdout ?? '');
}

/**
 * 一次问全：时长、画幅、有没有音轨。

 * 为什么不借内核的 `media probe`：它只给 path / duration / hasVideo / hasAudio，
 * 没有画幅——拼接必须知道统一到多大。而 ffprobe 一次就能把三样都给全，
 * 于是合成本身**不依赖内核装没装**，这条能力在没装 前置内核 的机器上也能用。
 */
export function probeClipArgs(path: string): string[] {
  return [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json',
    path,
  ];
}

export function parseProbeClip(stdout: string): Omit<ClipComposeClip, 'path'> | null {
  try {
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: unknown };
      streams?: Array<{ codec_type?: unknown; width?: unknown; height?: unknown }>;
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const duration = Number(parsed.format?.duration);
    const width = Number(video?.width);
    const height = Number(video?.height);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
    return {
      durationSeconds: duration,
      hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
      width: Math.round(width),
      height: Math.round(height),
    };
  } catch {
    return null;
  }
}

/** 读一段素材的全部合成所需事实；读不出就返回 null，调用方据此给一句人话 */
export async function probeClip(path: string): Promise<ClipComposeClip | null> {
  const result = await run('ffprobe', probeClipArgs(path));
  if (!result.ok) return null;
  const parsed = parseProbeClip(result.stdout ?? '');
  return parsed === null ? null : { path, ...parsed };
}

/**
 * 执行合成。

 * 失败时把 ffmpeg 的 stderr 尾部带出来：它的报错是这件事上最准确的说法，
 * 用一句"合成失败"盖掉，用户就只剩重试一条路。
 */
export async function composeClips(plan: ClipComposePlan): Promise<{
  ok: boolean;
  bytes: number;
  error?: string;
}> {
  const outputPath = plan.args[plan.args.length - 1] as string;
  const result = await run('ffmpeg', plan.args, 10 * 60 * 1000);
  if (!result.ok) return { ok: false, bytes: 0, error: result.error ?? 'ffmpeg 执行失败' };
  if (!existsSync(outputPath)) {
    return { ok: false, bytes: 0, error: 'ffmpeg 报成功，但没有产出文件' };
  }
  return { ok: true, bytes: statSync(outputPath).size };
}

function run(
  command: string,
  args: readonly string[],
  timeoutMs = 60_000,
): Promise<{ ok: boolean; stdout?: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout: typeof stdout === 'string' ? stdout : '' });
          return;
        }
        const text = (typeof stderr === 'string' ? stderr : '').trim();
        /* 只留最后几行：ffmpeg 的 stderr 很长，前面全是输入探测输出 */
        const tail = text.split('\n').slice(-3).join(' ').trim();
        resolve({ ok: false, error: tail.length > 0 ? `${command}：${tail}` : `${command} 执行失败` });
      },
    );
  });
}
