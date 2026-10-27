import { describe, expect, it } from 'vitest';
import {
  buildAuthorSource,
  buildRunSource,
  buildStyleSheet,
  transitionFramesFor,
  quantizedTotalMs,
  quantizeMsToFrames,
  secondsLiteral,
  shotContentDigest,
  totalDurationMs,
} from '@qiyin/kernel-service';

/**
 * Source 生成器。
 *
 * 最要紧的性质是**确定性**：同一份拆解必须产生逐字节相同的 Source。
 * 否则「改了 shot-03 的时长」会得到一份无从比对的新文件，
 * 执行快照的缓存语义（ADR-10）也就无从谈起。
 */

const shots = [
  { shot_id: 'shot-01', image_src: '../frames/a.jpg', duration_ms: 2100 },
  { shot_id: 'shot-02', image_src: '../frames/b.jpg', duration_ms: 1500 },
];

describe('时间字面量', () => {
  it('毫秒转秒，去掉多余的零', () => {
    expect(secondsLiteral(3000)).toBe('3s');
    expect(secondsLiteral(2100)).toBe('2.1s');
    expect(secondsLiteral(1500)).toBe('1.5s');
    expect(secondsLiteral(1234)).toBe('1.234s');
    expect(secondsLiteral(0)).toBe('0s');
  });

  it('总时长是各镜之和', () => {
    expect(totalDurationMs(shots)).toBe(3600);
    expect(totalDurationMs([])).toBe(0);
  });
});

describe('author Source', () => {
  it('同一份输入产生逐字节相同的文本', () => {
    const first = buildAuthorSource({ canvas: { width: 540, height: 960 }, frameRate: 30, shots });
    const second = buildAuthorSource({ canvas: { width: 540, height: 960 }, frameRate: 30, shots });
    expect(first).toBe(second);
  });

  it('声明了渲染链路需要的全部 import', () => {
    const source = buildAuthorSource({ canvas: { width: 540, height: 960 }, frameRate: 30, shots });
    for (const module of [
      '@frontkernel/timeline-author@1',
      '@frontkernel/spatial@1',
      '@frontkernel/media@1',
      '@frontkernel/media-track@1',
      '@frontkernel/film@1',
      '@frontkernel/render-hyperframes@1',
    ]) {
      expect(source).toContain(module);
    }
    expect(source).toContain('<?svml using="@frontkernel/markup@1"?>');
  });

  it('每个镜头一个图片资源与一个时间轴 Item，并按顺序排布', () => {
    const source = buildAuthorSource({ canvas: { width: 540, height: 960 }, frameRate: 30, shots });
    expect(source.match(/<media:Image /g)).toHaveLength(2);
    expect(source.match(/<track:Item /g)).toHaveLength(2);
    // 第二镜从第一镜结束处开始
    expect(source).toContain('at="0s" for="2.1s"');
    expect(source).toContain('at="2.1s" for="1.5s"');
    expect(source).toContain('id="shot-01"');
    expect(source).toContain('id="shot-02"');
  });

  it('时间轴总长等于各镜之和', () => {
    const source = buildAuthorSource({ canvas: { width: 540, height: 960 }, frameRate: 30, shots });
    expect(source).toContain('end="3.6s"');
  });

  it('文件名里的引号与 & 被转义，不会破坏语法', () => {
    const source = buildAuthorSource({
      canvas: { width: 100, height: 100 },
      frameRate: 30,
      shots: [{ shot_id: 'a"b', image_src: '../frames/x&y.jpg', duration_ms: 1000 }],
    });
    expect(source).toContain('src="../frames/x&amp;y.jpg"');
    expect(source).not.toContain('a"b"');
  });

  it('画布尺寸与帧率写进对应元素', () => {
    const source = buildAuthorSource({ canvas: { width: 1080, height: 1920 }, frameRate: 24, shots });
    expect(source).toContain('frame-rate="24"');
    expect(source).toContain('width="1080" height="1920"');
    expect(source).toContain('<space:Extent id="frame-extent" width="1080" height="1920"/>');
  });
});

/**
 * 视频片段分支。
 *
 * 而且都不是「写错了只是不好看」——写错直接构建失败：
 *
 *     `extent is only valid with image={Artifact}`）；
 *   · `Item.media` 只接受已归一化的定时媒体，因此中间必须有一次 Normalize；
 *   · 时间轴总长必须正好落在帧边界上，而模型产出的片段时长几乎从不落在
 *     （8.096s @30fps = 242.88 帧），所以要逐镜与总长一起量化。
 */
