import { describe, expect, it } from 'vitest';
import {
  CLIP_TRANSITIONS,
  COMPOSE_FPS,
  MAX_COMPOSE_DURATION_SECONDS,
  TRANSITION_MAX_SECONDS,
  TRANSITION_MIN_SECONDS,
  AUDIO_GAIN_MAX_DB,
  AUDIO_GAIN_MIN_DB,
  clipTransitionOption,
  composeDurationRefusal,
  normalizeAudioGainDb,
  parseProbeClip,
  parseProbeSize,
  planClipCompose,
  totalClipSeconds,
  type ClipComposeClip,
} from '../packages/kernel-service/src/compose-clips.js';

/*
  智能剪辑的合成参数。

  这一层用纯函数测，是因为它做的都是**判断**而不是 IO：
  转场时长被钳到多少、片段太短时加不加、缺音轨时声音怎么办、
  xfade 的 offset 累计对不对。这些错一个，成片就悄悄变样了——
  而 ffmpeg 不会为此报错，它只会照你给的参数产出另一条片子。
*/

const clip = (over: Partial<ClipComposeClip> = {}): ClipComposeClip => ({
  path: 'C:/ws/a.mp4',
  durationSeconds: 2,
  hasAudio: true,
  width: 1280,
  height: 720,
  ...over,
});

const argsOf = (args: readonly string[], flag: string): string[] => {
  const index = args.indexOf(flag);
  return index < 0 ? [] : [args[index + 1] as string];
};

/* ============================================================
  音轨：独立静音与音量增益。

    clipAudioTrack = 音频轨道 · clipAudioTitle = 音量 · clipAudioGain = 音量增益
    clipAudioGainInput = 输入音量增益（dB） · clipMuteAudioTrack = 静音音频轨
    clipMuteVideoTrackAudio = 静音视频原声

  验收口径（矩阵 AUD-004）：**对某轨静音后，其余轨混音输出逐采样差异 = 0**。
  所以这里重点钉两件事：静音的轨被跳过（不影响别人）、混音必须带 `normalize=0`
  （默认的 amix 会按路数把每一路都衰减一次，那样静音一条轨会连带改变另一条轨的电平）。
  ============================================================ */

const track = (over: Record<string, unknown> = {}) => ({ path: 'C:/ws/bgm.mp3', ...over });

const planWithAudio = (audioTracks: readonly unknown[], clipOver: Partial<ClipComposeClip> = {}) =>
  planClipCompose({
    clips: [clip({ durationSeconds: 4, ...clipOver })],
    transition: { id: 'none', durationSeconds: 0 },
    outputPath: 'C:/ws/out.mp4',
    audioTracks: audioTracks as never,
  });

describe('音轨 · 混音与时长对齐', () => {
  it('加一条 BGM：多一个输入、两路混音、时长都对齐到成片长度', () => {
    const plan = planWithAudio([track({ label: 'BGM', gainDb: -6 })]);
    const filter = plan.args.join(' ');
    expect(plan.args).toContain('C:/ws/bgm.mp3');
    expect(filter).toContain('[mainAudioRaw]atrim=0:4.000,apad=whole_dur=4.000[main]');
    expect(filter).toContain('[1:a]atrim=0:4.000,asetpts=PTS-STARTPTS,volume=-6.00dB,apad=whole_dur=4.000');
    expect(filter).toContain('[main][bgm0]amix=inputs=2:duration=first:normalize=0[outa]');
    expect(plan.args).toContain('[outa]');
    expect(plan.withAudio).toBe(true);
    expect(plan.notes).toContain('已混入 1 条音轨');
    expect(plan.notes).toContain('音量增益：BGM -6dB');
  });

  it('两条 BGM：inputs=3；带转场时成片时长要减掉重叠', () => {
    const plan = planClipCompose({
      clips: [clip({ durationSeconds: 4 }), clip({ durationSeconds: 4, path: 'C:/ws/b.mp4' })],
      transition: { id: 'crossfade', durationSeconds: 0.5 },
      outputPath: 'C:/ws/out.mp4',
      audioTracks: [track(), track({ path: 'C:/ws/bgm2.mp3' })] as never,
    });
    const filter = plan.args.join(' ');
    expect(filter).toContain('amix=inputs=3:duration=first:normalize=0[outa]');
    /* 4 + 4 − 0.5 = 7.5：音频每一路都按这个数裁/补 */
    expect(filter).toContain('apad=whole_dur=7.500');
  });
});

