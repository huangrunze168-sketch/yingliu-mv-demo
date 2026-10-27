/* ============================================================
  AUD-001（文本转语音）与 AUD-003（人声/伴奏分离）的量化验收。

  两条都是**本机能力**：配音走 Windows 系统语音（离线），分离走 ffmpeg 的立体声中置消除。
  所以验收标准也必须是真的东西：

    · 配音：产出非空 WAV，且 ffprobe 读得出时长与采样率；
    · 分离：**用频带去量**。造一段"中置 440Hz + 两侧 880Hz"的立体声，
      分离之后伴奏里 440 必须被压下去、人声里 440 必须留下——
      只断言"两个文件都生成了"是验不出分离有没有生效的。
   ============================================================ */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listSystemVoices, probeAudio, resolveTtsShell, synthesizeSpeech } from '@qiyin/kernel-service';
import { separateSources } from '@qiyin/kernel-service';
import { recordAcceptance } from './_acceptance.js';

const root = mkdtempSync(join(tmpdir(), 'qiyin-acceptance-audio-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const voices = await listSystemVoices();
const hasVoices = process.platform === 'win32' && voices.length > 0;

/** 用 ffmpeg 造一段已知频率成分的素材。 */
function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error === null) resolve();
      else reject(new Error(String(stderr ?? error.message)));
    });
  });
}

/**
 * 量某个频带的能量（dB）。

 * `volumedetect` 报的 mean_volume 是整个文件平均电平；
 * 前面挂一个带通就变成"这个频带里有多少能量"——这就是我们判断
 * "440Hz 被消掉了没有"的依据。
 */
function bandEnergyDb(file: string, frequency: number): Promise<number> {
  return new Promise((resolve) => {
    execFile('ffmpeg', [
      '-hide_banner', '-nostdin', '-i', file,
      '-af', `bandpass=f=${frequency}:w=80,volumedetect`,
      '-f', 'null', '-',
    ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (_error, _stdout, stderr) => {
      const match = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(String(stderr ?? ''));
      resolve(match === null ? Number.NaN : Number(match[1]));
    });
  });
}

describe('[AUD-001] 文本转语音（本机离线）', () => {
  it.skipIf(!hasVoices)('真合成一段台词：非空 WAV，且能读出时长与采样率', async () => {
    const output = join(root, 'voice.wav');
    const started = Date.now();
    const result = await synthesizeSpeech({ text: '第 3 镜台词：别回头。', outputPath: output });
    const elapsedMs = Date.now() - started;

    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    const bytes = result.ok ? result.bytes : 0;
    const probed = await probeAudio(output);

    recordAcceptance('AUD-001', {
      criterion: '文本 → 配音音频产物（离线，不联网、不花钱）',
      engine: 'Windows SAPI（System.Speech.Synthesis）',
      shell: await resolveTtsShell(),
      installedVoices: voices.length,
      voiceNames: voices.map((voice) => voice.name).slice(0, 6),
      bytes,
      durationSeconds: probed?.durationSeconds ?? 0,
      sampleRate: probed?.sampleRate ?? 0,
      elapsedMs,
      limitation: '音色来自系统安装，没有音色克隆与情绪控制（界面原样显示这条边界）',
    });

    expect(bytes).toBeGreaterThan(1000);
    expect(probed?.durationSeconds ?? 0).toBeGreaterThan(0);
    expect(probed?.sampleRate ?? 0).toBeGreaterThan(8000);
  }, 120_000);

  it('没有可用音色时如实说明（不假装合成成功）', async () => {
    if (hasVoices) {
      recordAcceptance('AUD-001.no-voice', { skipped: true, reason: '这台机器有可用音色' });
      return;
    }
    const output = join(root, 'no-voice.wav');
    const result = await synthesizeSpeech({ text: '测试', outputPath: output });
    recordAcceptance('AUD-001.no-voice', { ok: result.ok, reason: result.ok ? null : result.reason });
    expect(result.ok).toBe(false);
  });
});

describe('[AUD-003] 人声 / 伴奏分离（立体声中置消除）', () => {
  it('中置的人声被消掉、两侧的成分保留——用频带能量量出来', async () => {
    const stereo = join(root, 'stereo.wav');
    /*
      左 = 440（中置成分） + 880（两侧成分）
      右 = 440（中置成分） − 880（两侧成分）
      于是：中置消除（L−R）只剩 880；中置提取（(L+R)/2）只剩 440。
      两个频率刻意取开，带通才能干净地分辨它们。
    */
    await ffmpeg([
      '-f', 'lavfi',
      '-i', 'aevalsrc=0.4*sin(440*2*PI*t)+0.4*sin(880*2*PI*t)|0.4*sin(440*2*PI*t)-0.4*sin(880*2*PI*t):s=48000:d=2',
      '-c:a', 'pcm_s16le', '-y', stereo,
    ]);

    const instrumental = join(root, 'instrumental.wav');
    const vocals = join(root, 'vocals.wav');
    const started = Date.now();
    const result = await separateSources(stereo, { instrumental, vocals });
    const elapsedMs = Date.now() - started;
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);

    const inst440 = await bandEnergyDb(instrumental, 440);
    const inst880 = await bandEnergyDb(instrumental, 880);
    const voc440 = await bandEnergyDb(vocals, 440);
    const voc880 = await bandEnergyDb(vocals, 880);

    recordAcceptance('AUD-003', {
      criterion: '伴奏里中置人声被消掉、人声轨保留中置成分（频带能量对比）',
      method: 'ffmpeg pan：伴奏 c0=c0-c1；人声 0.5*c0+0.5*c1',
      band440: { instrumental: inst440, vocals: voc440 },
      band880: { instrumental: inst880, vocals: voc880 },
      instrumentalBytes: statSync(instrumental).size,
      vocalsBytes: statSync(vocals).size,
      elapsedMs,
      limitation: '不是 AI 分轨：单声道素材拒绝；中置的贝斯/底鼓会跟着被消掉',
    });

    /* 伴奏：440（中置）被压得比 880 低至少 20 dB */
    expect(inst880 - inst440).toBeGreaterThan(20);
    /* 人声：440（中置）比 880 高至少 20 dB */
    expect(voc440 - voc880).toBeGreaterThan(20);
  }, 120_000);

  it('单声道素材直接拒绝（不返回一条假的伴奏）', async () => {
    const mono = join(root, 'mono.wav');
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', '-y', mono]);
    const result = await separateSources(mono, {
      instrumental: join(root, 'mono-inst.wav'),
      vocals: join(root, 'mono-voc.wav'),
    });

    recordAcceptance('AUD-003.mono-refusal', {
      ok: result.ok,
      reason: result.ok ? null : result.reason,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('单声道');
  }, 60_000);
});
