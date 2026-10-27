import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, ProjectService, toPublicError } from '@qiyin/domain';
import { createFrontkernelAdapter } from '@qiyin/frontkernel-adapter';
import { ensureRuntimeProfileFile, KernelService } from '@qiyin/kernel-service';
import { createCanvasAdapter, ensureCanvasBinding, readCanvasBinding } from '@qiyin/canvas-adapter';
import {
  createGenerationBackend,
  labelForBackend,
  parseBackendId,
  probeGenerationBackends,
} from '@qiyin/generation-backends';
import { frameRatio, GenerationService, imagePromptFromShotFields } from '@qiyin/generation-service';
import {
  CLI_COMMANDS, CLI_ERROR_CODES, CLI_LIMITS, unknownCommandResponse,
} from './manifest.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

/**
 * 参考片的画幅比。
 *
 * 图片与视频模型的默认画幅都是 **16:9**：竖屏参考片若不显式指定，
 * 生成出来的素材会是横屏。这不是「复刻得不像」，是根本没对齐——
 * 按参考画布算的 `canvas_match` 评估会直接判 0。
 *
 * 探测失败时返回 undefined，把决定权交回调用方（视频那边会退到 `adaptive`，
 * 也就是「跟随首帧」），而不是让一次探测失败挡住整批生成。
 */
async function referenceRatio(
  kernelService: KernelService | null,
  workspaceDir: string,
  mediaPath: string | undefined,
): Promise<string | undefined> {
  if (kernelService === null || mediaPath === undefined) return undefined;
  try {
    const probe = await kernelService.probeMedia({ workspaceDir, mediaPath });
    if (probe.width && probe.height) return frameRatio(probe.width, probe.height);
  } catch { /* 探测失败不挡住生成 */ }
  return undefined;
}

