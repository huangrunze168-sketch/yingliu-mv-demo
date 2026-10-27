/* ============================================================
  VID-005「视频高清：2/4/6 倍放大 + 30/60/90fps 提帧」的量化验收。

  矩阵口径：

    「输出分辨率为请求倍数的整数倍，帧率精确等于请求值（误差 0）」
    「规格不符时明确报错而非静默降级」

  **这一条真跑 ffmpeg**：造一段夹具视频，逐档请求，跑完用 ffprobe
  读产物的宽 / 高 / 帧率，与"源片 × 倍数"逐项比。

  为什么必须真跑而不是断言命令长得对：`minterpolate` 写了不等于插上了帧，
  `scale` 写了也不等于尺寸就是倍数——滤镜链里少一个逗号它照样退出码 0。
  判据这一半在 `tests/video-hd.test.ts`；这里只回答"跑出来的东西对不对"。
   ============================================================ */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VIDEO_HD_SCALES,
  compareVideoHdSpec,
  createFfmpegRunner,
  judgeVideoHdSpec,
  planVideoHd,
  probeVideoHdFacts,
  runVideoHd,
  type VideoHdSpecCheck,
} from '@qiyin/kernel-service';
import { acceptanceTempDir, removeDir } from './_ffmpeg.js';
import { recordAcceptance } from './_acceptance.js';

/**
 * 夹具：`testsrc` 的画面，160×120 @ 30fps，1 秒。

 * 尺寸取小是**有意的**：6 倍要放大到 960×720，再插帧到 90fps。
 * 素材一大，"验收要跑多久"就会变成"验收要不要跑"。
 * 而这一条要证明的是**倍数与帧率**，不是画质——小尺寸同样能证明。
 */
function makeFixture(path: string, seconds = 1, fps = 30, size = '160x120'): void {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${fps}:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path,
  ], { stdio: 'pipe' });
}

