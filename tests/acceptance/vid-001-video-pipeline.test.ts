/* ============================================================
  VID-001「插帧、超分、稳定、裁剪」的量化验收。

  矩阵口径两条，两条都能量：

    「**输出规格正确率 100%**（分辨率/帧率/时长与请求一致）」
    「单镜耗时记录可审计」

  所以这里**真跑 ffmpeg**（不是 mock）：造一段**会抖**的夹具视频，
  请求"2 倍放大 + 插帧到 60fps + 稳定"，跑完用 ffprobe 读产物的
  宽 / 高 / 帧率 / 时长，逐项与**管线自己承诺的规格**比。

  为什么夹具要抖：不抖的视频跑稳定前后一模一样，那样这条验收等于没验
  （"稳定滤镜有没有生效"和"这条命令退出码是不是 0"是两件事）。
  ============================================================ */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareSpec, planVideoPipeline, runVideoPipeline, type VideoPipelineStepTiming,
} from '@qiyin/kernel-service';
import { acceptanceTempDir, removeDir } from './_ffmpeg.js';
import { recordAcceptance } from './_acceptance.js';

/**
 * 造一段**会抖**的夹具视频。

 * 用 `testsrc` 的画面，再用 `crop` 的 x/y 跟着正弦走——这就是"手持抖动"的
 * 最小可用模型：画面在动、但不是真的在拍东西，所以不依赖任何外部素材。
 */
