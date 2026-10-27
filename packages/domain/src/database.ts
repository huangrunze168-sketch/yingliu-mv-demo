import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 判断某一列是否存在。
 *
 * `PRAGMA table_info` 不接受参数占位符，只能拼表名；这里的表名全是本文件里的
 * 字符串常量，不存在外部输入进 SQL 的路径。把它写成函数而不是内联，
 * 是为了将来加第二处迁移时不用再把这段抄一遍。
 */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id),
      name TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      max_budget_cents INTEGER NOT NULL,
      reserved_budget_cents INTEGER NOT NULL DEFAULT 0,
      rights_confirmed INTEGER NOT NULL,
      -- 项目文件夹（只做分组，不影响项目自身事实）；NULL = 未分组
      folder_id TEXT,
      -- 回收站：NULL = 正常项目；有值 = 已移入回收站的时间戳
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_commands (
      command_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      project_id TEXT,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS providers (
      provider_id TEXT PRIMARY KEY,
      manifest_json TEXT NOT NULL,
      adapter_hash TEXT NOT NULL,
      test_only INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shot_fields (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      fields_revision INTEGER NOT NULL,
      breakdown_revision INTEGER NOT NULL,
      shots_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS canvas_documents (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      document_revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS timeline_documents (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      document_revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gate_decisions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      gate TEXT NOT NULL,
      status TEXT NOT NULL,
      approved_project_revision INTEGER NOT NULL,
      approved_fields_revision INTEGER,
      approved_budget_cents INTEGER,
      note TEXT,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gate_current_idx ON gate_decisions(project_id, gate, sequence DESC);
    CREATE TABLE IF NOT EXISTS prompt_bundles (
      bundle_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      source_fields_revision INTEGER NOT NULL,
      kit_version TEXT NOT NULL,
      model_id TEXT NOT NULL,
      content_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS image_candidates (
      project_id TEXT NOT NULL REFERENCES projects(id),
      shot_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, candidate_id)
    );
    CREATE TABLE IF NOT EXISTS selections (
      project_id TEXT NOT NULL REFERENCES projects(id),
      shot_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      selection_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, shot_id)
    );
    CREATE TABLE IF NOT EXISTS video_intents (
      intent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      shot_id TEXT NOT NULL,
      estimated_cost_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    -- 已登记主体：spatial_plan 的 subject_ref 必须能解析到这里（v2.3 §7.5.2 规则 2）
    CREATE TABLE IF NOT EXISTS registered_subjects (
      subject_ref TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- 主体档案（ASSET-003/005/006）：名称、类型、参考图、视频、音色、描述与标签。
    -- 与 registered_subjects 一样是**全局**资源（不属于任何项目），所以这张表里
    -- 故意没有 project_id——有了它就会跟着项目一起被删，而"我的角色库"不该这样。
    CREATE TABLE IF NOT EXISTS subject_profiles (
      subject_ref TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- 画布模板（CAN-010 我的工具箱 / FLOW-008 流水线固化）。
    -- 与主体档案一样是**全局**资源：一条验证过的产线应当能在任何项目里用。
    -- node_count / edge_count 由领域层从载荷里数出来，不由调用方声明。
    CREATE TABLE IF NOT EXISTS templates (
      template_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      edge_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- 项目级素材生成意图（主体补全 / 音频生成）。
    -- 与 image/video 那两张意图表同构，只是**没有 shot_id**：
    -- 这两类生成与"哪一镜"无关，硬塞一个 shot_id 只是为了让表结构好看。
    CREATE TABLE IF NOT EXISTS asset_generation_intents (
      intent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL,
      purpose TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT,
      estimated_cost_cents INTEGER NOT NULL,
      actual_cost_cents INTEGER,
      provider_cost_unit TEXT,
      provider_cost_amount REAL,
      status TEXT NOT NULL,
      artifact_id TEXT,
      failure TEXT,
      reservation_released_reason TEXT,
      digest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- 项目文件夹：只用来分组「用户怎么整理项目库」，不参与项目自身的事实
    CREATE TABLE IF NOT EXISTS folders (
      folder_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    -- 内容寻址 Artifact。主键即内容哈希，因此「重复截图」天然不会覆盖旧图（规则 6）
    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      media_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      metadata_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    -- 空间计划：按镜头保存，带独立 revision 供 CAS 与失效传播使用
    CREATE TABLE IF NOT EXISTS spatial_plans (
      project_id TEXT NOT NULL REFERENCES projects(id),
      shot_id TEXT NOT NULL,
      spatial_revision INTEGER NOT NULL,
      plan_json TEXT NOT NULL,
      digest_input TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, shot_id)
    );
    -- 内核任务（前置内核 前置 agent）：登记意图 → 上层执行 → 回填结果
    CREATE TABLE IF NOT EXISTS kernel_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL,
      source_path TEXT NOT NULL,
      purpose TEXT,
      status TEXT NOT NULL,
      report_json TEXT,
      failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kernel_tasks_project_idx ON kernel_tasks(project_id, created_at DESC);
    -- 参考视频（S0）：只存项目内相对路径与内容哈希，不存绝对路径
    CREATE TABLE IF NOT EXISTS source_assets (
      asset_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      relative_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      media_type TEXT,
      probe_json TEXT,
      registered_at TEXT NOT NULL,
      UNIQUE(project_id, relative_path)
    );
    -- 偏差评估报告（S8）：每条结论都带证据与归因，供修复阶段定位
    CREATE TABLE IF NOT EXISTS eval_reports (
      report_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      reference_artifact TEXT NOT NULL,
      result_artifact TEXT NOT NULL,
      evaluator_id TEXT NOT NULL,
      evaluator_version TEXT NOT NULL,
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS eval_reports_project_idx ON eval_reports(project_id, created_at DESC);
    -- 修复方案（S9）：必须依据某份评估报告，且写明作用域与显式复用清单
    CREATE TABLE IF NOT EXISTS repair_plans (
      plan_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      source_eval_report TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS repair_plans_project_idx ON repair_plans(project_id, created_at DESC);
    -- 图片生成意图（S5）：第一个真正花钱的动作，预估成本当场预留、事后结清
    CREATE TABLE IF NOT EXISTS image_generation_intents (
      intent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      shot_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      estimated_cost_cents INTEGER NOT NULL,
      actual_cost_cents INTEGER,
      -- 供应商原样报出的花费（单位跟着数字走）：积分就记积分，分就记分。
      -- 两者都为 NULL = 供应商什么都没报，与"花了 0"是两件事。
      provider_cost_unit TEXT,
      provider_cost_amount REAL,
      status TEXT NOT NULL,
      candidate_id TEXT,
      failure TEXT,
      -- 预留被显式释放的理由（NULL = 这笔预留当前仍占着预算）。
      -- 与"实际花费未知"是两件事：未知不代表能退，只有拿得出理由才退。
      reservation_released_reason TEXT,
      -- 执行摘要：把"决定这张图长什么样的所有输入"折成一个字符串，
      -- 用来判断"这次请求和历史哪一次是同一件事"（见 image-generation.reuse）。
      digest TEXT,
      -- 这一笔的结果是从哪一笔复用来的（NULL = 真的跑了一次生成）。
      -- 有值的时候 actual_cost_cents 一定是 0，而且那是**事实**：确实没调供应商。
      reused_from_intent_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS image_generation_intents_project_idx ON image_generation_intents(project_id, created_at DESC);
    -- 视频生成意图（S6）：G2 之后才可能出现，是付费链条的第二段
    CREATE TABLE IF NOT EXISTS video_generation_intents (
      intent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      shot_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT,
      duration_seconds INTEGER NOT NULL,
      estimated_cost_cents INTEGER NOT NULL,
      actual_cost_cents INTEGER,
      provider_cost_unit TEXT,
      provider_cost_amount REAL,
      status TEXT NOT NULL,
      clip_artifact_id TEXT,
      failure TEXT,
      reservation_released_reason TEXT,
      -- 见 image_generation_intents 里同名两列的说明
      digest TEXT,
      reused_from_intent_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS video_generation_intents_project_idx ON video_generation_intents(project_id, created_at DESC);

    /*
      资产评级（小QTV 资产页的一等筛选维度：N 星及以上 / 未评分）。

      主键是 (project_id, artifact_id) 而不是只按 artifact_id：
      artifact 是全局内容寻址的（同一张图可能出现在多个项目里），
      但"这张图好不好"是**就这个项目而言**的判断——A 项目里的废片，
      在 B 项目里可能正好是需要的素材。只按 artifact 存会让两个项目互相改分。
    */
    CREATE TABLE IF NOT EXISTS asset_ratings (
      project_id TEXT NOT NULL REFERENCES projects(id),
      artifact_id TEXT NOT NULL,
      stars INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, artifact_id)
    );

    /*
      逐镜的播放策略覆盖（见契约里的 shot.playback.set）。

      **只存"覆盖过"的镜头**：没在这一行里的镜头就是跟随项目设置。
      不存 inherit 那种"显式跟随"的行，是因为它与"没有这一行"是同一件事，
      存两遍只会让读取方多判一次，也让"到底覆盖了几个镜头"变得要过滤才数得清。
    */
    CREATE TABLE IF NOT EXISTS generation_checkpoints (
      intent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      stage TEXT NOT NULL,
      provider_task_ref TEXT,
      checkpoint_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS generation_checkpoints_project_idx ON generation_checkpoints(project_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS shot_playback (
      project_id TEXT NOT NULL REFERENCES projects(id),
      shot_id TEXT NOT NULL,
      playback TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, shot_id)
    );
  `);

  /**
   * 迁移：给已存在的库补上 `deleted_at`。
   *
   * 为什么必须显式写这一步：`CREATE TABLE IF NOT EXISTS` 对**已存在的表**
   * 什么都不做——列不会因为你在建表语句里新加了一行就出现。没有这一步，
   * 老库上跑回收站会得到一句 "no such column: deleted_at"，
   * 而报错点在查询里，离"忘了迁移"很远。
   *
   * 用 `PRAGMA table_info` 先判断再 ALTER，不用 try/catch：
   * SQLite 的 ALTER TABLE ADD COLUMN 重复执行会直接报错，
   * 靠捕获异常来当"已存在"用，会把真正的失败也一起吞掉。
   */
  if (!hasColumn(db, 'projects', 'workspace_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)');
  }
  /*
    LibTV 的 space/workspace 是容器，project 是容器中的画布。老库只有 projects，
    因而迁移时为每个旧 project 建一个独立 workspace；不能把两种 id 继续当成同一个值。
  */
  const orphanProjects = db.prepare('SELECT id, name, created_at, updated_at FROM projects WHERE workspace_id IS NULL').all() as unknown as Array<{ id: string; name: string; created_at: string; updated_at: string }>;
  const insertWorkspace = db.prepare('INSERT INTO workspaces(id, name, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)');
  const bindWorkspace = db.prepare('UPDATE projects SET workspace_id=? WHERE id=?');
  for (const project of orphanProjects) {
    const workspaceId = randomUUID();
    insertWorkspace.run(workspaceId, project.name, project.created_at, project.updated_at);
    bindWorkspace.run(workspaceId, project.id);
  }
  db.exec('CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects(workspace_id, created_at DESC)');

  if (!hasColumn(db, 'projects', 'deleted_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN deleted_at TEXT');
  }
  /*
    迁移：给已存在的库补上 `folder_id`。
    和 deleted_at 同一套理由——`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列，
    没有这一步，老库上一点「新建文件夹 / 移入文件夹」就会得到 "no such column: folder_id"，
    而报错点在查询里，离"忘了迁移"很远。
  */
  if (!hasColumn(db, 'projects', 'folder_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN folder_id TEXT');
  }
  /*
    迁移：成片的播放策略（见契约里的 `film.settings.set`）。
    老库补上这一列后是 NULL，读的时候按默认的 `hold` 处理——
    所以这里不是"保持旧行为"，而是**修正**：旧库里那些项目的成片
    本来就会在片段短于镜头时露黑底，那不是谁选择的策略。
  */
  if (!hasColumn(db, 'projects', 'film_playback')) {
    db.exec('ALTER TABLE projects ADD COLUMN film_playback TEXT');
  }
  /* 镜头之间怎么换（见契约里的 film.settings.set）；NULL 按 `cut` 读 */
  if (!hasColumn(db, 'projects', 'film_transition')) {
    db.exec('ALTER TABLE projects ADD COLUMN film_transition TEXT');
  }
  /* 方向性转场的方向（left/right/up/down）；NULL 按 left 读 */
  if (!hasColumn(db, 'projects', 'film_transition_direction')) {
    db.exec('ALTER TABLE projects ADD COLUMN film_transition_direction TEXT');
  }

  /**
   * 迁移：给两张生成意图表补上"供应商原样报出的花费"。
   *
   * 起因是一个记错的账：`actual_cost_cents` 以前会被填上**预估成本**
   * （供应商报积分或什么都不报时），于是账本里那个"实际花费"是谁也没报过的数字。
   * 现在把"谁报了什么、单位是什么"单独存一份，`actual_cost_cents` 只在
   * 真拿到人民币金额时才写。老库里的历史记录保持原样——**不回溯改写**，
   * 那些行本来就是按旧语义写的，改它们等于用今天的判断去修昨天的账。
   */
  for (const table of ['image_generation_intents', 'video_generation_intents']) {
    if (!hasColumn(db, table, 'provider_cost_unit')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN provider_cost_unit TEXT`);
    }
    if (!hasColumn(db, table, 'provider_cost_amount')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN provider_cost_amount REAL`);
    }
    /*
      迁移：给两张表补上"预留释放理由"。

      老库里的历史行这一列是 NULL，而 NULL 的含义正是"这笔预留还占着/没释放过"——
      与旧行为一致，所以不需要回溯改写。
    */
    if (!hasColumn(db, table, 'reservation_released_reason')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN reservation_released_reason TEXT`);
    }
    /*
      迁移：执行摘要与复用来源。
      老库里的历史行这两列是 NULL，含义正是"没有摘要/不是复用来的"——
      与旧行为一致，不回溯改写。
    */
    if (!hasColumn(db, table, 'digest')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN digest TEXT`);
    }
    if (!hasColumn(db, table, 'reused_from_intent_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN reused_from_intent_id TEXT`);
    }
  }
  return db;
}
