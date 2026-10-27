/* ============================================================
  小QTV · 内置 Agent 动作行（工具调用）的说法
  ------------------------------------------------------------
  为什么要单独一层：小QTV 那个对话 Agent 画动作时**不画函数名**，
  画的是一套按状态给的词条——
    「正在查找画布 / 画布已读取 / 正在编排画布 / 画布编排已完成 /
      已创建 {count} 个画布节点 / 视频待确认后生成」

  我们原来直接把 `add_canvas_nodes` 这种函数名画在对话里：
  同一件事，一个像产品，一个像日志——而且用户看不懂。

  起词的三条规矩（照它那套做法，但词只能起我们**真做得到**的）：
    ① 每个动作两条词：开始时「正在…」、跑完时「…已…」；
    ② 完成那条优先用主进程给的 `note` —— 那里有**真实数量**；
       词表里的那句只是没有 note 时的兜底；
    ③ 认不出的工具名**原样返回**，不硬塞进某一类。
       塞进去就是在描述一件我们不知道的事（上一轮用它拒掉过"抄它的词"）。
  ============================================================ */

export interface BuiltinToolPhrase {
  /** 开始那条 */
  running: string;
  /** 跑完那条（没有 note 时的兜底） */
  done: string;
  /**
   * 没做成那条。
   *
   * 为什么必须有：完成那条的词都是"…已…"（生成已提交、画布已写入）。
   * 失败时拿它来画，界面上就成了「生成已提交 · 失败」——同一行里
   * 前半句说提交了、后半句说失败。真机跑出来的，不是假想。
   */
  failed: string;
}

/**
 * 内置 Agent 那 10 个工具各两条词。
 *
 * 词从我们自己的动作面来：读项目 / 读画布 / 编排画布 / 连线 / 按镜头建节点 /
 * 提交生成 / 跑任务 op / 提命令。**没有**它那套"参考视频分析中""首尾帧已提取"
 * ——那些我们还没有对应的动作，摆上去就是假话。
 */
export const BUILTIN_TOOL_PHRASES: Readonly<Record<string, BuiltinToolPhrase>> = {
  list_projects: { running: '正在列出项目', done: '项目已列出', failed: '项目没能列出' },
  read_project: { running: '正在读取项目', done: '项目已读取', failed: '项目没读到' },
  read_canvas: { running: '正在查找画布', done: '画布已读取', failed: '画布没读到' },
  write_canvas: { running: '正在编排画布', done: '画布编排已完成', failed: '画布没能写入' },
  add_canvas_nodes: { running: '正在编排画布', done: '画布编排已完成', failed: '画布节点没能创建' },
  connect_canvas_nodes: { running: '正在连接节点', done: '连线已完成', failed: '连线没能完成' },
  create_nodes_from_shots: { running: '正在按镜头创建节点', done: '镜头节点已创建', failed: '镜头节点没能创建' },
  write_screenplay: { running: '正在写剧本', done: '剧本已写入', failed: '剧本没能写入' },
  /*
    ⚠ 这里是「**正在生成 / 已生成**」，不是「正在提交 / 已提交」。

    生成这条路是**阻塞等到出结果**的：generateShotImages 里 `await backend.generateImage`
    之后当场把产物读回来入库（见 packages/generation-service/src/index.ts）。
    所以工具返回时图片已经在项目里了——写「已提交」是**把干完的活说成刚交出去**
    （小QTV 那套词也是 `图片已生成`，不是"已提交"）。
  */
  generate_for_nodes: { running: '正在生成', done: '已生成', failed: '没能生成' },
  run_task: { running: '正在执行任务', done: '任务已完成', failed: '任务没能执行' },
  submit_command: { running: '正在提交命令', done: '命令已提交', failed: '命令没能提交' },
};

/**
 * 任务级 op 各有各的说法（跑的是哪一步，界面就画哪一步）。
 *
 * 词照 小QTV 那套的形态起（`成片合成中 / 成片已合成`、`图片已生成` 是它的原话），
 * 但只列我们**真会跑**的那些 op（白名单见 agent-tools.ts）。
 * 没登记的一律回落到「正在执行任务（op）」——带上 op 名，比编一个中文词诚实。
 */