describe('视频片段分支', () => {
  const videoShots = [
    { shot_id: 'shot-01', image_src: '../frames/a.jpg', duration_ms: 8096, video_src: '../clips/a.mp4' },
  ];

  it('有片段时用 media:Video 并补一次 Normalize，不再声明静帧', () => {
    const source = buildAuthorSource({ canvas: { width: 864, height: 496 }, frameRate: 30, shots: videoShots });
    expect(source).toContain('<media:Video id="clip-shot-01" src="../clips/a.mp4"/>');
    expect(source).toContain('<import as="pipeline" from="@frontkernel/media-pipeline@1"/>');
    expect(source).toContain('<pipeline:Normalize id="norm-shot-01" source={clip-shot-01}');
    expect(source).toContain('media={norm-shot-01.media}');
    expect(source).not.toContain('<media:Image id="still-shot-01"');
  });

  it('视频的 Item 不写 extent（上游只允许 image= 带 extent）', () => {
    const source = buildAuthorSource({ canvas: { width: 864, height: 496 }, frameRate: 30, shots: videoShots });
    const item = source.split('\n').find((line) => line.includes('<track:Item id="shot-01"'));
    expect(item).toBeDefined();
    expect(item).not.toContain('extent=');
    // extent 元素本身仍然声明着：静帧镜头还要用它
    expect(source).toContain('<space:Extent id="frame-extent"');
  });

  it('静帧的 Item 仍然写 extent —— 这条不能因为接了视频就一起丢掉', () => {
    const source = buildAuthorSource({ canvas: { width: 540, height: 960 }, frameRate: 30, shots });
    const items = source.split('\n').filter((line) => line.includes('<track:Item '));
    expect(items).toHaveLength(2);
    for (const item of items) expect(item).toContain('extent={frame-extent}');
  });

  it('混合镜头各走各的分支：有片段的用视频，没有的仍是静帧', () => {
    const source = buildAuthorSource({
      canvas: { width: 864, height: 496 },
      frameRate: 30,
      shots: [
        { shot_id: 'shot-01', image_src: '../frames/a.jpg', duration_ms: 4000, video_src: '../clips/a.mp4' },
        { shot_id: 'shot-02', image_src: '../frames/b.jpg', duration_ms: 2000 },
      ],
    });
    expect(source.match(/<media:Video /g)).toHaveLength(1);
    expect(source.match(/<media:Image /g)).toHaveLength(1);
    expect(source.match(/<pipeline:Normalize /g)).toHaveLength(1);
    const second = source.split('\n').find((line) => line.includes('<track:Item id="shot-02"'));
    expect(second).toContain('image={still-shot-02}');
    expect(second).toContain('extent={frame-extent}');
  });

  it('时长量化到帧边界：8.096s @30fps 落成 8.1s', () => {
    expect(quantizeMsToFrames(8096, 30)).toBe(8100);
    expect(quantizedTotalMs(videoShots, 30)).toBe(8100);
    const source = buildAuthorSource({ canvas: { width: 864, height: 496 }, frameRate: 30, shots: videoShots });
    // Timeline 的 end 与 Item 的 for 必须是同一个量化值，否则累计下来仍会偏离帧边界
    expect(source).toContain('end="8.1s"');
    expect(source).toContain('for="8.1s"');
  });

  it('量化不会把镜头量化成零帧', () => {
    expect(quantizeMsToFrames(0, 30)).toBe(33);
    expect(quantizeMsToFrames(5, 30)).toBe(33);
    expect(quantizeMsToFrames(1000, 0)).toBe(1000);
  });

  it('内容指纹纳入 video_src：换成片段就是另一份素材，必须重跑', () => {
    const still = { shot_id: 'shot-01', image_src: '../frames/a.jpg', duration_ms: 4000 };
    const clip = { ...still, video_src: '../clips/a.mp4' };
    expect(shotContentDigest(still)).not.toBe(shotContentDigest(clip));
    // 指纹只看输入，不看它在时间轴上的位置：所以起点移动不会让指纹变化
    expect(shotContentDigest(clip)).toBe(shotContentDigest({ ...clip }));
  });
});

