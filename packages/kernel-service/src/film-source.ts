/* ============================================================
   期音科技 · Source 生成器
   ------------------------------------------------------------
   产品不做「自己实现视频生成」这件事：它把已确认的拆解与已选定的首帧

   生成必须**确定性**：同一份输入产生逐字节相同的文本。这样
   「改了 shot-03 的时长」才会精确地只让这一版 Source 变化，
   而不是每次都得到一份"看起来差不多"的新文件无从比对。

   语法依据是实测可行的最小组合（见 docs/前置内核-KERNEL-INTEGRATION.md）：
     media:Image        —— 把项目内的图片文件发布为 Artifact
     media-track:Track  —— 把图片按 authored 时间铺在画布上（Item 带 extent 与 appearance）
     film:Film          —— 组装成 Composition
     render:Video       —— 渲染并输出 final.video
   ============================================================ */

import { FILM_TRANSITIONS, type FilmTransition } from '@qiyin/contracts';

/**
 *
 * 而 crossfade 恰好**不需要**方向，于是"不传 direction 也合法"这个假设
 * 看起来一直成立。默认取 `left`：短视频里最常见的推/擦方向。
 */
const DIRECTIONAL_TRANSITIONS: readonly FilmTransition[] = ['push', 'wipe', 'cover', 'page-turn'];
export const DEFAULT_TRANSITION_DIRECTION = 'left';

export interface FilmCanvas {
  width: number;
  height: number;
}

export interface FilmShot {
  shot_id: string;
  /** 图片文件相对于 Source 所在目录的路径（用 POSIX 分隔符）。 */
  image_src: string;
  duration_ms: number;
  /**
   * 若提供，则用这段**视频片段**而不是静帧。
   *
   * 传进来的路径同样是相对于 Source 所在目录的；`prepareFilmSource` 负责换算。
   * 视频要走 `media:Video → Normalize → SynchronizedMedia` 这条链路，
   * 因为 `track:Item` 的 `media` 只接受已归一化的定时媒体。
   */
  video_src?: string;
  /**
   * 片段是否带**可听**的源声音。
   *
   * 只有为 true 时才把它的声音接进成片。判据来自实测响度（见 `loudness.ts`），
   * 不是「容器里有没有音轨」——前置内核 的成片合流时总会写一条音轨，
   * 没有声音时写的是数字静音，所以 `hasAudio` 分不出这两种情况。
   *
   * 默认 false 是刻意的保守选择：默认带上，等于把一个没人听过的音轨混进成片。
   */
  audio?: boolean;
  /**
   * 片段与镜头不等长时的播放策略。
   *
   *   `hold`（默认）—— 播完停在最后一帧；
   *   `stretch`      —— 把源拉伸到正好填满窗口，也就是**变速**
   *                     （源短则慢放，源长则快放）。
   *
   */
  playback?: 'hold' | 'stretch';
}

export interface FilmSourceOptions {
  canvas: FilmCanvas;
  frameRate: number;
  shots: readonly FilmShot[];
  /**
   * 镜头之间怎么换。
   *
   *   `cut`（默认）—— 保持"每镜一个 Item"的原生结构；
   *   `crossfade`   —— 改写成 `Sequence + Member + Handoff`，
   *
   * 为什么默认那条路不换成 Sequence：硬切时两者的画面完全一样，
   * 而"每镜一个 Item"这条路已经在真实成片里跑过很多次。
   * 让默认路径保持原样，是把改动的影响面压到"用户真的要转场"这一种情况。
   */
  transition?: FilmTransition;
}

/** 转义 XML 属性值。文件名里出现引号或 & 时不能破坏语法。 */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 毫秒 → 秒字面量。保留三位小数并去掉多余的零，例如 2100 → `2.1s`。 */
export function secondsLiteral(ms: number): string {
  const seconds = ms / 1000;
  return `${Number(seconds.toFixed(3))}s`;
}

export function totalDurationMs(shots: readonly FilmShot[]): number {
  return shots.reduce((total, shot) => total + Math.max(0, shot.duration_ms), 0);
}

/** 转场时长的上限（帧）：30fps 下 0.4 秒——短到不会吃掉镜头，长到看得出是"化"过去的。 */
export const CROSSFADE_FRAMES_MAX = 12;