describe('音轨 · 静音的那一轨直接跳过', () => {
  it('静音的 BGM 不加输入、不混音，且回执里说清楚', () => {
    const plan = planWithAudio([track({ label: 'BGM', muted: true })]);
    const filter = plan.args.join(' ');
    expect(plan.args).not.toContain('C:/ws/bgm.mp3');
    expect(filter).not.toContain('amix');
    expect(plan.args).toContain('[mainAudioRaw]');
    expect(plan.notes).toContain('有 1 条音轨是静音状态，这次没有混进去');
  });

  it('全静音 + 片段有声 → 还是那条主音频（与没加音轨一模一样）', () => {
    const withMuted = planWithAudio([track({ muted: true }), track({ path: 'C:/ws/x.mp3', muted: true })]);
    const withoutAny = planWithAudio([]);
    expect(withMuted.args.join(' ')).toBe(withoutAny.args.join(' '));
  });

  it('静音一轨不影响另一轨：混音路数按**未静音**的数量算', () => {
    const one = planWithAudio([track({ path: 'C:/ws/a.mp3' }), track({ path: 'C:/ws/b.mp3', muted: true })]);
    expect(one.args.join(' ')).toContain('amix=inputs=2:duration=first:normalize=0');
    expect(one.args.join(' ')).not.toContain('C:/ws/b.mp3');
  });
});

describe('音轨 · 片段没音轨时由 BGM 顶上来', () => {
  it('垫一路静音当主、成片仍然有声、回执不再说"成片不带声音"', () => {
    const plan = planWithAudio([track({ label: 'BGM' })], { hasAudio: false });
    const filter = plan.args.join(' ');
    expect(filter).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(filter).toContain('amix=inputs=2:duration=first:normalize=0[outa]');
    expect(plan.withAudio).toBe(true);
    expect(plan.notes).toContain('这些片段都没有音轨');
    expect(plan.notes).toContain('片段本身没有音轨，成片的声音全部来自你加的音轨');
    expect(plan.notes.join(' ')).not.toContain('成片不带声音');
  });

  it('片段没音轨、也没加音轨 → 才是真的不带声音', () => {
    const plan = planWithAudio([], { hasAudio: false });
    expect(plan.withAudio).toBe(false);
    expect(plan.notes).toContain('成片不带声音（不给静音片段凭空补声音）');
    expect(plan.args).toContain('-an');
  });
});

describe('音轨 · 视频原声静音', () => {
  it('muteSourceAudio 的片段：音频链里压成 volume=0（不丢音轨，时长不变）', () => {
    const plan = planWithAudio([], { muteSourceAudio: true });
    const filter = plan.args.join(' ');
    expect(filter).toContain('volume=0,');
    /* 音轨还在（aresample 那一段），只是听不见 */
    expect(filter).toContain('aformat=sample_fmts=fltp:channel_layouts=stereo[mainAudioRaw]');
  });
});

describe('音轨 · 增益钳位', () => {
  it('越界钳进上下限、不是数字当原样', () => {
    expect(normalizeAudioGainDb(-999)).toBe(AUDIO_GAIN_MIN_DB);
    expect(normalizeAudioGainDb(200)).toBe(AUDIO_GAIN_MAX_DB);
    expect(normalizeAudioGainDb('x')).toBe(0);
    expect(normalizeAudioGainDb(undefined)).toBe(0);
    expect(normalizeAudioGainDb(-6)).toBe(-6);
  });

  it('增益是 0 时不往回执里写"音量增益"（没调就别提）', () => {
    const plan = planWithAudio([track({ label: 'BGM', gainDb: 0 })]);
    expect(plan.notes.join(' ')).not.toContain('音量增益');
  });
});

describe('转场清单（名字逐字来自 Canvas 词条）', () => {
  it('四个转场 + 不加转场，且都落到本机 ffmpeg 有的过渡名上', () => {
    expect(CLIP_TRANSITIONS.map((option) => option.label)).toEqual([
      '不加转场', '淡入淡出', '像素溶解', '黑场过渡', '白场过渡',
    ]);
    expect(clipTransitionOption('crossfade')?.ffmpeg).toBe('fade');
    expect(clipTransitionOption('dissolve')?.ffmpeg).toBe('pixelize');
    expect(clipTransitionOption('fadeblack')?.ffmpeg).toBe('fadeblack');
    expect(clipTransitionOption('fadewhite')?.ffmpeg).toBe('fadewhite');
    expect(clipTransitionOption('none')?.ffmpeg).toBeNull();
    /* 认不出的 id 返回 null，调用方据此回落而不是瞎猜一个转场 */
    expect(clipTransitionOption('wipe')).toBeNull();
  });
});

