import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './database.js';
import {
  commandSchema,
  COMMAND_TYPES,
  FILM_TRANSITIONS,
  GATE_NAMES,
  IMPLEMENTED_GATES,
  SHOT_FIELD_UNKNOWN,
  TRANSITION_DIRECTIONS,
  validateSubjectProfile,
  type DomainCommand,
  type DomainEvent,
  type GateName,
  type ResultEnvelope,
  type ShotField,
  type SubjectProfile,
} from '@qiyin/contracts';
import { spatialDigestInput, validateSpatialPlan } from '@qiyin/spatial-control';
import { DomainError, assertDomain } from './errors.js';

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  revision: number;
  state: string;
  max_budget_cents: number;
  reserved_budget_cents: number;
  rights_confirmed: number;
  /** 回收站标记：NULL = 正常项目；有值 = 移入回收站的时间戳 */
  deleted_at: string | null;
  /** 项目文件夹；NULL = 未分组。文件夹只做整理，不属于项目事实 */
  folder_id: string | null;
  /**
   * 成片的播放策略；NULL 表示从没设过，读的时候按 `hold` 处理。
   *
   * 存文案而不是布尔：以后要在 hold / stretch 之外再加一种（比如 loop），
   * 布尔就得改列。这一列是「用户对成片形态的选择」，属于项目事实。
   */
  film_playback: string | null;
  /** 镜头之间怎么换：NULL = 硬切 */
  film_transition: string | null;
  /** 方向性转场的方向：NULL = 左 */
  film_transition_direction: string | null;
  created_at: string;
  updated_at: string;
}

interface CommandRow { fingerprint: string; result_json: string }

/** 悬空多久算"该处理了"（秒）。出图通常几十秒到几分钟，图生视频更久一点。 */
export const RECONCILE_STALE_SECONDS = 15 * 60;

/** 对账里的一条在飞意图（提交了、还没有结果）。 */
export interface ReconcileInFlight {
  intent_id: string;
  kind: 'image' | 'video';
  shot_id: string;
  model: string;
  estimated_cost_cents: number;
  /** 从提交到现在过了多久 */
  age_seconds: number;
  created_at: string;
}

/**
 * 一条可执行的建议。

 * `intent_id` 为空表示这条建议是关于**整个项目**的（例如预算台账漂移），
 * 而不是某一次请求。
 */
export interface ReconcileSuggestion {
  intent_id: string;
  kind: 'image' | 'video' | null;
  action: 'inspect' | 'release' | 'settle';
  reason: string;
}

export interface ReconcileReport {
  project_id: string;
  revision: number;
  budget: {
    max_cents: number;
    /** 台账上的预留总额 */
    reserved_cents: number;
    /** 所有未结算意图的预估之和 */
    in_flight_cents: number;
    /** 前者减后者。不为 0 就是漂移，那是钱的事。 */
    drift_cents: number;
    consistent: boolean;
  };
  in_flight: ReconcileInFlight[];
  suggestions: ReconcileSuggestion[];
}
interface ShotFieldsRow { fields_revision: number; breakdown_revision: number; shots_json: string }
interface GateRow { gate: string; status: string; approved_project_revision: number; approved_fields_revision: number | null; approved_budget_cents: number | null }

/** 闸门全序。直接复用契约层的定义，避免领域层与契约层各写一遍。 */
export const GATE_ORDER = GATE_NAMES;

/**
 * 彻底删除一个项目时要清理的子表。
 *
 * 顺序是"先删引用别人的、再删被引用的"：`selections` 引用候选，候选又引用
 * 镜头表，从下往上删才不会撞外键。清单里每一张表的 `project_id` 都是直连，
 * 所以其实不存在跨表外键依赖，但保持这个顺序能避免将来加表时想当然地乱放。
 *
 * 有两张表**故意不在**这里：
 *   · `artifacts` —— 全局内容寻址（主键是内容哈希），跨项目共享，删了会伤到别人；
 *   · `registered_subjects` —— 同理，主体登记是全局的，不属于某一个项目。
 */
/**
 * 结清一次生成意图时的账目口径（图片与视频共用）。
 *
 * 实际花费只在拿到人民币金额时才写：供应商报积分（图像生成服务）或什么都不报（小QTV）时留空。
 * 以前这里会把"预估成本"顶上来当实际花费——账本里那条"实际花费"于是成了谁也没报过的
 * 数字，单位还是错的。供应商原样报了什么，走 provider_cost_* 两个字段记下来。
 *
 * 实际未知时不动预留：预留的意思是"这笔钱先占住"，结清时按实际花费退回差额；
 * 实际花费不知道就退不了——能证明省了钱才退，证不了就继续占着。
 * 按预估退等于替供应商做主，退多退少都会让预算上限失真。
 */
function settleCostFields(
  payload: {
    actual_cost_cents?: number | undefined;
    provider_cost?: { unit: 'credit' | 'cent'; amount: number } | undefined;
    release_reservation?: { reason: string } | undefined;
  },
  estimatedCostCents: number,
): {
  actualCents: number | null;
  providerCostUnit: string | null;
  providerCostAmount: number | null;
  releasedReason: string | null;
  delta: number;
  releasedCents: number;
} {
  const actualCents = payload.actual_cost_cents ?? null;
  /*
    三种情况，互不冒充（契约里那段注释是同一份口径）：

      · 拿到人民币金额      → 按它算差额，多退少补；
      · 带 release_reservation → 调用方**断言**这笔没花钱，全额释放；
      · 什么都没有          → 预留原地不动（charged = estimated，delta = 0）。

    第三种曾经被写成"actual_cost_cents: 0"，那是把"不知道"写成了"确定是 0"。
    证不了省了钱就继续占着——预算上限宁可保守，也不要虚增可用额度。
  */
  const releasedReason = payload.release_reservation?.reason ?? null;
  const chargedCents = actualCents ?? (releasedReason === null ? estimatedCostCents : 0);
  return {
    actualCents,
    providerCostUnit: payload.provider_cost?.unit ?? null,
    providerCostAmount: payload.provider_cost?.amount ?? null,
    releasedReason,
    delta: chargedCents - estimatedCostCents,
    releasedCents: Math.max(0, estimatedCostCents - chargedCents),
  };
}

export const PROJECT_CHILD_TABLES: readonly string[] = [
  'selections',
  'image_candidates',
  'video_intents',
  'video_generation_intents',
  'generation_checkpoints',
  'image_generation_intents',
  /* 项目级素材生成意图（主体补全 / 音频生成）。**必须在这里**：
     它带 project_id，漏了的话 `project.purge` 会撞外键、报一句"内部错误"（踩过一次）。 */
  'asset_generation_intents',
  'prompt_bundles',
  'canvas_documents',
  'timeline_documents',
  'shot_fields',
  'spatial_plans',
  'kernel_tasks',
  'source_assets',
  'eval_reports',
  'repair_plans',
  'gate_decisions',
  /*
    `asset_ratings` 是资产评级（AQ 那一轮加的），**一度漏在这份清单外面**。
    后果不是"评级没删掉"这么轻：只要有任何一个资产被打过分，
    最后那句 `DELETE FROM projects` 就会撞外键，整个彻底删除失败，
    而界面上一句"内部错误"看不出所以然——删不掉的正是用户以为已经删干净的项目。
    现在有一支结构性测试盯着这份清单（测试名里带"带 project_id 的表"）。
  */
  'asset_ratings',
  /* 逐镜播放策略覆盖（BS 之后那一轮加的）：漏在这里 = 彻底删除会撞外键 */
  'shot_playback',
  /* 事件与幂等记录不是外键关联，但按项目清理才不会把库越用越大 */
  'events',
  'processed_commands',
] as const;

/** 闸门当前状态：`null` 表示尚未做出任何决策。 */
export type GateStatus = string | null;

/** 一条闸门决策记录（append-only 审计历史的元素）。 */
export interface GateSnapshot {
  gate: string;
  status: string;
  approved_project_revision: number;
  approved_fields_revision: number | null;
  approved_budget_cents: number | null;
  created_at: string;
}

const VERSION = '0.1.0';

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function json(value: unknown): string { return JSON.stringify(value); }

/**
 * 从产物的 metadata 里取出它在工作目录里的相对路径。
 *
 * 两个键都要认，这是仓库既有约定（不是这里发明的）：
 *   · `artifact_path_relative` —— 上传/登记这类走主进程的产物
 *   · `frame_path_relative`    —— 生成服务发布的候选图/片段
 * 别处（主进程的 `artifactPathRelativeTo`、生成服务的 resolver）都是两个都认。
 *
 * 取不出来就返回 null：坏 metadata 不该让"删记录"这件事做不成，
 * 主进程那边对 null 的处理是"不去删文件"，界面会如实说磁盘上还留着。
 */
function artifactRelativePathOf(metadataJson: string | null): string | null {
  return artifactRelativePathFor(metadataJson, undefined);
}

/**
 * 取某个产物在**指定项目**里的相对路径。

 * 为什么需要 projectId 这一维：产物身份是内容哈希（`artifact_id`），
 * 同一份文件被传到两个项目时，`artifacts` 表里**只有一行**——
 * 而磁盘上每个项目目录里各有一份副本。早先只记一条路径，于是：

 *   1. 项目 A 上传 → 记 `A/uploads/x.mp4`
 *   2. 项目 B 上传同一份 → **顶替**成 `B/uploads/y.mp4`
 *   3. 项目 B 被删（工作目录一起删）→ 记录悬空
 *   4. 项目 A 里引用同一产物的节点全部读不到文件（实测就是这个）

 * 修法是记一份 `project_copies`（项目 → 该项目目录里的副本）：
 * 顶替只发生在**同一个项目**内，跨项目各留各的。
 * 老数据没有这个键，就退回顶上那条路径——与从前一致，不会更糟。
 */
export function artifactRelativePathFor(metadataJson: string | null, projectId: string | undefined): string | null {
  if (metadataJson === null) return null;
  try {
    return resolveArtifactPath(JSON.parse(metadataJson), projectId);
  } catch {
    return null;
  }
}

/**
 * 同上，但吃**已经解析过的** metadata 对象。

 * 为什么要两个入口：`listArtifacts()` 返回的是解析后的对象（主进程用它），
 * 而领域层内部手里是 JSON 字符串。两个入口共用同一套判据，
 * 免得"读记录"和"用记录"两边对 project_copies 的理解漂开。
 */
export function resolveArtifactPath(metadata: unknown, projectId: string | undefined): string | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = metadata as {
    artifact_path_relative?: unknown;
    frame_path_relative?: unknown;
    project_copies?: unknown;
  };
  /* ① 先看这个项目自己那份副本 */
  if (projectId !== undefined && projectId !== '') {
    const copies = parsed.project_copies;
    if (copies !== null && typeof copies === 'object' && !Array.isArray(copies)) {
      const mine = (copies as Record<string, unknown>)[projectId];
      if (typeof mine === 'string' && mine !== '') return mine;
    }
  }
  /* ② 退回顶上那条（老数据走这里） */
  if (typeof parsed.artifact_path_relative === 'string' && parsed.artifact_path_relative !== '') {
    return parsed.artifact_path_relative;
  }
  if (typeof parsed.frame_path_relative === 'string' && parsed.frame_path_relative !== '') {
    return parsed.frame_path_relative;
  }
  return null;
}

/**
 * 把"这份产物在这个项目里的副本"并进 metadata。

 * 位置键沿用既有的两个名字（`artifact_path_relative` / `frame_path_relative`），
 * 另起 `project_copies` 记每个项目那一份；顶层仍写当前这次发布的路径，
 * 于是**没传 projectId 的老调用方读到的还是最新那份**——行为不变。
 */
function withProjectCopy(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const projectId = metadata.project_id;
  if (typeof projectId !== 'string' || projectId === '') return metadata;
  const path = typeof metadata.artifact_path_relative === 'string' && metadata.artifact_path_relative !== ''
    ? metadata.artifact_path_relative
    : typeof metadata.frame_path_relative === 'string' && metadata.frame_path_relative !== ''
      ? metadata.frame_path_relative
      : '';
  if (path === '') return metadata;
  const previous = metadata.project_copies;
  const copies = previous !== null && typeof previous === 'object' && !Array.isArray(previous)
    ? { ...(previous as Record<string, string>) }
    : {};
  copies[projectId] = path;
  return { ...metadata, project_copies: copies };
}

/**
 * 反查"这条相对路径是哪个项目目录里的那一份"。

 * 用途只有一个：判断一次发布到底是不是**顶替**。
 * 同一个项目内换落点 = 真顶替，旧文件可以删；
 * 不同项目只是各存一份 = 不是顶替，谁都不该被删。
 */
function projectOwningCopy(metadataJson: string | null, relativePath: string): string | null {
  if (metadataJson === null) return null;
  try {
    const copies = (JSON.parse(metadataJson) as { project_copies?: unknown }).project_copies;
    if (copies === null || typeof copies !== 'object' || Array.isArray(copies)) return null;
    for (const [projectId, path] of Object.entries(copies as Record<string, unknown>)) {
      if (path === relativePath) return projectId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 判定疑似绝对路径：Windows 盘符、UNC 与 POSIX 根路径。
 * 领域协议只接受项目内的相对路径（架构 v2.3 §7.1）。
 */
function isAbsoluteLikePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//') || value.startsWith('/');
}

/**
 * 由边界候选生成七字段草稿。
 *
 * 镜头编号用 `shot-01` 这类两位序号：既与 小QTV 实测的命名一致，
 * 也保证同一份边界重复播种得到完全相同的 shot_id（可重放）。
 */
function buildSeedShots(
  boundaries: readonly { t0_ms: number; t1_ms: number; confidence?: number | undefined }[],
): ShotField[] {
  return boundaries.map((boundary, index) => ({
    shot_id: `shot-${String(index + 1).padStart(2, '0')}`,
    t0_ms: boundary.t0_ms,
    t1_ms: boundary.t1_ms,
    duration_ms: boundary.t1_ms - boundary.t0_ms,
    shot_size: SHOT_FIELD_UNKNOWN,
    camera_position: SHOT_FIELD_UNKNOWN,
    camera_move: SHOT_FIELD_UNKNOWN,
    lighting: SHOT_FIELD_UNKNOWN,
    sound: SHOT_FIELD_UNKNOWN,
    replacement: SHOT_FIELD_UNKNOWN,
    confidence: boundary.confidence ?? 0.5,
    source: 'model' as const,
    author: 'agent:frontkernel',
  }));
}

const PACKAGE_PROJECT_TABLES = [
  'events', 'shot_fields', 'canvas_documents', 'timeline_documents', 'gate_decisions', 'prompt_bundles', 'image_candidates', 'selections',
  'video_intents', 'spatial_plans', 'kernel_tasks', 'source_assets', 'eval_reports', 'repair_plans',
  'image_generation_intents', 'video_generation_intents', 'generation_checkpoints', 'asset_ratings', 'shot_playback',
] as const;

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quotedIdentifier(table)})`).all() as unknown as Array<{ name: string }>)
    .map((column) => column.name);
}

function insertRows(
  target: DatabaseSync,
  table: string,
  rows: readonly Record<string, unknown>[],
  options: { ignore?: boolean; omitSequence?: boolean } = {},
): void {
  if (rows.length === 0) return;
  const allowed = new Set(tableColumns(target, table));
  const columns = Object.keys(rows[0]!).filter((column) => allowed.has(column) && !(options.omitSequence && column === 'sequence'));
  if (columns.length === 0) return;
  const sql = `INSERT ${options.ignore ? 'OR IGNORE ' : ''}INTO ${quotedIdentifier(table)} (${columns.map(quotedIdentifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
  const statement = target.prepare(sql);
  for (const row of rows) statement.run(...columns.map((column) => row[column] as never));
}

function collectContentIds(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/sha256:[a-f0-9]{64}/g)) output.add(match[0]);
  } else if (Array.isArray(value)) {
    for (const item of value) collectContentIds(item, output);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectContentIds(item, output);
  }
}

export class ProjectService {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 某份产物"换了地方"时回调（同内容再次发布、落点变了）。
   *
   * 为什么要有这个钩子：`artifacts` 表是**内容寻址**的——同一份字节第二次被发布时
   * artifact_id 不变，但它的**落点**可能落在新一批目录里（生成、抽帧都会）。
   * 于是旧路径那份文件成了孤儿：记录指向新路径，旧文件谁也不认。
   * 真机收尾时就在 `frames/gen-…/` 里捡到过一个。
   *
   * 领域层**不碰磁盘**（这条分界一直都在），所以它只把"哪一份被顶替了"报出来；
   * 删文件由主进程做（它知道项目工作目录在哪）。
   */
  onArtifactSuperseded:
    | ((info: { artifactId: string; projectId: string | null; from: string; to: string }) => void)
    | undefined;