export const TASK_OP_PHRASES: Readonly<Record<string, BuiltinToolPhrase>> = {
  analyze: { running: '正在拆解镜头', done: '镜头已拆解', failed: '拆解没能完成' },
  candidates: { running: '正在挑候选画面', done: '候选已列出', failed: '候选没能列出' },
  'generate-images': { running: '正在生成图片', done: '图片已生成', failed: '图片没能生成' },
  'generate-videos': { running: '正在生成视频', done: '视频已生成', failed: '视频没能生成' },
  'retake-video': { running: '正在重拍片段', done: '片段已重拍', failed: '片段没能重拍' },
  produce: { running: '正在合成成片', done: '成片已合成', failed: '成片没能合成' },
  evaluate: { running: '正在比对成片', done: '比对已完成', failed: '比对没能完成' },
  'propose-repair': { running: '正在拟修复方案', done: '修复方案已拟出', failed: '修复方案没能拟出' },
  'execute-repair': { running: '正在执行修复', done: '修复已执行', failed: '修复没能执行' },
  filmstrip: { running: '正在拉片', done: '拉片已完成', failed: '拉片没能完成' },
  'extract-audio': { running: '正在分离音轨', done: '音轨已分离', failed: '音轨没能分离' },
  'model-capabilities': { running: '正在查模型能力', done: '模型能力已查到', failed: '模型能力没能查到' },
  'available-models': { running: '正在列可用模型', done: '可用模型已列出', failed: '可用模型没能列出' },
};

/** 参数里能看出来的数量——「正在连接 4 条连线」比「正在连接节点」有用 */
function countOf(args: Record<string, unknown> | undefined, key: string): number {
  const value = args?.[key];
  return Array.isArray(value) ? value.length : 0;
}

/**
 * 开始那条。
 *
 * 数量只在**多于一个**时才写：只做一件事的时候，多写一个「（1 个节点）」
 * 是噪音（小QTV 那套词也是单数不写数字，只有 `已创建 {count} 个` 才带）。
 */
export function builtinToolRunning(name: string, args?: Record<string, unknown>): string {
  const phrase = BUILTIN_TOOL_PHRASES[name];
  if (phrase === undefined) return name;

  if (name === 'add_canvas_nodes') {
    const count = countOf(args, 'nodes');
    return count > 1 ? `正在编排画布（${count} 个节点）` : phrase.running;
  }
  if (name === 'connect_canvas_nodes') {
    const count = countOf(args, 'edges');
    return count > 1 ? `正在连接节点（${count} 条连线）` : phrase.running;
  }
  if (name === 'generate_for_nodes') {
    const count = countOf(args, 'nodeIds');
    return count > 1 ? `正在生成（${count} 个节点）` : phrase.running;
  }
  if (name === 'run_task') {
    const op = typeof args?.op === 'string' ? args.op : '';
    const opPhrase = TASK_OP_PHRASES[op];
    if (opPhrase !== undefined) return opPhrase.running;
    /* 没登记的就带上 op 名：用户至少知道这一步在跑什么 */
    return op === '' ? phrase.running : `${phrase.running}（${op}）`;
  }
  return phrase.running;
}

/**
 * 跑完那条：有 note 用 note（里面有真实数量）；
 * 没成的那条**不许用"已完成"那套词**（见 BuiltinToolPhrase.failed 的说明）。
 */
export function builtinToolDone(
  name: string,
  note?: string,
  failed = false,
  args?: Record<string, unknown>,
): string {
  if (note !== undefined && note.trim() !== '') return note.trim();
  if (name === 'run_task') {
    const op = typeof args?.op === 'string' ? args.op : '';
    const opPhrase = TASK_OP_PHRASES[op];
    if (opPhrase !== undefined) return failed ? opPhrase.failed : opPhrase.done;
  }
  const phrase = BUILTIN_TOOL_PHRASES[name];
  if (phrase === undefined) return name;
  return failed ? phrase.failed : phrase.done;
}

/* ---------- 生成这件事的**真实回执** ---------- */

/**
 * 生成过程中的那一行字（跑完一镜就更新一次）。
 *
 * 为什么要有它：真后端一镜要几十秒到几分钟，而这条路是**阻塞**的——
 * 没有心跳，界面上从头到尾只有「正在生成（3 个节点）」，用户分不清它是在跑还是卡死了。
 * 小QTV 那边是「图片节点创建中」这类推进，我们照同一个形态报**第几镜 / 共几镜**。
 *
 * 只报数，不报百分比：进度是按"镜"报的，画成百分比会给出一个我们没有的精度。
 */
export function generationProgressText(progress: { done: number; total: number }): string {
  if (progress.total <= 0) return '正在生成';
  return `正在生成（${progress.done}/${progress.total} 镜）`;
}

