import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ============================================================
  期音科技 · 文本转语音（配音）
   ------------------------------------------------------------
  对应矩阵 AUD-001。小QTV 的配音走它自己的音色库（`characterStudioVoice*` 那 30 多条词条），
  而我们这里**没有接任何语音 Provider**。与其放一个点不动的按钮，不如把
  "本机就能做的那一档"做实：

    Windows 自带 SAPI（`System.Speech.Synthesis`）可以**离线**把文本合成成 WAV，
    用的是系统里已装的语音（中文机器上通常有 Microsoft Huihui / Yaoyao / Kangkang）。

  这是一条**真能用**的路：不联网、不花钱、产物是真文件，可以直接当配音轨铺进时间线。
  但它不是 小QTV 那套音色库：

    · 音色是系统装的，不由我们决定；不同机器上能用的音色不一样（所以界面必须先列出来）；
    · 没有音色克隆、没有情绪强度、没有语速之外的表演控制；
    · 音质是系统 TTS 的水平，不是"角色配音"的水平。

  这些差别写在 `describeTtsLimits()` 里由界面原样显示——用户要知道自己拿到的是什么。

  为什么不把文本直接拼进命令行：文本里可能有引号、换行、`$`，任何一处转义写错
  都会变成一句错话（而合成照样"成功"）。所以先把文本写成 UTF-8 文件，
  再由 PowerShell 按 UTF-8 读回来——命令行上一个用户字符都不出现。
   ============================================================ */

/** 单次合成的文本上限。**这是我们定的**（SAPI 本身没有硬限制），为的是不让一次合成长得离谱。 */
export const TTS_MAX_CHARS = 500;

/**/
export const TTS_RATE_MIN = -10;
export const TTS_RATE_MAX = 10;

export interface TtsVoice {
  name: string;
  /** 语言区域，例如 `zh-CN`；SAPI 里是 `Culture` 的字符串形式 */
  culture: string;
  gender: string;
  age: string;
}

/**
 * 用哪个 shell 跑语音合成。

 * 这件事必须**先定下来、再列音色**，因为两个 PowerShell 看到的音色不一样：
 * 实测这台机器上 `pwsh`（PowerShell 7 / .NET Core）能看到 5 个音色
 * （含中文男声 Kangkang、女声 Yaoyao），而 `powershell.exe`（5.1 / .NET Framework）
 * 只看到 2 个 OneCore 音色。

 * 后果很具体：**列表用一个引擎、合成用另一个引擎，界面就会列出选中也合成不了的音色**。
 * 所以两个函数共用这一个解析结果——优先 pwsh（音色更全），没有就退回 powershell.exe
 * （Windows 上一定有）。返回的引擎同时决定"列哪些"和"用哪个合成"。
 */
let shellPromise: Promise<string> | null = null;

export function resolveTtsShell(): Promise<string> {
  if (shellPromise !== null) return shellPromise;
  shellPromise = (async () => {
    if (process.platform !== 'win32') return 'powershell.exe';
    const probe = await run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], 15_000);
    return probe.ok ? 'pwsh.exe' : 'powershell.exe';
  })();
  return shellPromise;
}

/** 测试用：忘掉缓存的引擎解析结果。 */
export function resetTtsShellCache(): void {
  shellPromise = null;
}

export interface TtsOptions {
  text: string;
  /** 音色名；必须是 `listSystemVoices()` 给出来的那一个 */
  voiceName?: string;
  /** 语速 -10~10，0 是系统默认 */
  rate?: number;
  outputPath: string;
  /** 测试与探针用：覆盖 PowerShell 可执行文件 */
  powershell?: string;
}

export type TtsResult =
  | { ok: true; bytes: number; voiceName: string }
  | { ok: false; reason: string };

/** 给用户看的边界说明（界面原样展示，不加工）。 */
export function describeTtsLimits(): string {
  return '配音使用本机 Windows 语音合成（离线、不联网、不花钱）；音色来自系统已安装的语音，'
    + '没有音色克隆与情绪控制，音质是系统 TTS 的水平。要更接近角色的声音需要接入语音 Provider。';
}