  execute(input: unknown): ResultEnvelope {
    /**
     * 先区分「这个命令还不存在」与「这个命令的输入不合法」。
     * 若直接交给 zod，未知的 type 只会得到一句「输入不符合契约」，
     * 调用方（UI / CLI / Agent）无从判断是数据填错了，还是功能根本还没接上。
     */
    const requestedType = (input as { type?: unknown } | null | undefined)?.type;
    if (typeof requestedType === 'string' && !(COMMAND_TYPES as readonly string[]).includes(requestedType)) {
      throw new DomainError('COMMAND_NOT_IMPLEMENTED', `该命令尚未实现：${requestedType}`, 501);
    }
    const command = commandSchema.parse(input) as DomainCommand;
    const fingerprint = hash(json(command));
    const existing = this.db.prepare('SELECT fingerprint, result_json FROM processed_commands WHERE command_id = ?').get(command.command_id) as unknown as CommandRow | undefined;
    if (existing) {
      assertDomain(existing.fingerprint === fingerprint, 'IDEMPOTENCY_KEY_REUSED', '同一 command_id 不得用于不同命令', 409);
      return { ...(JSON.parse(existing.result_json) as ResultEnvelope), replayed: true };
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.dispatch(command);
      this.db.prepare('INSERT INTO processed_commands(command_id, fingerprint, project_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(command.command_id, fingerprint, result.project_id, json(result), result.created_at);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private dispatch(command: DomainCommand): ResultEnvelope {
    switch (command.type) {
      case 'project.create': return this.createProject(command);
      case 'project.trash': return this.trashProject(command);
      case 'project.restore': return this.restoreProject(command);
      case 'project.purge': return this.purgeProject(command);
      case 'project.rename': return this.renameProject(command);
      case 'project.duplicate': return this.duplicateProject(command);
      case 'folder.create': return this.createFolder(command);
      case 'folder.delete': return this.deleteFolder(command);
      case 'folder.rename': return this.renameFolder(command);
      case 'project.move-to-folder': return this.moveProjectToFolder(command);
      case 'film.settings.set': return this.setFilmSettings(command);
      case 'shot.playback.set': return this.setShotPlayback(command);
      case 'provider.register': return this.registerProvider(command);
      case 'project.production.authorize': return this.authorizeProduction(command);
      case 'shot-fields.replace': return this.replaceShotFields(command);
      case 'canvas-document.replace': return this.replaceCanvasDocument(command);
      case 'timeline-document.replace': return this.replaceTimelineDocument(command);
      case 'gate.approve': return this.approveGate(command);
      case 'prompt.derive': return this.derivePrompt(command);
      case 'image-candidate.add': return this.addCandidate(command);
      case 'image-candidate.select': return this.selectCandidate(command);
      case 'image-candidate.remove': return this.removeCandidate(command);
      case 'video.request': return this.requestVideo(command);
      case 'subject.register': return this.registerSubject(command);
      case 'subject.profile.set': return this.setSubjectProfile(command);
      case 'subject.profile.remove': return this.removeSubjectProfile(command);
      case 'template.save': return this.setTemplate(command);
      case 'template.remove': return this.removeTemplate(command);
      case 'asset-generation.request': return this.requestAssetGeneration(command);
      case 'asset-generation.settle': return this.settleAssetGeneration(command);
      case 'artifact.publish': return this.publishArtifact(command);
      case 'artifact.delete': return this.deleteArtifact(command);
      case 'asset.rate': return this.rateAsset(command);
      case 'spatial-plan.set': return this.setSpatialPlan(command);
      case 'kernel.check': return this.requestKernelCheck(command);
      case 'kernel.plan': return this.requestKernelPlan(command);
      case 'kernel.build': return this.requestKernelBuild(command);
      case 'kernel.analyze': return this.requestKernelAnalyze(command);
      case 'kernel.transcribe': return this.requestKernelTranscribe(command);
      case 'kernel.result.record': return this.recordKernelResult(command);
      case 'source.register': return this.registerSource(command);
      case 'shot-fields.seed': return this.seedShotFields(command);
      case 'eval.record': return this.recordEvalReport(command);
      case 'repair.propose': return this.proposeRepairPlan(command);
      case 'repair.execute': return this.executeRepairPlan(command);
      case 'image-generation.request': return this.requestImageGeneration(command);
      case 'image-generation.reuse': return this.reuseImageGeneration(command);
      case 'image-generation.settle': return this.settleImageGeneration(command);
      case 'image-generation.release-reservation': return this.releaseReservation(command, 'image');
      case 'video-generation.request': return this.requestVideoGeneration(command);
      case 'video-generation.reuse': return this.reuseVideoGeneration(command);
      case 'video-generation.settle': return this.settleVideoGeneration(command);
      case 'video-generation.release-reservation': return this.releaseReservation(command, 'video');
    }
  }

  private envelope(command: DomainCommand, projectId: string | null, revision: number | null, payload: unknown): ResultEnvelope {
    return {
      schema: 'replica.command-result@1',
      command_id: command.command_id,
      correlation_id: command.correlation_id ?? command.command_id,
      project_id: projectId,
      project_revision: revision,
      created_at: now(),
      producer: { name: 'project-service', version: VERSION },
      payload,
    };
  }

  private createProject(command: Extract<DomainCommand, { type: 'project.create' }>): ResultEnvelope {
    const id = randomUUID();
    const createdAt = now();
    const state = 'EMPTY';
    /*
      名字去掉首尾空白再存。

      契约只保证长度 ≥1，`   `（三个空格）能过契约；存下来之后，项目卡上是一块空白，
      而回收站的"彻底删除"要求逐字输入项目名——用户根本不知道该输什么。
      改名那条命令用的是同一套规则，所以这里也必须是同一套。
    */
    const name = command.payload.name.trim();
    let workspaceId = command.payload.workspace_id;
    if (workspaceId) {
      const workspace = this.db.prepare('SELECT id FROM workspaces WHERE id=? AND deleted_at IS NULL').get(workspaceId);
      assertDomain(workspace, 'WORKSPACE_NOT_FOUND', '工作区不存在', 404);
      this.db.prepare('UPDATE workspaces SET revision=revision+1, updated_at=? WHERE id=?').run(createdAt, workspaceId);
    } else {
      workspaceId = randomUUID();
      const workspaceName = command.payload.workspace_name?.trim() || name;
      this.db.prepare('INSERT INTO workspaces(id, name, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
        .run(workspaceId, workspaceName, createdAt, createdAt);
    }
    this.db.prepare(`INSERT INTO projects(id, workspace_id, name, revision, state, max_budget_cents, rights_confirmed, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(id, workspaceId, name, state, command.payload.max_budget_cents, command.payload.rights_confirmed ? 1 : 0, createdAt, createdAt);
    this.event(id, 1, 'project.created', command, { workspace_id: workspaceId, name, state, max_budget_cents: command.payload.max_budget_cents, rights_confirmed: command.payload.rights_confirmed });
    return this.envelope(command, id, 1, { workspace_id: workspaceId, project_id: id, name, state });
  }

  /**
   * 设成片的播放策略（见契约里的 `film.settings.set`）。
   *
   * 只改一个字段，**状态与 revision 照旧前进**：这是项目事实的一部分，
   * 别的窗口靠 revision 决定要不要刷新（和改名同一条理由）。
   * 不做"值与现在相同就拒绝"——`set` 是幂等的设定动作，
   * 而来回切换两次（hold → stretch → hold）在界面上是很正常的操作。
   */
  private setFilmSettings(command: Extract<DomainCommand, { type: 'film.settings.set' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const timestamp = now();
    const revision = project.revision + 1;
    /*
      部分更新：只动调用方真的给了的字段。

      界面上这两项是两个独立的下拉，用户改一个不该把另一个重置回默认值——
      整体替换的写法迟早会咬人（改转场顺手把播放策略打回 hold）。
    */
    const previousPlayback = project.film_playback === 'stretch' ? 'stretch' : 'hold';
    const previousTransition = (FILM_TRANSITIONS as readonly string[]).includes(project.film_transition ?? '')
      ? (project.film_transition as string)
      : 'cut';
    const previousDirection = (TRANSITION_DIRECTIONS as readonly string[]).includes(project.film_transition_direction ?? '')
      ? (project.film_transition_direction as string)
      : 'left';
    this.db.prepare(`UPDATE projects SET
        film_playback = COALESCE(?, film_playback),
        film_transition = COALESCE(?, film_transition),
        film_transition_direction = COALESCE(?, film_transition_direction),
        revision=?, updated_at=? WHERE id=?`)
      .run(
        command.payload.playback ?? null,
        command.payload.transition ?? null,
        command.payload.direction ?? null,
        revision, timestamp, project.id,
      );
    this.event(project.id, revision, 'film.settings.changed', command, {
      playback: command.payload.playback ?? previousPlayback,
      transition: command.payload.transition ?? previousTransition,
      direction: command.payload.direction ?? previousDirection,
      previous_playback: previousPlayback,
      previous_transition: previousTransition,
      previous_direction: previousDirection,
    });
    return this.envelope(command, project.id, revision, {
      playback: command.payload.playback ?? previousPlayback,
      transition: command.payload.transition ?? previousTransition,
      direction: command.payload.direction ?? previousDirection,
    });
  }

  /**
   * 改**某一个镜头**的播放策略（或撤掉覆盖）。
   *
   * 三条与项目级设置一致、两条不同：
   *   一致：幂等（重复设同值也接受）、revision 前进、事件留旧值；
   *   不同：① 撤销覆盖（`inherit`）是**删行**而不是写一个值——
   *          "没设过"与"显式跟随"是同一件事，存两遍会让读取方多判一次；
   *        ② 镜头必须存在（不然会留下一条永远不生效的覆盖）。
   */
  private setShotPlayback(command: Extract<DomainCommand, { type: 'shot.playback.set' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const fields = this.shotFields(project.id);
    assertDomain(fields, 'SHOT_FIELDS_REQUIRED', '缺少 ShotFields');
    const shots = JSON.parse(fields.shots_json) as ShotField[];
    assertDomain(shots.some((shot) => shot.shot_id === command.payload.shot_id), 'SHOT_NOT_FOUND', '镜头不存在', 404);

    const previous = this.db.prepare('SELECT playback FROM shot_playback WHERE project_id=? AND shot_id=?')
      .get(project.id, command.payload.shot_id) as unknown as { playback: string } | undefined;
    const timestamp = now();
    if (command.payload.playback === 'inherit') {
      this.db.prepare('DELETE FROM shot_playback WHERE project_id=? AND shot_id=?').run(project.id, command.payload.shot_id);
    } else {
      this.db.prepare(`INSERT INTO shot_playback(project_id, shot_id, playback, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, shot_id) DO UPDATE SET playback=excluded.playback, updated_at=excluded.updated_at`)
        .run(project.id, command.payload.shot_id, command.payload.playback, timestamp);
    }

    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, project.state, timestamp);
    this.event(project.id, revision, 'shot.playback.changed', command, {
      shot_id: command.payload.shot_id,
      playback: command.payload.playback,
      /* 旧值：没覆盖过时如实写 null，而不是编一个 'inherit' 混淆"从没设过" */
      previous: previous?.playback ?? null,
    });
    return this.envelope(command, project.id, revision, {
      shot_id: command.payload.shot_id,
      playback: command.payload.playback,
    });
  }

  /**
   * 改项目名（小QTV 项目卡片的「更多」里就有这一项）。
   *
   * 只改名字：状态、闸门、产物、预算一律不动，但 revision 照样前进——
   * 别的窗口靠 revision 刷新列表，不涨 revision 的话它们会一直显示旧名字。
   * 事件里同时记下**旧名与新名**：改名是可追溯的，事后要能回答"它原来叫什么"。
   */
  private renameProject(command: Extract<DomainCommand, { type: 'project.rename' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const name = command.payload.name.trim();
    assertDomain(name.length > 0, 'PROJECT_NAME_REQUIRED', '项目名不能只有空白', 422);
    assertDomain(name !== project.name, 'PROJECT_NAME_UNCHANGED', '新名字与现在一样，没有改动', 409);

    const timestamp = now();
    const revision = project.revision + 1;
    this.db.prepare('UPDATE projects SET name=?, revision=?, updated_at=? WHERE id=?')
      .run(name, revision, timestamp, project.id);
    this.event(project.id, revision, 'project.renamed', command, { from: project.name, to: name });
    return this.envelope(command, project.id, revision, { name });
  }

  /**
   * 复制项目：复制项目事实、分镜、素材引用、主体关联、候选、修复与生成历史。
   *
   * 产物是内容寻址的全局资源，因此不复制文件本身，而是为副本创建一条新的
   * artifact 记录，并在 metadata 中保留 project_copies，后续接入文件复制时
   * 可以按同一套路径规则补上磁盘副本。
   */
  private duplicateProject(command: Extract<DomainCommand, { type: 'project.duplicate' }>): ResultEnvelope {
    const source = this.projectForWrite(command.project_id, command.expected_revision);
    const id = command.payload.target_project_id ?? randomUUID();
    const timestamp = now();
    const baseName = command.payload.name?.trim() || `${source.name} · 副本`;
    this.db.prepare(
      `INSERT INTO projects(id, workspace_id, name, revision, state, max_budget_cents, reserved_budget_cents, rights_confirmed, folder_id, deleted_at, created_at, updated_at,
        film_playback, film_transition, film_transition_direction)
       VALUES (?, ?, ?, 1, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      source.workspace_id,
      baseName,
      source.state,
      source.max_budget_cents,
      source.rights_confirmed,
      timestamp,
      timestamp,
      source.film_playback,
      source.film_transition,
      source.film_transition_direction,
    );

    const artifactMap = new Map<string, string>();
    const artifactRows = this.db
      .prepare('SELECT artifact_id, media_type, bytes, metadata_json, status, created_at FROM artifacts WHERE metadata_json IS NOT NULL')
      .all() as unknown as Array<{ artifact_id: string; media_type: string; bytes: number; metadata_json: string | null; status: string; created_at: string }>;
    for (const row of artifactRows) {
      if (row.metadata_json === null) continue;
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const owner = metadata.project_id;
      const copies = metadata.project_copies;
      const copiesRecord = copies !== null && typeof copies === 'object' && !Array.isArray(copies) ? copies as Record<string, unknown> : {};
      const ownedBySource = owner === source.id || typeof copiesRecord[source.id] === 'string';
      if (!ownedBySource) continue;
      const newArtifactId = `sha256:${createHash('sha256').update(`${row.artifact_id}:${id}`).digest('hex')}`;
      const relativePath = typeof metadata.artifact_path_relative === 'string'
        ? metadata.artifact_path_relative
        : typeof metadata.frame_path_relative === 'string'
          ? metadata.frame_path_relative
          : null;
      const nextMetadata: Record<string, unknown> = {
        ...metadata,
        project_id: id,
        project_copies: {
          ...copiesRecord,
          [id]: relativePath ?? (typeof copiesRecord[source.id] === 'string' ? copiesRecord[source.id] : ''),
        },
      };
      this.db.prepare(
        'INSERT INTO artifacts(artifact_id, media_type, bytes, metadata_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(newArtifactId, row.media_type, row.bytes, json(nextMetadata), row.status, row.created_at);
      artifactMap.set(row.artifact_id, newArtifactId);
    }

    const regenerate = new Set([
      'decision_id', 'bundle_id', 'intent_id', 'task_id', 'asset_id', 'report_id', 'plan_id',
    ]);
    const projectTables = [
      'shot_fields',
      'gate_decisions',
      'prompt_bundles',
      'image_candidates',
      'selections',
      'video_intents',
      'asset_generation_intents',
      'spatial_plans',
      'kernel_tasks',
      'source_assets',
      'eval_reports',
      'repair_plans',
      'image_generation_intents',
      'video_generation_intents',
      'generation_checkpoints',
      'asset_ratings',
      'shot_playback',
    ];
    let copiedRows = 0;
    for (const table of projectTables) {
      const tableColumns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>)
        .map(column => column.name)
        .filter(column => !(table === 'gate_decisions' && column === 'sequence'));
      const rows = this.db.prepare(`SELECT * FROM ${table} WHERE project_id=?`).all(source.id) as unknown as Array<Record<string, unknown>>;
      if (rows.length === 0) continue;
      const insertColumns = tableColumns.filter(column => column !== 'sequence');
      const placeholders = insertColumns.map(() => '?').join(', ');
      const insert = this.db.prepare(`INSERT INTO ${table}(${insertColumns.join(', ')}) VALUES (${placeholders})`);
      for (const row of rows) {
        const values = insertColumns.map((column) => {
          if (column === 'project_id') return id;
          if (regenerate.has(column)) return randomUUID();
          if (['reference_artifact', 'result_artifact', 'clip_artifact_id', 'artifact_id'].includes(column)) {
            const value = row[column];
            return typeof value === 'string' ? artifactMap.get(value) ?? value : value;
          }
          return row[column];
        });
        insert.run(...(values as never[]));
        copiedRows += 1;
      }
    }

    this.event(id, 1, 'project.duplicated', command, {
      source_project_id: source.id,
      name: baseName,
      copied_rows: copiedRows,
      copied_artifacts: artifactMap.size,
    });
    return this.envelope(command, id, 1, {
      project_id: id,
      source_project_id: source.id,
      name: baseName,
      copied_rows: copiedRows,
      copied_artifacts: artifactMap.size,
    });
  }

  /**
   * 移入回收站（软删除）。
   *
   * 只改一个 `deleted_at`，**不动任何子表**。这一点很重要：
   * 回收站里的项目必须能原样恢复，所以这一步不能"顺手清理一下产物"。
   *
   * 代价是磁盘上的产物文件不会因为进回收站而释放——这是有意的取舍：
   * 用户以为"删了但还能恢复"的时候，如果中间某一步真的把文件清了，
   * 恢复回来就是一个空壳项目。要释放空间就走 `project.purge`。
   */
  private trashProject(command: Extract<DomainCommand, { type: 'project.trash' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    assertDomain(project.deleted_at === null, 'PROJECT_ALREADY_TRASHED', '项目已经在回收站里', 409);
    const timestamp = now();
    const revision = project.revision + 1;
    this.db.prepare('UPDATE projects SET revision=?, deleted_at=?, updated_at=? WHERE id=?')
      .run(revision, timestamp, timestamp, project.id);
    /*
      事件写在 trash 之后仍然可读：软删除不动 events 表。
      记录条目本身也有用——"这个项目是什么时候被移走的、谁移的"，
      在回收站列表里就要显示这个时间。
    */
    this.event(project.id, revision, 'project.trashed', command, { name: project.name, deleted_at: timestamp });
    return this.envelope(command, project.id, revision, { project_id: project.id, deleted_at: timestamp });
  }

  /**
   * 从回收站恢复。
   *
   * 这里没有走 `projectForWrite`：那个函数会拒绝已删除的项目（这是对的，
   * 其它写命令都该被拒绝），而恢复恰恰是要操作一个已删除的项目。
   */
  private restoreProject(command: Extract<DomainCommand, { type: 'project.restore' }>): ResultEnvelope {
    const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(command.project_id) as unknown as ProjectRow | undefined;
    assertDomain(project, 'PROJECT_NOT_FOUND', '项目不存在', 404);
    assertDomain(project.deleted_at !== null, 'PROJECT_NOT_TRASHED', '项目不在回收站里，无需恢复', 409);
    assertDomain(
      project.revision === command.expected_revision,
      'PROJECT_REVISION_CONFLICT',
      '项目 revision 冲突',
      409,
      { expected: command.expected_revision, actual: project.revision },
    );
    const timestamp = now();
    const revision = project.revision + 1;
    this.db.prepare('UPDATE projects SET revision=?, deleted_at=NULL, updated_at=? WHERE id=?')
      .run(revision, timestamp, project.id);
    this.event(project.id, revision, 'project.restored', command, { name: project.name });
    return this.envelope(command, project.id, revision, { project_id: project.id, deleted_at: null });
  }

  /**
   * 彻底删除。**这一步不可逆**，所以有两道独立的闸门：
   *
   *   ① 项目必须已在回收站里 —— 活跃项目即使名字输对了也删不掉；
   *   ② `confirm_name` 必须与项目名逐字一致 —— 在回收站里点一下不够。
   *
   * 两道都要，因为它们防的是不同的失误：①防"对着项目列表手滑"，
   * ②防"在回收站里选错了复选框"。任何一道单独存在时都有一种失误能穿过去。
   *
   * 子表按 `PROJECT_CHILD_TABLES` 逐张清理，而不是靠外键级联：
   * 这些外键当初就没写 `ON DELETE CASCADE`（当时没有删除语义），
   * 而现在补级联要改已有表结构。显式列出反而更好——删了什么一目了然，
   * 将来加了新表，忘记加进清单会立刻在测试里暴露（有外键就会报约束失败）。
   *
   * `artifacts` 不在清单里：它是**全局内容寻址**的，主键是内容哈希，
   * 一个新项目完全可能引用到同一个哈希。按项目删会破坏别的项目。
   */
  /**
   * 新建一个项目文件夹。
   *
   * 三条校验，每条都对应一种真实会遇到的输入：
   *   · 名字去掉首尾空白后不能为空（契约只保证长度 ≥1，`   ` 是能过契约的）；
   *   · 重名直接拒绝。重名文件夹在界面上是分不清的，
   *     而"我明明建了两个却只看到一个"比"建不了"更让人摸不着头脑。
   *
   * 长度上限**不在这里再判一次**：契约已经把 `name` 限制在 60 字符以内，
   * 再写一遍是够不到的死代码（实测：61 个字符在 zod 那一层就被拒了）。
   * 权威只留一份——这条与"工具层不重复实现领域门禁"是同一条规矩。
   */
  private createFolder(command: Extract<DomainCommand, { type: 'folder.create' }>): ResultEnvelope {
    const name = command.payload.name.trim();
    assertDomain(name.length > 0, 'FOLDER_NAME_REQUIRED', '文件夹名不能只有空白', 422);
    const existing = this.db.prepare('SELECT folder_id FROM folders WHERE name=?').get(name) as unknown as { folder_id: string } | undefined;
    assertDomain(existing === undefined, 'FOLDER_NAME_TAKEN', `已经有一个叫「${name}」的文件夹了`, 409);

    const folderId = randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO folders(folder_id, name, created_at) VALUES (?, ?, ?)').run(folderId, name, timestamp);
    /*
      文件夹不属于任何项目，所以这里没有项目事件可写。返回里给 null 的 project_id，
      调用方（界面 / CLI）据此知道"这条命令没有改动任何项目"。
    */
    return this.envelope(command, null, null, { folder_id: folderId, name });
  }

  /**
   * 改文件夹名。
   *
   * 规则与 `folder.create` 完全一致（去掉空白、不能空、不能与别的文件夹重名），
   * 只是重名检查要**排除自己**——否则"改个大小写"之类的操作会被自己挡住。
   */
  private renameFolder(command: Extract<DomainCommand, { type: 'folder.rename' }>): ResultEnvelope {
    const folder = this.db.prepare('SELECT folder_id, name FROM folders WHERE folder_id=?').get(command.payload.folder_id) as unknown as
      { folder_id: string; name: string } | undefined;
    assertDomain(folder, 'FOLDER_NOT_FOUND', '这个文件夹不存在（可能已经被删掉了）', 404);
    const name = command.payload.name.trim();
    assertDomain(name.length > 0, 'FOLDER_NAME_REQUIRED', '文件夹名不能只有空白', 422);
    const clash = this.db.prepare('SELECT folder_id FROM folders WHERE name=? AND folder_id<>?')
      .get(name, folder.folder_id) as unknown as { folder_id: string } | undefined;
    assertDomain(clash === undefined, 'FOLDER_NAME_TAKEN', `已经有一个叫「${name}」的文件夹了`, 409);
    /* 与项目改名同一条规矩：没变的名字不算"改成了"，否则界面会弹一句"已改名"而其实什么都没发生 */
    assertDomain(name !== folder.name, 'FOLDER_NAME_UNCHANGED', '新名字与现在一样，没有改动', 409);

    this.db.prepare('UPDATE folders SET name=? WHERE folder_id=?').run(name, folder.folder_id);
    return this.envelope(command, null, null, { folder_id: folder.folder_id, name, previous_name: folder.name });
  }

  /**
   * 删掉一个文件夹，里面的项目**回到未分组**（一个都不少）。
   *
   * 这里刻意不做级联删除：文件夹是"用户怎么整理项目库"，删掉一个收纳盒
   * 不该把盒子里的东西一起扔掉。每个被移出的项目都按正常写入走一遍
   * revision + 事件，所以别的窗口也会跟着刷新，而不是我这边看着没了、
   * 它那边还挂在文件夹里。
   */
  private deleteFolder(command: Extract<DomainCommand, { type: 'folder.delete' }>): ResultEnvelope {
    const folder = this.db.prepare('SELECT folder_id, name FROM folders WHERE folder_id=?').get(command.payload.folder_id) as unknown as
      { folder_id: string; name: string } | undefined;
    assertDomain(folder, 'FOLDER_NOT_FOUND', '这个文件夹不存在（可能已经被删掉了）', 404);

    const members = this.db.prepare('SELECT id, revision FROM projects WHERE folder_id=?').all(folder.folder_id) as unknown as
      Array<{ id: string; revision: number }>;
    const timestamp = now();
    for (const member of members) {
      const revision = member.revision + 1;
      this.db.prepare('UPDATE projects SET folder_id=NULL, revision=?, updated_at=? WHERE id=?')
        .run(revision, timestamp, member.id);
      this.event(member.id, revision, 'project.moved-to-folder', command, { folder_id: null, reason: 'folder-deleted' });
    }
    this.db.prepare('DELETE FROM folders WHERE folder_id=?').run(folder.folder_id);
    return this.envelope(command, null, null, { folder_id: folder.folder_id, name: folder.name, moved_out: members.length });
  }

  /**
   * 把项目放进文件夹（`folder_id: null` = 移出）。
   *
   * 只改分组，不动项目的任何业务事实（状态、闸门、产物都不受它影响），
   * 但仍然走一次 revision：界面上的列表是按 revision 刷新的，
   * 不涨 revision，别的窗口就看不到这次移动。
   */
  private moveProjectToFolder(command: Extract<DomainCommand, { type: 'project.move-to-folder' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const folderId = command.payload.folder_id;
    if (folderId !== null) {
      const folder = this.db.prepare('SELECT folder_id, name FROM folders WHERE folder_id=?').get(folderId) as unknown as
        { folder_id: string; name: string } | undefined;
      assertDomain(folder, 'FOLDER_NOT_FOUND', '这个文件夹不存在（可能已经在别处被删掉了）', 404);
    }

    const timestamp = now();
    const revision = project.revision + 1;
    this.db.prepare('UPDATE projects SET folder_id=?, revision=?, updated_at=? WHERE id=?')
      .run(folderId, revision, timestamp, project.id);
    this.event(project.id, revision, 'project.moved-to-folder', command, { folder_id: folderId });
    return this.envelope(command, project.id, revision, { folder_id: folderId });
  }

  private purgeProject(command: Extract<DomainCommand, { type: 'project.purge' }>): ResultEnvelope {
    const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(command.project_id) as unknown as ProjectRow | undefined;
    assertDomain(project, 'PROJECT_NOT_FOUND', '项目不存在', 404);
    assertDomain(project.deleted_at !== null, 'PROJECT_NOT_TRASHED', '只有回收站里的项目才能彻底删除', 409);
    assertDomain(
      command.payload.confirm_name === project.name,
      'PROJECT_NAME_MISMATCH',
      '项目名不一致，没有执行彻底删除',
      409,
      { expected: project.name },
    );

    for (const table of PROJECT_CHILD_TABLES) {
      this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(project.id);
    }
    try {
      this.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
    } catch (error) {
      /*
        走到这里只有一种情况：还有一张带 project_id 的表没进 PROJECT_CHILD_TABLES。
        SQLite 只会说一句 "FOREIGN KEY constraint failed"，不说是哪张表——
        报成"内部错误"的话，下次加表的人还会再踩一遍。

        外层的事务会回滚，所以此刻**什么都没删掉**，项目原样留在回收站里。
      */
      throw new DomainError(
        'PROJECT_PURGE_INCOMPLETE',
        '彻底删除未能完成：还有子表引用了这个项目。这一条通常是"新增的表没进 PROJECT_CHILD_TABLES"，'
        + `删除已被回滚，项目仍在回收站。原始错误：${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }

    /*
      不再调 this.event(...)：项目已经不存在了，写进去的是一条孤儿事件，
      而且下一次 purge 也读不到它。彻底删除的语义就是"不留痕"，
      留一条只有我们自己看得到的日志反而是自我安慰。
    */
    return this.envelope(command, project.id, null, {
      project_id: project.id,
      name: project.name,
      purged: true,
    });
  }

  private registerProvider(command: Extract<DomainCommand, { type: 'provider.register' }>): ResultEnvelope {
    /**
     * `probe` 是系统回写字段（v2.3 §7.7 规则 8）：适配器提交什么都在这里重置。
     * 否则适配器可以自报 drift_status=clean，把「我的接口已经漂移」这件事盖过去。
     */
    const manifest = {
      ...command.payload.manifest,
      probe: { last_probed_at: null, drift_status: 'unknown' as const, drift_details: [] as unknown[] },
    };
    const timestamp = now();
    this.db.prepare(`INSERT INTO providers(provider_id, manifest_json, adapter_hash, test_only, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET manifest_json=excluded.manifest_json, adapter_hash=excluded.adapter_hash, test_only=excluded.test_only, updated_at=excluded.updated_at`)
      .run(manifest.provider_id, json(manifest), manifest.adapter_hash, manifest.testOnly ? 1 : 0, timestamp, timestamp);
    return this.envelope(command, null, null, { provider_id: manifest.provider_id, registered: true, test_only: manifest.testOnly });
  }

  /** 只允许显式扩大项目预算上限；实际供应商调用仍须通过 G1/G2 与逐次费用确认。 */
  private authorizeProduction(command: Extract<DomainCommand, { type: 'project.production.authorize' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const budget = command.payload.max_budget_cents;
    assertDomain(budget >= project.max_budget_cents, 'BUDGET_CANNOT_DECREASE', '不能用生产授权降低已有项目预算上限', 409);
    const revision = project.revision + 1;
    const timestamp = now();
    this.db.prepare('UPDATE projects SET max_budget_cents=?, rights_confirmed=1 WHERE id=?').run(budget, project.id);
    this.advanceProject(project.id, revision, project.state, timestamp);
    this.event(project.id, revision, 'project.production.authorized', command, { max_budget_cents: budget, rights_confirmed: true });
    return this.envelope(command, project.id, revision, { max_budget_cents: budget, rights_confirmed: true });
  }

  private replaceShotFields(command: Extract<DomainCommand, { type: 'shot-fields.replace' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    return this.writeShotFields(project, command, command.payload.shots as ShotField[], command.payload.breakdown_revision, 'shot-fields.replaced');
  }

  private replaceCanvasDocument(command: Extract<DomainCommand, { type: 'canvas-document.replace' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const revision = project.revision + 1;
    const timestamp = now();
    const document = command.payload.document;
    this.db.prepare(`INSERT INTO canvas_documents(project_id, document_revision, document_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET document_revision=excluded.document_revision, document_json=excluded.document_json, updated_at=excluded.updated_at`)
      .run(project.id, revision, json(document), timestamp);
    this.advanceProject(project.id, revision, project.state, timestamp);
    this.event(project.id, revision, 'canvas-document.replaced', command, { document });
    return this.envelope(command, project.id, revision, { document_revision: revision });
  }

  private replaceTimelineDocument(command: Extract<DomainCommand, { type: 'timeline-document.replace' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const revision = project.revision + 1;
    const timestamp = now();
    const document = command.payload.document;
    this.db.prepare(`INSERT INTO timeline_documents(project_id, document_revision, document_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET document_revision=excluded.document_revision, document_json=excluded.document_json, updated_at=excluded.updated_at`)
      .run(project.id, revision, json(document), timestamp);
    this.advanceProject(project.id, revision, project.state, timestamp);
    this.event(project.id, revision, 'timeline-document.replaced', command, { document });
    return this.envelope(command, project.id, revision, { document_revision: revision });
  }

  /**
   * 由镜头边界候选生成拆解草稿。
   *
   * 自动分析只确定得了时长，其余六项按契约显式写成 `unknown`——
   * 留空会让下游误以为「已确认无此项」，而 unknown 明确表示等人确认。
   * 生成后走的是与手工替换**同一条写入路径**，因此失效传播、G1 失效、
   * prompt bundle 置 STALE 的行为完全一致，不存在两套语义。
   */
  private seedShotFields(command: Extract<DomainCommand, { type: 'shot-fields.seed' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    return this.writeShotFields(project, command, buildSeedShots(command.payload.boundaries), command.payload.breakdown_revision, 'shot-fields.seeded');
  }

  /**
   * 申请一次视频生成（S6）。
   *
   * 这里是 **G2 存在的全部意义**：未选帧的镜头不得产生付费视频请求。
   * 所以前置条件比图片生成更硬——G2 必须已批准，且该镜确实选定了首帧；
   * 两条缺一，都在花钱之前被拦下。
   */
  private requestVideoGeneration(command: Extract<DomainCommand, { type: 'video-generation.request' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    assertDomain(this.isGateApproved(project.id, 'G2'), 'G2_REQUIRED', '视频生成前必须批准 G2（首帧与视频预算）');

    const selection = this.db.prepare(
      `SELECT s.candidate_id, c.status AS candidate_status
       FROM selections s
       LEFT JOIN image_candidates c ON c.project_id = s.project_id AND c.candidate_id = s.candidate_id
       WHERE s.project_id=? AND s.shot_id=?`,
    ).get(project.id, command.payload.shot_id) as unknown as { candidate_id: string; candidate_status: string | null } | undefined;
    assertDomain(selection, 'FIRST_FRAME_REQUIRED', '该镜头尚未选定首帧，不得提交视频生成', 409);
    assertDomain(selection.candidate_status === 'ACTIVE', 'FIRST_FRAME_SUPERSEDED', '该镜头的首帧已失效，必须重新选帧', 409);

    const g2 = this.currentGate(project.id, 'G2');
    const approved = g2?.approved_budget_cents ?? 0;
    const cost = command.payload.estimated_cost_cents;
    assertDomain(
      project.reserved_budget_cents + cost <= approved,
      'G2_BUDGET_EXCEEDED',
      '视频请求超过 G2 已批准预算',
      409,
      { reserved_budget_cents: project.reserved_budget_cents, approved_budget_cents: approved, requested_cents: cost },
    );
    assertDomain(project.reserved_budget_cents + cost <= project.max_budget_cents, 'PROJECT_BUDGET_EXCEEDED', '视频请求超过项目预算', 409);

    /* 在飞去重：与图片那条同一条规矩（见 requestImageGeneration 里的说明） */
    const digest = command.payload.digest ?? null;
    if (digest !== null) {
      const inFlight = this.db.prepare(`
        SELECT intent_id, estimated_cost_cents FROM video_generation_intents
        WHERE project_id=? AND digest=? AND status='ADMITTED'
        ORDER BY created_at LIMIT 1
      `).get(project.id, digest) as unknown as { intent_id: string; estimated_cost_cents: number } | undefined;
      if (inFlight) {
        return this.envelope(command, project.id, project.revision, {
          intent_id: inFlight.intent_id,
          shot_id: command.payload.shot_id,
          status: 'ADMITTED',
          estimated_cost_cents: inFlight.estimated_cost_cents,
          provider_started: false,
          deduplicated: true,
        });
      }

    }

    const intentId = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO video_generation_intents(intent_id, project_id, shot_id, model, prompt, duration_seconds, estimated_cost_cents, status, digest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ADMITTED', ?, ?, ?)`)
      .run(
        intentId, project.id, command.payload.shot_id, command.payload.model,
        command.payload.prompt ?? null, command.payload.duration_seconds, cost,
        command.payload.digest ?? null, timestamp, timestamp,
      );
    const revision = project.revision + 1;
    this.db.prepare('UPDATE projects SET revision=?, state=?, reserved_budget_cents=reserved_budget_cents+?, updated_at=? WHERE id=?')
      .run(revision, 'VIDEO_GENERATING', cost, timestamp, project.id);
    this.event(project.id, revision, 'video-generation.requested', command, {
      intent_id: intentId,
      shot_id: command.payload.shot_id,
      model: command.payload.model,
      duration_seconds: command.payload.duration_seconds,
      estimated_cost_cents: cost,
      first_frame_candidate_id: selection.candidate_id,
      digest: command.payload.digest ?? null,
    });
    return this.envelope(command, project.id, revision, {
      intent_id: intentId,
      shot_id: command.payload.shot_id,
      status: 'ADMITTED',
      estimated_cost_cents: cost,
      provider_started: false,
    });
  }

  /** 结清一次视频生成。与图片生成同理：差额必须退回，否则预算是只进不出的黑洞。 */
  private settleVideoGeneration(command: Extract<DomainCommand, { type: 'video-generation.settle' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const intent = this.db.prepare(
      'SELECT intent_id, shot_id, estimated_cost_cents, status FROM video_generation_intents WHERE intent_id=? AND project_id=?',
    ).get(command.payload.intent_id, project.id) as unknown as
      { intent_id: string; shot_id: string; estimated_cost_cents: number; status: string } | undefined;
    assertDomain(intent, 'VIDEO_INTENT_NOT_FOUND', '视频生成意图不存在', 404);
    assertDomain(intent.status === 'ADMITTED', 'VIDEO_INTENT_ALREADY_SETTLED', '该视频生成意图已经结清', 409);
    if (command.payload.status === 'FAILED') {
      assertDomain(command.payload.failure !== undefined, 'VIDEO_FAILURE_REQUIRED', '失败结清必须说明原因', 422);
    }

    const timestamp = now();
    const settled = settleCostFields(command.payload, intent.estimated_cost_cents);
    this.db.prepare('UPDATE video_generation_intents SET status=?, actual_cost_cents=?, provider_cost_unit=?, provider_cost_amount=?, clip_artifact_id=?, failure=?, reservation_released_reason=?, updated_at=? WHERE intent_id=?')
      .run(command.payload.status, settled.actualCents, settled.providerCostUnit, settled.providerCostAmount, command.payload.clip_artifact_id ?? null, command.payload.failure ?? null, settled.releasedReason, timestamp, intent.intent_id);
    const revision = project.revision + 1;
    this.db.prepare('UPDATE projects SET revision=?, state=?, reserved_budget_cents=MAX(0, reserved_budget_cents + ?), updated_at=? WHERE id=?')
      .run(revision, command.payload.status === 'COMPLETED' ? 'VIDEO_GENERATED' : 'G2_APPROVED', settled.delta, timestamp, project.id);
    this.event(project.id, revision,
      command.payload.status === 'COMPLETED' ? 'video-generation.completed' : 'video-generation.failed',
      command,
      {
        intent_id: intent.intent_id,
        shot_id: intent.shot_id,
        estimated_cost_cents: intent.estimated_cost_cents,
        actual_cost_cents: settled.actualCents,
        provider_cost: command.payload.provider_cost ?? null,
        clip_artifact_id: command.payload.clip_artifact_id ?? null,
        failure: command.payload.failure ?? null,
        reservation_released_reason: settled.releasedReason,
      });
    return this.envelope(command, project.id, revision, {
      intent_id: intent.intent_id,
      status: command.payload.status,
      actual_cost_cents: settled.actualCents,
      released_cents: settled.releasedCents,
      reservation_released_reason: settled.releasedReason,
    });
  }

  /**
   * 申请一次图片生成（S5）。
   *
   * 前置条件是 G1——拆解被批准之后才谈得上"按这一镜的要求生成画面"。
   * 预估成本当场预留：**没有预留就没有上限**，而这是一次真实付费调用。
   */
  private requestImageGeneration(command: Extract<DomainCommand, { type: 'image-generation.request' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    assertDomain(this.isGateApproved(project.id, 'G1'), 'G1_REQUIRED', '图片生成前必须批准 G1（拆解冻结）');

    const fields = this.shotFields(project.id);
    assertDomain(fields, 'SHOT_FIELDS_REQUIRED', '图片生成前必须存在逐镜字段表');
    const shots = JSON.parse(fields.shots_json) as ShotField[];
    assertDomain(
      shots.some((shot) => shot.shot_id === command.payload.shot_id),
      'SHOT_NOT_FOUND',
      '镜头不存在',
      404,
    );

    const cost = command.payload.estimated_cost_cents;
    assertDomain(
      project.reserved_budget_cents + cost <= project.max_budget_cents,
      'PROJECT_BUDGET_EXCEEDED',
      '本次生成会超过项目预算',
      409,
      { reserved_budget_cents: project.reserved_budget_cents, max_budget_cents: project.max_budget_cents, requested_cents: cost },
    );

    /*
      **在飞去重**：同一个意图（同项目 + 同镜头 + 同 digest）如果已经有一发
      还没结算的请求，就把它当成"同一次请求"返回，不新建意图、不重复预留预算。

      为什么非要有这一层：`processed_commands` 挡的只是"**同一个 command_id**
      重试"，而客户端在"发出去但没收到响应"时会**换一个新的 command_id 重试**
      ——那是很多 HTTP 客户端的默认行为（重试中间件重新生成请求 id）。
      没有这一层的话，一次网络抖动就会让同一张图被买两次。

      digest 为空（调用方没给）时不做去重：没有"意图指纹"就没有判断依据，
      宁可如实新建，也不能拿"看着像同一张"去替用户省钱——
      模型有随机性，两次真跑本来就该是两张不同的图。
    */
    const digest = command.payload.digest ?? null;
    if (digest !== null) {
      const inFlight = this.db.prepare(`
        SELECT intent_id, estimated_cost_cents FROM image_generation_intents
        WHERE project_id=? AND digest=? AND status='ADMITTED'
        ORDER BY created_at LIMIT 1
      `).get(project.id, digest) as unknown as { intent_id: string; estimated_cost_cents: number } | undefined;
      if (inFlight) {
        /* 没有任何状态变化 → revision 不动、不发事件、不再预留 */
        return this.envelope(command, project.id, project.revision, {
          intent_id: inFlight.intent_id,
          shot_id: command.payload.shot_id,
          status: 'ADMITTED',
          estimated_cost_cents: inFlight.estimated_cost_cents,
          provider_started: false,
          deduplicated: true,
        });
      }
    }

    const intentId = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO image_generation_intents(intent_id, project_id, shot_id, model, prompt, estimated_cost_cents, status, digest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ADMITTED', ?, ?, ?)`)
      .run(intentId, project.id, command.payload.shot_id, command.payload.model, command.payload.prompt, cost, command.payload.digest ?? null, timestamp, timestamp);
    const revision = project.revision + 1;
    this.db.prepare('UPDATE projects SET revision=?, state=?, reserved_budget_cents=reserved_budget_cents+?, updated_at=? WHERE id=?')
      .run(revision, 'IMAGE_GENERATING', cost, timestamp, project.id);
    this.event(project.id, revision, 'image-generation.requested', command, {
      intent_id: intentId,
      shot_id: command.payload.shot_id,
      model: command.payload.model,
      estimated_cost_cents: cost,
      digest: command.payload.digest ?? null,
    });
    return this.envelope(command, project.id, revision, {
      intent_id: intentId,
      shot_id: command.payload.shot_id,
      status: 'ADMITTED',
      estimated_cost_cents: cost,
      provider_started: false,
    });
  }

  /**
   * 复用一次成功结果，而不是再花钱跑一遍。
   *
   * 为什么放在领域层而不是服务层：**"这是不是同一次请求"必须由事实来判**。
   * 服务层说"摘要一样"，领域层照着信——那么任何一个摘要计算的 bug
   * 都会让一张不相干的图被登记成"命中"，而且账上写着省了钱。
   * 所以这里再比一次摘要，并且只认 COMPLETED 的来源意图。
   *
   * 复用不预留预算：它确实不花钱。账目上这一笔的 `actual_cost_cents` 写 0，
   * 与"失败但不知道花没花"那条（写 null）区别开——**0 是事实，null 是未知**。
   */
  private reuseImageGeneration(command: Extract<DomainCommand, { type: 'image-generation.reuse' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const fields = this.shotFields(project.id);
    assertDomain(fields, 'SHOT_FIELDS_REQUIRED', '缺少 ShotFields');
    const shots = JSON.parse(fields.shots_json) as ShotField[];
    assertDomain(shots.some((shot) => shot.shot_id === command.payload.shot_id), 'SHOT_NOT_FOUND', '镜头不存在', 404);

    const source = this.db.prepare(
      'SELECT intent_id, shot_id, status, digest, candidate_id FROM image_generation_intents WHERE intent_id=? AND project_id=?',
    ).get(command.payload.source_intent_id, project.id) as unknown as {
      intent_id: string;
      shot_id: string;
      status: string;
      digest: string | null;
      candidate_id: string | null;
    } | undefined;
    assertDomain(source, 'IMAGE_INTENT_NOT_FOUND', '要复用的那次生成记录不存在', 404);
    assertDomain(
      source.status === 'COMPLETED',
      'REUSE_SOURCE_NOT_COMPLETED',
      '要复用的那一次没有成功，它没有可用的产物',
      409,
    );
    assertDomain(
      source.digest !== null && source.digest === command.payload.digest,
      'REUSE_DIGEST_MISMATCH',
      '执行摘要对不上：这不是同一次生成，不能复用',
      409,
      { source_digest: source.digest, requested_digest: command.payload.digest },
    );
    const sourceCandidate = this.db.prepare(
      'SELECT artifact_id FROM image_candidates WHERE project_id=? AND candidate_id=?',
    ).get(project.id, source.candidate_id ?? '') as unknown as { artifact_id: string } | undefined;
    assertDomain(sourceCandidate, 'REUSE_SOURCE_ARTIFACT_MISSING', '要复用的那次记录里没有候选产物', 409);

    const duplicated = this.db.prepare('SELECT candidate_id FROM image_candidates WHERE project_id=? AND candidate_id=?')
      .get(project.id, command.payload.candidate_id) as unknown as { candidate_id: string } | undefined;
    assertDomain(!duplicated, 'CANDIDATE_ALREADY_EXISTS', `图片候选已存在：${command.payload.candidate_id}`, 409);

    const timestamp = now();
    const intentId = randomUUID();
    /*
      新意图行直接写 COMPLETED：它没有"进行中"这一段——复用是一次本地登记，
      没有等待、没有失败的可能，把它写成 ADMITTED 反而会留下一条永远结不清的记录。
    */
    this.db.prepare(`INSERT INTO image_generation_intents(
        intent_id, project_id, shot_id, model, prompt, estimated_cost_cents, actual_cost_cents,
        status, candidate_id, digest, reused_from_intent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, 'COMPLETED', ?, ?, ?, ?, ?)`).run(
      intentId, project.id, command.payload.shot_id, 'reuse', '复用已有结果',
      command.payload.candidate_id, command.payload.digest, command.payload.source_intent_id,
      timestamp, timestamp,
    );
    this.db.prepare(`INSERT INTO image_candidates(project_id, shot_id, candidate_id, artifact_id, status, created_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?)`)
      .run(project.id, command.payload.shot_id, command.payload.candidate_id, sourceCandidate.artifact_id, timestamp);
    this.supersedeGates(project.id, ['G2']);
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, 'IMAGE_SELECTING', timestamp);
    this.event(project.id, revision, 'image-generation.reused', command, {
      intent_id: intentId,
      shot_id: command.payload.shot_id,
      candidate_id: command.payload.candidate_id,
      artifact_id: sourceCandidate.artifact_id,
      source_intent_id: command.payload.source_intent_id,
      digest: command.payload.digest,
    });
    return this.envelope(command, project.id, revision, {
      intent_id: intentId,
      shot_id: command.payload.shot_id,
      candidate_id: command.payload.candidate_id,
      artifact_id: sourceCandidate.artifact_id,
      source_intent_id: command.payload.source_intent_id,
      status: 'COMPLETED',
      actual_cost_cents: 0,
    });
  }

  /**
   * 复用一段已有视频，而不是再花一次钱。
   *
   * 与图片那条同构（见 `reuseImageGeneration`），两处差别：
   *   · 产物是**片段**（`clip_artifact_id`），不是候选——视频没有候选这个概念；
   *   · 前置条件不查 G2。复用不花钱，而 G2 是"允许花钱"的闸门；
   *     拿它来拦一次不花钱的登记，只会让用户困惑。
   *     （首帧是否还在、摘要对不对，这两条仍然要判。）
   */
  private reuseVideoGeneration(command: Extract<DomainCommand, { type: 'video-generation.reuse' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const fields = this.shotFields(project.id);
    assertDomain(fields, 'SHOT_FIELDS_REQUIRED', '缺少 ShotFields');
    const shots = JSON.parse(fields.shots_json) as ShotField[];
    assertDomain(shots.some((shot) => shot.shot_id === command.payload.shot_id), 'SHOT_NOT_FOUND', '镜头不存在', 404);

    const source = this.db.prepare(
      'SELECT intent_id, status, digest, clip_artifact_id FROM video_generation_intents WHERE intent_id=? AND project_id=?',
    ).get(command.payload.source_intent_id, project.id) as unknown as {
      intent_id: string;
      status: string;
      digest: string | null;
      clip_artifact_id: string | null;
    } | undefined;
    assertDomain(source, 'VIDEO_INTENT_NOT_FOUND', '要复用的那次视频生成记录不存在', 404);
    assertDomain(source.status === 'COMPLETED', 'REUSE_SOURCE_NOT_COMPLETED', '要复用的那一次没有成功，它没有可用的片段', 409);
    assertDomain(
      source.digest !== null && source.digest === command.payload.digest,
      'REUSE_DIGEST_MISMATCH',
      '执行摘要对不上：这不是同一次生成，不能复用',
      409,
      { source_digest: source.digest, requested_digest: command.payload.digest },
    );
    assertDomain(source.clip_artifact_id !== null, 'REUSE_SOURCE_ARTIFACT_MISSING', '要复用的那次记录里没有片段产物', 409);

    const timestamp = now();
    const intentId = randomUUID();
    this.db.prepare(`INSERT INTO video_generation_intents(
        intent_id, project_id, shot_id, model, duration_seconds, estimated_cost_cents, actual_cost_cents,
        status, clip_artifact_id, digest, reused_from_intent_id, created_at, updated_at)
      VALUES (?, ?, ?, 'reuse', 0, 0, 0, 'COMPLETED', ?, ?, ?, ?, ?)`).run(
      intentId, project.id, command.payload.shot_id, source.clip_artifact_id,
      command.payload.digest, command.payload.source_intent_id, timestamp, timestamp,
    );
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, 'VIDEO_GENERATED', timestamp);
    this.event(project.id, revision, 'video-generation.reused', command, {
      intent_id: intentId,
      shot_id: command.payload.shot_id,
      clip_artifact_id: source.clip_artifact_id,
      source_intent_id: command.payload.source_intent_id,
      digest: command.payload.digest,
    });
    return this.envelope(command, project.id, revision, {
      intent_id: intentId,
      shot_id: command.payload.shot_id,
      clip_artifact_id: source.clip_artifact_id,
      source_intent_id: command.payload.source_intent_id,
      status: 'COMPLETED',
      actual_cost_cents: 0,
    });
  }

  /**
   * 结清一次图片生成。
   *
   * 把「预估预留」换成「实际花费」：差额退回项目预算。
   * 少了这一步，预算只会单调往上爬，用户看到的是一个永远在减少、
   * 却没有任何东西被释放的数字。
   */
  private settleImageGeneration(command: Extract<DomainCommand, { type: 'image-generation.settle' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const intent = this.db.prepare(
      'SELECT intent_id, shot_id, estimated_cost_cents, status FROM image_generation_intents WHERE intent_id=? AND project_id=?',
    ).get(command.payload.intent_id, project.id) as unknown as
      { intent_id: string; shot_id: string; estimated_cost_cents: number; status: string } | undefined;
    assertDomain(intent, 'IMAGE_INTENT_NOT_FOUND', '图片生成意图不存在', 404);
    assertDomain(intent.status === 'ADMITTED', 'IMAGE_INTENT_ALREADY_SETTLED', '该生成意图已经结清', 409);
    if (command.payload.status === 'FAILED') {
      assertDomain(command.payload.failure !== undefined, 'IMAGE_FAILURE_REQUIRED', '失败结清必须说明原因', 422);
    }

    const timestamp = now();
    const settled = settleCostFields(command.payload, intent.estimated_cost_cents);
    this.db.prepare('UPDATE image_generation_intents SET status=?, actual_cost_cents=?, provider_cost_unit=?, provider_cost_amount=?, candidate_id=?, failure=?, reservation_released_reason=?, updated_at=? WHERE intent_id=?')
      .run(
        command.payload.status,
        settled.actualCents,
        settled.providerCostUnit,
        settled.providerCostAmount,
        command.payload.candidate_id ?? null,
        command.payload.failure ?? null,
        settled.releasedReason,
        timestamp,
        intent.intent_id,
      );
    const revision = project.revision + 1;
    this.db.prepare('UPDATE projects SET revision=?, state=?, reserved_budget_cents=MAX(0, reserved_budget_cents + ?), updated_at=? WHERE id=?')
      .run(revision, command.payload.status === 'COMPLETED' ? 'IMAGE_SELECTING' : 'G1_APPROVED', settled.delta, timestamp, project.id);
    this.event(project.id, revision,
      command.payload.status === 'COMPLETED' ? 'image-generation.completed' : 'image-generation.failed',
      command,
      {
        intent_id: intent.intent_id,
        shot_id: intent.shot_id,
        estimated_cost_cents: intent.estimated_cost_cents,
        actual_cost_cents: settled.actualCents,
        provider_cost: command.payload.provider_cost ?? null,
        candidate_id: command.payload.candidate_id ?? null,
        failure: command.payload.failure ?? null,
        reservation_released_reason: settled.releasedReason,
      });
    return this.envelope(command, project.id, revision, {
      intent_id: intent.intent_id,
      status: command.payload.status,
      actual_cost_cents: settled.actualCents,
      released_cents: settled.releasedCents,
      reservation_released_reason: settled.releasedReason,
    });
  }

  /**
   * 事后释放一笔已经失败结清的预留。
   *
   * 存在的理由：失败结清时如果拿不出"这笔没花钱"的凭据，预留会**如实留着**。
   * 那之后如果没有入口能放开它，用户的可用预算就被永久扣住——
   * 而"当时不知道、后来查清了"是常态（对一次供应商账单就知道了）。
   *
   * 三条前提缺一不可：
   *   · 记录必须是 FAILED（还没结清的在 `settle` 时决定，已完成的实付已定）；
   *   · 没写过实际花费（写过说明已经按实际金额退过差额）；
   *   · 没释放过（重复释放会把同一笔钱退两次）。
   */
  private releaseReservation(
    command: Extract<
      DomainCommand,
      { type: 'image-generation.release-reservation' } | { type: 'video-generation.release-reservation' }
    >,
    kind: 'image' | 'video',
  ): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const table = kind === 'image' ? 'image_generation_intents' : 'video_generation_intents';
    const row = this.db.prepare(
      `SELECT intent_id, estimated_cost_cents, actual_cost_cents, status, reservation_released_reason
         FROM ${table} WHERE intent_id=? AND project_id=?`,
    ).get(command.payload.intent_id, project.id) as unknown as {
      intent_id: string;
      estimated_cost_cents: number;
      actual_cost_cents: number | null;
      status: string;
      reservation_released_reason: string | null;
    } | undefined;
    assertDomain(row, 'GENERATION_INTENT_NOT_FOUND', '这条生成记录不存在', 404);
    assertDomain(
      row.status === 'FAILED',
      'RESERVATION_ONLY_AFTER_FAILURE',
      '只有失败结清的记录才谈得上事后释放预留',
      409,
    );
    assertDomain(
      row.reservation_released_reason === null,
      'RESERVATION_ALREADY_RELEASED',
      '这笔预留已经释放过了',
      409,
    );
    assertDomain(
      row.actual_cost_cents === null,
      'RESERVATION_ALREADY_SETTLED',
      '这笔已经按实际花费结清，没有预留可释放',
      409,
    );

    const timestamp = now();
    const revision = project.revision + 1;
    const released = row.estimated_cost_cents;
    this.db.prepare(`UPDATE ${table} SET reservation_released_reason=?, updated_at=? WHERE intent_id=?`)
      .run(command.payload.reason, timestamp, row.intent_id);
    /*
      状态**不动**：释放预留只是把占着的额度放开，与"这条片子做到哪一步"无关。
      失败之后项目停在 G1_APPROVED（出图）/ G2_APPROVED（视频），
      释放一次账目不该把它推回别的状态。
    */
    this.db.prepare('UPDATE projects SET revision=?, reserved_budget_cents=MAX(0, reserved_budget_cents - ?), updated_at=? WHERE id=?')
      .run(revision, released, timestamp, project.id);
    this.event(
      project.id,
      revision,
      kind === 'image' ? 'image-generation.reservation-released' : 'video-generation.reservation-released',
      command,
      { intent_id: row.intent_id, released_cents: released, reason: command.payload.reason },
    );
    return this.envelope(command, project.id, revision, {
      intent_id: row.intent_id,
      status: 'FAILED',
      released_cents: released,
      reservation_released_reason: command.payload.reason,
    });
  }

  /**
   * 记录一份修复方案（S9）。
   *
   * 方案必须**有据可依**：`source_eval_report` 指向本项目已存在的评估报告，
   * 否则就是凭感觉改片。作用域之外的部分属于显式复用，不会被动重跑。
   */
  private proposeRepairPlan(command: Extract<DomainCommand, { type: 'repair.propose' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const plan = command.payload.plan;
    const sourceEval = this.db.prepare('SELECT report_id FROM eval_reports WHERE report_id=? AND project_id=?')
      .get(plan.source_eval_report, project.id) as unknown as { report_id: string } | undefined;
    assertDomain(sourceEval, 'EVAL_REPORT_NOT_FOUND', '修复方案必须依据本项目已有的评估报告', 404);

    const planId = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO repair_plans(plan_id, project_id, source_eval_report, plan_json, status, created_at)
      VALUES (?, ?, ?, ?, 'PROPOSED', ?)`)
      .run(planId, project.id, plan.source_eval_report, json(plan), timestamp);
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, 'REPAIR_PROPOSED', timestamp);
    const scope = Array.from(new Set(plan.operations.flatMap((operation) => operation.scope)));
    this.event(project.id, revision, 'repair.proposed', command, {
      plan_id: planId,
      source_eval_report: plan.source_eval_report,
      operation_count: plan.operations.length,
      scope,
      reused: plan.reused,
      estimated_cost_cents: plan.operations.reduce((total, operation) => total + operation.estimated_cost_cents, 0),
    });
    return this.envelope(command, project.id, revision, {
      plan_id: planId,
      operation_count: plan.operations.length,
      scope,
      reused: plan.reused,
    });
  }

  /**
   * 记录一次修复执行的结果（S9 的后半段）。
   *
   * 这条命令**只记账**：真正的前置校验（计划是否仍然新鲜、闸门批没批）在执行器那一侧，
   * 因为它必须先于改动发生——而改动一落库，revision 就变了，事后再判就判不出来。
   * 为了这份记录仍然可核，执行器要带上 `execution_revision`（它验证时看到的那个 revision），
   * 领域层据此确认"G4 批准的就是这个 revision"，而不是拿新 revision 去猜。
   *
   * 三条硬校验：
   *   · 方案必须是 PROPOSED（已经执行过的不许再记一次）；
   *   · 必须是这个项目**最新**的一份方案——否则批的是别的方案，执行的却是这一份；
   *   · 必须有一次 G4 批准，且它批准时的 revision 就是 `execution_revision`。
   */
  private executeRepairPlan(command: Extract<DomainCommand, { type: 'repair.execute' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const { plan_id: planId, execution_revision: executionRevision, status, executed, refused } = command.payload;
    const plan = this.db.prepare('SELECT plan_id, plan_json, status, created_at FROM repair_plans WHERE plan_id=? AND project_id=?')
      .get(planId, project.id) as unknown as
        { plan_id: string; plan_json: string; status: string; created_at: string } | undefined;
    assertDomain(plan, 'REPAIR_PLAN_NOT_FOUND', '修复方案不存在', 404);
    assertDomain(plan.status === 'PROPOSED', 'REPAIR_PLAN_NOT_PROPOSED', `该修复方案当前状态是 ${plan.status}，不能再执行一次`, 409);

    const latest = this.db.prepare('SELECT plan_id FROM repair_plans WHERE project_id=? ORDER BY created_at DESC LIMIT 1')
      .get(project.id) as unknown as { plan_id: string } | undefined;
    assertDomain(latest?.plan_id === planId, 'REPAIR_PLAN_SUPERSEDED', '这不是最新的一份修复方案：先处理最新那份', 409);

    const g4 = this.db.prepare(
      "SELECT approved_project_revision FROM gate_decisions WHERE project_id=? AND gate='G4' AND status='APPROVED' AND created_at >= ? ORDER BY sequence DESC LIMIT 1",
    ).get(project.id, plan.created_at) as unknown as { approved_project_revision: number | null } | undefined;
    assertDomain(g4, 'G4_REQUIRED', '执行修复前必须先批准 G4（批准的对象就是这份方案）', 409);
    assertDomain(
      g4.approved_project_revision === executionRevision,
      'REPAIR_PLAN_STALE',
      `批准之后项目又变了（批准在 R${String(g4.approved_project_revision)}，执行时是 R${executionRevision}）：重新评估一次再执行`,
      409,
    );

    const timestamp = now();
    this.db.prepare('UPDATE repair_plans SET status=? WHERE plan_id=?').run(status, planId);
    const parsed = JSON.parse(plan.plan_json) as { operations?: Array<{ id: string; scope?: string[] }>; reused?: string[] };
    const scope = Array.from(new Set((parsed.operations ?? []).flatMap((operation) => operation.scope ?? [])));
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, 'REPAIR_EXECUTED', timestamp);
    this.event(project.id, revision, 'repair.executed', command, {
      plan_id: planId,
      status,
      executed,
      refused,
      scope,
      reused: parsed.reused ?? [],
    });
    return this.envelope(command, project.id, revision, {
      plan_id: planId,
      status,
      executed_count: executed.length,
      refused_count: refused.length,
      scope,
      reused: parsed.reused ?? [],
    });
  }

  /**
   * 记录一份偏差评估报告（S8）。
   *
   * 领域层不负责评估——它只把结论连证据与归因一起留成项目事实。
   * 返回里带上「最差的维度」与「被归因的实体」，让修复阶段和界面
   * 都不必自己再算一遍就能指出问题出在哪一镜。
   */
  private recordEvalReport(command: Extract<DomainCommand, { type: 'eval.record' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const report = command.payload.report;
    const reportId = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO eval_reports(report_id, project_id, reference_artifact, result_artifact, evaluator_id, evaluator_version, report_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        reportId, project.id,
        report.reference_artifact, report.result_artifact,
        report.evaluator.id, report.evaluator.version,
        json(report), timestamp,
      );
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, 'EVALUATED', timestamp);
    const attributedEntities = Array.from(new Set(
      report.dimensions.flatMap((dimension) => dimension.attribution.map((item) => item.entity_id)),
    ));
    this.event(project.id, revision, 'eval.recorded', command, {
      report_id: reportId,
      dimension_count: report.dimensions.length,
      attributed_entities: attributedEntities,
    });
    const worst = [...report.dimensions].sort((a, b) => a.score - b.score)[0];
    return this.envelope(command, project.id, revision, {
      report_id: reportId,
      dimension_count: report.dimensions.length,
      worst_dimension: worst ? { name: worst.name, score: worst.score } : null,
      attributed_entities: attributedEntities,
    });
  }

  /** 登记一个参考视频（S0）。只存相对路径与内容哈希。 */
  private registerSource(command: Extract<DomainCommand, { type: 'source.register' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const relativePath = command.payload.relative_path;
    assertDomain(
      !isAbsoluteLikePath(relativePath),
      'ABSOLUTE_PATH_FORBIDDEN',
      '参考视频路径必须是项目内的相对路径',
      422,
      { relative_path: relativePath },
    );
    const existing = this.db.prepare('SELECT asset_id FROM source_assets WHERE project_id=? AND relative_path=?')
      .get(project.id, relativePath) as unknown as { asset_id: string } | undefined;
    const assetId = existing?.asset_id ?? randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO source_assets(asset_id, project_id, relative_path, content_hash, bytes, media_type, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, relative_path) DO UPDATE SET
        content_hash=excluded.content_hash, bytes=excluded.bytes,
        media_type=excluded.media_type, registered_at=excluded.registered_at`)
      .run(
        assetId, project.id, relativePath, command.payload.content_hash,
        command.payload.bytes, command.payload.media_type ?? null, timestamp,
      );
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, 'INGESTED', timestamp);
    this.event(project.id, revision, existing ? 'source.replaced' : 'source.registered', command, {
      asset_id: assetId,
      relative_path: relativePath,
      content_hash: command.payload.content_hash,
      bytes: command.payload.bytes,
      media_type: command.payload.media_type ?? null,
    });
    return this.envelope(command, project.id, revision, {
      asset_id: assetId,
      relative_path: relativePath,
      content_hash: command.payload.content_hash,
      replaced: Boolean(existing),
    });
  }

  /** 字段表的唯一写入路径：手工替换与自动播种都经过这里。 */
  private writeShotFields(
    project: ProjectRow,
    command: Extract<DomainCommand, { type: 'shot-fields.replace' | 'shot-fields.seed' }>,
    shots: ShotField[],
    breakdownRevision: number,
    eventType: string,
  ): ResultEnvelope {
    const duplicate = this.findDuplicate(shots.map((shot) => shot.shot_id));
    assertDomain(!duplicate, 'DUPLICATE_SHOT_ID', `镜头编号重复：${duplicate}`);
    const previous = this.db.prepare('SELECT fields_revision, breakdown_revision, shots_json FROM shot_fields WHERE project_id = ?').get(project.id) as unknown as ShotFieldsRow | undefined;
    const fieldsRevision = (previous?.fields_revision ?? 0) + 1;
    const revision = project.revision + 1;
    const timestamp = now();
    this.db.prepare(`INSERT INTO shot_fields(project_id, fields_revision, breakdown_revision, shots_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET fields_revision=excluded.fields_revision, breakdown_revision=excluded.breakdown_revision, shots_json=excluded.shots_json, updated_at=excluded.updated_at`)
      .run(project.id, fieldsRevision, breakdownRevision, json(shots), timestamp);
    this.db.prepare("UPDATE prompt_bundles SET status='STALE' WHERE project_id = ? AND status = 'CURRENT'").run(project.id);
    this.supersedeGates(project.id, ['G1', 'G2']);
    this.advanceProject(project.id, revision, 'BREAKDOWN_EDITING', timestamp);
    this.event(project.id, revision, eventType, command, { fields_revision: fieldsRevision, breakdown_revision: breakdownRevision, shots });
    return this.envelope(command, project.id, revision, { fields_revision: fieldsRevision, shot_count: shots.length, state: 'BREAKDOWN_EDITING' });
  }

  private approveGate(command: Extract<DomainCommand, { type: 'gate.approve' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const gate = command.payload.gate;
    assertDomain(
      (IMPLEMENTED_GATES as readonly string[]).includes(gate),
      'GATE_NOT_IMPLEMENTED',
      `闸门 ${gate} 的审批流程尚未接入（当前支持 ${IMPLEMENTED_GATES.join(' / ')}）`,
      501,
    );
    const fields = this.shotFields(project.id);
    if (gate === 'G0') {
      assertDomain(project.rights_confirmed === 1, 'RIGHTS_NOT_CONFIRMED', 'G0 前必须确认素材权利');
    }
    if (gate === 'G1') {
      assertDomain(this.isGateApproved(project.id, 'G0'), 'G0_REQUIRED', 'G1 前必须批准 G0');
      assertDomain(fields, 'SHOT_FIELDS_REQUIRED', 'G1 审批必须包含 ShotFields 快照');
    }
    if (gate === 'G2') {
      assertDomain(this.isGateApproved(project.id, 'G1'), 'G1_REQUIRED', 'G2 前必须批准 G1');
      assertDomain(fields, 'SHOT_FIELDS_REQUIRED', 'G2 前必须存在镜头字段表');
      const shots = JSON.parse(fields.shots_json) as ShotField[];
      const selections = this.db.prepare('SELECT shot_id FROM selections WHERE project_id = ?').all(project.id) as unknown as Array<{ shot_id: string }>;
      const selected = new Set(selections.map((row) => row.shot_id));
      const missing = shots.map((shot) => shot.shot_id).filter((shotId) => !selected.has(shotId));
      assertDomain(missing.length === 0, 'FIRST_FRAME_REQUIRED', '每个镜头都必须选择首帧后才能批准 G2', 409, { missing_shot_ids: missing });
      const approvedBudget = command.payload.approved_budget_cents;
      assertDomain(approvedBudget !== undefined, 'VIDEO_BUDGET_REQUIRED', 'G2 必须明确批准视频预算');
      // G2 存储项目累计占用上限；视频请求按已占用金额加本次预估比较，不能重复扣掉既有费用。
      assertDomain(approvedBudget >= project.reserved_budget_cents && approvedBudget <= project.max_budget_cents,
        'BUDGET_EXCEEDED', 'G2 累计占用上限必须覆盖已占用金额且不超过项目上限', 409);
    }
    /**
     * G4：修复前批准。
     *
     * 它要批准的对象是一份**已提出的修复方案**——否则「批准修复」这四个字
     * 没有指向任何具体动作，批了也不知道批了什么。
     */
    if (gate === 'G4') {
      const plan = this.db.prepare("SELECT plan_id FROM repair_plans WHERE project_id=? AND status='PROPOSED' ORDER BY created_at DESC LIMIT 1")
        .get(project.id) as unknown as { plan_id: string } | undefined;
      assertDomain(plan, 'REPAIR_PLAN_REQUIRED', 'G4 前必须先有修复方案');
    }

    const revision = project.revision + 1;
    const timestamp = now();
    this.db.prepare(`INSERT INTO gate_decisions(decision_id, project_id, gate, status, approved_project_revision, approved_fields_revision, approved_budget_cents, note, actor, created_at)
      VALUES (?, ?, ?, 'APPROVED', ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), project.id, gate, revision, fields?.fields_revision ?? null, command.payload.approved_budget_cents ?? null, command.payload.note ?? null, command.actor, timestamp);
    const state = gate === 'G0' ? 'INGESTED'
      : gate === 'G1' ? 'G1_APPROVED'
        : gate === 'G2' ? 'G2_APPROVED'
          : 'REPAIR_APPROVED';
    this.advanceProject(project.id, revision, state, timestamp);
    this.event(project.id, revision, 'gate.approved', command, { gate, approved_fields_revision: fields?.fields_revision ?? null, approved_budget_cents: command.payload.approved_budget_cents ?? null });
    return this.envelope(command, project.id, revision, { gate, status: 'APPROVED', state });
  }

  private derivePrompt(command: Extract<DomainCommand, { type: 'prompt.derive' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    assertDomain(this.isGateApproved(project.id, 'G1'), 'G1_REQUIRED', '派生提示词前必须批准 G1');
    const fields = this.shotFields(project.id);
    assertDomain(fields, 'SHOT_FIELDS_REQUIRED', '缺少 ShotFields');
    const shots = JSON.parse(fields.shots_json) as ShotField[];
    const content = {
      schema: 'replica.prompt-bundle@1',
      source_fields_revision: fields.fields_revision,
      kit_version: command.payload.kit_version,
      model_id: command.payload.model_id,
      prompts: shots.map((shot) => ({
        shot_id: shot.shot_id,
        image_prompt: [shot.shot_size, shot.camera_position, shot.lighting, shot.replacement].join('；'),
        video_prompt: [shot.camera_move, shot.sound, `时长${shot.duration_ms}ms`].join('；'),
        structured_fields: shot,
      })),
    };
    const serialized = json(content);
    const contentHash = hash(serialized);
    const prior = this.db.prepare(`SELECT bundle_id FROM prompt_bundles WHERE project_id=? AND source_fields_revision=? AND kit_version=? AND model_id=? AND content_hash=?`)
      .get(project.id, fields.fields_revision, command.payload.kit_version, command.payload.model_id, contentHash) as unknown as { bundle_id: string } | undefined;
    const bundleId = prior?.bundle_id ?? randomUUID();
    if (!prior) {
      this.db.prepare(`INSERT INTO prompt_bundles(bundle_id, project_id, source_fields_revision, kit_version, model_id, content_json, content_hash, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'CURRENT', ?)`)
        .run(bundleId, project.id, fields.fields_revision, command.payload.kit_version, command.payload.model_id, serialized, contentHash, now());
    }
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, 'STORYBOARDING', now());
    this.event(project.id, revision, 'prompt.derived', command, { bundle_id: bundleId, content_hash: contentHash, source_fields_revision: fields.fields_revision, reused: Boolean(prior) });
    return this.envelope(command, project.id, revision, { bundle_id: bundleId, content_hash: contentHash, content, reused: Boolean(prior) });
  }

  private addCandidate(command: Extract<DomainCommand, { type: 'image-candidate.add' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const fields = this.shotFields(project.id);
    assertDomain(fields, 'SHOT_FIELDS_REQUIRED', '缺少 ShotFields');
    const shots = JSON.parse(fields.shots_json) as ShotField[];
    assertDomain(shots.some((shot) => shot.shot_id === command.payload.shot_id), 'SHOT_NOT_FOUND', '候选所属镜头不存在', 404);
    /**
     * 重复候选必须给出明确的领域错误。
     * 不能把主键冲突留给 SQLite：那样会冒泡成 500 INTERNAL_ERROR，
     * 调用方（UI / CLI / Agent）就分不清「输入不合法」与「服务端故障」了。
     */
    const duplicated = this.db.prepare('SELECT candidate_id FROM image_candidates WHERE project_id=? AND candidate_id=?')
      .get(project.id, command.payload.candidate_id) as unknown as { candidate_id: string } | undefined;
    assertDomain(!duplicated, 'CANDIDATE_ALREADY_EXISTS', `图片候选已存在：${command.payload.candidate_id}`, 409);
    this.db.prepare(`INSERT INTO image_candidates(project_id, shot_id, candidate_id, artifact_id, status, created_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)`)
      .run(project.id, command.payload.shot_id, command.payload.candidate_id, command.payload.artifact_id, now());
    this.supersedeGates(project.id, ['G2']);
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, 'IMAGE_SELECTING', now());
    this.event(project.id, revision, 'image-candidate.added', command, command.payload);
    return this.envelope(command, project.id, revision, { ...command.payload, status: 'ACTIVE' });
  }

  private selectCandidate(command: Extract<DomainCommand, { type: 'image-candidate.select' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const candidate = this.db.prepare(`SELECT shot_id FROM image_candidates WHERE project_id=? AND candidate_id=? AND status='ACTIVE'`).get(project.id, command.payload.candidate_id) as unknown as { shot_id: string } | undefined;
    assertDomain(candidate, 'CANDIDATE_NOT_FOUND', '图片候选不存在或已失效', 404);
    assertDomain(candidate.shot_id === command.payload.shot_id, 'CANDIDATE_SHOT_MISMATCH', '候选不属于指定镜头', 409);
    const current = this.db.prepare('SELECT selection_revision FROM selections WHERE project_id=? AND shot_id=?').get(project.id, command.payload.shot_id) as unknown as { selection_revision: number } | undefined;
    const currentRevision = current?.selection_revision ?? 0;
    assertDomain(currentRevision === command.payload.expected_selection_revision, 'SELECTION_REVISION_CONFLICT', '选帧 revision 冲突', 409, { expected: command.payload.expected_selection_revision, actual: currentRevision });
    const selectionRevision = currentRevision + 1;
    this.db.prepare(`INSERT INTO selections(project_id, shot_id, candidate_id, selection_revision, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, shot_id) DO UPDATE SET candidate_id=excluded.candidate_id, selection_revision=excluded.selection_revision, updated_at=excluded.updated_at`)
      .run(project.id, command.payload.shot_id, command.payload.candidate_id, selectionRevision, now());
    this.supersedeGates(project.id, ['G2']);
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, 'G2_PENDING', now());
    this.event(project.id, revision, 'image-candidate.selected', command, { ...command.payload, selection_revision: selectionRevision });
    return this.envelope(command, project.id, revision, { shot_id: command.payload.shot_id, candidate_id: command.payload.candidate_id, selection_revision: selectionRevision });
  }

  /**
   * 移除一张图片候选（**不删产物本身**）。
   *
   * 为什么必须有这条：`artifact.delete` 会在"这份产物还被当作候选"时拒绝删除，
   * 而在它之前**没有任何办法把候选摘掉**——一张不满意的图只能永远留在项目里。
   * 真机上撞到过（验证用的占位图候选删不掉），小QTV 那边候选是可以清掉的。
   *
   * 三件事按顺序做，缺一件都会留下脏数据：
   *   ① 候选行删掉——摘掉之后 `artifact.delete` 才轮得到这份产物；
   *   ② 它要是**当前选中的那张**，选择一起清掉。否则会留下一条指向不存在候选的选帧，
   *      下游（生成视频）读出来就是一个永远找不到的 candidate_id；
   *   ③ **动过选帧才作废 G2**（第一帧变了，之前批准的视频生产不能照旧）。
   *      删的是一张没选中的候选时不动闸门——那只是清理，不该打断已经批准的事。
   */
  private removeCandidate(command: Extract<DomainCommand, { type: 'image-candidate.remove' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const candidate = this.db.prepare('SELECT shot_id FROM image_candidates WHERE project_id=? AND candidate_id=?')
      .get(project.id, command.payload.candidate_id) as unknown as { shot_id: string } | undefined;
    assertDomain(candidate, 'CANDIDATE_NOT_FOUND', '这张图片候选不存在（可能已经被移除过了）', 404);
    const selection = this.db.prepare('SELECT candidate_id FROM selections WHERE project_id=? AND shot_id=?')
      .get(project.id, candidate.shot_id) as unknown as { candidate_id: string } | undefined;
    const wasSelected = selection?.candidate_id === command.payload.candidate_id;

    this.db.prepare('DELETE FROM image_candidates WHERE project_id=? AND candidate_id=?')
      .run(project.id, command.payload.candidate_id);
    if (wasSelected) {
      this.db.prepare('DELETE FROM selections WHERE project_id=? AND shot_id=?').run(project.id, candidate.shot_id);
      this.supersedeGates(project.id, ['G2']);
    }

    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, wasSelected ? 'G2_PENDING' : 'IMAGE_SELECTING', now());
    this.event(project.id, revision, 'image-candidate.removed', command, {
      ...command.payload,
      shot_id: candidate.shot_id,
      was_selected: wasSelected,
    });
    return this.envelope(command, project.id, revision, {
      candidate_id: command.payload.candidate_id,
      shot_id: candidate.shot_id,
      was_selected: wasSelected,
    });
  }

  private requestVideo(command: Extract<DomainCommand, { type: 'video.request' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const g2 = this.currentGate(project.id, 'G2');
    assertDomain(g2?.status === 'APPROVED', 'G2_REQUIRED', '未批准 G2，禁止创建视频生成请求', 403);
    const approved = g2.approved_budget_cents ?? 0;
    assertDomain(project.reserved_budget_cents + command.payload.estimated_cost_cents <= approved, 'G2_BUDGET_EXCEEDED', '视频请求超过 G2 已批准预算', 409);
    assertDomain(project.reserved_budget_cents + command.payload.estimated_cost_cents <= project.max_budget_cents, 'PROJECT_BUDGET_EXCEEDED', '视频请求超过项目预算', 409);
    const selection = this.db.prepare(
      `SELECT s.candidate_id, c.status AS candidate_status
       FROM selections s
       LEFT JOIN image_candidates c ON c.project_id = s.project_id AND c.candidate_id = s.candidate_id
       WHERE s.project_id=? AND s.shot_id=?`,
    ).get(project.id, command.payload.shot_id) as unknown as { candidate_id: string; candidate_status: string | null } | undefined;
    assertDomain(selection, 'FIRST_FRAME_REQUIRED', '该镜头尚未选择首帧', 409);
    /**
     * 首帧候选必须是 ACTIVE。
     * 「选帧记录还在」就放行，等于拿一版已作废的首帧去生成视频。
     */
    assertDomain(
      selection.candidate_status === 'ACTIVE',
      'FIRST_FRAME_SUPERSEDED',
      '该镜头的首帧已失效（候选被上游变更取代），必须重新选帧',
      409,
    );
    const intentId = randomUUID();
    this.db.prepare(`INSERT INTO video_intents(intent_id, project_id, shot_id, estimated_cost_cents, status, created_at) VALUES (?, ?, ?, ?, 'ADMITTED', ?)`)
      .run(intentId, project.id, command.payload.shot_id, command.payload.estimated_cost_cents, now());
    const revision = project.revision + 1;
    this.db.prepare(`UPDATE projects SET revision=?, state='VIDEO_GENERATING', reserved_budget_cents=reserved_budget_cents+?, updated_at=? WHERE id=?`)
      .run(revision, command.payload.estimated_cost_cents, now(), project.id);
    this.event(project.id, revision, 'video-intent.admitted', command, { intent_id: intentId, shot_id: command.payload.shot_id, selected_candidate_id: selection.candidate_id, estimated_cost_cents: command.payload.estimated_cost_cents });
    return this.envelope(command, project.id, revision, { intent_id: intentId, status: 'ADMITTED', provider_started: false });
  }

  /**
   * 登记一次内核校验意图。
   *
   * 只登记、不执行：前置内核是独立进程，领域层不在这里同步等待它。
   * 这样做的收益是——即使 GUI 或内核当场挂掉，「这次校验被请求过」仍然留在审计里，
   * 重启后可以按 task_id 对账，而不是变成一段谁也不知道发生过什么的历史。
   */
  private requestKernelCheck(command: Extract<DomainCommand, { type: 'kernel.check' }>): ResultEnvelope {
    return this.requestKernelTask(command, 'check');
  }

  /** 登记一次内核规划意图。与校验同构，只是 kind 不同。 */
  private requestKernelPlan(command: Extract<DomainCommand, { type: 'kernel.plan' }>): ResultEnvelope {
    return this.requestKernelTask(command, 'plan');
  }

  /** 登记一次内核构建意图。真正执行由上层发起，这里只负责留下事实。 */
  private requestKernelBuild(command: Extract<DomainCommand, { type: 'kernel.build' }>): ResultEnvelope {
    return this.requestKernelTask(command, 'build');
  }

  /** 登记一次参考视频分析意图。 */
  private requestKernelAnalyze(command: Extract<DomainCommand, { type: 'kernel.analyze' }>): ResultEnvelope {
    return this.requestKernelTask(command, 'analyze');
  }

  /** 登记一次逐词转录意图；真正的 Provider 调用仍由内核服务执行。 */
  private requestKernelTranscribe(command: Extract<DomainCommand, { type: 'kernel.transcribe' }>): ResultEnvelope {
    return this.requestKernelTask(command, 'transcribe');
  }

  private requestKernelTask(
    command: Extract<DomainCommand, { type: 'kernel.check' | 'kernel.plan' | 'kernel.build' | 'kernel.analyze' | 'kernel.transcribe' }>,
    kind: 'check' | 'plan' | 'build' | 'analyze' | 'transcribe',
  ): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const sourcePath = command.payload.source_path;
    /**
     * 领域协议不接受裸绝对路径（架构 v2.3 §7.1）。
     * 绝对路径会把开发机目录结构写进项目事实，导出与迁移时立刻变成坏引用。
     */
    assertDomain(
      !isAbsoluteLikePath(sourcePath),
      'ABSOLUTE_PATH_FORBIDDEN',
      'Source 路径必须是项目内的相对路径',
      422,
      { source_path: sourcePath },
    );
    const taskId = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO kernel_tasks(task_id, project_id, kind, source_path, purpose, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ADMITTED', ?, ?)`)
      .run(taskId, project.id, kind, sourcePath, command.payload.purpose ?? null, timestamp, timestamp);
    const revision = project.revision + 1;
    const state = kind === 'plan' ? 'KERNEL_PLANNING'
      : kind === 'build' ? 'KERNEL_BUILDING'
        : kind === 'analyze' ? 'ANALYZING'
          : kind === 'transcribe' ? 'TRANSCRIBING'
            : 'KERNEL_CHECKING';
    this.advanceProject(project.id, revision, state, timestamp);
    this.event(project.id, revision, `kernel-${kind}.requested`, command, {
      task_id: taskId,
      kind,
      source_path: sourcePath,
      purpose: command.payload.purpose ?? null,
    });
    return this.envelope(command, project.id, revision, {
      task_id: taskId,
      kind,
      source_path: sourcePath,
      status: 'ADMITTED',
      kernel_started: false,
    });
  }

  /**
   * 回填内核校验结果。
   *
   * `status` 描述的是**执行**是否完成；报告内部的 `ok` 描述的是**校验**是否通过。
   * 两者不能混为一谈：Source 有语法错误是一次成功执行的失败结论，
   * 而内核崩了才是执行失败。
   */
  private recordKernelResult(command: Extract<DomainCommand, { type: 'kernel.result.record' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const task = this.db.prepare('SELECT task_id, kind, source_path, status FROM kernel_tasks WHERE task_id=? AND project_id=?')
      .get(command.payload.task_id, project.id) as unknown as { task_id: string; kind: string; source_path: string; status: string } | undefined;
    assertDomain(task, 'KERNEL_TASK_NOT_FOUND', '内核任务不存在', 404);
    assertDomain(task.status === 'ADMITTED', 'KERNEL_TASK_ALREADY_SETTLED', '该内核任务已经回填过结果', 409);
    if (command.payload.status === 'COMPLETED') {
      assertDomain(command.payload.report !== undefined, 'KERNEL_REPORT_REQUIRED', '成功回填必须带上内核报告', 422);
    } else {
      assertDomain(command.payload.failure !== undefined, 'KERNEL_FAILURE_REQUIRED', '失败回填必须说明原因', 422);
    }
    const timestamp = now();
    this.db.prepare(`UPDATE kernel_tasks SET status=?, report_json=?, failure=?, updated_at=? WHERE task_id=?`)
      .run(
        command.payload.status,
        command.payload.report ? json(command.payload.report) : null,
        command.payload.failure ?? null,
        timestamp,
        task.task_id,
      );
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, 'BREAKDOWN_EDITING', timestamp);
    this.event(project.id, revision, `kernel-${task.kind}.${command.payload.status === 'COMPLETED' ? 'completed' : 'failed'}`, command, {
      task_id: task.task_id,
      kind: task.kind,
      source_path: task.source_path,
      report: command.payload.report ?? null,
      failure: command.payload.failure ?? null,
    });
    return this.envelope(command, project.id, revision, {
      task_id: task.task_id,
      status: command.payload.status,
      kind: task.kind,
    });
  }

  private registerSubject(command: Extract<DomainCommand, { type: 'subject.register' }>): ResultEnvelope {
    const { subject_ref, display_name } = command.payload;
    const timestamp = now();
    const existing = this.db.prepare('SELECT subject_ref FROM registered_subjects WHERE subject_ref=?')
      .get(subject_ref) as unknown as { subject_ref: string } | undefined;
    this.db.prepare(`INSERT INTO registered_subjects(subject_ref, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(subject_ref) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at`)
      .run(subject_ref, display_name, timestamp, timestamp);
    // 主体是全局资源、不属于任何项目，因此不写项目事件
    return this.envelope(command, null, null, {
      subject_ref,
      display_name,
      registered: true,
      created: !existing,
    });
  }

  /**
   * 写入一份主体档案（ASSET-003「可复用主体」/ ASSET-005「绑定音色」/ ASSET-006「描述」）。

   * 两件事必须在这里做，而不是交给界面：

     · **规则校验**：图片张数与第一张正脸、视频时长与"仅人物"、音色时长/格式/授权、
       描述字数——这些判断来自线上词条，界面与领域层共用 `validateSubjectProfile`。
       界面拦住只是体验，**领域层再判一次才是约束**；
     · **顺手登记**：档案存在就意味着这个主体可以被空间方案引用，
       所以同一条命令里把 `registered_subjects` 也补上。
       分两条命令写，迟早有人只调其中一条。

   * 主体是全局资源，因此不写项目事件、不推进项目 revision——
   * 和 `subject.register` 同一条口径。
   */
  private setSubjectProfile(command: Extract<DomainCommand, { type: 'subject.profile.set' }>): ResultEnvelope {
    const payload = command.payload;
    const problem = validateSubjectProfile({
      kind: payload.kind,
      display_name: payload.display_name,
      description: payload.description,
      images: payload.images,
      video: payload.video,
      voice: payload.voice,
    });
    if (problem !== null) throw new DomainError('SUBJECT_PROFILE_INVALID', problem, 422);

    /*
      引用的产物必须**真实存在、类型对得上**。

      这一步比看起来重要：主体档案里存的是 artifact_id，
      而 artifact_id 只是一个内容哈希——写错一位、或者那份产物已经被删掉，
      档案照样能存下去，等到生成那一刻才炸，那时钱已经花了。
      所以这里逐个回查 `artifacts`（全局内容寻址表），对不上就当场拒绝。
    */
    const mediaTypeOf = (artifactId: string): string | null => {
      const row = this.db.prepare('SELECT media_type FROM artifacts WHERE artifact_id=?')
        .get(artifactId) as unknown as { media_type: string } | undefined;
      return row?.media_type ?? null;
    };
    const requireMedia = (artifactId: string, prefixes: readonly string[], what: string): void => {
      const mediaType = mediaTypeOf(artifactId);
      if (mediaType === null) {
        throw new DomainError('SUBJECT_MEDIA_MISSING', `${what}指向的素材不存在：${artifactId}`, 422);
      }
      if (!prefixes.some((prefix) => mediaType.startsWith(prefix))) {
        throw new DomainError('SUBJECT_MEDIA_TYPE', `${what}的素材类型不对：${mediaType}`, 422, { artifact_id: artifactId, media_type: mediaType });
      }
    };
    for (const image of payload.images) requireMedia(image.artifact_id, ['image/'], '参考图');
    if (payload.video !== null) requireMedia(payload.video.artifact_id, ['video/'], '视频素材');
    if (payload.voice !== null) requireMedia(payload.voice.artifact_id, ['audio/', 'video/'], '音色素材');

    const timestamp = now();
    const existing = this.db.prepare('SELECT created_at FROM subject_profiles WHERE subject_ref=?')
      .get(payload.subject_ref) as unknown as { created_at: string } | undefined;
    const profile: SubjectProfile = {
      schema: 'replica.subject-profile@1',
      subject_ref: payload.subject_ref,
      display_name: payload.display_name,
      kind: payload.kind,
      description: payload.description,
      tags: payload.tags,
      images: payload.images,
      video: payload.video,
      voice: payload.voice,
      smart_completion: payload.smart_completion,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
    };

    this.db.prepare(`INSERT INTO subject_profiles(subject_ref, display_name, kind, profile_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_ref) DO UPDATE SET display_name=excluded.display_name, kind=excluded.kind,
        profile_json=excluded.profile_json, updated_at=excluded.updated_at`)
      .run(profile.subject_ref, profile.display_name, profile.kind, json(profile), profile.created_at, profile.updated_at);

    /* 顺手登记：档案存在 = 这个主体可以被引用 */
    this.db.prepare(`INSERT INTO registered_subjects(subject_ref, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(subject_ref) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at`)
      .run(profile.subject_ref, profile.display_name, profile.created_at, timestamp);

    return this.envelope(command, null, null, {
      subject_ref: profile.subject_ref,
      created: !existing,
      profile,
    });
  }

  /** 删掉一份主体档案（登记也一并撤销——留着一半反而更让人困惑）。 */
  private removeSubjectProfile(command: Extract<DomainCommand, { type: 'subject.profile.remove' }>): ResultEnvelope {
    const { subject_ref } = command.payload;
    const existing = this.db.prepare('SELECT subject_ref FROM subject_profiles WHERE subject_ref=?')
      .get(subject_ref) as unknown as { subject_ref: string } | undefined;
    assertDomain(existing, 'SUBJECT_PROFILE_NOT_FOUND', `没有这个主体档案：${subject_ref}`, 404);
    this.db.prepare('DELETE FROM subject_profiles WHERE subject_ref=?').run(subject_ref);
    this.db.prepare('DELETE FROM registered_subjects WHERE subject_ref=?').run(subject_ref);
    return this.envelope(command, null, null, { subject_ref, removed: true });
  }

  /**
   * 存一份画布模板（CAN-010「我的工具箱」/ FLOW-008「流水线固化」）。

   * 两条口径：

     · `node_count` / `edge_count` **由这里数出来**，不接受调用方声明——
       让调用方填就是一个可以撒谎的字段，而界面上正好会显示它；
     · 同名模板**覆盖**（同 `template_id` 即同一条），这样"改完再存一次"
       不会在工具箱里堆出一串同名条目。
   */
  private setTemplate(command: Extract<DomainCommand, { type: 'template.save' }>): ResultEnvelope {
    const { template_id, name, kind, payload } = command.payload;
    const nodeCount = payload.nodes.length;
    const edgeCount = payload.edges.length;
    if (nodeCount === 0) {
      throw new DomainError('TEMPLATE_EMPTY', '这份模板里没有节点，存下来也用不了', 422);
    }
    const timestamp = now();
    const existing = this.db.prepare('SELECT created_at FROM templates WHERE template_id=?')
      .get(template_id) as unknown as { created_at: string } | undefined;
    const createdAt = existing?.created_at ?? timestamp;
    this.db.prepare(`INSERT INTO templates(template_id, name, kind, node_count, edge_count, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(template_id) DO UPDATE SET name=excluded.name, kind=excluded.kind,
        node_count=excluded.node_count, edge_count=excluded.edge_count,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at`)
      .run(template_id, name, kind, nodeCount, edgeCount, json(payload), createdAt, timestamp);
    return this.envelope(command, null, null, {
      template_id,
      created: !existing,
      node_count: nodeCount,
      edge_count: edgeCount,
    });
  }

  private removeTemplate(command: Extract<DomainCommand, { type: 'template.remove' }>): ResultEnvelope {
    const { template_id } = command.payload;
    const existing = this.db.prepare('SELECT template_id FROM templates WHERE template_id=?')
      .get(template_id) as unknown as { template_id: string } | undefined;
    assertDomain(existing, 'TEMPLATE_NOT_FOUND', `没有这个模板：${template_id}`, 404);
    this.db.prepare('DELETE FROM templates WHERE template_id=?').run(template_id);
    return this.envelope(command, null, null, { template_id, removed: true });
  }

  /**
   * 申请一次**项目级**生成（主体补全 / 音频生成）。

   * 与图片/视频那两条的区别只有一个：**没有镜头**。其余规矩一条不少——
   * 尤其是"先预留预算"：不预留就没有上限，而这是一次真实付费调用。
   *
   * 不查 G1/G2：那两道闸门管的是"拆解冻结"与"允许花视频的钱"。
   * 给主体补两张视角图、合成一段配音，与镜头拆解没有任何关系，
   * 拿它们来拦只会让用户困惑。
   */
  private requestAssetGeneration(command: Extract<DomainCommand, { type: 'asset-generation.request' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const cost = command.payload.estimated_cost_cents;
    assertDomain(
      project.reserved_budget_cents + cost <= project.max_budget_cents,
      'PROJECT_BUDGET_EXCEEDED',
      '本次生成会超过项目预算',
      409,
      { reserved_budget_cents: project.reserved_budget_cents, max_budget_cents: project.max_budget_cents, requested_cents: cost },
    );

    const intentId = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO asset_generation_intents(
        intent_id, project_id, kind, purpose, model, prompt, estimated_cost_cents,
        status, digest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ADMITTED', ?, ?, ?)`).run(
      intentId, project.id, command.payload.kind, command.payload.purpose, command.payload.model,
      command.payload.prompt ?? null, cost, command.payload.digest ?? null, timestamp, timestamp,
    );
    const revision = project.revision + 1;
    this.db.prepare('UPDATE projects SET revision=?, reserved_budget_cents=reserved_budget_cents+?, updated_at=? WHERE id=?')
      .run(revision, cost, timestamp, project.id);
    this.event(project.id, revision, 'asset-generation.requested', command, {
      intent_id: intentId,
      kind: command.payload.kind,
      purpose: command.payload.purpose,
      model: command.payload.model,
      estimated_cost_cents: cost,
      digest: command.payload.digest ?? null,
    });
    return this.envelope(command, project.id, revision, {
      intent_id: intentId,
      kind: command.payload.kind,
      purpose: command.payload.purpose,
      status: 'ADMITTED',
      estimated_cost_cents: cost,
      provider_started: false,
    });
  }

  /**
   * 结清一次项目级生成。

   * 成功**必须带产物 id**：这条链路上最贵的错误是"报成功但其实没有东西"——
   * 用户以为拿到了两张视角图，档案里却什么也没加。
   * 所以成功却没产物 = 拒绝，让调用方按失败重来或按失败结清。
   */
  private settleAssetGeneration(command: Extract<DomainCommand, { type: 'asset-generation.settle' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const intent = this.db.prepare(
      'SELECT intent_id, kind, purpose, estimated_cost_cents, status FROM asset_generation_intents WHERE intent_id=? AND project_id=?',
    ).get(command.payload.intent_id, project.id) as unknown as
      { intent_id: string; kind: string; purpose: string; estimated_cost_cents: number; status: string } | undefined;
    assertDomain(intent, 'ASSET_INTENT_NOT_FOUND', '这次生成的意图不存在', 404);
    assertDomain(intent.status === 'ADMITTED', 'ASSET_INTENT_ALREADY_SETTLED', '这次生成已经结清过了', 409);
    if (command.payload.status === 'COMPLETED') {
      assertDomain(command.payload.artifact_id !== undefined, 'ASSET_ARTIFACT_REQUIRED', '成功结清必须带上产物 id', 422);
    } else {
      assertDomain(command.payload.failure !== undefined, 'ASSET_FAILURE_REQUIRED', '失败结清必须说明原因', 422);
    }

    const timestamp = now();
    const settled = settleCostFields(command.payload, intent.estimated_cost_cents);
    this.db.prepare(`UPDATE asset_generation_intents SET status=?, actual_cost_cents=?, provider_cost_unit=?,
        provider_cost_amount=?, artifact_id=?, failure=?, reservation_released_reason=?, updated_at=?
      WHERE intent_id=?`).run(
      command.payload.status, settled.actualCents, settled.providerCostUnit, settled.providerCostAmount,
      command.payload.artifact_id ?? null, command.payload.failure ?? null, settled.releasedReason,
      timestamp, intent.intent_id,
    );
    const revision = project.revision + 1;
    this.db.prepare('UPDATE projects SET revision=?, reserved_budget_cents=MAX(0, reserved_budget_cents + ?), updated_at=? WHERE id=?')
      .run(revision, settled.delta, timestamp, project.id);
    this.event(project.id, revision,
      command.payload.status === 'COMPLETED' ? 'asset-generation.completed' : 'asset-generation.failed',
      command,
      {
        intent_id: intent.intent_id,
        kind: intent.kind,
        purpose: intent.purpose,
        estimated_cost_cents: intent.estimated_cost_cents,
        actual_cost_cents: settled.actualCents,
        provider_cost: command.payload.provider_cost ?? null,
        artifact_id: command.payload.artifact_id ?? null,
        failure: command.payload.failure ?? null,
        reservation_released_reason: settled.releasedReason,
      });
    return this.envelope(command, project.id, revision, {
      intent_id: intent.intent_id,
      status: command.payload.status,
      actual_cost_cents: settled.actualCents,
      released_cents: settled.releasedCents,
      reservation_released_reason: settled.releasedReason,
    });
  }

  /** 项目级生成意图清单（新的在前）。 */
  listAssetGenerationIntents(projectId: string): unknown[] {
    return this.db.prepare(
      `SELECT intent_id, kind, purpose, model, prompt, estimated_cost_cents, actual_cost_cents,
        provider_cost_unit, provider_cost_amount, status, artifact_id, failure,
        reservation_released_reason, digest, created_at
       FROM asset_generation_intents WHERE project_id=? ORDER BY created_at DESC`,
    ).all(projectId);
  }

  /** 模板清单（最近改过的排前面——"我的工具箱"里刚存的应当在最上面）。 */
  listTemplates(): unknown[] {
    const rows = this.db.prepare(
      'SELECT template_id, name, kind, node_count, edge_count, payload_json, created_at, updated_at FROM templates ORDER BY updated_at DESC',
    ).all() as unknown as Array<{
      template_id: string; name: string; kind: string; node_count: number; edge_count: number;
      payload_json: string; created_at: string; updated_at: string;
    }>;
    return rows.map((row) => ({
      template_id: row.template_id,
      name: row.name,
      kind: row.kind,
      node_count: row.node_count,
      edge_count: row.edge_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
      payload: JSON.parse(row.payload_json) as unknown,
    }));
  }

  /**
   * 发布一个内容寻址 Artifact。
   *
   * 主键就是内容哈希，所以同一 id 重复发布幂等、也不可能覆盖旧内容——
   * 这正是「重复截图产生新 Artifact 而非覆盖」这条规则的实现基础。
   */
  /**
   * 删掉一份产物。
   *
   * **先查引用，再删**——而且查的是所有项目，不只当前这个：
   * `artifacts` 表是全局内容寻址的，同一份内容可能被别的项目当候选、当片段、当蓝图。
   * 只查当前项目就删，另一个项目那边会突然指向空白，而报错点在很远的地方。
   *
   * 报错时要说清"还在用在哪"：一句"还有引用"用户没法处理，
   * 而"它还是第 3 镜的首帧候选"能直接告诉他先去哪儿解绑。
   */
  private deleteArtifact(command: Extract<DomainCommand, { type: 'artifact.delete' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const artifactId = command.payload.artifact_id;
    const artifact = this.db.prepare('SELECT artifact_id FROM artifacts WHERE artifact_id=?')
      .get(artifactId) as unknown as { artifact_id: string } | undefined;
    assertDomain(artifact, 'ARTIFACT_NOT_FOUND', '这份产物不存在（可能已经被删过了）', 404);

    /* ① 候选（首帧） */
    const asCandidate = this.db.prepare(
      'SELECT project_id, shot_id, candidate_id FROM image_candidates WHERE artifact_id=? LIMIT 5',
    ).all(artifactId) as unknown as Array<{ project_id: string; shot_id: string; candidate_id: string }>;
    /* ② 生成出来的片段 */
    const asClip = this.db.prepare(
      'SELECT project_id, shot_id FROM video_generation_intents WHERE clip_artifact_id=? LIMIT 5',
    ).all(artifactId) as unknown as Array<{ project_id: string; shot_id: string }>;
    /* ③ 空间方案里的构图蓝图：它在 plan_json 里，只能按字符串先粗筛再确认 */
    const asBlueprint: Array<{ project_id: string; shot_id: string }> = [];
    for (const row of this.db.prepare(
      "SELECT project_id, shot_id, plan_json FROM spatial_plans WHERE plan_json LIKE '%' || ? || '%' LIMIT 20",
    ).all(artifactId) as unknown as Array<{ project_id: string; shot_id: string; plan_json: string }>) {
      try {
        const plan = JSON.parse(row.plan_json) as { blueprint?: { artifact_id?: unknown } };
        if (plan.blueprint?.artifact_id === artifactId) {
          asBlueprint.push({ project_id: row.project_id, shot_id: row.shot_id });
        }
      } catch {
        /* 坏 JSON 不当引用（那是数据问题，不该让删除也做不了） */
      }
    }
    /* ④ 评估报告与修复方案：同样按字符串粗筛——宁严勿松，误拦比误删便宜 */
    const mentionedElsewhere: string[] = [];
    for (const table of ['eval_reports', 'repair_plans'] as const) {
      const column = table === 'eval_reports' ? 'report_json' : 'plan_json';
      const hits = this.db.prepare(
        `SELECT project_id FROM ${table} WHERE ${column} LIKE '%' || ? || '%' LIMIT 1`,
      ).get(artifactId) as unknown as { project_id: string } | undefined;
      if (hits) mentionedElsewhere.push(table === 'eval_reports' ? '评估报告' : '修复方案');
    }

    const reasons: string[] = [];
    // 内容寻址产物是全局身份；保护其他项目画布候选与时间线引用，不能只看当前删除请求的项目。
    for (const [table, label] of [['canvas_documents', '画布节点或候选'], ['timeline_documents', '时间线片段']] as const) {
      const hit = this.db.prepare(`SELECT project_id FROM ${table} WHERE document_json LIKE '%' || ? || '%' LIMIT 1`).get(artifactId) as unknown as { project_id: string } | undefined;
      if (hit) reasons.push(hit.project_id === project.id ? `它仍被${label}引用` : `它仍被另一个项目的${label}引用`);
    }
    if (asCandidate.length > 0) {
      const first = asCandidate[0]!;
      reasons.push(first.project_id === project.id
        ? `它还是「${first.shot_id}」的首帧候选`
        : `它还是另一个项目里「${first.shot_id}」的首帧候选`);
    }
    if (asClip.length > 0) {
      const first = asClip[0]!;
      reasons.push(first.project_id === project.id
        ? `它是「${first.shot_id}」已生成的片段`
        : `它是另一个项目里「${first.shot_id}」已生成的片段`);
    }
    if (asBlueprint.length > 0) {
      const first = asBlueprint[0]!;
      reasons.push(`它是「${first.shot_id}」空间方案里的构图蓝图`);
    }
    if (mentionedElsewhere.length > 0) {
      reasons.push(`它被${mentionedElsewhere.join('、')}引用`);
    }
    assertDomain(
      reasons.length === 0,
      'ARTIFACT_STILL_REFERENCED',
      `这份产物还在用，不能删：${reasons.join('；')}`,
      409,
      { reasons },
    );

    const metadata = this.db.prepare('SELECT metadata_json FROM artifacts WHERE artifact_id=?')
      .get(artifactId) as unknown as { metadata_json: string | null };
    /*
      路径有**两个名字**，这是全仓库既有的约定：
        上传类写 `artifact_path_relative`（`qiyin:artifact:upload`）
        生成类写 `frame_path_relative`（生成服务发布候选时，见
          packages/generation-service/src/index.ts 里那段"两个键都要认"的解析）
      别处（主进程的 artifactPathRelativeTo、生成服务的 resolver）一律是**两个都认**，
      只有这里原来只认第一个——真机上撞到过：生成出来的候选删掉记录之后
      `artifact_path_relative` 回 null，于是主进程连文件都不去删，
      界面只能写一句"磁盘文件没删掉，可能需要手动清理"，**连路径都不给**。
    */
    const relativePath = artifactRelativePathOf(metadata.metadata_json);

    this.db.prepare('DELETE FROM artifacts WHERE artifact_id=?').run(artifactId);
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, project.state, now());
    this.event(project.id, revision, 'artifact.deleted', command, {
      artifact_id: artifactId,
      /* 路径要回给主进程去删文件；它不落库（删完这份记录就没了） */
      artifact_path_relative: relativePath,
    });
    return this.envelope(command, project.id, revision, {
      artifact_id: artifactId,
      artifact_path_relative: relativePath,
    });
  }

  private publishArtifact(command: Extract<DomainCommand, { type: 'artifact.publish' }>): ResultEnvelope {
    const { artifact_id, media_type, bytes, metadata } = command.payload;
    const existing = this.db.prepare('SELECT status, metadata_json FROM artifacts WHERE artifact_id=?')
      .get(artifact_id) as unknown as { status: string; metadata_json: string | null } | undefined;
    if (existing) {
      /**
       * 内容相同就复用，但**位置不是内容的一部分**。
       *
       * 踩过的坑（实测）：同一张首帧第二次被抽出来时，内容哈希一样 → artifact_id 一样，
       * 于是这里直接返回、metadata 不更新。可 metadata 里存着 `frame_path_relative`，
       * 而新一批抽帧落在**新的时间戳目录**里。结果这份产物一直指向上一批那个已经被清掉的路径，
       * 直到成片那一步才炸：`ENOENT: no such file or directory, realpath '…/frames/<旧批次>/frame-0_000s.jpg'`。
       * 报错离起因隔了好几步，很难往"发布是幂等的"上面想。
       *
       * 所以这里改成**合并 metadata**（新值覆盖同名字段，其它字段保留）：
       * 产物身份仍由内容决定，但"它现在在哪"跟着最新一次发布走。
       */
      if (metadata !== undefined) {
        const merged = { ...(existing.metadata_json ? JSON.parse(existing.metadata_json) as Record<string, unknown> : {}), ...metadata };
        /*
          记下"这个项目里的那一份在哪"。

          产物是内容寻址的：同一份文件传到两个项目，`artifacts` 表里只有一行。
          没有这份映射时，后一次发布会把前一次的项目指向的路径顶掉——
          而磁盘上那个项目的副本还在，只是**没人记得它了**。
        */
        const stored = withProjectCopy(merged) ?? merged;
        this.db.prepare('UPDATE artifacts SET metadata_json=? WHERE artifact_id=?').run(json(stored), artifact_id);
        /*
          落点变了就把"被顶替的那一份"报出去（见 onArtifactSuperseded 的说明）：
          记录跟着新路径走，旧路径那份文件得有人删——领域层不碰磁盘，交给主进程。

          项目 id 只能从 metadata 里取：`artifact.publish` 是**全局**命令
          （schema 里没有 project_id 字段——产物表本来就是全局的），
          而发布方（生成类、抽帧类）都会把 project_id 写进 metadata。
        */
        const before = artifactRelativePathOf(existing.metadata_json);
        const after = artifactRelativePathOf(json(metadata));
        /*
          只有**同一个项目内**换了落点才算顶替。

          跨项目的那条路径是"另一个项目目录里的副本"，删不得——
          早先的判据只看"路径变了没有"，于是跨项目上传时会对一个
          根本不存在的路径发起删除（侥幸没伤到东西，因为拼出来的路径是错的）。
        */
        const declared = merged.project_id;
        const publisher = typeof declared === 'string' && declared !== '' ? declared : null;
        const previousOwner = before === null ? null : projectOwningCopy(existing.metadata_json, before);
        const isSupersede = before !== null && after !== null && before !== after
          && (previousOwner === null || previousOwner === publisher);
        if (isSupersede) {
          this.onArtifactSuperseded?.({ artifactId: artifact_id, projectId: publisher, from: before, to: after });
          return this.envelope(command, null, null, {
            artifact_id, status: existing.status, published: true, reused: true,
            superseded_path_relative: before,
          });
        }
      }
      return this.envelope(command, null, null, { artifact_id, status: existing.status, published: true, reused: true });
    }
    const stored = withProjectCopy(metadata) ?? metadata;
    this.db.prepare(`INSERT INTO artifacts(artifact_id, media_type, bytes, metadata_json, status, created_at)
      VALUES (?, ?, ?, ?, 'PUBLISHED', ?)`)
      .run(artifact_id, media_type, bytes, stored ? json(stored) : null, now());
    return this.envelope(command, null, null, { artifact_id, status: 'PUBLISHED', published: true, reused: false });
  }

  /**
   * 设置某个镜头的空间计划（v2.3 §7.5 / 阶段 S3.5）。
   *
   * 三条最容易做错的地方：
   *   1. 空对象是「未启用空间控制」，必须原样放行，不能当成缺字段拒绝；
   *   2. 参数完全没变就不该推进 revision——否则拖一下 3D 预览视角都会击穿复用命中；
   *   3. 站位一变，本镜旧候选立刻作废，但其它镜头的候选一个都不能碰。
   */
  /**
   * 给一份资产打分（1–5），`stars: 0` 清除评分。
   *
   * 三个判断：
   *
   * ① **只接受已发布的产物。** 打分对象是 artifact_id，而编造的 id
   *    会在库里留下一条永远对不上任何东西的评分。界面上的资产本来就都来自
   *    产物，所以这一条不会挡住正常操作。
   *
   * ② **0 是"清除"，不是"打 0 星"。** 界面上"取消评分"就是同一件事，
   *    分成两个命令只会让调用方多一个判断——而那个判断迟早会写错一边。
   *
   * ③ **按项目存。** artifact 是全局内容寻址的（同一张图可能出现在多个项目里），
   *    但"这张图好不好"是就这个项目而言的判断：A 项目里的废片，
   *    在 B 项目里可能正好是要的素材。只按 artifact 存会让两个项目互相改分。
   */
  private rateAsset(command: Extract<DomainCommand, { type: 'asset.rate' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const { artifact_id, stars } = command.payload;
    const artifact = this.db.prepare('SELECT artifact_id FROM artifacts WHERE artifact_id=?')
      .get(artifact_id) as unknown as { artifact_id: string } | undefined;
    assertDomain(artifact, 'ARTIFACT_NOT_FOUND', '这份资产不存在（它还没成为项目产物）', 404);

    const timestamp = now();
    if (stars === 0) {
      this.db.prepare('DELETE FROM asset_ratings WHERE project_id=? AND artifact_id=?')
        .run(project.id, artifact_id);
    } else {
      this.db.prepare(`INSERT INTO asset_ratings(project_id, artifact_id, stars, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, artifact_id) DO UPDATE SET stars=excluded.stars, updated_at=excluded.updated_at`)
        .run(project.id, artifact_id, stars, timestamp);
    }
    const revision = project.revision + 1;
    this.db.prepare('UPDATE projects SET revision=?, updated_at=? WHERE id=?')
      .run(revision, timestamp, project.id);
    this.event(project.id, revision, 'asset.rated', command, { artifact_id, stars });
    return this.envelope(command, project.id, revision, { artifact_id, stars });
  }

  private setSpatialPlan(command: Extract<DomainCommand, { type: 'spatial-plan.set' }>): ResultEnvelope {
    const project = this.projectForWrite(command.project_id, command.expected_revision);
    const fields = this.shotFields(project.id);
    assertDomain(fields, 'SHOT_FIELDS_REQUIRED', '设置空间计划前必须存在镜头字段表');
    const shots = JSON.parse(fields.shots_json) as ShotField[];
    assertDomain(shots.some((shot) => shot.shot_id === command.payload.shot_id), 'SHOT_NOT_FOUND', '镜头不存在', 404);

    const current = this.db.prepare('SELECT spatial_revision, plan_json FROM spatial_plans WHERE project_id=? AND shot_id=?')
      .get(project.id, command.payload.shot_id) as unknown as { spatial_revision: number; plan_json: string } | undefined;
    const currentRevision = current?.spatial_revision ?? 0;
    assertDomain(
      currentRevision === command.payload.expected_spatial_revision,
      'SPATIAL_REVISION_CONFLICT',
      '空间计划 revision 冲突',
      409,
      { expected: command.payload.expected_spatial_revision, actual: currentRevision },
    );

    const validated = validateSpatialPlan(command.payload.plan, {
      registeredSubjects: this.registeredSubjects(),
      publishedArtifacts: this.publishedArtifacts(),
    });
    if (!validated.ok) {
      throw new DomainError('SPATIAL_PLAN_INVALID', '空间计划未通过校验', 422, { issues: validated.issues });
    }

    const serialized = json(validated.plan);
    // 参数未变化（例如只拖了预览视角）：不推进 revision，也不触发失效传播
    if (current && current.plan_json === serialized) {
      return this.envelope(command, project.id, project.revision, {
        shot_id: command.payload.shot_id,
        spatial_revision: currentRevision,
        enabled: validated.enabled,
        reused: true,
        invalidated_candidates: 0,
      });
    }

    const spatialRevision = currentRevision + 1;
    const timestamp = now();
    this.db.prepare(`INSERT INTO spatial_plans(project_id, shot_id, spatial_revision, plan_json, digest_input, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, shot_id) DO UPDATE SET spatial_revision=excluded.spatial_revision, plan_json=excluded.plan_json, digest_input=excluded.digest_input, updated_at=excluded.updated_at`)
      .run(project.id, command.payload.shot_id, spatialRevision, serialized, spatialDigestInput(validated.plan), timestamp);

    // 失效传播：只作废本镜候选（Phase 4 验收要求「其它镜头受影响数 = 0」）
    const invalidated = this.db.prepare(`UPDATE image_candidates SET status='SUPERSEDED'
      WHERE project_id=? AND shot_id=? AND status='ACTIVE'`)
      .run(project.id, command.payload.shot_id);

    // 旧蓝图归档而不是删除：重截图必须留痕（§7.5.2 规则 6）
    const previousPlan = current ? (JSON.parse(current.plan_json) as { blueprint?: { artifact_id?: string } }) : null;
    const nextArtifact = 'blueprint' in validated.plan ? validated.plan.blueprint?.artifact_id : undefined;
    const previousArtifact = previousPlan?.blueprint?.artifact_id;
    if (previousArtifact && previousArtifact !== nextArtifact) {
      this.db.prepare(`UPDATE artifacts SET status='ARCHIVED' WHERE artifact_id=?`).run(previousArtifact);
    }

    // 首帧可能已作废，已批准的视频预算随之失效
    this.supersedeGates(project.id, ['G2']);
    const revision = project.revision + 1;
    this.advanceProject(project.id, revision, 'SPATIAL_PLANNING', timestamp);
    this.event(project.id, revision, 'spatial-plan.set', command, {
      shot_id: command.payload.shot_id,
      spatial_revision: spatialRevision,
      enabled: validated.enabled,
      invalidated_candidates: invalidated.changes,
    });
    return this.envelope(command, project.id, revision, {
      shot_id: command.payload.shot_id,
      spatial_revision: spatialRevision,
      enabled: validated.enabled,
      reused: false,
      invalidated_candidates: invalidated.changes,
    });
  }

  /**
   * 项目列表：**默认不含回收站**。
   *
   * 默认排除而不是加参数让调用方自己过滤——调用方漏掉一次，用户就会在
   * "全部项目"里看到自己以为已经删掉的东西。要回收站内容显式调
   * `listTrashedProjects()`。
   */
  /** LibTV 的 space/workspace 容器列表；project 是其下的画布，二者 id 永不复用。 */
  listWorkspaces(trashed = false): unknown[] {
    return this.db.prepare(`SELECT w.id, w.name, w.revision, w.deleted_at, w.created_at, w.updated_at,
      COUNT(p.id) AS canvas_count,
      (SELECT p2.id FROM projects p2 WHERE p2.workspace_id=w.id AND p2.deleted_at IS NULL ORDER BY p2.created_at LIMIT 1) AS primary_project_id
      FROM workspaces w LEFT JOIN projects p ON p.workspace_id=w.id AND p.deleted_at IS NULL
      WHERE ${trashed ? 'w.deleted_at IS NOT NULL' : 'w.deleted_at IS NULL'}
      GROUP BY w.id ORDER BY ${trashed ? 'w.deleted_at' : 'w.updated_at'} DESC`).all();
  }

  getWorkspace(workspaceId: string): unknown {
    const workspace = this.db.prepare('SELECT id, name, revision, deleted_at, created_at, updated_at FROM workspaces WHERE id=?').get(workspaceId) as unknown as Record<string, unknown> | undefined;
    assertDomain(workspace, 'WORKSPACE_NOT_FOUND', '工作区不存在', 404);
    const canvases = this.db.prepare('SELECT id, workspace_id, name, revision, state, deleted_at, created_at, updated_at FROM projects WHERE workspace_id=? ORDER BY created_at').all(workspaceId);
    return { ...workspace, canvases };
  }

  renameWorkspace(workspaceId: string, nameInput: string): unknown {
    const workspace = this.db.prepare('SELECT id, name, revision FROM workspaces WHERE id=?').get(workspaceId) as unknown as { id: string; name: string; revision: number } | undefined;
    assertDomain(workspace, 'WORKSPACE_NOT_FOUND', '工作区不存在', 404);
    const name = nameInput.trim();
    assertDomain(name.length > 0, 'WORKSPACE_NAME_REQUIRED', '工作区名称不能为空', 422);
    const timestamp = now();
    this.db.prepare('UPDATE workspaces SET name=?, revision=?, updated_at=? WHERE id=?').run(name, workspace.revision + 1, timestamp, workspaceId);
    return this.getWorkspace(workspaceId);
  }

  trashWorkspace(workspaceId: string): unknown {
    const workspace = this.db.prepare('SELECT id FROM workspaces WHERE id=?').get(workspaceId);
    assertDomain(workspace, 'WORKSPACE_NOT_FOUND', '工作区不存在', 404);
    const timestamp = now();
    this.db.prepare('UPDATE workspaces SET deleted_at=?, revision=revision+1, updated_at=? WHERE id=?').run(timestamp, timestamp, workspaceId);
    this.db.prepare('UPDATE projects SET deleted_at=COALESCE(deleted_at, ?), updated_at=? WHERE workspace_id=?').run(timestamp, timestamp, workspaceId);
    return this.getWorkspace(workspaceId);
  }

  restoreWorkspace(workspaceId: string): unknown {
    const workspace = this.db.prepare('SELECT id FROM workspaces WHERE id=?').get(workspaceId);
    assertDomain(workspace, 'WORKSPACE_NOT_FOUND', '工作区不存在', 404);
    const timestamp = now();
    this.db.prepare('UPDATE workspaces SET deleted_at=NULL, revision=revision+1, updated_at=? WHERE id=?').run(timestamp, workspaceId);
    this.db.prepare('UPDATE projects SET deleted_at=NULL, updated_at=? WHERE workspace_id=?').run(timestamp, workspaceId);
    return this.getWorkspace(workspaceId);
  }

  purgeWorkspace(workspaceId: string, confirmName: string): void {
    const workspace = this.db.prepare('SELECT id, name, deleted_at FROM workspaces WHERE id=?').get(workspaceId) as unknown as { id: string; name: string; deleted_at: string | null } | undefined;
    assertDomain(workspace, 'WORKSPACE_NOT_FOUND', '工作区不存在', 404);
    assertDomain(workspace.deleted_at !== null, 'WORKSPACE_NOT_TRASHED', '只有回收站里的工作区才能彻底删除', 409);
    assertDomain(confirmName === workspace.name, 'WORKSPACE_NAME_MISMATCH', '工作区名称不一致，没有执行彻底删除', 409);
    const canvases = this.db.prepare('SELECT id FROM projects WHERE workspace_id=?').all(workspaceId) as unknown as Array<{ id: string }>;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const canvas of canvases) {
        for (const table of PROJECT_CHILD_TABLES) this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(canvas.id);
      }
      this.db.prepare('DELETE FROM projects WHERE workspace_id=?').run(workspaceId);
      this.db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listProjects(): unknown[] {
    return this.db.prepare('SELECT id, workspace_id, name, revision, state, max_budget_cents, reserved_budget_cents, folder_id, film_playback, film_transition, film_transition_direction, deleted_at, created_at, updated_at FROM projects WHERE deleted_at IS NULL ORDER BY created_at DESC').all();
  }

  /**
   * 全部项目文件夹，按创建时间正序（先建的在前，与用户建的顺序一致）。
   *
   * 不做"空文件夹自动消失"这种事：用户刚建好还没放东西，文件夹就必须在那里，
   * 否则他会以为没建成。
   */
  listFolders(): unknown[] {
    return this.db.prepare('SELECT folder_id, name, created_at FROM folders ORDER BY created_at').all();
  }

  /** 回收站：按移入时间倒序（最近删的在最前面，和用户的期待一致）。 */
  listTrashedProjects(): unknown[] {
    return this.db.prepare('SELECT id, workspace_id, name, revision, state, max_budget_cents, reserved_budget_cents, folder_id, film_playback, film_transition, film_transition_direction, deleted_at, created_at, updated_at FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all();
  }

  getProject(projectId: string): unknown {
    const project = this.db.prepare('SELECT id, workspace_id, name, revision, state, max_budget_cents, reserved_budget_cents, rights_confirmed, folder_id, film_playback, film_transition, film_transition_direction, deleted_at, created_at, updated_at FROM projects WHERE id=?').get(projectId) as unknown as ProjectRow | undefined;
    assertDomain(project, 'PROJECT_NOT_FOUND', '项目不存在', 404);
    const fields = this.shotFields(projectId);
    const gates = this.db.prepare(`SELECT gate, status, approved_project_revision, approved_fields_revision, approved_budget_cents, created_at FROM gate_decisions WHERE project_id=? ORDER BY sequence`).all(projectId) as unknown as GateSnapshot[];
    const selections = this.db.prepare('SELECT shot_id, candidate_id, selection_revision FROM selections WHERE project_id=? ORDER BY shot_id').all(projectId);
    const canvasDocument = this.db.prepare('SELECT document_revision, document_json, updated_at FROM canvas_documents WHERE project_id=?').get(projectId) as unknown as { document_revision: number; document_json: string; updated_at: string } | undefined;
    const timelineDocument = this.db.prepare('SELECT document_revision, document_json, updated_at FROM timeline_documents WHERE project_id=?').get(projectId) as unknown as { document_revision: number; document_json: string; updated_at: string } | undefined;
    /**
     * `gates` 是 append-only 的审计历史：同一个闸门会同时留下旧的 APPROVED 与新的 SUPERSEDED。
     * 当成已批准——与领域层 `currentGate()` 的判断相反。因此这里直接给出权威的当前状态，
     * 让「状态机只有一份实现」这条铁律在 UI 侧也成立。
     */
    return {
      ...project,
      rights_confirmed: Boolean(project.rights_confirmed),
      shot_fields: fields ? { ...fields, shots: JSON.parse(fields.shots_json), shots_json: undefined } : null,
      canvas_document: canvasDocument ? { document_revision: canvasDocument.document_revision, document: JSON.parse(canvasDocument.document_json), updated_at: canvasDocument.updated_at } : null,
      timeline_document: timelineDocument ? { document_revision: timelineDocument.document_revision, document: JSON.parse(timelineDocument.document_json), updated_at: timelineDocument.updated_at } : null,
      gates,
      gate_status: this.gateStatuses(projectId),
      selections,
      sources: this.listSources(projectId),
      candidates: this.listImageCandidates(projectId),
      /* 空间方案：导演台要在同一份项目快照里看到它，不然就得再发一次请求 */
      spatial_plans: this.listSpatialPlans(projectId),
      eval_reports: this.listEvalReports(projectId),
      repair_plans: this.listRepairPlans(projectId),
      image_generations: this.listImageGenerationIntents(projectId),
      video_generations: this.listVideoGenerationIntents(projectId),
      generation_checkpoints: this.listGenerationCheckpoints(projectId),
      /* 派生出来的产物（宫格切分等）：资产页靠它把"切出来的图"也列出来 */
      derived_artifacts: this.listProjectArtifacts(projectId),
      /* 资产评级：资产页的「N 星及以上 / 未评分」筛选靠它 */
      asset_ratings: this.listAssetRatings(projectId),
      /*
        成片播放策略：NULL（从没设过）对外一律给 `hold`——
        消费方不该自己判 NULL 该当什么。
      */
      film_playback: project.film_playback === 'stretch' ? 'stretch' : 'hold',
      /*
        同理：NULL（从没设过）对外一律给 `cut`。
        逐个比对 FILM_TRANSITIONS 而不是写死两个值——清单加一项时，
        这里忘了跟就会把用户选的新转场悄悄读成"硬切"。
      */
      film_transition: (FILM_TRANSITIONS as readonly string[]).includes(project.film_transition ?? '')
        ? project.film_transition
        : 'cut',
      /* 方向：NULL（从没设过）对外一律给 left，消费方不必自己判空 */
      film_transition_direction: (TRANSITION_DIRECTIONS as readonly string[]).includes(project.film_transition_direction ?? '')
        ? project.film_transition_direction
        : 'left',
      /*
        逐镜覆盖：**只列覆盖过的镜头**。没有覆盖的镜头跟随项目设置，
        消费方据此合并——不要把项目级的值在这里补全成一行行，
        那样"用户改过哪几镜"就再也看不出来了。
      */
      shot_playbacks: this.db.prepare(
        'SELECT shot_id, playback FROM shot_playback WHERE project_id=? ORDER BY shot_id',
      ).all(projectId),
    };
  }

  /**
   * 导出一个只含单项目可编辑事实的 SQLite 快照。
   * 不带 Provider 凭据，也不带其他项目的 Artifact，供 `.xqtvproj` 交付包使用。
   */
  exportProjectDatabase(projectId: string, targetPath: string): { projectId: string; revision: number; events: number; artifacts: number } {
    const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as unknown as Record<string, unknown> | undefined;
    assertDomain(project !== undefined, 'PROJECT_NOT_FOUND', '项目不存在', 404);
    const target = openDatabase(targetPath);
    const artifactIds = new Set<string>();
    let eventCount = 0;
    try {
      target.exec('BEGIN IMMEDIATE');
      const folderId = typeof project.folder_id === 'string' ? project.folder_id : null;
      if (folderId) {
        const folder = this.db.prepare('SELECT * FROM folders WHERE folder_id=?').get(folderId) as unknown as Record<string, unknown> | undefined;
        if (folder) insertRows(target, 'folders', [folder], { ignore: true });
      }
      insertRows(target, 'projects', [project]);
      const tableRows = new Map<string, Record<string, unknown>[]>();
      for (const table of PACKAGE_PROJECT_TABLES) {
        const rows = this.db.prepare(`SELECT * FROM ${quotedIdentifier(table)} WHERE project_id=? ORDER BY rowid`).all(projectId) as unknown as Record<string, unknown>[];
        tableRows.set(table, rows);
        if (table === 'events') eventCount = rows.length;
        collectContentIds(rows, artifactIds);
      }
      for (const artifact of this.listArtifacts() as Array<Record<string, unknown>>) {
        if ((artifact.metadata as { project_id?: unknown } | null)?.project_id === projectId) {
          const id = artifact.artifact_id;
          if (typeof id === 'string') artifactIds.add(id);
        }
      }
      if (artifactIds.size > 0) {
        const findArtifact = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id=?');
        const artifacts = [...artifactIds]
          .map((id) => findArtifact.get(id) as unknown as Record<string, unknown> | undefined)
          .filter((row): row is Record<string, unknown> => row !== undefined);
        insertRows(target, 'artifacts', artifacts, { ignore: true });
      }
      for (const table of PACKAGE_PROJECT_TABLES) {
        insertRows(target, table, tableRows.get(table) ?? [], { omitSequence: true });
      }
      target.exec('COMMIT');
      return { projectId, revision: Number(project.revision), events: eventCount, artifacts: artifactIds.size };
    } catch (error) {
      target.exec('ROLLBACK');
      throw error;
    } finally {
      target.close();
    }
  }

  /** 把交付包里的单项目快照导入当前库；已有同 id 项目时拒绝，不静默覆盖。 */
  importProjectDatabase(sourcePath: string): { projectId: string; revision: number } {
    const source = new DatabaseSync(sourcePath);
    try {
      const project = source.prepare('SELECT * FROM projects LIMIT 2').all() as unknown as Record<string, unknown>[];
      assertDomain(project.length === 1, 'PROJECT_PACKAGE_INVALID', '项目包必须且只能包含一个项目', 422);
      const row = project[0]!;
      const projectId = typeof row.id === 'string' ? row.id : '';
      assertDomain(projectId !== '', 'PROJECT_PACKAGE_INVALID', '项目包缺少项目 id', 422);
      assertDomain(this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId) === undefined,
        'PROJECT_ALREADY_EXISTS', '当前资料库已存在同 id 项目，未覆盖', 409);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const folderId = typeof row.folder_id === 'string' ? row.folder_id : null;
        if (folderId) {
          const folder = source.prepare('SELECT * FROM folders WHERE folder_id=?').get(folderId) as unknown as Record<string, unknown> | undefined;
          if (folder) insertRows(this.db, 'folders', [folder], { ignore: true });
        }
        insertRows(this.db, 'projects', [row]);
        const artifacts = source.prepare('SELECT * FROM artifacts ORDER BY rowid').all() as unknown as Record<string, unknown>[];
        insertRows(this.db, 'artifacts', artifacts, { ignore: true });
        for (const table of PACKAGE_PROJECT_TABLES) {
          const rows = source.prepare(`SELECT * FROM ${quotedIdentifier(table)} WHERE project_id=? ORDER BY rowid`).all(projectId) as unknown as Record<string, unknown>[];
          insertRows(this.db, table, rows, { omitSequence: true });
        }
        this.db.exec('COMMIT');
        return { projectId, revision: Number(row.revision) };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      source.close();
    }
  }

  listEvents(projectId: string, after = 0): DomainEvent[] {
    const rows = this.db.prepare(`SELECT sequence, event_id, project_id, project_revision, type, actor, correlation_id, created_at, payload_json FROM events WHERE project_id=? AND sequence>? ORDER BY sequence`).all(projectId, after) as unknown as Array<Omit<DomainEvent, 'payload'> & { payload_json: string }>;
    return rows.map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(payload_json) }));
  }

  listProviders(): unknown[] {
    const rows = this.db.prepare('SELECT provider_id, manifest_json, adapter_hash, test_only, created_at, updated_at FROM providers ORDER BY provider_id').all() as unknown as Array<{ manifest_json: string; test_only: number } & Record<string, unknown>>;
    return rows.map(({ manifest_json, test_only, ...row }) => ({ ...row, test_only: Boolean(test_only), manifest: JSON.parse(manifest_json) }));
  }

  listImageCandidates(projectId: string): unknown[] {
    return this.db.prepare('SELECT shot_id, candidate_id, artifact_id, status, created_at FROM image_candidates WHERE project_id=? ORDER BY created_at, candidate_id').all(projectId);
  }

  listSubjects(): unknown[] {
    return this.db.prepare('SELECT subject_ref, display_name, created_at FROM registered_subjects ORDER BY subject_ref').all();
  }

  /**
   * 主体档案清单（按更新时间倒序，最近改过的排前面——和"我的角色库"的排序一致）。
   *
   * `references` 是**下游引用计数**（空间方案里引用过几次）：
   * 界面上要显示"引用 {count}"，也得在删除前说清"还被谁用着"。
   * 主体是全局的，所以这个计数跨项目统计。
   */
  listSubjectProfiles(): unknown[] {
    const rows = this.db.prepare(
      'SELECT subject_ref, display_name, kind, profile_json, created_at, updated_at FROM subject_profiles ORDER BY updated_at DESC',
    ).all() as unknown as Array<{ subject_ref: string; display_name: string; kind: string; profile_json: string; created_at: string; updated_at: string }>;
    const references = this.db.prepare(
      'SELECT plan_json FROM spatial_plans',
    ).all() as unknown as Array<{ plan_json: string }>;
    const counts = new Map<string, number>();
    for (const row of references) {
      let parsed: { subjects?: unknown } | null = null;
      try { parsed = JSON.parse(row.plan_json) as { subjects?: unknown }; } catch { continue; }
      const subjects = Array.isArray(parsed?.subjects) ? parsed.subjects : [];
      for (const subject of subjects) {
        const ref = (subject as { subject_ref?: unknown } | null)?.subject_ref;
        if (typeof ref === 'string') counts.set(ref, (counts.get(ref) ?? 0) + 1);
      }
    }
    return rows.map((row) => ({
      ...row,
      profile: JSON.parse(row.profile_json) as unknown,
      references: counts.get(row.subject_ref) ?? 0,
    }));
  }

  listArtifacts(): unknown[] {
    const rows = this.db.prepare(
      'SELECT artifact_id, media_type, bytes, metadata_json, status, created_at FROM artifacts ORDER BY created_at, artifact_id',
    ).all() as unknown as Array<{ metadata_json: string | null } & Record<string, unknown>>;
    return rows.map(({ metadata_json, ...row }) => ({
      ...row,
      metadata: metadata_json === null ? null : JSON.parse(metadata_json),
    }));
  }

  /**
   * 某个项目**派生出来**的产物（宫格切分，以及以后的编辑类操作）。
   *
   * 为什么单独一个方法，而不是给 listArtifacts 加个可选参数：
   * artifacts 表是全局的（主键是内容哈希、跨项目共享），"属于哪个项目"
   * 只存在于 metadata 里。让每个调用方自己写这段过滤，迟早有人在某处
   * 忘了处理 metadata 为空、或者把 JSON.parse 抛出来的异常漏出去。
   *
   * 过滤是**严格相等**，而且要有 project_id：抽帧与视频片段那些老产物
   * 没有这个键，它们本来就通过候选/来源登记进项目了，
   * 在这里再列一遍会让资产页出现两份同样的东西。
   */
  listProjectArtifacts(projectId: string): unknown[] {
    const rows = this.db.prepare(
      'SELECT artifact_id, media_type, bytes, metadata_json, status, created_at FROM artifacts ORDER BY created_at, artifact_id',
    ).all() as unknown as Array<{ metadata_json: string | null } & Record<string, unknown>>;
    const result: unknown[] = [];
    for (const { metadata_json, ...row } of rows) {
      if (metadata_json === null) continue;
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(metadata_json) as Record<string, unknown>;
      } catch {
        /* 库里存了坏 JSON 是数据问题，不该让整个项目快照读不出来 */
        continue;
      }
      if (metadata.project_id !== projectId) continue;
      result.push({ ...row, metadata });
    }
    return result;
  }

  /** 这个项目的资产评级。没打过分的不出现在这里（而不是出现一条 0 星）。 */
  listAssetRatings(projectId: string): unknown[] {
    return this.db.prepare(
      'SELECT artifact_id, stars, updated_at FROM asset_ratings WHERE project_id=? ORDER BY artifact_id',
    ).all(projectId);
  }

  listKernelTasks(projectId: string): unknown[] {
    const rows = this.db.prepare(
      'SELECT task_id, kind, source_path, purpose, status, report_json, failure, created_at, updated_at FROM kernel_tasks WHERE project_id=? ORDER BY created_at DESC',
    ).all(projectId) as unknown as Array<{ report_json: string | null } & Record<string, unknown>>;
    return rows.map(({ report_json, ...row }) => ({ ...row, report: report_json === null ? null : JSON.parse(report_json) }));
  }

  listSources(projectId: string): unknown[] {
    return this.db.prepare(
      'SELECT asset_id, relative_path, content_hash, bytes, media_type, registered_at FROM source_assets WHERE project_id=? ORDER BY registered_at',
    ).all(projectId);
  }

  /** 评估报告，新的在前。 */
  listEvalReports(projectId: string): unknown[] {
    const rows = this.db.prepare(
      'SELECT report_id, reference_artifact, result_artifact, evaluator_id, evaluator_version, report_json, created_at FROM eval_reports WHERE project_id=? ORDER BY created_at DESC',
    ).all(projectId) as unknown as Array<{ report_json: string } & Record<string, unknown>>;
    return rows.map(({ report_json, ...row }) => ({ ...row, report: JSON.parse(report_json) }));
  }

  /** 修复方案，新的在前。 */
  listRepairPlans(projectId: string): unknown[] {
    const rows = this.db.prepare(
      'SELECT plan_id, source_eval_report, plan_json, status, created_at FROM repair_plans WHERE project_id=? ORDER BY created_at DESC',
    ).all(projectId) as unknown as Array<{ plan_json: string } & Record<string, unknown>>;
    return rows.map(({ plan_json, ...row }) => ({ ...row, plan: JSON.parse(plan_json) }));
  }

  /** 图片生成意图，新的在前。 */
  listImageGenerationIntents(projectId: string): unknown[] {
    return this.db.prepare(
      'SELECT intent_id, shot_id, model, prompt, estimated_cost_cents, actual_cost_cents, provider_cost_unit, provider_cost_amount, status, candidate_id, failure, reservation_released_reason, digest, reused_from_intent_id, created_at, updated_at FROM image_generation_intents WHERE project_id=? ORDER BY created_at DESC',
    ).all(projectId);
  }

  /** 视频生成意图，新的在前。 */
  listVideoGenerationIntents(projectId: string): unknown[] {
    return this.db.prepare(
      'SELECT intent_id, shot_id, model, duration_seconds, estimated_cost_cents, actual_cost_cents, provider_cost_unit, provider_cost_amount, status, clip_artifact_id, failure, reservation_released_reason, digest, reused_from_intent_id, created_at, updated_at FROM video_generation_intents WHERE project_id=? ORDER BY created_at DESC',
    ).all(projectId);
  }
  /**
   * 持久化生成 Provider 的执行阶段与恢复点。
   * 不推进项目 revision：它是执行器内部状态，改一次就让业务快照全部失效是错的。
   */
  recordGenerationCheckpoint(
    projectId: string,
    intentId: string,
    stage: 'accepted' | 'provider_started' | 'provider_finished' | 'completed' | 'failed',
    checkpoint: Record<string, unknown>,
    providerTaskRef?: string | null,
  ): void {
    const project = this.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId) as unknown as { id: string } | undefined;
    assertDomain(project, 'PROJECT_NOT_FOUND', '项目不存在', 404);
    this.db.prepare(
      `INSERT INTO generation_checkpoints(intent_id, project_id, stage, provider_task_ref, checkpoint_json, updated_at)`
        + ' VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(intent_id) DO UPDATE SET'
        + ' project_id=excluded.project_id, stage=excluded.stage, provider_task_ref=excluded.provider_task_ref,'
        + ' checkpoint_json=excluded.checkpoint_json, updated_at=excluded.updated_at'
    ).run(intentId, projectId, stage, providerTaskRef ?? null, json(checkpoint), now());
  }

  listGenerationCheckpoints(projectId: string): unknown[] {
    const rows = this.db.prepare('SELECT * FROM generation_checkpoints WHERE project_id=? ORDER BY updated_at DESC').all(projectId) as unknown as Array<{ checkpoint_json: string } & Record<string, unknown>>;
    return rows.map(({ checkpoint_json, ...row }) => ({ ...row, checkpoint: JSON.parse(checkpoint_json) }));
  }

  /**
   * 这台机器上**每个模型跑过多少次、成不成、花了多少、最后一次是什么时候**。

   * 这是 `MODEL-001`（按任务推荐模型）的**唯一依据来源**。
   * 矩阵对这一条的验收口径是「推荐理由可解释（每条推荐给出 ≥1 条可核验依据）」
   * ——所以依据必须来自库里的既有事实，不能在界面层写一句"推荐"了事：
   *
   *   · `completed` / `failed` 来自 `status`（`ADMITTED` 是"还在跑"，不算成也不败）
   *   · `completed_cost_cents` 只累加**成功**那几次的实际花费（分）
   *   · `last_used_at` 取该模型最后一次提交的时间（成功失败都算"用过"）
   *
   * 聚合放在 SQL 里而不是把几千行明细搬到界面再算：这条查询会被模型选择器
   * 在每次打开时调用，明细越攒越多，搬过去的代价是线性涨的。
   */
  listModelUsage(): Array<{
    model: string;
    kind: 'image' | 'video';
    completed: number;
    failed: number;
    admitted: number;
    completed_cost_cents: number;
    last_used_at: string | null;
  }> {
    const rows = this.db.prepare(`
      SELECT model, 'image' AS kind,
             SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status IN ('COMPLETED','FAILED') THEN 0 ELSE 1 END) AS admitted,
             SUM(CASE WHEN status='COMPLETED' THEN actual_cost_cents ELSE 0 END) AS completed_cost_cents,
             MAX(created_at) AS last_used_at
      FROM image_generation_intents
      GROUP BY model
      UNION ALL
      SELECT model, 'video' AS kind,
             SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status IN ('COMPLETED','FAILED') THEN 0 ELSE 1 END) AS admitted,
             SUM(CASE WHEN status='COMPLETED' THEN actual_cost_cents ELSE 0 END) AS completed_cost_cents,
             MAX(created_at) AS last_used_at
      FROM video_generation_intents
      GROUP BY model
    `).all() as unknown as Array<{
      model: string; kind: string; completed: number; failed: number;
      admitted: number; completed_cost_cents: number; last_used_at: string | null;
    }>;
    return rows.map((row) => ({
      model: row.model,
      kind: row.kind === 'video' ? 'video' as const : 'image' as const,
      completed: Number(row.completed ?? 0),
      failed: Number(row.failed ?? 0),
      admitted: Number(row.admitted ?? 0),
      completed_cost_cents: Number(row.completed_cost_cents ?? 0),
      last_used_at: row.last_used_at ?? null,
    }));
  }

  /**
   * 对账（CLI-002 的 `reconcile`）。

   * 它回答的是脚本作者最想问的那个问题：**"我上次发出去的那些付费请求，
   * 现在到底怎么样了？"** 具体做三件事：

   *   ① **列在飞意图**：状态还是 `ADMITTED` 的那些（提交了、还没有结果），
   *      带上是哪种生成、花了多少预估、已经等了多久；
   *   ② **核对预算台账**：`projects.reserved_budget_cents` 是"预留总额"，
   *      它应当等于所有未结算意图的预估之和。**对不上就是漂移**——
   *      意味着有预算被占着却没有对应的意图（或者反过来），
   *      那是钱的事，不能只看界面上的数字；
   *   ③ **给建议**：每条悬空意图给出可执行动作，而不是一句"请注意"。

   * 阈值取 15 分钟：出图通常几十秒到几分钟，图生视频更久一点。
   * 超过阈值还没结果的，大概率是客户端那次已经没了（进程被杀 / 网络断），
   * 应该释放预留；但这只是**建议**——领域层不替用户决定要不要放弃一次生成。
   */
  reconcileProject(projectId: string): ReconcileReport {
    const project = this.db.prepare(
      'SELECT id, revision, max_budget_cents, reserved_budget_cents FROM projects WHERE id=?',
    ).get(projectId) as unknown as {
      id: string; revision: number; max_budget_cents: number; reserved_budget_cents: number;
    } | undefined;
    assertDomain(project !== undefined, 'PROJECT_NOT_FOUND', '项目不存在', 404);

    const inFlight: ReconcileInFlight[] = [];
    const nowMs = Date.parse(now());
    const rows = this.db.prepare(`
      SELECT intent_id, shot_id, model, estimated_cost_cents, status, created_at, 'image' AS kind
      FROM image_generation_intents WHERE project_id=? AND status='ADMITTED'
      UNION ALL
      SELECT intent_id, shot_id, model, estimated_cost_cents, status, created_at, 'video' AS kind
      FROM video_generation_intents WHERE project_id=? AND status='ADMITTED'
      ORDER BY created_at
    `).all(projectId, projectId) as unknown as Array<{
      intent_id: string; shot_id: string; model: string; estimated_cost_cents: number;
      status: string; created_at: string; kind: string;
    }>;

    for (const row of rows) {
      const createdMs = Date.parse(row.created_at);
      const ageSeconds = Number.isFinite(createdMs) ? Math.max(0, Math.round((nowMs - createdMs) / 1000)) : 0;
      inFlight.push({
        intent_id: row.intent_id,
        kind: row.kind === 'video' ? 'video' : 'image',
        shot_id: row.shot_id,
        model: row.model,
        estimated_cost_cents: Number(row.estimated_cost_cents ?? 0),
        age_seconds: ageSeconds,
        created_at: row.created_at,
      });
    }

    const inFlightCents = inFlight.reduce((sum, item) => sum + item.estimated_cost_cents, 0);
    const reservedCents = Number(project.reserved_budget_cents ?? 0);
    /* 漂移 = 台账上的预留 − 在飞意图的预估之和。正负都有问题，所以原样带出来。 */
    const driftCents = reservedCents - inFlightCents;

    const suggestions: ReconcileSuggestion[] = inFlight.map((item) => {
      if (item.age_seconds < RECONCILE_STALE_SECONDS) {
        return {
          intent_id: item.intent_id,
          kind: item.kind,
          action: 'inspect',
          reason: `才等了 ${Math.round(item.age_seconds / 60)} 分钟（阈值 ${RECONCILE_STALE_SECONDS / 60} 分钟）：可能还在跑，先查一次它的状态再决定`,
        };
      }
      return {
        intent_id: item.intent_id,
        kind: item.kind,
        action: 'release',
        reason: `已等待 ${Math.round(item.age_seconds / 60)} 分钟仍无结果，建议释放这 ${item.estimated_cost_cents} 分预留`
          + '（如果它其实跑完了，应当走对应 settle 命令结算，而不是释放）',
      };
    });
    if (driftCents !== 0) {
      const more = driftCents > 0;
      suggestions.push({
        intent_id: '',
        kind: null,
        action: 'release',
        reason: `预算台账与在飞意图对不上：台账预留 ${reservedCents} 分，在飞意图合计 ${inFlightCents} 分，`
          + `相差 ${driftCents} 分（${more ? '台账多占' : '台账少占'}）。`
          + (more ? '多占的那部分没有对应意图，应当查一次项目事件流再释放。' : '在飞意图比台账多，说明有意图没记进预留。'),
      });
    }

    return {
      project_id: project.id,
      revision: Number(project.revision ?? 0),
      budget: {
        max_cents: Number(project.max_budget_cents ?? 0),
        reserved_cents: reservedCents,
        in_flight_cents: inFlightCents,
        drift_cents: driftCents,
        consistent: driftCents === 0,
      },
      in_flight: inFlight,
      suggestions,
    };
  }

  getSpatialPlan(projectId: string, shotId: string): unknown {
    return this.db.prepare('SELECT shot_id, spatial_revision, plan_json, digest_input, updated_at FROM spatial_plans WHERE project_id=? AND shot_id=?')
      .get(projectId, shotId) ?? null;
  }

  /**
   * 列出项目的全部空间方案。
   *
   * 补这个是因为界面需要**读回自己写进去的东西**：
   * 导演台改完机位要能看到"这一镜现在用的是哪个方案、第几版"，
   * 否则用户只能靠记忆判断刚才那一下有没有生效。
   */
  listSpatialPlans(projectId: string): unknown[] {
    return this.db.prepare(
      'SELECT shot_id, spatial_revision, plan_json, digest_input, updated_at FROM spatial_plans WHERE project_id=? ORDER BY shot_id',
    ).all(projectId);
  }

  private projectForWrite(projectId: string, expectedRevision: number): ProjectRow {
    const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as unknown as ProjectRow | undefined;
    assertDomain(project, 'PROJECT_NOT_FOUND', '项目不存在', 404);
    /*
      回收站里的项目不能继续写。

      不拦的话会出现一种很难解释的状态：项目在回收站里，但生成/审批还在往上加，
      用户在回收站里看到一个"还在长大"的项目。要接着干活就得先恢复——
      这一条也让"恢复之后一切照旧"是可信的，因为期间没人动过它。
    */
    assertDomain(project.deleted_at === null, 'PROJECT_TRASHED', '项目在回收站里，先恢复再操作', 409);
    assertDomain(project.revision === expectedRevision, 'PROJECT_REVISION_CONFLICT', '项目 revision 冲突', 409, { expected: expectedRevision, actual: project.revision });
    return project;
  }

  private shotFields(projectId: string): ShotFieldsRow | undefined {
    return this.db.prepare('SELECT fields_revision, breakdown_revision, shots_json FROM shot_fields WHERE project_id=?').get(projectId) as unknown as ShotFieldsRow | undefined;
  }

  private registeredSubjects(): ReadonlySet<string> {
    const rows = this.db.prepare('SELECT subject_ref FROM registered_subjects').all() as unknown as Array<{ subject_ref: string }>;
    return new Set(rows.map((row) => row.subject_ref));
  }

  private publishedArtifacts(): ReadonlySet<string> {
    const rows = this.db.prepare("SELECT artifact_id FROM artifacts WHERE status='PUBLISHED'").all() as unknown as Array<{ artifact_id: string }>;
    return new Set(rows.map((row) => row.artifact_id));
  }

  /**
   * 每个闸门的当前状态 = 该闸门 sequence 最大的一条决策。
   * 未被决策过的闸门返回 `null`，而不是省略键——省略会让消费方分不清
   * 「没有这个闸门」与「这个闸门还没决策」。
   */
  private gateStatuses(projectId: string): Record<GateName, GateStatus> {
    const rows = this.db.prepare(
      `SELECT gate, status FROM gate_decisions
       WHERE project_id=? AND sequence IN (
         SELECT MAX(sequence) FROM gate_decisions WHERE project_id=? GROUP BY gate
       )`,
    ).all(projectId, projectId) as unknown as Array<{ gate: string; status: string }>;
    const statuses = Object.fromEntries(GATE_ORDER.map((gate) => [gate, null])) as Record<GateName, GateStatus>;
    for (const row of rows) {
      if ((GATE_ORDER as readonly string[]).includes(row.gate)) {
        statuses[row.gate as GateName] = row.status;
      }
    }
    return statuses;
  }

  private currentGate(projectId: string, gate: string): GateRow | undefined {
    return this.db.prepare('SELECT gate, status, approved_project_revision, approved_fields_revision, approved_budget_cents FROM gate_decisions WHERE project_id=? AND gate=? ORDER BY sequence DESC LIMIT 1').get(projectId, gate) as unknown as GateRow | undefined;
  }

  private isGateApproved(projectId: string, gate: string): boolean { return this.currentGate(projectId, gate)?.status === 'APPROVED'; }

  private supersedeGates(projectId: string, gates: string[]): void {
    for (const gate of gates) {
      if (this.isGateApproved(projectId, gate)) {
        // 失效记录写清它取代的是哪一次批准，审计时才能回答「为什么这版批准不算数」。
        const previous = this.currentGate(projectId, gate);
        const revision = (this.db.prepare('SELECT revision FROM projects WHERE id=?').get(projectId) as unknown as { revision: number } | undefined)?.revision ?? 0;
        this.db.prepare(`INSERT INTO gate_decisions(decision_id, project_id, gate, status, approved_project_revision, approved_fields_revision, approved_budget_cents, note, actor, created_at)
          VALUES (?, ?, ?, 'SUPERSEDED', ?, ?, ?, ?, 'system:invalidation', ?)`)
          .run(
            randomUUID(), projectId, gate, revision,
            previous?.approved_fields_revision ?? null,
            previous?.approved_budget_cents ?? null,
            previous ? `上游变更使该批准失效（原批准基于 R${previous.approved_project_revision}）` : null,
            now(),
          );
      }
    }
  }

  private advanceProject(projectId: string, revision: number, state: string, timestamp: string): void {
    this.db.prepare('UPDATE projects SET revision=?, state=?, updated_at=? WHERE id=?').run(revision, state, timestamp, projectId);
  }

  private event(projectId: string, revision: number, type: string, command: DomainCommand, payload: unknown): void {
    this.db.prepare(`INSERT INTO events(event_id, project_id, project_revision, type, actor, correlation_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), projectId, revision, type, command.actor, command.correlation_id ?? command.command_id, json(payload), now());
  }

  private findDuplicate(values: string[]): string | undefined {
    const seen = new Set<string>();
    return values.find((value) => seen.has(value) || !seen.add(value));
  }
}

export function toPublicError(error: unknown): { statusCode: number; body: unknown } {
  if (error instanceof DomainError) return { statusCode: error.statusCode, body: { error: { code: error.code, message: error.message, details: error.details ?? null } } };
  if (error && typeof error === 'object' && 'issues' in error) return { statusCode: 400, body: { error: { code: 'VALIDATION_FAILED', message: '输入不符合契约', details: (error as { issues: unknown }).issues } } };
  return { statusCode: 500, body: { error: { code: 'INTERNAL_ERROR', message: '内部错误' } } };
}