/**
 * 每一对相邻镜头的转场帧数（长度 = 镜头数 − 1）。
 *
 * 为什么不能用一个固定值：镜头时长来自参考片的切镜，快切到 0.2 秒很常见，
 * 而固定 12 帧（0.4 秒）会**盖住整个短镜头**——那一镜在成片里根本看不见，
 * 于是用户只会觉得"我那一镜怎么没了"。
 *
 * 规则：取默认上限与"较短那一镜的一半"里的小者。
 * "一半"这个系数是有意的：转场之后两镜各自都还得留得住可见的部分。
 * 算出来不足 2 帧的直接归 0（等价于硬切）——1 帧的"淡入淡出"没有意义，
 * 写 0 反而能让 Source 如实表达"这里就是切"。
 */
export function transitionFramesFor(shots: readonly FilmShot[], frameRate: number): number[] {
  /*
    注意别用 `quantizeMsToFrames`：那个函数名字像"转成帧数"，其实返回的是
    **量化到帧边界的毫秒数**（见它的实现）。这里要的是帧数，得自己算——
    名字看走眼会把整段夹取逻辑算成"永远取上限"，而结果看起来还挺合理。
  */
  const framesOf = (ms: number): number => frameRate <= 0
    ? Math.max(1, ms)
    : Math.max(1, Math.round((Math.max(0, ms) / 1000) * frameRate));
  const frames: number[] = [];
  for (let index = 0; index < shots.length - 1; index += 1) {
    const previous = framesOf(shots[index]!.duration_ms);
    const next = framesOf(shots[index + 1]!.duration_ms);
    const half = Math.floor(Math.min(previous, next) / 2);
    const wanted = Math.min(CROSSFADE_FRAMES_MAX, half);
    frames.push(wanted < 2 ? 0 : wanted);
  }
  return frames;
}

/**
 * 把毫秒量化到帧边界。
 *
 * 否则 `assemble-timeline` 会直接失败——
 * 「Timeline duration 8.096s must land on an exact frame boundary」。
 *
 * 8.096s @30fps = 242.88 帧，不是整数帧；量化后是 243 帧 = 8.1s。
 * 这也让成片的时间轴与偏差评估用的是同一套量化模型，两边不会各算各的。
 */
export function quantizeMsToFrames(ms: number, frameRate: number): number {
  if (frameRate <= 0) return Math.max(1, ms);
  // 至少一帧：零长度片段在时间轴上没有意义
  const frames = Math.max(1, Math.round((Math.max(0, ms) / 1000) * frameRate));
  return Math.round((frames / frameRate) * 1000);
}

/** 量化后的总时长（与逐镜量化之和一致，保证 end 落在帧边界）。 */
export function quantizedTotalMs(shots: readonly FilmShot[], frameRate: number): number {
  return shots.reduce((total, shot) => total + quantizeMsToFrames(shot.duration_ms, frameRate), 0);
}

/**
 * 镜头的内容指纹——判定「这一镜要不要重跑」的唯一依据。
 *
 * 它只看**输入**（画面、时长），不看这一镜在时间轴上的位置。
 * 这个区分很关键：前一镜改短了，后一镜的起点当然要往前移，
 * 但那不等于后一镜的画面需要重做。若把位置算进指纹，
 * 任何一次改动都会退化成「全片重跑」——正是复刻类产品最容易悄悄烧钱的地方。
 */
export function shotContentDigest(shot: FilmShot): string {
  return JSON.stringify({
    shot_id: shot.shot_id,
    image_src: shot.image_src,
    duration_ms: shot.duration_ms,
    video_src: shot.video_src ?? null,
    // 声音算不算这一镜的内容？算——同一段画面配上声音就是另一份素材
    audio: shot.audio === true,
  });
}