describe('单段：归一化一次就够', () => {
  it('没有拼接，但仍按第一段的画幅与帧率归一化', () => {
    const plan = planClipCompose({
      clips: [clip()],
      transition: { id: 'crossfade', durationSeconds: 0.5 },
      outputPath: 'out.mp4',
    });
    const filter = argsOf(plan.args, '-filter_complex')[0]!;
    expect(filter).toContain('scale=1280:720');
    expect(filter).toContain(`fps=${COMPOSE_FPS}`);
    expect(filter).not.toContain('concat');
    expect(filter).not.toContain('xfade');
    /* 单段也该说清"转场没地方加"，而不是默默忽略 */
    expect(plan.notes.some((note) => note.includes('只有一个片段'))).toBe(true);
    expect(plan.appliedTransition).toBe('none');
    expect(plan.withAudio).toBe(true);
  });
});

describe('裁剪与变速', () => {
  it('视频与音频使用同一入点、取用时长和 2× 速度', () => {
    const plan = planClipCompose({ clips: [clip({ durationSeconds: 2, sourceOffsetSeconds: 1.25, sourceDurationSeconds: 4, speed: 2 })], transition: { id: 'none', durationSeconds: .5 }, outputPath: 'out.mp4' });
    const filter = argsOf(plan.args, '-filter_complex')[0]!;
    expect(filter).toContain('trim=start=1.250:duration=4.000,setpts=(PTS-STARTPTS)/2.000000');
    expect(filter).toContain('atrim=start=1.250:duration=4.000,asetpts=PTS-STARTPTS,atempo=2.000000');
    expect(plan.notes).toContain('已应用 1 段裁剪/变速设置');
  });

  it('极端慢速用多个合法 atempo 链实现', () => {
    const plan = planClipCompose({ clips: [clip({ durationSeconds: 16, speed: .125 })], transition: { id: 'none', durationSeconds: .5 }, outputPath: 'out.mp4' });
    const filter = argsOf(plan.args, '-filter_complex')[0]!;
    expect(filter).toContain('atempo=0.500000,atempo=0.500000,atempo=0.500000');
  });
});

describe('多段无转场：concat', () => {
  it('两段拼一起，视频与音频各拼各的', () => {
    const plan = planClipCompose({
      clips: [clip(), clip({ path: 'C:/ws/b.mp4' })],
      transition: { id: 'none', durationSeconds: 0.5 },
      outputPath: 'out.mp4',
    });
    const filter = argsOf(plan.args, '-filter_complex')[0]!;
    /*
      音频那一路的名字从 `[outa]` 改成了 `[mainAudioRaw]`：这一轮加了"附加油轨混音"，
      混音结果才叫 `[outa]`。同一个 label 不能既当输入又当输出，
      所以主音频让开这个名字（没加音轨时它会被直接 map 出去，行为与以前一模一样）。
    */
    expect(filter).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][mainAudioRaw]');
    expect(plan.notes).toEqual([]);
    expect(plan.appliedTransition).toBe('none');
  });
});

