import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/* ============================================================
  期音科技 · 人声 / 伴奏分离
   ------------------------------------------------------------
  对应矩阵 AUD-003 的后半截（前半截"把整条音轨抽出来"在 `audio-extract.ts`，早就有了）。

  **这一层不是 AI 分轨，写清楚它到底是什么**：

    用的是立体声**中置消除**这一经典做法——
      · 伴奏：`pan=stereo|c0=c0-c1|c1=c1-c0`
        （左右声道相减：中置的成分被抵消，通常就是主唱）
      · 人声：`pan=mono|c0=0.5*c0+0.5*c1`
        （左右相加：中置的成分被留下——注意它同时留下贝斯、底鼓这些同样在中置的东西）

  为什么还是值得做：这一招在"人声居中"的立体声素材上**真的有效**，
  而且是 karaoke 工具几十年的通行做法；对有 Provider 的团队它是一条免费的本机路径，
  没有 Provider 时它是唯一能拿到的"伴奏"。

  它的边界必须一起交出去（界面原样显示，见 `describeSeparationLimits`）：
    · 单声道素材做不了（没有左右可以相减）——**直接拒绝，不返回一条假的伴奏**；
    · 人声不在正中间时效果差；
    · 不是神经网络分轨：乐器的中置成分会跟着人声一起被消掉。
   ============================================================ */

export interface SeparationPlan {
  instrumental: string;
  vocals: string;
  args: string[];
}

/** 给用户看的边界说明。 */
export function describeSeparationLimits(): string {
  return '分离用立体声中置消除（不是 AI 分轨）：适合人声居中的立体声素材；'
    + '单声道素材无法分离；中置的贝斯/底鼓会被一起消掉。';
}

export function separationArgs(inputPath: string, instrumentalPath: string, vocalsPath: string): string[] {
  /*
    一次 ffmpeg 出两条产物：它本来就是两侧取不同的声道组合，
    分两次跑只是把同一份解码做两遍。`-map` 按 filter_complex 的输出名取。
  */
  const filter = [
    '[0:a]pan=stereo|c0=c0-c1|c1=c1-c0[inst]',
    '[0:a]pan=mono|c0=0.5*c0+0.5*c1[voc]',
  ].join(';');
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-i', inputPath,
    '-filter_complex', filter,
    '-map', '[inst]', '-c:a', 'pcm_s16le', '-y', instrumentalPath,
    '-map', '[voc]', '-c:a', 'pcm_s16le', '-y', vocalsPath,
  ];
}

/** 采样声道数：中置消除要求 ≥ 2 声道。读不出来返回 null（调用方按"读不出来"处理）。 */
export async function probeChannelCount(path: string): Promise<number | null> {
  const result = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'json', path,
  ], 30_000);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { streams?: Array<{ channels?: number }> };
    const channels = parsed.streams?.[0]?.channels;
    return typeof channels === 'number' && channels > 0 ? channels : null;
  } catch {
    return null;
  }
}

export type SeparationResult =
  | { ok: true; instrumental: string; vocals: string; bytes: number }
  | { ok: false; reason: string };

/**
 * 跑一次分离。

 * 单声道**直接拒绝**：ffmpeg 会照跑不误（相减等于静音），产出两条毫无用处的轨，
 * 而用户要过一会儿才发现"伴奏是空的"。宁可当场说清。
 */
export async function separateSources(inputPath: string, plan: { instrumental: string; vocals: string }): Promise<SeparationResult> {
  if (!existsSync(inputPath)) return { ok: false, reason: `找不到输入素材：${inputPath}` };
  const channels = await probeChannelCount(inputPath);
  if (channels === null) {
    return { ok: false, reason: '读不出这段素材的声道信息（它可能没有音轨）' };
  }
  if (channels < 2) {
    return { ok: false, reason: '这段素材是单声道的，中置消除做不了分离（需要立体声素材）' };
  }

  mkdirSync(dirname(plan.instrumental), { recursive: true });
  mkdirSync(dirname(plan.vocals), { recursive: true });
  const result = await run('ffmpeg', separationArgs(inputPath, plan.instrumental, plan.vocals), 10 * 60 * 1000);
  if (!result.ok) {
    return { ok: false, reason: result.error || 'ffmpeg 执行失败' };
  }
  if (!existsSync(plan.instrumental) || !existsSync(plan.vocals)) {
    return { ok: false, reason: 'ffmpeg 报成功，但没有产出两条音轨' };
  }
  const instrumentalBytes = statSync(plan.instrumental).size;
  const vocalsBytes = statSync(plan.vocals).size;
  if (instrumentalBytes === 0 || vocalsBytes === 0) {
    return { ok: false, reason: '分离产出了空文件' };
  }
  return { ok: true, instrumental: plan.instrumental, vocals: plan.vocals, bytes: instrumentalBytes + vocalsBytes };
}

function run(command: string, args: readonly string[], timeout: number): Promise<{ ok: boolean; stdout: string; error: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) return resolve({ ok: true, stdout: typeof stdout === 'string' ? stdout : '', error: '' });
      const tail = String(stderr ?? '').trim().split('\n').slice(-3).join(' ').trim();
      return resolve({ ok: false, stdout: typeof stdout === 'string' ? stdout : '', error: tail || '命令执行失败' });
    });
  });
}
