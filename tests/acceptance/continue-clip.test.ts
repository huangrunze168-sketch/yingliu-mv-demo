/* ============================================================
  VID-006「视频续写 / 延长」的量化验收。

  续写 = **取上一段的尾帧 → 当成下一段的起点 → 生成 → 登记产物**。

  三条口径：
    ① 尾帧是**真取出来的**（ffmpeg 真跑、文件真存在）——"续写"的依据就是这一帧；
    ② 走**项目级生成意图**：先预留预算、结清按实际退回；
    ③ **不动分镜选帧**，所以 G2 不会被作废（G2 管的是"按分镜出视频"）。
       这一条是刻意与"给下一镜选首帧"分开的：那条路会作废 G2，得让人再批一次。
   ============================================================ */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BackendMedia, BackendVideoRequest, GenerationBackend } from '@qiyin/generation-backend';
import { GenerationService } from '@qiyin/generation-service';
import { extractLastFrame, probeClip } from '@qiyin/kernel-service';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { recordAcceptance } from './_acceptance.js';

const root = mkdtempSync(join(tmpdir(), 'qiyin-acceptance-continue-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:acceptance', type, payload, ...extras };
}

function commandExists(binary: string): boolean {
  try {
    const result = require('node:child_process').execFileSync(binary, ['-version'], { stdio: 'ignore' });
    void result;
    return true;
  } catch {
    return false;
  }
}

const hasFfmpeg = commandExists('ffmpeg');

/** 一个"图生视频"假后端：把收到的首帧路径记下来，写一段新片段。 */
function videoBackend(): { backend: GenerationBackend; frames: string[] } {
  const frames: string[] = [];
  const backend: GenerationBackend = {
    id: 'fake-continue',
    label: '假续写后端',
    capabilities: {
      image: false, videoFromImage: true, videoEdit: false, imageShortcut: false, imageUpscale: false,
      audioSpeech: false, audioMusic: false,
    },
    async generateImage(): Promise<BackendMedia> { throw new Error('用不到'); },
    async generateVideoFromImage(request: BackendVideoRequest): Promise<BackendMedia> {
      frames.push(request.imageFile);
      mkdirSync(request.outputDir, { recursive: true });
      const file = join(request.outputDir, `${request.label}.mp4`);
      writeFileSync(file, Buffer.from(`MP4:${request.prompt}`), 'utf8');
      return { files: [file], source_url: null, task_ref: null, cost: { unit: 'credit', amount: 2 }, notes: [] };
    },
    async editVideo(): Promise<BackendMedia> { throw new Error('用不到'); },
    async applyImageShortcut(): Promise<BackendMedia> { throw new Error('用不到'); },
    async upscaleImage(): Promise<BackendMedia> { throw new Error('用不到'); },
    async generateAudio(): Promise<BackendMedia> { throw new Error('用不到'); },
  };
  return { backend, frames };
}

function setup() {
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const projects = new ProjectService(openDatabase(':memory:'));
  const projectId = projects.execute(command('project.create', {
    name: '续写', max_budget_cents: 500, rights_confirmed: true,
  })).project_id as string;
  const revision = () => (projects.getProject(projectId) as { revision: number }).revision;
  return { projects, projectId, revision, workspace };
}