/** 解析 `k=v;k=v` 形式的字段赋值。 */
function parseKeyValues(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    result[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return result;
}

async function main(): Promise<void> {
  const db = openDatabase(process.env.QIYIN_DB_PATH ?? resolve('.data/qiyin.db'));
  const service = new ProjectService(db);
  const action = process.argv[2];

  /**
   * 前置内核按需接入：找不到发行版时其余命令照常可用，
   * 只有真正需要内核的子命令才会明确报错。
   */
  let kernel: KernelService | null = null;
  let kernelUnavailable: string | null = null;
  try {
    kernel = new KernelService(service, createFrontkernelAdapter());
  } catch (error) {
    kernelUnavailable = error instanceof Error ? error.message : String(error);
  }

  switch (action) {
    case 'project:create':
      output(service.execute({
        command_id: option('--command-id') ?? randomUUID(),
        actor: option('--actor') ?? 'user:cli',
        type: 'project.create',
        payload: {
          name: required('--name'),
          max_budget_cents: Number(option('--budget-cents') ?? 0),
          rights_confirmed: process.argv.includes('--rights-confirmed'),
        },
      }));
      break;
    case 'project:list': output(service.listProjects()); break;
    case 'project:status': output(service.getProject(required('--project-id'))); break;
    case 'provider:list': output(service.listProviders()); break;
    /** 批准闸门。G2 需要同时给出视频预算，这是契约要求而不是可选参数。 */
    case 'gate:approve':
      output(service.execute({
        command_id: option('--command-id') ?? randomUUID(),
        actor: option('--actor') ?? 'user:cli',
        type: 'gate.approve',
        project_id: required('--project-id'),
        expected_revision: Number(required('--revision')),
        payload: {
          gate: required('--gate'),
          ...(option('--budget-cents') === undefined ? {} : { approved_budget_cents: Number(option('--budget-cents')) }),
          ...(option('--note') === undefined ? {} : { note: option('--note') }),
        },
      }));
      break;
    case 'kernel:tasks': output(service.listKernelTasks(required('--project-id'))); break;
    case 'source:list': output(service.listSources(required('--project-id'))); break;
    case 'candidate:list': output(service.listImageCandidates(required('--project-id'))); break;
    /**
     * 确认某个镜头的字段值（把 unknown 换成真实内容）。
     *
     * 走的是与界面完全相同的 `shot-fields.replace`：会推进 fields_revision，
     */
    case 'shot-fields:set': {
      const projectId = required('--project-id');
      const project = service.getProject(projectId) as {
        shot_fields?: { shots?: Array<Record<string, unknown>>; breakdown_revision?: number } | null;
      };
      const shots = project.shot_fields?.shots ?? [];
      if (shots.length === 0) throw new Error('请先生成或录入逐镜字段表');
      const shotId = required('--shot');
      if (!shots.some((shot) => String(shot.shot_id) === shotId)) throw new Error(`镜头不存在：${shotId}`);
      const values = parseKeyValues(required('--values'));
      const next = shots.map((shot) => (String(shot.shot_id) === shotId
        ? { ...shot, ...values, source: 'human', author: option('--actor') ?? 'user:cli' }
        : shot));
      output(service.execute({
        command_id: option('--command-id') ?? randomUUID(),
        actor: option('--actor') ?? 'user:cli',
        type: 'shot-fields.replace',
        project_id: projectId,
        expected_revision: Number(required('--revision')),
        payload: { breakdown_revision: (project.shot_fields?.breakdown_revision ?? 0) + 1, shots: next },
      }));
      break;
    }
    /** 选帧：把某个候选定为该镜头的首帧。带 selection revision 做 CAS，避免覆盖他人选择。 */
    case 'candidate:select':
      output(service.execute({
        command_id: option('--command-id') ?? randomUUID(),
        actor: option('--actor') ?? 'user:cli',
        type: 'image-candidate.select',
        project_id: required('--project-id'),
        expected_revision: Number(required('--revision')),
        payload: {
          shot_id: required('--shot'),
          candidate_id: required('--candidate'),
          expected_selection_revision: Number(option('--selection-revision') ?? 0),
        },
      }));
      break;
    /**
     * 成片：把已选首帧按各镜时长写成 Source，交给内核渲染。
     *
     * 与桌面端走的是同一条服务层路径；帧文件位置从 Artifact 的 metadata 里读，
     * 因此换一个进程、换一台机器都能重新找到同一张帧。
     */
    case 'film:produce': {
      if (!kernel) throw new Error(`前置内核未接入：${kernelUnavailable ?? '未知原因'}`);
      const projectId = required('--project-id');
      const workspaceDir = resolve(required('--workspace'));
      const project = service.getProject(projectId) as {
        shot_fields?: { shots?: Array<{ shot_id: string; t1_ms: number; t0_ms: number }> } | null;
        selections?: Array<{ shot_id: string; candidate_id: string }>;
        candidates?: Array<{ candidate_id: string; artifact_id: string }>;
        sources?: Array<{ relative_path: string }>;
      };
      const shots = project.shot_fields?.shots ?? [];
      if (shots.length === 0) throw new Error('请先生成或录入逐镜字段表');
      const selected = new Map((project.selections ?? []).map((item) => [item.shot_id, item.candidate_id]));
      const missing = shots.filter((shot) => !selected.has(shot.shot_id));
      if (missing.length > 0) throw new Error(`还有 ${missing.length} 个镜头未选首帧`);

      const artifactByCandidate = new Map((project.candidates ?? []).map((item) => [item.candidate_id, item.artifact_id]));
      const artifacts = service.listArtifacts() as Array<{
        artifact_id: string;
        metadata: { frame_path_relative?: string } | null;
      }>;
      const frameByArtifact = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact.metadata?.frame_path_relative]));
      /**
       * 已生成成功的视频片段：有片段就用片段，没有的镜头退回静帧。
       *
       * 同一个镜头可能生成过多次（失败重试、换模型、换规格），这里取**最新一条成功**
       * 的片段——`listVideoGenerationIntents` 按 created_at 倒序返回，
       * 因此「先到先得」就是最新的那条。失败的意图不进这张表：
       * 它们的 clip_artifact_id 本来就是空，本来也没有片段可用。
       */
      const clipByShot = new Map<string, string>();
      for (const intent of service.listVideoGenerationIntents(projectId) as Array<{
        shot_id: string;
        status: string;
        clip_artifact_id: string | null;
      }>) {
        if (intent.status !== 'COMPLETED' || intent.clip_artifact_id === null) continue;
        const clip = frameByArtifact.get(intent.clip_artifact_id);
        if (clip !== undefined && !clipByShot.has(intent.shot_id)) clipByShot.set(intent.shot_id, clip);
      }
      const filmShots: Array<{ shot_id: string; image_src: string; duration_ms: number; video_src?: string; audio?: boolean }> = [];
      /** 声音决策要摆出来：哪一镜带上了声音、读到的峰值是多少。 */
      const audioReport: Array<{ shot_id: string; has_audio: boolean; max_db: number | null; included: boolean }> = [];
      for (const shot of shots) {
        const artifactId = artifactByCandidate.get(selected.get(shot.shot_id) ?? '') ?? '';
        const frame = frameByArtifact.get(artifactId);
        if (!frame) throw new Error(`${shot.shot_id} 的首帧文件没有登记在项目里，请重新抽帧`);
        const clip = clipByShot.get(shot.shot_id);
        /**
         * 片段的声音要不要带上，**量过再说**。
         *
         * 不看 `hasAudio`：前置内核 的成片合流时总会写一条音轨，静音也是音轨，
         * 实测三条素材 `hasAudio` 全 true 而真实峰值是 -91/-8.8/-91 dB。
         * 量不出来（ffmpeg 缺失）时按「不带」处理，并在报告里标出来——
         * 宁可不带，也不把一个没人听过的音轨混进成片。
         */
        let audio: boolean | undefined;
        if (clip !== undefined) {
          const audibility = await kernel.probeAudibility({ workspaceDir, mediaPath: clip });
          audio = audibility.audible === true;
          audioReport.push({
            shot_id: shot.shot_id,
            has_audio: audibility.hasAudio,
            max_db: audibility.max_db,
            included: audio,
          });
        }
        filmShots.push({
          shot_id: shot.shot_id,
          image_src: frame,
          duration_ms: Math.max(1, shot.t1_ms - shot.t0_ms),
          ...(clip === undefined ? {} : { video_src: clip }),
          ...(audio === undefined ? {} : { audio }),
        });
      }

      // 画布跟随参考视频；探测失败时退回竖屏默认值，不因此挡住成片
      let canvas = { width: 540, height: 960 };
      try {
        const probe = await kernel.probeMedia({ workspaceDir, mediaPath: required('--media') });
        if (probe.width && probe.height) canvas = { width: probe.width, height: probe.height };
      } catch { /* 用默认画布继续 */ }

      const prepared = kernel.prepareFilmSource({ workspaceDir, canvas, shots: filmShots });
      ensureRuntimeProfileFile(workspaceDir);
      const submission = await kernel.submitBuild({
        projectId,
        expectedRevision: Number(required('--revision')),
        sourcePath: prepared.svrun,
        workspaceDir,
        runtimeProfile: 'frontkernel.runtime.json',
        actor: option('--actor') ?? 'user:cli',
      });
      output({ prepared, canvas, audio: audioReport, submission });
      if (!submission.executed) process.exitCode = 5;
      break;
    }
    /**
     * 画布绑定：查状态，或在没绑定时新建一张并绑定。
     *
     * 绑定文件因此写在项目 workspace 里：换机器、换会话都跟着项目走，
     * 两个项目也不会把节点堆到同一张画布上。
     *
     * `canvas:bind` 会在用户账号里**真实建出画布**，所以它是独立命令，
     * 不在生成流程里顺手做掉。
     */
    /**
     * 这台机器上有哪些生成后端可用。
     *
     * 只查可执行文件是否存在，**不做登录检查**：登录状态属于账号，
     * 把两件事混在一起，用户会看到一个「不可用」，却不知道该装软件还是该登录。
     */
    case 'backend:list':
      output({ backends: probeGenerationBackends() });
      break;
    case 'canvas:status': {
      const workspaceDir = resolve(required('--workspace'));
      const binding = readCanvasBinding(workspaceDir);
      output(binding === null
        ? { bound: false, workspace: workspaceDir }
        : { bound: true, workspace: workspaceDir, canvas_uuid: binding.canvasUuid, workspace_id: binding.workspaceId });
      break;
    }
    case 'canvas:bind': {
      const workspaceDir = resolve(required('--workspace'));
      const name = option('--name') ?? basename(workspaceDir);
      const { binding, created } = await ensureCanvasBinding(createCanvasAdapter({ cwd: workspaceDir }), {
        dir: workspaceDir,
        name: `${name} · 复刻画布`,
      });
      output({
        bound: true,
        created,
        workspace: workspaceDir,
        canvas_uuid: binding.canvasUuid,
        workspace_id: binding.workspaceId,
      });
      break;
    }
    /**
     * 偏差评估：把成片与参考片比对，产出带归因的报告。
     * 只用可计算事实（时长/画幅/音轨），因此结论确定、可复现、不花钱。
     */
    case 'film:evaluate': {
      if (!kernel) throw new Error(`前置内核未接入：${kernelUnavailable ?? '未知原因'}`);
      const projectId = required('--project-id');
      const project = service.getProject(projectId) as {
        sources?: Array<{ relative_path: string; content_hash: string }>;
      };
      const reference = project.sources?.[0];
      if (!reference) throw new Error('请先登记参考视频');
      const evaluation = await kernel.evaluateFilm({
        projectId,
        expectedRevision: Number(required('--revision')),
        workspaceDir: resolve(required('--workspace')),
        referencePath: reference.relative_path,
        resultPath: required('--result'),
        referenceArtifact: reference.content_hash,
        actor: option('--actor') ?? 'user:cli',
      });
      output(evaluation);
      if (!evaluation.executed) process.exitCode = 5;
      break;
    }
    /**
     * 用 小QTV 为每个镜头生成图片并登记为首帧候选（S5）。
     *
     * 这是产品里**真正花钱**的一步：每条 `image-generation.request` 都会
     * 在领域层预留预算，生成结束后按实际成本结清。
     */
    case 'image:generate': {
      const projectId = required('--project-id');
      const workspaceDir = resolve(required('--workspace'));
      /**
       * 所以适配器必须带着那个目录构造；用 CLI 进程自己的 cwd 会直接报「缺少项目」。
       */
      const canvasCwd = resolve(option('--canvas-cwd') ?? required('--workspace'));
      const backendId = parseBackendId(option('--backend'));
      let generator: GenerationService;
      try {
        generator = new GenerationService(service, createGenerationBackend(backendId, { canvasCwd }));
      } catch (error) {
        throw new Error(`${labelForBackend(backendId)} 未接入：${error instanceof Error ? error.message : String(error)}`);
      }
      const project = service.getProject(projectId) as {
        shot_fields?: { shots?: Array<Record<string, unknown>> } | null;
        sources?: Array<{ relative_path: string }>;
      };
      const allShots = project.shot_fields?.shots ?? [];
      if (allShots.length === 0) throw new Error('请先生成或录入逐镜字段表');

      const only = option('--shots')?.split(',').map((item) => item.trim()).filter(Boolean);
      const shots = allShots
        .filter((shot) => only === undefined || only.includes(String(shot.shot_id)))
        .map((shot) => ({
          shot_id: String(shot.shot_id),
          prompt: imagePromptFromShotFields(shot),
        }))
        .filter((shot) => shot.prompt.length > 0);
      if (shots.length === 0) throw new Error('所选镜头没有可用的提示词（字段可能全是 unknown）');

      // 画幅跟随参考片；探测不到才交给模型自己的默认值
      const ratio = option('--ratio') ?? await referenceRatio(kernel, workspaceDir, project.sources?.[0]?.relative_path);
      const outcome = await generator.generateShotImages({
        projectId,
        expectedRevision: Number(required('--revision')),
        canvasCwd,
        workspaceDir,
        shots,
        model: required('--model'),
        ...(ratio === undefined ? {} : { ratio }),
        ...(option('--quality') === undefined ? {} : { quality: option('--quality')! }),
        ...(option('--cost-cents') === undefined ? {} : { estimatedCostCents: Number(option('--cost-cents')) }),
        ...(option('--actual-cents') === undefined ? {} : { actualCostCents: Number(option('--actual-cents')) }),
        actor: option('--actor') ?? 'user:cli',
      });
      output(outcome);
      if (outcome.failures.length > 0) process.exitCode = 5;
      break;
    }
    /**
     * 用 小QTV 把每个镜头已选定的首帧生成成视频片段（S6）。
     *
     * 前置条件由领域层强制：G2 已批准 **且**该镜已选定首帧——
     * 未选帧的镜头不得产生付费视频请求，这是 G2 存在的全部意义。
     */
    case 'video:generate': {
      const projectId = required('--project-id');
      const workspaceDir = resolve(required('--workspace'));
      const canvasCwd = resolve(option('--canvas-cwd') ?? required('--workspace'));
      const backendId = parseBackendId(option('--backend'));
      let generator: GenerationService;
      try {
        generator = new GenerationService(service, createGenerationBackend(backendId, { canvasCwd }));
      } catch (error) {
        throw new Error(`${labelForBackend(backendId)} 未接入：${error instanceof Error ? error.message : String(error)}`);
      }

      const project = service.getProject(projectId) as {
        shot_fields?: { shots?: Array<{ shot_id: string; duration_ms: number; camera_move?: unknown }> } | null;
        selections?: Array<{ shot_id: string; candidate_id: string }>;
        candidates?: Array<{ candidate_id: string; artifact_id: string }>;
        sources?: Array<{ relative_path: string }>;
      };
      const shots = project.shot_fields?.shots ?? [];
      if (shots.length === 0) throw new Error('请先生成或录入逐镜字段表');

      // 首帧文件路径存在 Artifact metadata 里（相对 workspace）
      const artifactFrame = new Map(
        (service.listArtifacts() as Array<{ artifact_id: string; metadata: { frame_path_relative?: string } | null }>)
          .map((artifact) => [artifact.artifact_id, artifact.metadata?.frame_path_relative]),
      );
      const candidateArtifact = new Map((project.candidates ?? []).map((item) => [item.candidate_id, item.artifact_id]));
      const selected = new Map((project.selections ?? []).map((item) => [item.shot_id, item.candidate_id]));

      const only = option('--shots')?.split(',').map((item) => item.trim()).filter(Boolean);
      const videoShots = shots
        .filter((shot) => only === undefined || only.includes(shot.shot_id))
        .flatMap((shot) => {
          const artifactId = candidateArtifact.get(selected.get(shot.shot_id) ?? '');
          const frame = artifactId === undefined ? undefined : artifactFrame.get(artifactId);
          if (!frame) return [];
          const seconds = Math.min(15, Math.max(4, Math.round(shot.duration_ms / 1000)));
          const move = typeof shot.camera_move === 'string' && shot.camera_move !== 'unknown' ? shot.camera_move : undefined;
          return [{
            shot_id: shot.shot_id,
            image_path_relative: frame,
            duration_seconds: seconds,
            ...(move === undefined ? {} : { prompt: move }),
          }];
        });
      if (videoShots.length === 0) throw new Error('没有可用于生成的镜头（需要已选定首帧）');

      /**
       * 画幅必须跟着参考片走。模型默认 16:9，竖屏参考片会因此产出横屏片段；
       * 省略时服务层退到 `adaptive`（跟随首帧），但我们有参考片的真实画幅，
       * 优先用那个——首帧本身可能是 1:1 生成出来的，不能当真值。
       */
      const ratio = option('--ratio') ?? await referenceRatio(kernel, workspaceDir, project.sources?.[0]?.relative_path);
      const outcome = await generator.generateShotVideos({
        projectId,
        expectedRevision: Number(required('--revision')),
        canvasCwd,
        workspaceDir,
        shots: videoShots,
        model: required('--model'),
        ...(option('--resolution') === undefined ? {} : { resolution: option('--resolution')! }),
        ...(ratio === undefined ? {} : { ratio }),
        ...(option('--cost-cents') === undefined ? {} : { estimatedCostCents: Number(option('--cost-cents')) }),
        ...(option('--actual-cents') === undefined ? {} : { actualCostCents: Number(option('--actual-cents')) }),
        actor: option('--actor') ?? 'user:cli',
      });
      output(outcome);
      if (outcome.failures.length > 0) process.exitCode = 5;
      break;
    }
    /**
     * 登记参考视频（S0）。
     *
     * 会先把文件复制进项目 workspace，再按项目内的相对路径登记——
     * 领域事实里因此只有相对路径与内容哈希，没有开发机目录。
     */
    case 'source:register': {
      const file = resolve(required('--file'));
      const workspace = resolve(required('--workspace'));
      const relative = option('--as') ?? `sources/${basename(file)}`;
      const target = join(workspace, relative);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
      const bytes = statSync(target).size;
      const contentHash = `sha256:${createHash('sha256').update(readFileSync(target)).digest('hex')}`;
      output(service.execute({
        command_id: option('--command-id') ?? randomUUID(),
        actor: option('--actor') ?? 'user:cli',
        type: 'source.register',
        project_id: required('--project-id'),
        expected_revision: Number(required('--revision')),
        payload: {
          relative_path: relative,
          content_hash: contentHash,
          bytes,
          media_type: option('--media-type') ?? 'video/mp4',
        },
      }));
      break;
    }
    /**
     * 从参考视频抽出每个镜头的首帧，登记为首帧候选。
     *
     * 抽帧本地完成，因此这条命令不需要任何 Provider 账号。
     */
    case 'kernel:candidates': {
      if (!kernel) throw new Error(`前置内核未接入：${kernelUnavailable ?? '未知原因'}`);
      const projectId = required('--project-id');
      const project = service.getProject(projectId) as {
        shot_fields?: { shots?: Array<{ shot_id: string; t0_ms: number }> } | null;
      };
      const shots = project.shot_fields?.shots ?? [];
      if (shots.length === 0) throw new Error('请先生成或录入逐镜字段表');
      output(await kernel.extractShotCandidates({
        projectId,
        expectedRevision: Number(required('--revision')),
        mediaPath: required('--media'),
        workspaceDir: resolve(required('--workspace')),
        shots: shots.map((shot) => ({ shot_id: shot.shot_id, t0_ms: shot.t0_ms })),
        actor: option('--actor') ?? 'user:cli',
      }));
      break;
    }
    /**
     * 分析参考视频并播种拆解草稿：probe + boundaries → 七字段表。
     * 全程本地、不花钱；--no-seed 只分析不写字段表。
     */
    case 'kernel:analyze': {
      if (!kernel) throw new Error(`前置内核未接入：${kernelUnavailable ?? '未知原因'}`);
      const base = {
        projectId: required('--project-id'),
        expectedRevision: Number(required('--revision')),
        mediaPath: required('--media'),
        workspaceDir: resolve(required('--workspace')),
        actor: option('--actor') ?? 'user:cli',
      };
      if (process.argv.includes('--no-seed')) {
        output(await kernel.analyzeSource(base));
      } else {
        output(await kernel.analyzeAndSeed(base));
      }
      break;
    }
    /** 使用 前置内核 官方 transcribe 生成词级时间戳；Provider/费用由 Runtime Profile 决定。 */
    case 'kernel:transcribe': {
      if (!kernel) throw new Error(`前置内核未接入：${kernelUnavailable ?? '未知原因'}`);
      const outcome = await kernel.transcribeSource({
        projectId: required('--project-id'),
        expectedRevision: Number(required('--revision')),
        mediaPath: required('--media'),
        workspaceDir: resolve(required('--workspace')),
        language: required('--language'),
        executionConfirmed: process.argv.includes('--confirm-execution'),
        actor: option('--actor') ?? 'user:cli',
        ...(option('--runtime-profile') === undefined ? {} : { runtimeProfile: option('--runtime-profile')! }),
      });
      output(outcome);
      if (!outcome.executed) process.exitCode = 5;
      break;
    }
    /**
     * 前置 agent：校验一个 Source。
     * 与桌面端、本地 API 走的是同一条「登记 → 执行 → 回填」链路，
     * 因此三条入口产生的项目事实完全一致。
     */
    case 'kernel:check': {
      if (!kernel) throw new Error(`前置内核未接入：${kernelUnavailable ?? '未知原因'}`);
      const outcome = await kernel.checkSource({
        projectId: required('--project-id'),
        expectedRevision: Number(required('--revision')),
        sourcePath: required('--source'),
        workspaceDir: resolve(required('--workspace')),
        actor: option('--actor') ?? 'user:cli',
        ...(option('--package-root') === undefined ? {} : { packageRoot: resolve(option('--package-root')!) }),
      });
      output(outcome);
      if (!outcome.executed) process.exitCode = 5;
      break;
    }
    /**
     * 前置 agent：规划一个 Run。
     * 解析目标与能力需求，但不提交执行——用户可以在花钱之前先看清要动用什么能力。
     */
    case 'kernel:plan': {
      if (!kernel) throw new Error(`前置内核未接入：${kernelUnavailable ?? '未知原因'}`);
      const outcome = await kernel.planRun({
        projectId: required('--project-id'),
        expectedRevision: Number(required('--revision')),
        sourcePath: required('--source'),
        workspaceDir: resolve(required('--workspace')),
        actor: option('--actor') ?? 'user:cli',
        ...(option('--package-root') === undefined ? {} : { packageRoot: resolve(option('--package-root')!) }),
      });
      output(outcome);
      if (!outcome.executed) process.exitCode = 5;
      break;
    }
    /**
     * 前置 agent：提交一次构建。
     * 默认提交后即返回（由后台 Worker 继续），因此这个命令本身是快的；
     * 加 --follow 才会等到出结果，用于需要一次看完全过程的场景。
     */
    case 'kernel:build': {
      if (!kernel) throw new Error(`前置内核未接入：${kernelUnavailable ?? '未知原因'}`);
      const outcome = await kernel.submitBuild({
        projectId: required('--project-id'),
        expectedRevision: Number(required('--revision')),
        sourcePath: required('--source'),
        workspaceDir: resolve(required('--workspace')),
        actor: option('--actor') ?? 'user:cli',
        ...(option('--package-root') === undefined ? {} : { packageRoot: resolve(option('--package-root')!) }),
        ...(option('--runtime-profile') === undefined ? {} : { runtimeProfile: option('--runtime-profile')! }),
        ...(process.argv.includes('--follow') ? { follow: true } : {}),
      });
      output(outcome);
      if (!outcome.executed) process.exitCode = 5;
      break;
    }
    case 'kernel:status': {
      if (!kernel) throw new Error(`前置内核未接入：${kernelUnavailable ?? '未知原因'}`);
      const status = await kernel.buildStatus(
        required('--build-id'),
        resolve(required('--workspace')),
        option('--runtime-profile'),
      );
      output(status ?? { build: null, note: '该 build id 在此 workspace 下不存在' });
      if (status === null) process.exitCode = 5;
      break;
    }
    case 'kernel:inspect': {
      if (!kernel) throw new Error(`前置内核未接入：${kernelUnavailable ?? '未知原因'}`);
      output(await kernel.inspectBuild(required('--build-id'), resolve(required('--workspace')), option('--output')));
      break;
    }
    case 'kernel:get': {
      if (!kernel) throw new Error(`前置内核未接入：${kernelUnavailable ?? '未知原因'}`);
      output(await kernel.exportOutput(
        required('--build-id'),
        required('--output'),
        resolve(required('--to')),
        resolve(required('--workspace')),
      ));
      break;
    }
    case 'command': {
      const file = required('--file');
      output(service.execute(JSON.parse(readFileSync(resolve(file), 'utf8'))));
      break;
    }
    /*
      能力边界声明（CLI-006）。它替代了原来那份手写的帮助文本——
      手写的那份**没有约束**：新加一个命令忘了写进去，用户按帮助用就会漏掉它。
      现在清单是数据，测试会拿它和下面的 `case` 列表逐条比对（对不上就红）。
    */
    case 'capabilities': {
      output({
        schema: 'xqtv.cli-capabilities@1',
        cli: 'qiyin',
        commands: CLI_COMMANDS,
        limits: CLI_LIMITS,
        error_codes: CLI_ERROR_CODES,
      });
      break;
    }
    /*
      对账（CLI-002）。脚本作者最想问的那句话是"我上次发出去的付费请求
      现在怎么样了"——这条命令回答它：在飞的有哪些、预算台账对不对得上、
      每条该做什么。**只读**：释放预留要另发命令，它不替用户做决定。
    */
    case 'reconcile': {
      output(service.reconcileProject(required('--project-id')));
      break;
    }
    /*
      未知命令**不是成功**。

      以前这里输出一份帮助就从 `default` 走了，退出码 0——脚本里 `set -e`
      抓不到，链子会带着"一半成功"的状态往下跑。矩阵对 CLI-006 的第一条
      验收就是「越界命令返回稳定错误码率 100%」，所以要的是一个**稳定的码**
      加一个非零退出码：`CLI_UNKNOWN_COMMAND` / 2。
    */
    default: {
      output(unknownCommandResponse(action ?? null));
      process.exitCode = 2;
      break;
    }
  }
}

main().catch((error: unknown) => {
  const result = toPublicError(error);
  output(result.body);
  process.exitCode = result.statusCode === 409 ? 3 : result.statusCode === 403 ? 4 : 2;
});