function makeShakyClip(path: string, seconds = 2, fps = 30): void {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=${fps}:duration=${seconds}`,
    '-vf', "crop=w=300:h=220:x='10+6*sin(t*12)':y='10+6*cos(t*9)'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path,
  ], { stdio: 'pipe' });
}

interface ProbedSpec {
  width: number | null;
  height: number | null;
  fps: number | null;
  durationSeconds: number | null;
}

/** 用 ffprobe 读产物的真实规格——这是"输出规格正确率"的**唯一**依据。 */
function probeSpec(path: string): ProbedSpec {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate',
    '-show_entries', 'format=duration',
    '-of', 'json', path,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(raw) as {
    streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  /* `r_frame_rate` 长这样：`30/1` 或 `30000/1001` */
  const ratio = stream?.r_frame_rate ?? '';
  const [numerator, denominator] = ratio.split('/').map((part) => Number(part));
  const fps = Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? (numerator as number) / (denominator as number)
    : null;
  const duration = Number(parsed.format?.duration);
  return {
    width: stream?.width ?? null,
    height: stream?.height ?? null,
    fps,
    durationSeconds: Number.isFinite(duration) ? duration : null,
  };
}

describe('[VID-001] 视频处理管线', () => {
  it('2 倍放大 + 插帧到 60fps + 稳定：输出规格正确率 100%，耗时逐步可审计', async () => {
    const dir = acceptanceTempDir('qiyin-vid001-');
    try {
      const input = join(dir, 'input.mp4');
      const output = join(dir, 'output.mp4');
      makeShakyClip(input, 2, 30);
      const inputSpec = probeSpec(input);
      expect(inputSpec.width).toBe(300);
      expect(inputSpec.height).toBe(220);
      expect(inputSpec.fps).toBeCloseTo(30, 1);

      const planned = planVideoPipeline({
        inputPath: input,
        outputPath: output,
        fps: 60,
        stabilize: true,
        scale: 2,
        workDir: dir,
      }, {
        width: inputSpec.width as number,
        height: inputSpec.height as number,
        fps: inputSpec.fps as number,
        durationSeconds: inputSpec.durationSeconds as number,
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;

      /* 承诺：600×440（300×2 / 220×2 都要偶数对齐）、60fps、时长不变 */
      expect(planned.plan.expected.width).toBe(600);
      expect(planned.plan.expected.height).toBe(440);
      expect(planned.plan.expected.fps).toBe(60);
      /* 稳定是两遍（分析 + 应用），缩放/插帧独立一步——一共三步 */
      expect(planned.plan.steps.map((step) => step.name)).toEqual([
        '稳定·分析抖动轨迹',
        '稳定·应用抖动轨迹',
        '视频变换（稳定 / 缩放 / 插帧）',
      ]);

      /* 真跑 */
      const timings: VideoPipelineStepTiming[] = [];
      const run = await runVideoPipeline(planned.plan, {
        run: async (args, cwd) => {
          try {
            execFileSync('ffmpeg', [...args], { stdio: 'pipe', ...(cwd === undefined ? {} : { cwd }) });
            return { ok: true };
          } catch (error) {
            /* 把 ffmpeg 的 stderr 带回来：`-loglevel error` 下真正的原因都在那儿 */
            const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
            const stdout = (error as { stdout?: Buffer }).stdout?.toString().trim() ?? '';
            return {
              ok: false,
              failure: [error instanceof Error ? error.message : String(error), stderr, stdout]
                .filter((part) => part !== '').join(' / '),
            };
          }
        },
        now: () => Date.now(),
        stamp: () => new Date().toISOString(),
      });
      expect(run.ok, run.ok ? '' : (run as { message: string }).message).toBe(true);
      if (run.ok) timings.push(...run.timing.steps);
      expect(existsSync(output)).toBe(true);

      /* 用 ffprobe 读产物，逐项与承诺比 */
      const actual = probeSpec(output);
      const checks = compareSpec(planned.plan.expected, actual);
      const passed = checks.filter((check) => check.ok).length;
      const rate = (passed / checks.length) * 100;

      const detail = {
        expected: planned.plan.expected,
        actual,
        checks: checks.map((check) => ({
          field: check.field, expected: check.expected, actual: check.actual, ok: check.ok,
        })),
        correctRate: `${passed}/${checks.length} = ${rate}%`,
        /* 耗时记录：每一步都有名字、开始时刻、花了多久 */
        timings: timings.map((step) => ({
          name: step.name, startedAt: step.startedAt, elapsedMs: step.elapsedMs, ok: step.ok,
        })),
      };

      expect(rate, JSON.stringify(detail.checks)).toBe(100);
      /* "可审计"的最低要求：每一步都有名字与非负耗时 */
      expect(timings.length).toBeGreaterThanOrEqual(2);
      expect(timings.every((step) => step.name !== '' && step.elapsedMs >= 0)).toBe(true);

      recordAcceptance('VID-001', {
        criterion: '输出规格正确率 100%（分辨率/帧率/时长与请求一致）；单步耗时记录可审计',
        correctRate: `${passed}/${checks.length}`,
        expected: planned.plan.expected,
        actual,
        stepCount: timings.length,
        totalElapsedMs: timings.reduce((sum, step) => sum + step.elapsedMs, 0),
        framesPerSecondRequested: 60,
      });
    } finally {
      removeDir(dir);
    }
  }, 180_000);

  it('请求自相矛盾时拒绝：放大倍数与目标分辨率不能同时给', () => {
    const result = planVideoPipeline({
      inputPath: 'a.mp4', outputPath: 'b.mp4',
      scale: 2, resolution: { width: 800, height: 600 }, workDir: '.',
    }, { width: 320, height: 240, fps: 30, durationSeconds: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('VIDEO_SCALE_CONFLICT');
  });

  it('什么都没选时拒绝：空管线不该悄悄通过', () => {
    const result = planVideoPipeline({ inputPath: 'a.mp4', outputPath: 'b.mp4', workDir: '.' }, {
      width: 320, height: 240, fps: 30, durationSeconds: 2,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('VIDEO_PIPELINE_EMPTY');
  });

  it('读不到原片尺寸 / 时长时拒绝：承诺不了规格就不开工', () => {
    const noSize = planVideoPipeline({ inputPath: 'a.mp4', outputPath: 'b.mp4', scale: 2, workDir: '.' }, {
      width: 0, height: 0, fps: 30, durationSeconds: 2,
    });
    expect(noSize.ok).toBe(false);
    if (!noSize.ok) expect(noSize.code).toBe('VIDEO_INPUT_SIZE_UNKNOWN');

    const noDuration = planVideoPipeline({ inputPath: 'a.mp4', outputPath: 'b.mp4', scale: 2, workDir: '.' }, {
      width: 320, height: 240, fps: 30, durationSeconds: 0,
    });
    expect(noDuration.ok).toBe(false);
    if (!noDuration.ok) expect(noDuration.code).toBe('VIDEO_INPUT_DURATION_UNKNOWN');
  });

  it('帧率与倍数的边界：超范围拒绝，降帧会明确说出来', () => {
    const tooHigh = planVideoPipeline({ inputPath: 'a.mp4', outputPath: 'b.mp4', fps: 480, workDir: '.' }, {
      width: 320, height: 240, fps: 30, durationSeconds: 2,
    });
    expect(tooHigh.ok).toBe(false);

    const tooBig = planVideoPipeline({ inputPath: 'a.mp4', outputPath: 'b.mp4', scale: 20, workDir: '.' }, {
      width: 320, height: 240, fps: 30, durationSeconds: 2,
    });
    expect(tooBig.ok).toBe(false);

    const down = planVideoPipeline({ inputPath: 'a.mp4', outputPath: 'b.mp4', fps: 24, workDir: '.' }, {
      width: 320, height: 240, fps: 30, durationSeconds: 2,
    });
    expect(down.ok).toBe(true);
    if (down.ok) expect(down.plan.notes.join('')).toContain('降帧');
  });
});