/**
 * 片段的声音。
 *
 * 生成的片段是有声音的（实测峰值 -8.8 dB），但成片一度把它丢掉了——
 * 因为 `Normalize` 无条件写 `audio="none"`，而评估又只看 `hasAudio`，
 * 两边合起来让「声音被丢了」这件事完全不可见。
 *
 * 现在的规则是逐镜量过再决定，因此这一分支必须能在 Source 上看出来：
 * 带声音的镜要 `audio="default"` + `source-audio="content"`，
 * 并且 Film 必须把 Track 新出现的 `.audio` 端口接进来。
 */
describe('片段的声音', () => {
  const withAudio = [{ shot_id: 'shot-01', image_src: '../frames/a.jpg', duration_ms: 8000, video_src: '../clips/a.mp4', audio: true }];
  const withoutAudio = [{ shot_id: 'shot-01', image_src: '../frames/a.jpg', duration_ms: 8000, video_src: '../clips/a.mp4' }];

  it('有声的镜：Normalize 取默认音轨，Item 声明取用源声音', () => {
    const source = buildAuthorSource({ canvas: { width: 540, height: 960 }, frameRate: 30, shots: withAudio });
    expect(source).toContain('audio="default"');
    expect(source).not.toContain('audio="none"');
    const item = source.split('\n').find((line) => line.includes('<track:Item id="shot-01"'));
    expect(item).toContain('source-audio="content"');
  });

  it('有声的镜：Film 必须接上 Track 的 audio 端口', () => {
    const source = buildAuthorSource({ canvas: { width: 540, height: 960 }, frameRate: 30, shots: withAudio });
    expect(source).toContain('<film:Track source={scenes.visual}/>');
    expect(source).toContain('<film:Track source={scenes.audio}/>');
  });

  it('无声的镜：既不取音轨，也不引用不存在的 audio 端口', () => {
    const source = buildAuthorSource({ canvas: { width: 540, height: 960 }, frameRate: 30, shots: withoutAudio });
    expect(source).toContain('audio="none"');
    expect(source).not.toContain('source-audio=');
    /**
     * 这一条最要紧：Track 只在有声音时才发布 `.audio`。
     * 一镜都没发声却写了 `scenes.audio`，就是一个指向不存在端口的引用。
     */
    expect(source).not.toContain('scenes.audio');
  });

  it('静帧镜头不参与声音判断，混合时也只有有声的那一镜接进来', () => {
    const source = buildAuthorSource({
      canvas: { width: 540, height: 960 },
      frameRate: 30,
      shots: [
        { shot_id: 'shot-01', image_src: '../frames/a.jpg', duration_ms: 4000, video_src: '../clips/a.mp4', audio: true },
        { shot_id: 'shot-02', image_src: '../frames/b.jpg', duration_ms: 4000, video_src: '../clips/b.mp4' },
        { shot_id: 'shot-03', image_src: '../frames/c.jpg', duration_ms: 4000 },
      ],
    });
    expect(source.match(/audio="default"/g)).toHaveLength(1);
    expect(source.match(/audio="none"/g)).toHaveLength(1);
    expect(source.match(/source-audio="content"/g)).toHaveLength(1);
    expect(source.match(/<film:Track /g)).toHaveLength(2);
  });

  it('声音算内容的一部分：同一段画面配上声音就是另一份素材', () => {
    expect(shotContentDigest(withAudio[0]!)).not.toBe(shotContentDigest(withoutAudio[0]!));
  });
});