describe('多段有转场：xfade 链', () => {
  it('两段：转场名对得上，offset = 前一段时长 − 转场时长', () => {
    const plan = planClipCompose({
      clips: [clip({ durationSeconds: 3 }), clip({ path: 'C:/ws/b.mp4', durationSeconds: 2 })],
      transition: { id: 'crossfade', durationSeconds: 0.5 },
      outputPath: 'out.mp4',
    });
    const filter = argsOf(plan.args, '-filter_complex')[0]!;
    expect(filter).toContain('xfade=transition=fade:duration=0.500:offset=2.500');
    expect(filter).toContain('acrossfade=d=0.500');
    expect(filter).toContain('[outv]');
    expect(filter).toContain('[mainAudioRaw]');
    expect(plan.appliedTransition).toBe('crossfade');
  });

  /**
   * 三段时最容易错的就是 offset：每次转场都要把**已经重叠掉的时间**算进去，
   * 否则第二条转场会晚 D 秒，末尾露出一段黑。
   */
  it('三段：offset 逐次累计（每次都减去已重叠的转场时长）', () => {
    const plan = planClipCompose({
      clips: [
        clip({ durationSeconds: 2 }),
        clip({ path: 'C:/ws/b.mp4', durationSeconds: 2 }),
        clip({ path: 'C:/ws/c.mp4', durationSeconds: 2 }),
      ],
      transition: { id: 'dissolve', durationSeconds: 0.5 },
      outputPath: 'out.mp4',
    });
    const filter = argsOf(plan.args, '-filter_complex')[0]!;
    expect(filter).toContain('xfade=transition=pixelize:duration=0.500:offset=1.500');
    expect(filter).toContain('xfade=transition=pixelize:duration=0.500:offset=3.000');
    /* 链式：第一段的结果接第二段，再接第三段，最后落到 outv */
    expect(filter).toContain('[v0][v1]xfade');
    expect(filter).toContain('[vx1][v2]xfade');
  });

  it('转场时长被钳制：请求 5 秒 → 收到上限，并带一句回执', () => {
    const plan = planClipCompose({
      clips: [clip({ durationSeconds: 10 }), clip({ path: 'C:/ws/b.mp4', durationSeconds: 10 })],
      transition: { id: 'fadeblack', durationSeconds: 5 },
      outputPath: 'out.mp4',
    });
    const filter = argsOf(plan.args, '-filter_complex')[0]!;
    expect(filter).toContain(`duration=${TRANSITION_MAX_SECONDS.toFixed(3)}`);
    expect(plan.notes.some((note) => note.includes('转场时长从'))).toBe(true);
  });

  it('片段太短：不加转场，并且说清为什么', () => {
    const plan = planClipCompose({
      clips: [clip({ durationSeconds: 0.3 }), clip({ path: 'C:/ws/b.mp4', durationSeconds: 2 })],
      transition: { id: 'crossfade', durationSeconds: 0.5 },
      outputPath: 'out.mp4',
    });
    const filter = argsOf(plan.args, '-filter_complex')[0]!;
    expect(filter).not.toContain('xfade');
    expect(filter).toContain('concat=n=2');
    expect(plan.appliedTransition).toBe('none');
    expect(plan.notes.some((note) => note.includes('片段太短'))).toBe(true);
    /* 下限本身也要是个正数，否则"钳制"会算出 0 秒转场 */
    expect(TRANSITION_MIN_SECONDS).toBeGreaterThan(0);
  });
});

describe('声音（不给静音片段凭空补声音）', () => {
  it('有一段没音轨 → 整条成片不带声音，并写进回执', () => {
    const plan = planClipCompose({
      clips: [clip(), clip({ path: 'C:/ws/b.mp4', hasAudio: false })],
      transition: { id: 'none', durationSeconds: 0.5 },
      outputPath: 'out.mp4',
    });
    expect(plan.withAudio).toBe(false);
    expect(plan.args).toContain('-an');
    expect(plan.args).not.toContain('-c:a');
    const filter = argsOf(plan.args, '-filter_complex')[0]!;
    expect(filter).toContain('concat=n=2:v=1:a=0');
    expect(filter).not.toContain('aresample');
    expect(plan.notes.some((note) => note.includes('没有音轨'))).toBe(true);
  });
});

describe('多视频轨与画布内布局', () => {
  it('画中画把两条轨并行合成，总时长取最长轨而不是所有片段相加', () => {
    const plan = planClipCompose({
      clips: [
        clip({ path: 'base.mp4', videoTrack: 1, durationSeconds: 6 }),
        clip({ path: 'pip-a.mp4', videoTrack: 2, durationSeconds: 2 }),
        clip({ path: 'pip-b.mp4', videoTrack: 2, durationSeconds: 3 }),
      ],
      layout: 'pip',
      transition: { id: 'none', durationSeconds: 0 },
      outputPath: 'out.mp4',
    });
    const filter = plan.args.join(' ');
    expect(totalClipSeconds([
      clip({ videoTrack: 1, durationSeconds: 6 }),
      clip({ videoTrack: 2, durationSeconds: 2 }),
      clip({ videoTrack: 2, durationSeconds: 3 }),
    ])).toBe(6);
    expect(filter).toContain('concat=n=2:v=1:a=0[track2]');
    expect(filter).toContain('overlay=x=');
    expect(filter).toContain('-t 6.000');
    expect(plan.notes).toContain('画中画：2 条视频轨同时合成');
  });

  it('三分屏要求轨 1–3 都有素材，不能静默丢轨', () => {
    expect(() => planClipCompose({
      clips: [clip({ videoTrack: 1 }), clip({ videoTrack: 3 })],
      layout: 'three',
      transition: { id: 'none', durationSeconds: 0 },
      outputPath: 'out.mp4',
    })).toThrow('需要视频轨 1–3 都有素材');
  });

  it('四分屏生成四个等时并行轨和三次以上 overlay', () => {
    const plan = planClipCompose({
      clips: [1, 2, 3, 4].map((videoTrack) => clip({ videoTrack: videoTrack as 1 | 2 | 3 | 4 })),
      layout: 'quad',
      transition: { id: 'none', durationSeconds: 0 },
      outputPath: 'out.mp4',
    });
    expect((plan.args.join(' ').match(/overlay=/g) ?? [])).toHaveLength(4);
    expect(plan.notes).toContain('四分屏：4 条视频轨同时合成');
  });
});