describe('[VID-006] 视频续写', () => {
  it.skipIf(!hasFfmpeg)('尾帧是真取出来的：ffmpeg 跑一遍，产出一张能读的图', async () => {
    const clip = join(root, 'source.mp4');
    const { execFileSync } = await import('node:child_process');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=2:r=24',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', clip,
    ]);
    const frame = join(root, 'last-frame.png');
    const extracted = await extractLastFrame(clip, frame);

    recordAcceptance('VID-006.frame', {
      criterion: '取尾帧：ffmpeg 真跑、文件真存在、可被媒体探针读出',
      ok: extracted.ok,
      bytes: extracted.ok ? extracted.bytes : 0,
      usedSeekBackSeconds: extracted.ok ? extracted.usedSeekBackSeconds : null,
      notes: extracted.ok ? extracted.notes : [],
      probed: extracted.ok ? await probeClip(frame) : null,
      reasonWhenMissing: extracted.ok ? null : extracted.reason,
    });

    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.bytes).toBeGreaterThan(100);
    expect(readFileSync(frame).length).toBe(extracted.bytes);
    /* 取不到文件时也要有明确原因（这条同时盖住"片段路径不存在"那一支） */
    const missing = await extractLastFrame(join(root, 'nope.mp4'), join(root, 'x.png'));
    expect(missing.ok).toBe(false);
  }, 120_000);

  it('续写走项目级账本：预留 → 生成 → 结清；且不动分镜选帧（G2 不受影响）', async () => {
    const ctx = setup();
    const frame = join(ctx.workspace, 'derived', 'last-frame.png');
    mkdirSync(join(ctx.workspace, 'derived'), { recursive: true });
    writeFileSync(frame, Buffer.from('PNG:frame'), 'utf8');
    const { backend, frames } = videoBackend();
    const service = new GenerationService(ctx.projects, backend);

    const outcome = await service.continueClip({
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      workspaceDir: ctx.workspace,
      firstFrameFile: frame,
      prompt: '继续往前走两步',
      model: 'fake-model',
      durationSeconds: 5,
      estimatedCostCents: 30,
      actualCostCents: 30,
    });

    expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
    if (!outcome.ok) return;
    const project = ctx.projects.getProject(ctx.projectId) as {
      reserved_budget_cents: number;
      candidates?: unknown[];
      selections?: unknown[];
    };
    const intents = ctx.projects.listAssetGenerationIntents(ctx.projectId) as Array<{ kind: string; status: string; artifact_id: string | null }>;

    recordAcceptance('VID-006', {
      criterion: '续写：尾帧入库 → 项目级意图（先预留后结清）→ 新片段入库；不碰选帧',
      frameArtifactId: outcome.frameArtifactId,
      clipArtifactId: outcome.clipArtifactId,
      bytes: outcome.bytes,
      cost: outcome.cost,
      backendReceivedFrame: frames[0] === frame,
      intents: intents.map((intent) => ({ kind: intent.kind, status: intent.status, hasArtifact: intent.artifact_id !== null })),
      /*
        `reserved_budget_cents` 的语义是"**已占用**（含已花费）"，不是"还剩多少预留"。
        所以实际花费 = 预估 30 时，结清后它仍是 30；只有"实际 < 预估"才会退回差额。
      */
      reservedBudgetCentsAfterSettle: project.reserved_budget_cents,
      estimatedCents: 30,
      actualCents: 30,
      candidatesTouched: project.candidates?.length ?? 0,
      selectionsTouched: project.selections?.length ?? 0,
    });

    expect(outcome.frameArtifactId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(outcome.clipArtifactId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(frames[0]).toBe(frame);
    /* 结清完成：占用额 = 实际花费 30（不是 0——它是"已占用"，差额才会退） */
    expect(project.reserved_budget_cents).toBe(30);
    expect(intents[0]).toMatchObject({ kind: 'video', status: 'COMPLETED' });
    /* **没有动选帧**：这是"续写不改分镜、不作废 G2"的证据 */
    expect(project.selections ?? []).toHaveLength(0);
    expect(project.candidates ?? []).toHaveLength(0);
  }, 120_000);

  it('后端失败时：意图结清为 FAILED，预留按"花费未知"口径继续占着', async () => {
    const ctx = setup();
    const frame = join(ctx.workspace, 'derived', 'last-frame.png');
    mkdirSync(join(ctx.workspace, 'derived'), { recursive: true });
    writeFileSync(frame, Buffer.from('PNG:frame'), 'utf8');
    const failing: GenerationBackend = {
      id: 'fake-fail',
      label: '会失败的假后端',
      capabilities: {
        image: false, videoFromImage: true, videoEdit: false, imageShortcut: false, imageUpscale: false,
        audioSpeech: false, audioMusic: false,
      },
      async generateImage(): Promise<BackendMedia> { throw new Error('用不到'); },
      async generateVideoFromImage(): Promise<BackendMedia> { throw new Error('模型繁忙'); },
      async editVideo(): Promise<BackendMedia> { throw new Error('用不到'); },
      async applyImageShortcut(): Promise<BackendMedia> { throw new Error('用不到'); },
      async upscaleImage(): Promise<BackendMedia> { throw new Error('用不到'); },
      async generateAudio(): Promise<BackendMedia> { throw new Error('用不到'); },
    };
    const service = new GenerationService(ctx.projects, failing);
    const outcome = await service.continueClip({
      projectId: ctx.projectId,
      expectedRevision: ctx.revision(),
      workspaceDir: ctx.workspace,
      firstFrameFile: frame,
      prompt: '继续',
      model: 'fake-model',
      durationSeconds: 5,
      estimatedCostCents: 30,
    });
    const project = ctx.projects.getProject(ctx.projectId) as { reserved_budget_cents: number };
    const intents = ctx.projects.listAssetGenerationIntents(ctx.projectId) as Array<{ status: string; failure: string | null }>;

    recordAcceptance('VID-006.failure', {
      criterion: '续写失败：意图 FAILED 留痕、预留按"花费未知"继续占着',
      ok: outcome.ok,
      reason: outcome.ok ? null : outcome.reason,
      intentStatus: intents[0]?.status ?? null,
      failure: intents[0]?.failure ?? null,
      reservedBudgetCents: project.reserved_budget_cents,
    });

    expect(outcome.ok).toBe(false);
    expect(intents[0]).toMatchObject({ status: 'FAILED' });
    expect(intents[0]?.failure).toContain('模型繁忙');
    expect(project.reserved_budget_cents).toBe(30);
  }, 120_000);
});
