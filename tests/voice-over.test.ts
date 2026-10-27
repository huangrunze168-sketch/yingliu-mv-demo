/* ============================================================
  AUD-001 文本转语音（本机 Windows 语音合成）。

  这些用例**真的调系统语音**（SAPI）并检查产出的文件：
  "合成成功"这句话不算数，得有一个非空的 WAV，且 ffprobe 能读出时长。

  非 Windows 或系统没装语音时**跳过而不是装作通过**——
  那两种情况本来就没有这条能力，测试假装成功只会让人以为它可用。
   ============================================================ */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TTS_MAX_CHARS, listSystemVoices, probeAudio, synthesizeSpeech } from '@qiyin/kernel-service';

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qiyin-tts-test-'));
  scratchDirs.push(dir);
  return dir;
}

const voices = await listSystemVoices();
const hasVoices = process.platform === 'win32' && voices.length > 0;

describe('文本转语音 · 本机语音合成', () => {
  it('能列出这台机器上装了哪些音色（空列表也要如实返回空）', () => {
    expect(Array.isArray(voices)).toBe(true);
    for (const voice of voices) expect(voice.name.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasVoices)('合成一段中文：产出真文件、ffprobe 读得出时长', async () => {
    const dir = scratch();
    const output = join(dir, 'voice.wav');
    const result = await synthesizeSpeech({ text: '这是第 3 镜的台词：别回头。', outputPath: output });

    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    expect(existsSync(output)).toBe(true);
    expect(statSync(output).size).toBeGreaterThan(1000);

    const probed = await probeAudio(output);
    expect(probed).not.toBeNull();
    expect(probed?.durationSeconds ?? 0).toBeGreaterThan(0);
    expect(probed?.channels ?? 0).toBeGreaterThanOrEqual(1);
    expect(probed?.sampleRate ?? 0).toBeGreaterThan(8000);
  }, 120_000);

  it.skipIf(!hasVoices)('文本里有引号、换行和 $ 也能合成（走文件不走命令行）', async () => {
    const dir = scratch();
    const output = join(dir, 'tricky.wav');
    const text = '他说：“$100 就行”；\n然后走了。';
    const result = await synthesizeSpeech({ text, outputPath: output });

    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    expect(statSync(output).size).toBeGreaterThan(1000);
  }, 120_000);

  it('空文本、超长文本、越界语速都在**动手之前**就拒掉，且不产生文件', async () => {
    const dir = scratch();
    const empty = await synthesizeSpeech({ text: '   ', outputPath: join(dir, 'a.wav') });
    const tooLong = await synthesizeSpeech({ text: '字'.repeat(TTS_MAX_CHARS + 1), outputPath: join(dir, 'b.wav') });
    const badRate = await synthesizeSpeech({ text: '测试', rate: 99, outputPath: join(dir, 'c.wav') });

    expect(empty).toEqual({ ok: false, reason: '要合成的文本是空的' });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.ok ? '' : tooLong.reason).toContain(`一次最多合成 ${TTS_MAX_CHARS} 个字`);
    expect(badRate.ok ? '' : badRate.reason).toContain('语速必须在 -10~10 之间');
    for (const name of ['a.wav', 'b.wav', 'c.wav']) expect(existsSync(join(dir, name))).toBe(false);
  });

  it.skipIf(!hasVoices)('指定一个这台机器上没有的音色 → 明确拒绝（不悄悄换一个音色顶上）', async () => {
    const dir = scratch();
    const output = join(dir, 'missing-voice.wav');
    const result = await synthesizeSpeech({ text: '测试', voiceName: '不存在的音色', outputPath: output });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('这台机器上没有这个音色');
    expect(existsSync(output)).toBe(false);
  }, 60_000);

  it('输出目录不存在时不假装成功', async () => {
    const dir = scratch();
    /* 目录不存在：SAPI 那边会报错，我们要把它变成一句人话，而不是一个空文件 */
    const output = join(dir, '不存在的目录', 'voice.wav');
    writeFileSync(join(dir, 'placeholder.txt'), 'x');
    const result = await synthesizeSpeech({ text: '测试', outputPath: output });
    if (!hasVoices) {
      expect(result.ok).toBe(false);
      return;
    }
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('语音合成失败');
  }, 60_000);
});