describe('run Source 与样式表', () => {
  it('run Source 指向 author Source 并声明目标输出', () => {
    const run = buildRunSource('film.svml');
    expect(run).toContain('<?svml using="@frontkernel/run-markup@1"?>');
    expect(run).toContain('<author source="./film.svml"/>');
    expect(run).toContain('<target output="final.video"/>');
  });

  it('样式表给 film 背景与 media 配方；media 配方带 stack-order（上游要求）', () => {
    const style = buildStyleSheet();
    expect(style).toContain('film.main { background: #000000; }');
    expect(style).toContain('media.clip {');
    expect(style).toContain('stack-order: 10;');
    expect(style).toContain('fit: cover;');
  });

  /*
    视频单独一份 recipe，只多一行 playback。

    这一条防的是"片段比镜头短 → 成片尾部露黑底"：
    黑色背景，看起来像那一段黑屏了。`hold-start` 改成停在最后一帧。

    两处必须同时成立，所以这里两条都断言：
      · 视频 recipe 带 playback；
        （「cannot apply playback or trim to durationless still material」）。
  */
  it('视频 recipe 带 hold-start，静图 recipe 不带 playback', () => {
    const style = buildStyleSheet();
    expect(style).toContain('media.video {');
    expect(style).toContain('playback: hold-start;');
    /**/
    const stillBlock = style.slice(style.indexOf('media.clip {'), style.indexOf('media.video {'));
    expect(stillBlock).not.toContain('playback');
  });

  it('视频镜头用视频那份 recipe，静图镜头用静图那份', () => {
    const video = buildAuthorSource({
      canvas: { width: 1080, height: 1920 },
      frameRate: 30,
      shots: [{ shot_id: 'shot-01', image_src: 'frames/a.png', video_src: 'clips/a.mp4', duration_ms: 2000 }],
    });
    expect(video).toContain('appearance={style.media.video}');
    const still = buildAuthorSource({
      canvas: { width: 1080, height: 1920 },
      frameRate: 30,
      shots: [{ shot_id: 'shot-01', image_src: 'frames/a.png', duration_ms: 2000 }],
    });
    expect(still).toContain('appearance={style.media.clip}');
    expect(still).not.toContain('style.media.video');
  });

  /*
    转场时长按对夹取。

    固定 12 帧（0.4 秒）遇到 0.2 秒的快切会**盖住整个镜头**——
    所以这里盯三档：正常镜头取上限、短镜头各分一半、极短的对直接退成硬切。

    为什么是"一半"而不是"刚好等于较短那一镜"：转场之后两镜各自
    都还得留住可见的部分，否则等于把短的那一镜整个吃掉。
  */
  it('转场帧数按相邻两镜的较短者夹取，太短的一对退成硬切', () => {
    const shots = (durations: number[]) => durations.map((duration_ms, index) => ({
      shot_id: `shot-0${index + 1}`, image_src: `frames/${index}.png`, duration_ms,
    }));

    /* 两镜都够长：取上限 12 帧 */
    expect(transitionFramesFor(shots([2000, 2000]), 30)).toEqual([12]);
    /* 一镜短：0.5 秒 = 15 帧，一半是 7 帧 */
    expect(transitionFramesFor(shots([500, 2000]), 30)).toEqual([7]);
    /* 0.2 秒 = 6 帧，一半是 3 帧 */
    expect(transitionFramesFor(shots([200, 2000]), 30)).toEqual([3]);
    /* 只剩 2 帧：一半是 1 帧，1 帧的"淡入淡出"没有意义，如实退成硬切 */
    expect(transitionFramesFor(shots([100, 2000]), 30)).toEqual([0]);
    /* 三镜两对，各算各的 */
    expect(transitionFramesFor(shots([2000, 500, 2000]), 30)).toEqual([7, 7]);
  });

  it('逐对配方写进样式表：够长的写 crossfade，太短的如实写 cut', () => {
    const style = buildStyleSheet([12, 0]);
    expect(style).toContain('transition.handoff-1 {');
    expect(style).toContain('operator: crossfade;');
    expect(style).toContain('transition.handoff-2 {');
    expect(style).toContain('operator: cut;');
    /* 没有转场时不生成 handoff 配方：cut 路径根本不写 Sequence */
    expect(buildStyleSheet()).not.toContain('transition.handoff-1');
  });

  /*
    方向：只有方向性转场才写。

    而 crossfade 恰好不需要方向，于是"不传 direction 也合法"看起来一直成立。
    真跑 push 就撞上了：`MediaHandoffSpec push requires a direction.`
    反过来，给 crossfade 写方向同样会被当成多余属性拒掉，所以两边都要断言。
  */
  it('方向性转场带 direction，淡入淡出不带', () => {
    const push = buildStyleSheet([12], 'push');
    expect(push).toContain('operator: push;');
    expect(push).toContain('direction: left;');

    const crossfade = buildStyleSheet([12], 'crossfade');
    expect(crossfade).toContain('operator: crossfade;');
    expect(crossfade).not.toContain('direction:');

    /* 可以指定方向（以后界面上给方向选项时走这条路） */
    expect(buildStyleSheet([12], 'wipe', 'up')).toContain('direction: up;');
  });

  it('四种方向性转场都写 direction，硬切不写', () => {
    for (const operator of ['push', 'wipe', 'cover', 'page-turn'] as const) {
      const style = buildStyleSheet([12], operator);
      expect(style).toContain(`operator: ${operator};`);
      expect(style).toContain('direction: left;');
    }
    /* 帧数夹成 0 时 operator 退成 cut，方向也跟着不该写 */
    const cut = buildStyleSheet([0], 'push');
    expect(cut).toContain('operator: cut;');
    expect(cut).not.toContain('direction:');
  });
});