/** 列出系统里可用的语音。读不出来时返回空数组（调用方据此说"这台机器上没有可用音色"）。 */
export async function listSystemVoices(powershell = 'powershell.exe'): Promise<TtsVoice[]> {
  if (process.platform !== 'win32') return [];
  /* 省略参数时才去解析引擎；显式传了就用传进来的那个（测试与探针用） */
  const shell = powershell === 'powershell.exe' ? await resolveTtsShell() : powershell;
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$rows = foreach ($v in $s.GetInstalledVoices()) {',
    '  $i = $v.VoiceInfo',
    '  [pscustomobject]@{ name = $i.Name; culture = $i.Culture.Name; gender = $i.Gender.ToString(); age = $i.Age.ToString() }',
    '}',
    '$s.Dispose()',
    'ConvertTo-Json -InputObject @($rows) -Compress',
  ].join('\n');
  const result = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 30_000);
  if (!result.ok) return [];
  try {
    const parsed = JSON.parse(result.stdout.trim() === '' ? '[]' : result.stdout.trim()) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.flatMap((item) => {
      const row = item as { name?: unknown; culture?: unknown; gender?: unknown; age?: unknown };
      return typeof row.name === 'string' && row.name !== ''
        ? [{
          name: row.name,
          culture: typeof row.culture === 'string' ? row.culture : '',
          gender: typeof row.gender === 'string' ? row.gender : '',
          age: typeof row.age === 'string' ? row.age : '',
        }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * 把文本合成为 WAV。

 * 所有"能不能做"的判断都在**跑 PowerShell 之前**做完：
 * 这样失败原因是一句人话，而不是 SAPI 抛出来的一串英文堆栈。
 */
export async function synthesizeSpeech(options: TtsOptions): Promise<TtsResult> {
  const text = options.text.trim();
  if (text === '') return { ok: false, reason: '要合成的文本是空的' };
  if (text.length > TTS_MAX_CHARS) {
    return { ok: false, reason: `一次最多合成 ${TTS_MAX_CHARS} 个字（当前 ${text.length} 个字），请分段` };
  }
  const rate = Math.trunc(options.rate ?? 0);
  if (rate < TTS_RATE_MIN || rate > TTS_RATE_MAX) {
    return { ok: false, reason: `语速必须在 ${TTS_RATE_MIN}~${TTS_RATE_MAX} 之间` };
  }
  if (process.platform !== 'win32') {
    return { ok: false, reason: '本机配音使用 Windows 语音合成，当前系统不是 Windows' };
  }

  /* 与 listSystemVoices 用**同一个引擎**：列出来的音色必须真能选中 */
  const shell = options.powershell ?? await resolveTtsShell();
  const voices = await listSystemVoices(shell);
  if (voices.length === 0) {
    return { ok: false, reason: '这台机器上没有可用的语音合成音色（系统未安装语音）' };
  }
  const voiceName = options.voiceName ?? voices[0]!.name;
  if (!voices.some((voice) => voice.name === voiceName)) {
    return { ok: false, reason: `这台机器上没有这个音色：${voiceName}` };
  }

  /*
    文本走文件、不走命令行：引号/换行/`$` 在命令行里都要转义，
    写错一处就会合成出一句错话，而整个过程"成功"。
  */
  const scratch = mkdtempSync(join(tmpdir(), 'qiyin-tts-'));
  const textPath = join(scratch, 'text.txt');
  writeFileSync(textPath, text, 'utf8');
  const escapedText = textPath.replace(/'/g, "''");
  const escapedOut = options.outputPath.replace(/'/g, "''");
  const escapedVoice = voiceName.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.SelectVoice('${escapedVoice}')`,
    `$s.Rate = ${rate}`,
    'try { $s.SetOutputToWaveFile(' + `'${escapedOut}'` + ') } catch { Write-Error $_.Exception.Message; exit 3 }',
    `$text = [IO.File]::ReadAllText('${escapedText}', [Text.Encoding]::UTF8)`,
    'try { $s.Speak($text) } catch { Write-Error $_.Exception.Message; exit 4 }',
    '$s.Dispose()',
  ].join('\n');

  try {
    const result = await run(shell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 120_000);
    if (!result.ok) {
      const tail = result.error.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(-2).join(' ');
      return { ok: false, reason: `语音合成失败：${tail || '系统语音合成没有给出原因'}` };
    }
    if (!existsSync(options.outputPath)) {
      return { ok: false, reason: '系统语音合成没有产出文件' };
    }
    const bytes = statSync(options.outputPath).size;
    if (bytes === 0) return { ok: false, reason: '系统语音合成产出了空文件' };
    return { ok: true, bytes, voiceName };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function run(command: string, args: readonly string[], timeout: number): Promise<{ ok: boolean; stdout: string; error: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) return resolve({ ok: true, stdout: typeof stdout === 'string' ? stdout : '', error: '' });
      const text = `${String(stderr ?? '')}\n${String(stdout ?? '')}\n${error.message}`.trim();
      return resolve({ ok: false, stdout: typeof stdout === 'string' ? stdout : '', error: text });
    });
  });
}

/**
 * 读一条音频文件的基本事实（时长 / 声道 / 采样率）。

 * 为什么不复用 `probeClip`：那个探针是给**视频片段**用的（它挑的是 `v:0` 流），
 * 拿它探一个纯 WAV 会得到 `null`——于是"合成成功但读不出时长"，
 * 而调用方会以为文件坏了。音频要问音频的问题。
 */
export async function probeAudio(path: string): Promise<{
  durationSeconds: number;
  channels: number;
  sampleRate: number;
} | null> {
  if (!existsSync(path)) return null;
  const result = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=channels,sample_rate:format=duration', '-of', 'json', path,
  ], 30_000);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<{ channels?: number; sample_rate?: string }>;
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];
    const durationSeconds = Number(parsed.format?.duration ?? 'NaN');
    const channels = Number(stream?.channels ?? 'NaN');
    const sampleRate = Number(stream?.sample_rate ?? 'NaN');
    if (!Number.isFinite(durationSeconds) || !Number.isFinite(channels) || !Number.isFinite(sampleRate)) return null;
    return { durationSeconds, channels, sampleRate };
  } catch {
    return null;
  }
}