describe('ffprobe 尺寸解析', () => {
  it('正常输出能读出宽高', () => {
    expect(parseProbeSize('{"streams":[{"width":1152,"height":2048}]}')).toEqual({ width: 1152, height: 2048 });
  });

  it('读不出来时返回 null，而不是编一个 0×0', () => {
    expect(parseProbeSize('')).toBeNull();
    expect(parseProbeSize('not json')).toBeNull();
    expect(parseProbeSize('{"streams":[]}')).toBeNull();
    expect(parseProbeSize('{"streams":[{"width":0,"height":720}]}')).toBeNull();
  });
});

describe('ffprobe 一次问全（时长 / 画幅 / 音轨）', () => {
  it('带音轨的片段：三样都给全', () => {
    const stdout = JSON.stringify({
      format: { duration: '3.003000' },
      streams: [
        { codec_type: 'video', width: 720, height: 1280 },
        { codec_type: 'audio' },
      ],
    });
    expect(parseProbeClip(stdout)).toEqual({
      durationSeconds: 3.003, hasAudio: true, width: 720, height: 1280,
    });
  });

  it('没有音频流时如实报 false（成片据此决定带不带声音）', () => {
    const stdout = JSON.stringify({
      format: { duration: '1.5' },
      streams: [{ codec_type: 'video', width: 1280, height: 720 }],
    });
    expect(parseProbeClip(stdout)?.hasAudio).toBe(false);
  });

  it('时长或画幅读不出来就返回 null，不拿 0 当事实', () => {
    expect(parseProbeClip('')).toBeNull();
    expect(parseProbeClip(JSON.stringify({ format: {}, streams: [{ codec_type: 'video', width: 1, height: 1 }] }))).toBeNull();
    expect(parseProbeClip(JSON.stringify({ format: { duration: '2' }, streams: [] }))).toBeNull();
  });
});

describe('智能剪辑·合成时长上限（Canvas MAX_VIDEO_COMPOSE_DURATION_SEC）', () => {
  it('常量与 Canvas 的常量表一致：1200 秒（20 分钟）', () => {
    /**/
    expect(MAX_COMPOSE_DURATION_SECONDS).toBe(1200);
  });

  it('加总只算片段本身，转场重叠不参与（保守估计）', () => {
    expect(totalClipSeconds([])).toBe(0);
    expect(totalClipSeconds([clip({ durationSeconds: 2 }), clip({ durationSeconds: 3.5 })])).toBe(5.5);
    /* 坏数据当 0 处理：读不出时长的片段不该把总数算成 NaN */
    expect(totalClipSeconds([clip({ durationSeconds: Number.NaN }), clip({ durationSeconds: 4 })]))
      .toBe(4);
    expect(totalClipSeconds([clip({ durationSeconds: -5 }), clip({ durationSeconds: 2 })]))
      .toBe(2);
  });

  it('刚好 20 分钟放行，超一秒就拒，而且给的是能照做的话', () => {
    const exact = [clip({ durationSeconds: MAX_COMPOSE_DURATION_SECONDS })];
    expect(composeDurationRefusal(exact)).toBeNull();

    const over = [clip({ durationSeconds: MAX_COMPOSE_DURATION_SECONDS + 1 })];
    const message = composeDurationRefusal(over);
    expect(message).not.toBeNull();
    /* 说清"多少秒、上限多少、怎么办"——只说"太长"用户没法动手 */
    expect(message).toContain('1201');
    expect(message).toContain('1200');
    expect(message).toContain('分两次');
  });

  it('并行多轨按最长轨判断上限，切回单轨串联则仍按总和', () => {
    const clips = [clip({ videoTrack: 1, durationSeconds: 700 }), clip({ videoTrack: 2, durationSeconds: 700 })];
    expect(composeDurationRefusal(clips, 'pip')).toBeNull();
    expect(composeDurationRefusal(clips, 'sequence')).not.toBeNull();
  });

  it('多段加起来超限同样拦住（不是只看单段）', () => {
    const clips = Array.from({ length: 13 }, () => clip({ durationSeconds: 100 }));
    expect(totalClipSeconds(clips)).toBe(1300);
    expect(composeDurationRefusal(clips)).not.toBeNull();
  });
});