/** 生成器标识符：短 id 直接由镜头编号派生，保证可读且稳定。 */
function identifier(prefix: string, shotId: string): string {
  return `${prefix}-${shotId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/** 单个镜头的媒体资源声明：有视频片段就用视频，否则用静帧图。 */
export function shotMediaSource(shot: FilmShot): string {
  if (shot.video_src !== undefined) {
    return `  <media:Video id="${attr(identifier('clip', shot.shot_id))}" src="${attr(shot.video_src)}"/>`;
  }
  return `  <media:Image id="${attr(identifier('still', shot.shot_id))}" src="${attr(shot.image_src)}"/>`;
}

/**
 * 视频片段的归一化声明。
 *
 * `Item.media` 只接受 SynchronizedMedia，而 `media:Video` 给出的是普通 Blob，
 * 因此中间必须有一次 Normalize。
 *
 * 这里的 `audio` **不是**写死的：它由调用方逐镜量过电平之后决定（见下面的说明）。
 * 早先这一行无条件写 `audio="none"`，那版注释也写着"还没做音频编排"——
 * 两句话在音频编排实现之后都过时了，留着会让下一个人以为功能还没做。
 */
export function shotNormalizeSource(shot: FilmShot): string | null {
  if (shot.video_src === undefined) return null;
  /**
   * 声音是**逐镜选择**的：只有这一镜的片段真的有声（实测响度过了门槛）才带上。
   *
   * 之前这里无条件写 `audio="none"`，于是生成片段里那段 -8.8 dB 的真实声音
   * 被成片丢掉了，而评估还报「音轨一致」。现在改由调用方先量过再决定。
   */
  const audio = shot.audio === true ? 'default' : 'none';
  return `  <pipeline:Normalize id="${attr(identifier('norm', shot.shot_id))}"`
    + ` source={${identifier('clip', shot.shot_id)}}`
    + ` video="primary-moving" audio="${audio}" span-authority="video" clock={clock}/>`;
}

/** 单个镜头的时间轴 Item。`cursorMs` 是它在片中的起点。 */
/**
 * 单个镜头的时间轴 Item。
 *
 * 「extent is only valid with image={Artifact}」）。视频片段的尺寸来自它自己的
 * 媒体事实，不需要也不允许再用 authored extent 去声明。
 */
export function shotItemSource(shot: FilmShot, cursorMs: number): string {
  const isVideo = shot.video_src !== undefined;
  const source = isVideo
    ? `media={${identifier('norm', shot.shot_id)}.media}`
    : `image={${identifier('still', shot.shot_id)}}`;
  const extent = isVideo ? '' : ' extent={frame-extent}';
  /**
   * 直接源被采样进名为 `content` 的层，所以 `source-audio="content"` 就是
   */
  const sourceAudio = isVideo && shot.audio === true ? ' source-audio="content"' : '';
  /*
    视频按这一镜选的策略取 recipe（hold 或 stretch）；
  */
  const appearance = isVideo
    ? (shot.playback === 'stretch' ? 'style.media.video-stretch' : 'style.media.video')
    : 'style.media.clip';
  return `    <track:Item id="${attr(shot.shot_id)}" ${source}`
    + ` at="${secondsLiteral(cursorMs)}" for="${secondsLiteral(Math.max(0, shot.duration_ms))}"`
    + ` frame={full}${extent}${sourceAudio} appearance={${appearance}}/>`;
}

/**
 * Sequence 里的一个 Member（一镜）。
 *
 * 与 `shotItemSource` 的区别不只是标签名：
 *   · Member 只有 `at`（激活时刻），**没有 `for`**——它换到下一个 Member 就结束；
 *   · 片段的播放策略走 **Member 自己的 appearance**：Sequence 那份只管外框，
 *     Member 那份才读 fit 与 sample（含 playback）。
 *     所以 `hold` / `stretch` 在转场模式下同样按镜生效。
 *   · 静图**不写 appearance**：它继承 Sequence 的 `media.clip`，
 *     写了反而会把"没有播放策略"这件事说得更绕。
 */
function shotMemberSource(shot: FilmShot, cursorMs: number, memberId: string): string {
  const isVideo = shot.video_src !== undefined;
  const source = isVideo
    ? `media={${identifier('norm', shot.shot_id)}.media}`
    : `image={${identifier('still', shot.shot_id)}} extent={frame-extent}`;
  const appearance = isVideo
    ? ` appearance={${shot.playback === 'stretch' ? 'style.media.video-stretch' : 'style.media.video'}}`
    : '';
  /* 与 Item 路径同一条：只有这一镜的片段真的有声，才把它自己的声音发出来 */
  const sourceAudio = isVideo && shot.audio === true ? ' source-audio="content"' : '';
  return `      <track:Member id="${attr(memberId)}" ${source}`
    + ` at="${secondsLiteral(cursorMs)}"${appearance}${sourceAudio}/>`;
}

/**
 * SVS 配方：film 背景、每种素材的贴合方式，以及逐对转场。
 *
 * `crossfadeFrames` 给出"每一对相邻镜头的转场帧数"（见 `crossfadeFramesFor`）；
 * 不传（或传空）表示这次不走转场路径，配方里就不会有 handoff 那几份。
 */
export function buildStyleSheet(
  transitionFrames: readonly number[] = [],
  operator: FilmTransition = 'crossfade',
  direction: string = DEFAULT_TRANSITION_DIRECTION,
): string {
  /*
    逐对配方的 operator：帧数夹出来是 0 的那些对，**不论用户选了哪种转场**，
    都如实写成 `cut`——它们本来就短到放不下一次转场，写 crossfade 只是自欺。
  */
  const cleanOperator: FilmTransition = (FILM_TRANSITIONS as readonly string[]).includes(operator)
    ? operator
    : 'crossfade';
  /*
    而 push/wipe/cover/page-turn 不写方向同样会被拒——两边都不能想当然。
  */
  const directionLine = DIRECTIONAL_TRANSITIONS.includes(cleanOperator)
    ? [`    direction: ${direction};`]
    : [];
  return [
    '<?svml using="@frontkernel/svs@1"?>',
    '<sheet version="1">',
    '  film.main { background: #000000; }',
    '  media.clip {',
    '    stack-order: 10;',
    '    fit: cover;',
    '  }',
    /*
      视频片段单独一份 recipe，唯一区别是多一行 `playback`。

      为什么必须单独一份：`playback` 只对**有时长的素材**有效，
      still material」）。而我们的 Item 既可能是首帧静图、也可能是生成出来的片段，
      共用一份 recipe 就得二选一：要么静图报错，要么视频没有播放策略。

      "draw no source after it ends if the Window is longer"），
      于是成片尾部会露出 film 的黑色背景——看起来像"这一段黑屏了"。
      实景里这不罕见：用户在时间轴上把镜头拉长、或者模型给的片段比请求的短，
      都会撞上。`hold-start` 改成播完停在最后一帧，画面还是那一镜的画面。
    */
    '  media.video {',
    '    stack-order: 10;',
    '    fit: cover;',
    '    playback: hold-start;',
    '  }',
    /*
      第三种：把源拉伸到正好填满窗口（源短则慢放）。这是**变速**，
      只在用户明确选了 stretch 时才用——默认那份只影响"多出来的那一段"，
      不会改已经对上的部分。
    */
    '  media.video-stretch {',
    '    stack-order: 10;',
    '    fit: cover;',
    '    playback: stretch;',
    '  }',
    /*
      转场配方**逐对生成**，而不是一个全局的 crossfade。

      原因是镜头长短不一：固定 12 帧遇到 0.2 秒的快切会盖住整个镜头
      `crossfadeFramesFor` 按相邻两镜的较短者夹出来，配方也就要有 N 份。

      直接写 `cut`——1 帧的"淡入淡出"没有意义，如实表达"这里就是切"更好。
    */
    ...transitionFrames.flatMap((frames, index) => (frames > 0 ? [
      `  transition.handoff-${index + 1} {`,
      `    operator: ${cleanOperator};`,
      `    duration-frames: ${frames};`,
      ...directionLine,
      '  }',
    ] : [
      `  transition.handoff-${index + 1} {`,
      '    operator: cut;',
      '    duration-frames: 0;',
      '  }',
    ])),
    '</sheet>',
    '',
  ].join('\n');
}

/**
 * 生成 author Source。
 *
 * 每个镜头一个 Item：`image` 指向该镜已选定的首帧，`at`/`for` 给出它在片中的位置。
 * 这就是「用参考片的节奏 + 自己的首帧」——结构来自拆解，画面来自选帧。
 */
export function buildAuthorSource(options: FilmSourceOptions): string {
  const { canvas, frameRate, shots } = options;
  const lines: string[] = [
    '<?svml using="@frontkernel/markup@1"?>',
    '<svml>',
    '  <import as="time" from="@frontkernel/timeline-author@1"/>',
    '  <import as="space" from="@frontkernel/spatial@1"/>',
    '  <import as="media" from="@frontkernel/media@1"/>',
    '  <import as="pipeline" from="@frontkernel/media-pipeline@1"/>',
    '  <import as="track" from="@frontkernel/media-track@1"/>',
    '  <import as="film" from="@frontkernel/film@1"/>',
    '  <import as="render" from="@frontkernel/render-hyperframes@1"/>',
    '  <import as="style" source="./film.svs"/>',
    '',
    `  <time:Clock id="clock" frame-rate="${frameRate}"/>`,
    `  <time:Timeline id="timeline" clock={clock} end="${secondsLiteral(quantizedTotalMs(shots, frameRate))}"/>`,
    `  <space:Canvas id="canvas" width="${canvas.width}" height="${canvas.height}"/>`,
    '  <space:Frame id="full" within={canvas} left="0%" top="0%" right="100%" bottom="100%"/>',
    `  <space:Extent id="frame-extent" width="${canvas.width}" height="${canvas.height}"/>`,
    '',
  ];

  for (const shot of shots) {
    lines.push(shotMediaSource(shot));
  }
  for (const shot of shots) {
    const normalize = shotNormalizeSource(shot);
    if (normalize !== null) lines.push(normalize);
  }
  lines.push('');

  lines.push('  <track:Track id="scenes" timeline={timeline.timeline} canvas={canvas}>');
  let cursorMs = 0;
  /*
    `cut` 保持"每镜一个 Item"的原生结构（见本文件顶部的说明）。
  */
  const wantsTransition = options.transition !== undefined && options.transition !== 'cut';
  if (wantsTransition && shots.length >= 2) {
    /*
      转场路径：一个 Sequence + N 个 Member + N-1 个 Handoff。

        · Sequence 自己要有 `until`（终止时刻），Item 各自带 `for`；
        · Member 只有 `at`（激活时刻），时长由下一个 Member 的 at 决定；
        · 相邻两个 Member **必须**各有一个 Handoff，一个都不能漏。
    */
    const quantizedShots = shots.map((shot) => ({
      shot, duration_ms: quantizeMsToFrames(shot.duration_ms, frameRate),
    }));
    lines.push('    <track:Sequence id="shots" frame={full} appearance={style.media.clip}'
      + ` until="${secondsLiteral(quantizedTotalMs(shots, frameRate))}">`);
    const memberIds = quantizedShots.map(({ shot }) => identifier('member', shot.shot_id));
    for (const [index, entry] of quantizedShots.entries()) {
      lines.push(shotMemberSource({ ...entry.shot, duration_ms: entry.duration_ms }, cursorMs, memberIds[index]!));
      cursorMs += entry.duration_ms;
    }
    for (let index = 0; index < memberIds.length - 1; index += 1) {
      lines.push(`    <track:Handoff id="handoff-${index + 1}" from="${attr(memberIds[index]!)}"`
        + ` transition={style.transition.handoff-${index + 1}}/>`);
    }
    lines.push('    </track:Sequence>');
  } else {
    for (const shot of shots) {
      // 逐镜同样量化：Item 的时长与它推进游标的步长必须是同一个数，
      // 否则累计下来的 end 会重新偏离帧边界
      const quantized = quantizeMsToFrames(shot.duration_ms, frameRate);
      lines.push(shotItemSource({ ...shot, duration_ms: quantized }, cursorMs));
      cursorMs += quantized;
    }
  }
  lines.push('  </track:Track>');
  lines.push('');

  lines.push('  <film:Film id="main" canvas={canvas} timeline={timeline.timeline} appearance={style.film.main}>');
  lines.push('    <film:Track source={scenes.visual}/>');
  /**
   * 只要有一镜发出了声音，Track 就会多出一个 `audio` 端口，Film 必须把它接进来。
   *
   * 反过来，一镜都没发声时**不能**写这一行：那时 `scenes.audio` 端口根本不存在，
   * 「Track 在有声音时才发布 `.audio`；Film 必须包含需要的同级输出」。
   */
  if (shots.some((shot) => shot.video_src !== undefined && shot.audio === true)) {
    lines.push('    <film:Track source={scenes.audio}/>');
  }
  lines.push('  </film:Film>');
  lines.push('');
  lines.push('  <render:Video id="final" composition={main.composition} timeline={timeline.timeline}/>');
  lines.push('</svml>');
  lines.push('');
  return lines.join('\n');
}

/** 生成 run Source：把 author Source 与目标输出绑在一起。 */
export function buildRunSource(authorFileName: string): string {
  return [
    '<?svml using="@frontkernel/run-markup@1"?>',
    '',
    '<svrun version="1">',
    `  <author source="${attr(`./${authorFileName}`)}"/>`,
    '  <target output="final.video"/>',
    '</svrun>',
    '',
  ].join('\n');
}