describe('[VID-005] 视频高清', () => {
  it('2/4/6 倍 × 提帧：分辨率恰为整数倍、帧率精确相等（逐档真跑）', async () => {
    const dir = acceptanceTempDir('qiyin-vid005-');
    try {
      const input = join(dir, 'input.mp4');
      makeFixture(input);
      const facts = await probeVideoHdFacts(input);
      expect(facts, '夹具都读不出规格的话，后面的比较没有依据').not.toBeNull();
      if (facts === null) return;
      expect(facts.width).toBe(160);
      expect(facts.height).toBe(120);
      expect(facts.fps).toBeCloseTo(30, 2);
      expect(facts.extension).toBe('mp4');

      /*
        四个组合，覆盖三档放大与三档提帧，外加"自适应(原帧率)"：
          ① 2 倍 + 60fps   —— 最常见的那一档
          ② 4 倍 + 30fps   —— 目标帧率与原片相同（不该插帧，也不该丢帧）
          ③ 6 倍 + 90fps   —— 最大的那一档
          ④ 2 倍 + 自适应  —— 只放大，帧率保持原样
        90fps 那一档慢，但它是硬要求里的一档，跳过就等于没验。
      */
      const combinations: Array<{ scale: number; fps: number | undefined }> = [
        { scale: 2, fps: 60 },
        { scale: 4, fps: 30 },
        { scale: 6, fps: 90 },
        { scale: 2, fps: undefined },
      ];

      const rows: Array<{
        request: string;
        expected: { width: number; height: number; fps: number };
        actual: { width: number | null; height: number | null; fps: number | null };
        checks: VideoHdSpecCheck[];
        correctRate: string;
        elapsedMs: number;
      }> = [];

      for (const combo of combinations) {
        const label = `${combo.scale}x-${combo.fps ?? 'auto'}fps`;
        const output = join(dir, `out-${label}.mp4`);
        const planned = planVideoHd({
          inputPath: input,
          outputPath: output,
          scale: combo.scale,
          ...(combo.fps === undefined ? {} : { fps: combo.fps }),
          workDir: dir,
        }, facts);
        expect(planned.ok, `${label} 应当能规划：${planned.ok ? '' : planned.message}`).toBe(true);
        if (!planned.ok) continue;

        /* 承诺的规格：源片 × 倍数（整数倍），帧率是请求值或原片帧率 */
        expect(planned.plan.expectedWidth).toBe(160 * combo.scale);
        expect(planned.plan.expectedHeight).toBe(120 * combo.scale);

        const outcome = await runVideoHd(planned.plan, {
          run: async (args, cwd) => {
            try {
              execFileSync('ffmpeg', [...args], { stdio: 'pipe', ...(cwd === undefined ? {} : { cwd }) });
              return { ok: true };
            } catch (error) {
              const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
              return {
                ok: false,
                failure: [error instanceof Error ? error.message : String(error), stderr]
                  .filter((part) => part !== '').join(' / '),
              };
            }
          },
          now: () => Date.now(),
          stamp: () => new Date().toISOString(),
        });
        expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true);
        if (!outcome.ok) continue;
        expect(existsSync(output)).toBe(true);

        const actualFacts = await probeVideoHdFacts(output);
        const actual = {
          width: actualFacts?.width ?? null,
          height: actualFacts?.height ?? null,
          fps: actualFacts?.fps ?? null,
        };
        const checks = compareVideoHdSpec(
          facts,
          { scale: combo.scale, ...(combo.fps === undefined ? {} : { fps: combo.fps }), sourceFps: facts.fps },
          actual,
        );
        const verdict = judgeVideoHdSpec(checks);
        expect(verdict.ok, `${label}：${verdict.ok ? '' : verdict.message}`).toBe(true);

        rows.push({
          request: label,
          expected: {
            width: planned.plan.expectedWidth,
            height: planned.plan.expectedHeight,
            fps: planned.plan.fps,
          },
          actual,
          checks,
          correctRate: verdict.correctRate,
          elapsedMs: outcome.totalElapsedMs,
        });
      }

      expect(rows).toHaveLength(combinations.length);
      const allChecks = rows.flatMap((row) => row.checks);
      const passed = allChecks.filter((check) => check.ok).length;
      const rate = (passed / allChecks.length) * 100;
      expect(rate, JSON.stringify(rows.map((row) => ({ request: row.request, actual: row.actual })))).toBe(100);

      /* 三档都真的跑到过——不是只跑了第一档就宣布"三档都对" */
      expect(new Set(rows.map((row) => row.request.split('x')[0]))).toEqual(new Set(VIDEO_HD_SCALES.map(String)));

      recordAcceptance('VID-005', {
        criterion: '输出分辨率为请求倍数的整数倍；帧率精确等于请求值（误差 0）；规格不符时明确报错',
        correctRate: `${passed}/${allChecks.length}`,
        combinations: rows.map((row) => ({
          request: row.request,
          expected: row.expected,
          actual: row.actual,
          correctRate: row.correctRate,
          elapsedMs: row.elapsedMs,
        })),
        source: { width: facts.width, height: facts.height, fps: facts.fps },
        cases: combinations.length,
      });
    } finally {
      removeDir(dir);
    }
  }, 600_000);

  it('源片超过 2K 时拒绝，不静默降级成一档能做的大小', async () => {
    /*
      这一条防的是"体贴的降级"：源片 4K、用户点 2 倍，
      如果实现选择"那我按 2K 上限给你缩一下"，产物就不是请求的那一个了，
      而用户从结果上看不出来。拒绝并说清原因才是对的。
    */
    const dir = acceptanceTempDir('qiyin-vid005-2k-');
    try {
      const input = join(dir, 'input.mp4');
      /* 2048 的长边门槛之上：用 2560×1440 造一条真实存在的小短片头 */
      makeFixture(input, 0.5, 30, '2560x1440');
      const facts = await probeVideoHdFacts(input);
      expect(facts?.width).toBe(2560);
      if (facts === null) return;

      const planned = planVideoHd({
        inputPath: input, outputPath: join(dir, 'out.mp4'), scale: 2, fps: 60, workDir: dir,
      }, facts);
      expect(planned.ok).toBe(false);
      if (planned.ok) return;
      expect(planned.code).toBe('VIDEO_HD_SOURCE_OVER_2K');
      expect(planned.message).toBe('视频分辨率超过 2K，暂不支持超分');
    } finally {
      removeDir(dir);
    }
  }, 300_000);

  it('生产路径的那个 runner（createFfmpegRunner）本身也跑得通：2 倍 + 60fps', async () => {
    /*
      上面那条用的是验收自己包的 `execFileSync` runner，好处是失败时 stderr 进断言。
      但**真正上线的**是主进程里那个 `createFfmpegRunner()`（`execFile` + 异步）。
      两者的调用方式不同（同步 vs 异步、cwd 传法不同），只验一个等于另一个没验——
      而"验收通过、上手就炸"最常见的原因就是这种"验的不是那一个"。
    */
    const dir = acceptanceTempDir('qiyin-vid005-prod-');
    try {
      const input = join(dir, 'input.mp4');
      const output = join(dir, 'output.mp4');
      makeFixture(input);
      const facts = await probeVideoHdFacts(input);
      expect(facts).not.toBeNull();
      if (facts === null) return;

      const planned = planVideoHd({
        inputPath: input, outputPath: output, scale: 2, fps: 60, workDir: dir,
      }, facts);
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;

      const outcome = await runVideoHd(planned.plan, createFfmpegRunner());
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true);
      if (!outcome.ok) return;
      /* 耗时记录是"可审计"的载体：每一步都得有名字和真实花掉的时间 */
      expect(outcome.steps.length).toBeGreaterThan(0);
      expect(outcome.steps.every((step) => step.name !== '' && step.elapsedMs >= 0)).toBe(true);
      expect(outcome.totalElapsedMs).toBeGreaterThan(0);

      const actual = await probeVideoHdFacts(output);
      expect(actual?.width).toBe(320);
      expect(actual?.height).toBe(240);
      expect(actual?.fps).toBe(60);
    } finally {
      removeDir(dir);
    }
  }, 300_000);
});