export interface GenerationReceipt {
  /** 这一批真的产出了几张 / 几段 */
  generated: number;
  /** 有几个镜头没成 */
  failures: number;
  /** 其中几个是复用已有产物（复用不花钱） */
  reused: number;
  /**
   * 后端对参数做的调整 / 对产出本身的说明（原样带出来，不加工）。
   *
   * 为什么必须带：小QTV 会把该模型不认的键丢掉、把取值改成 schema 的写法；
   * 而"本地假后端"这类测试后端会在这里写明**它产出的是占位图**。
   * 这些都属于"用户设了 / 以为的，跟实际不一样"的事，不能烂在工具结果里。
   */
  notes: string[];
  /**
   * 每一个没成的镜头**为什么**没成（原样带出来）。
   *
   * 为什么必须带：一张都没出的时候，面板上那句"0 张（1 组跑完但没有产物）"
   * 等于什么都没说。真机上撞到的那次，真实原因是「项目 revision 冲突」——
   * 那句话才是用户（和模型）能据此动手的东西。
   */
  failureReasons: string[];
}

/**
 * 从任务 op 的回复里把"到底出了几个"读出来。
 *
 * 为什么要写这一层：工具回复的形状是**套了两层**的
 * （`{ok, data:{ok, data:{generated…}}}`——外层是"这次调用送达了"，
 * 而 0 会被画成"一张都没出"——那就是假话。
 *
 * 所以这里按"哪一层有 `generated` / `failures` 就用哪一层"去找；
 * 真的找不到就是 0（**宁可少报，也不编一个数**）。
 */
export function generationReceipt(body: unknown): GenerationReceipt {
  const found = findGenerationResult(body, 0);
  const generated = found !== null && Array.isArray(found.generated) ? (found.generated as unknown[]) : [];
  const failures = found !== null && Array.isArray(found.failures) ? (found.failures as unknown[]) : [];
  const reused = generated.filter((item) => (
    item !== null && typeof item === 'object' && (item as { reused?: unknown }).reused === true
  )).length;
  const notes: string[] = [];
  for (const item of generated) {
    if (item === null || typeof item !== 'object') continue;
    const raw = (item as { parameter_notes?: unknown }).parameter_notes;
    if (!Array.isArray(raw)) continue;
    for (const note of raw) {
      if (typeof note === 'string' && note !== '') notes.push(note);
    }
  }
  const failureReasons: string[] = [];
  for (const item of failures) {
    if (item === null || typeof item !== 'object') continue;
    const reason = (item as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason !== '') failureReasons.push(reason);
  }
  return { generated: generated.length, failures: failures.length, reused, notes, failureReasons };
}

function findGenerationResult(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 4 || value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.generated) || Array.isArray(record.failures)) return record;
  for (const nested of Object.values(record)) {
    const found = findGenerationResult(nested, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 面板上那句生成回执（抽成纯函数：这句话是**用户唯一能看到的产出凭证**，
 * 必须能被测试钉住，不能散在几百行编排代码里拼字符串）。
 *
 * 三条规矩：
 *   · 说**产出**（几张 / 几段），不说"提交了几组"——活已经干完了；
 *   · 复用**单独说**（那几张没花钱）；
 *   · 一个都没出的时候如实说 0，并把原因交给 waitingNote（在等谁）或直接说没生成。
 */
export function generationNote(input: {
  images: number;
  videos: number;
  reused: number;
  failedShots: number;
  skippedNodes: number;
  okGroups: number;
  waitingNote: string | null;
  /** 后端自己说的话（参数被调整、产出是占位图之类），最多带一条 */
  notes?: readonly string[];
  /** 一个都没出时要说清**为什么**（原样带出来，不加工） */
  failureReasons?: readonly string[];
}): string {
  const produced: string[] = [];
  if (input.images > 0) produced.push(`${input.images} 张图片`);
  if (input.videos > 0) produced.push(`${input.videos} 段视频`);
  if (produced.length > 0) {
    const note = input.notes?.[0];
    return `已生成 ${produced.join(' + ')}`
      + (input.reused > 0 ? `（其中 ${input.reused} 个是复用，没花钱）` : '')
      + (input.failedShots > 0 ? `（${input.failedShots} 个镜头失败）` : '')
      + (input.skippedNodes > 0 ? `（另有 ${input.skippedNodes} 个节点没参与）` : '')
      + (note === undefined ? '' : `（${note.length > 60 ? `${note.slice(0, 60)}…` : note}）`);
  }
  const reason = input.failureReasons?.[0];
  if (reason !== undefined) {
    return `没能生成（${reason.length > 60 ? `${reason.slice(0, 60)}…` : reason}）`;
  }
  if (input.okGroups > 0) return `已生成 0 张（${input.okGroups} 组跑完但没有产物）`;
  return input.waitingNote ?? '一组都没生成';
}

/* ---------- "只差你点一下"的那几件事 ---------- */

/**
 * 「在等你」这件事的**结构化**说法。
 *
 * 为什么要结构而不是只给一句中文：界面上那一行要能**点**——
 * 点了要填预算、要去批准、要去选首帧。拿中文措辞去猜该做什么，
 * 改一个字的文案就会把按钮连到错的动作上。
 *
 * `nodeIds` 是"这件事跟哪些节点有关"：填预算要按节点写，
 * 定位也要按节点跳。
 */
export interface ToolWaiting {
  kind: 'budget' | 'gate' | 'first-frame';
  nodeIds: string[];
  /** kind === 'gate' 时是哪一个闸门（G1 图 / G2 视频） */
  gate?: string;
}

/**
 * 领域层报出这几个码时，这件事**不是走不通，是只差用户点一下**：
 *
 *   G1_REQUIRED / G2_REQUIRED  闸门没批准——批准只能是人的决定（产品核心规则）
 *   FIRST_FRAME_REQUIRED       还没给这个镜头选首帧
 *
 * 为什么必须单列：小QTV 那套词里这两件事也是分开的
 * （`视频待确认后生成` vs 失败）。画成一个红叉，用户会去查"是不是坏了"，
 * 而这几个码的正确答案是"你去点一下那一处"。
 *
 * **只列这几个**：别的错误码该按失败画就按失败画，不许为了好看往这里塞。
 */
const PENDING_DOMAIN: Readonly<Record<string, { note: string; kind: ToolWaiting['kind']; gate?: string }>> = {
  G1_REQUIRED: { note: '待你批准 G1 后生成', kind: 'gate', gate: 'G1' },
  G2_REQUIRED: { note: '待你批准 G2 后生成', kind: 'gate', gate: 'G2' },
  FIRST_FRAME_REQUIRED: { note: '待你选定首帧后生成', kind: 'first-frame' },
};

/**
 * 从工具回复里把领域层的错误码抠出来。
 *
 * 两种形状都要认，因为它们真的都存在（都实测过）：
 *   · 领域层**抛**出来的（闸门拒绝）：`{ ok:false, code:'G1_REQUIRED', reason:… }`
 *   · 领域层**返回**的（前置检查没通过）：`{ ok:true, data:{ ok:false, body:{ error:{ code } } } }`
 * 第二种外面那层 `ok:true` 只是"这次调用送达了"，不是"这件事办成了"——
 * 拿外层当结果就是拿"送到了"当"办成了"。
 */
export function domainErrorCode(body: Record<string, unknown>): string | null {
  if (typeof body.code === 'string' && body.code !== '') return body.code;
  const inner = body.data;
  if (inner === null || typeof inner !== 'object') return null;
  const nested = (inner as Record<string, unknown>).body;
  if (nested === null || typeof nested !== 'object') return null;
  const error = (nested as Record<string, unknown>).error;
  if (error === null || typeof error !== 'object') return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' && code !== '' ? code : null;
}

/** 这个码对应的"在等你"说法；不是那几个码就返回 null（该按失败画就按失败画） */
export function pendingNoteForCode(code: string | null): string | null {
  if (code === null) return null;
  return PENDING_DOMAIN[code]?.note ?? null;
}

/** 这个码对应的"在等你"结构（界面上那个按钮要按它决定做什么）；不是那几个码就是 null */
export function pendingFromDomainCode(
  code: string | null,
  nodeIds: readonly string[] = [],
): ToolWaiting | null {
  if (code === null) return null;
  const entry = PENDING_DOMAIN[code];
  if (entry === undefined) return null;
  return {
    kind: entry.kind,
    nodeIds: [...nodeIds],
    ...(entry.gate === undefined ? {} : { gate: entry.gate }),
  };
}

/**
 * 这次工具调用**到底办成了没有**。
 *
 * 内层的 `ok` 优先：`{ ok:true, data:{ ok:false, … } }` 是"送到了但没办成"。
 * 内层没有 `ok` 字段时（`project` / `projects` / `command` 那几路的 data
 * 是项目对象或列表）才看外层。
 */
export function toolReplyOk(body: Record<string, unknown>): boolean {
  const inner = body.data;
  if (inner !== null && typeof inner === 'object'
    && typeof (inner as Record<string, unknown>).ok === 'boolean') {
    return (inner as Record<string, unknown>).ok === true;
  }
  return body.ok === true;
}
