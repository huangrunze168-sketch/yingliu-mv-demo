/* ============================================================
  期音科技 · 节点属性写入策略（NODE-004）
  ------------------------------------------------------------
  矩阵对这一条的验收口径是两条，两条都能量：

    「schema 外参数提交被拒率 100%；**白名单外属性写入被拒率 100%**」

  它背后的分区规则来自 小QTV CLI 的权威对照（本机那份 skill 的
  `node-types/README.md`）：

    `-s, --set`     → `data.params.*`  **生成参数**：按当前模型 schema 严格校验
    `-u, --update`  → `data.*`（不含 params） **节点属性**：白名单式键名拒写

  它那份"`-u` 明确拒写的键"清单是这一条的原始依据：

    `params` / `label` / `type` / `action` / `taskInfo` / `prevTaskInfo`
    / `generatorType` / `isStale`

  这三类键在我们这里各自有明确归宿，所以策略也分三层：

    ① **一律拒写**：身份、类型、位置、以及"由任务链路维护"的那批字段。
       位置（`x`/`y`）单独拒是因为它有专门的移动动作——从属性写入绕过去
       会让"移动节点"这条路径上的一致性检查（连线、分组框、吸附）全部失效。
    ② **只允许宿主写**：运行态与产物元数据（`state`/`progress`/`previewUrl`/…）。
       界面里的任务链路就是宿主，它得写；而**外部写入**（Agent / 插件 / CLI）
       写这些等于绕过任务链路直接改状态——那正是这一条要挡的。
    ③ **可写白名单**：改名与剪辑参数这类"节点自己承载的属性"。

  `prompt` / `model` 单列成 **generationParams**：它们既不是"被拒"，也不是
  普通属性——按 小QTV 的分区，它们属于**生成参数**，要过模型 schema 校验
  （见 `validateGenerationParamKeys`）。
   ============================================================ */

export type NodePatchActor = 'host' | 'external';

export interface NodePatchRejection {
  key: string;
  reason: string;
  /** 该走哪条路（没有替代说法时为空串） */
  instead: string;
}

export interface NodePatchDecision {
  /** 可以直接写进节点的属性 */
  accepted: Record<string, unknown>;
  /** 属于生成参数：不在这里判，交给模型 schema 校验 */
  generationParams: Record<string, unknown>;
  rejected: NodePatchRejection[];
}

/** ① 一律拒写。理由与替代做法逐条给出——只说"非法"等于没说。 */
export const NODE_PATCH_REFUSED: Readonly<Record<string, { reason: string; instead: string }>> = {
  id: { reason: '节点身份不可变更', instead: '删掉重建一个' },
  type: {
    reason: '节点类型不可通过属性写入变更',
    instead: '删掉重建（小QTV CLI 的 `-u type=` 同样被拒）',
  },
  x: { reason: '位置不在属性写入这条路上', instead: '用移动节点的动作（它会一并处理连线与吸附）' },
  y: { reason: '位置不在属性写入这条路上', instead: '用移动节点的动作（它会一并处理连线与吸附）' },
  params: { reason: 'params 是生成参数的容器', instead: '改生成参数走模型 schema 那条路' },
  action: { reason: '由任务链路维护', instead: '不要手写' },
  taskInfo: { reason: '由任务链路维护', instead: '不要手写' },
  prevTaskInfo: { reason: '由任务链路维护', instead: '不要手写' },
  generatorType: { reason: '由任务链路维护', instead: '不要手写' },
  isStale: { reason: '由任务链路维护', instead: '不要手写' },
};

/** ② 只允许宿主写（界面里的任务链路）。外部写入一律拒。 */
export const NODE_HOST_ONLY: Readonly<Record<string, string>> = {
  state: '运行状态由任务链路维护，外部写入等于绕过它改状态',
  progress: '进度由任务链路维护',
  thumb: '缩略图是产物登记的结果',
  previewUrl: '预览地址是产物登记的结果',
  previewKind: '预览类型跟着产物走',
  pendingSelection: '是否待选帧由项目事实推导',
  candidates: '候选清单来自项目事实',
  costCents: '花费由预算台账记账',
  shotId: '镜头归属由项目事实决定',
  artifactId: '产物 id 由产物登记决定',
  contentWidth: '素材尺寸由探测得到',
  contentHeight: '素材尺寸由探测得到',
  saveRejected: '保存被拒是同步层的状态',
  draggable: '可拖拽由权限与编辑态决定',
};

/** ③ 可写白名单：节点自己承载的属性。 */
export const NODE_PROPERTY_WHITELIST: Readonly<Record<string, string>> = {
  name: '展示名',
  clipSequence: '智能剪辑的片段顺序',
  clipSegments: '智能剪辑的片段实例（含位置、入点、变速）',
  clipEdits: '旧版逐源编辑（保留兼容）',
  clipTransition: '转场',
  clipAnimation: '片段动画',
  clipLayout: '视频轨布局',
  clipAudioTracks: '音频轨',
  clipSubtitles: '字幕',
  clipSubtitleStyle: '字幕样式',
};

/**
 * 属于**生成参数**的键（走模型 schema 校验，不走属性白名单）。

 * 这里只列"落到节点上的那几个入口键"：真正的参数展开在 `paramSchema` 里
 * （它才是从 小QTV 扒下来的权威表）。这一层只负责把它们**分出来**，
 * 别让它们混进属性白名单——混进去的话，"schema 外参数被拒"就没人管了。
 */
export const NODE_GENERATION_PARAM_KEYS: readonly string[] = ['prompt', 'model'];

/**
 * 判定一次节点属性写入。

 * `actor` 的区别是这一条的关键：宿主（界面任务链路）写运行态是正常业务，
 * 外部写同样的字段就是绕过。用一个参数表达"谁在写"，比两套函数更不容易漂。
 */
export function decideNodePatch(
  patch: Record<string, unknown>,
  options: { actor: NodePatchActor },
): NodePatchDecision {
  const accepted: Record<string, unknown> = {};
  const generationParams: Record<string, unknown> = {};
  const rejected: NodePatchRejection[] = [];

  for (const [key, value] of Object.entries(patch)) {
    const refused = NODE_PATCH_REFUSED[key];
    if (refused !== undefined) {
      rejected.push({ key, reason: refused.reason, instead: refused.instead });
      continue;
    }
    const hostOnly = NODE_HOST_ONLY[key];
    if (hostOnly !== undefined) {
      if (options.actor === 'external') {
        rejected.push({ key, reason: hostOnly, instead: '这件事由界面里的任务链路做' });
      } else {
        accepted[key] = value;
      }
      continue;
    }
    if (NODE_GENERATION_PARAM_KEYS.includes(key)) {
      generationParams[key] = value;
      continue;
    }
    if (NODE_PROPERTY_WHITELIST[key] !== undefined) {
      accepted[key] = value;
      continue;
    }
    rejected.push({
      key,
      reason: '不在节点属性白名单里',
      instead: '可写的属性见 NODE_PROPERTY_WHITELIST；生成参数走模型 schema',
    });
  }

  return { accepted, generationParams, rejected };
}

/**
 * 生成参数的键校验：把"这个模型不认识的键"挑出来。

 * `allowed` 由调用方给——它来自 `paramSchema` 的 `panelFields(modelKey, modeType)`
 * 与 `advancedGroups(modelKey)`，也就是**从 小QTV 扒下来的那张表**。
 * 这一层不重复实现那张表，只做判定：少一处数据源就少一处漂移。
 */
export function validateGenerationParamKeys(input: {
  allowed: readonly string[];
  keys: readonly string[];
  /** 全局都认的结构键（`prompt` / `model` / `count` 这类） */
  structural?: readonly string[];
}): NodePatchRejection[] {
  const structural = new Set(input.structural ?? ['prompt', 'model', 'count', 'modeType']);
  const allowed = new Set(input.allowed);
  const rejected: NodePatchRejection[] = [];
  for (const key of input.keys) {
    if (structural.has(key)) continue;
    if (allowed.has(key)) continue;
    rejected.push({
      key,
      reason: `当前模型/模式下没有参数「${key}」`,
      instead: '用这个模型支持的参数，或者换一个支持它的模型',
    });
  }
  return rejected;
}

/** 外部写底板时被拒的属性（带节点身份，调用方才知道是哪一处）。 */
export interface BoardPatchRejection {
  node_id: string;
  node_name: string;
  key: string;
  reason: string;
  instead: string;
}

/**
 * 外部整份写底板时的**属性审计**。

 * 为什么只判"改动了哪些键"，而不是把整个节点过一遍白名单：
 * 写底板是"把我手里这一份存下来"，节点上绝大多数字段（产物 id、尺寸、运行态…）
 * 本来就该原样保留——拿整份节点去判会把正常保存全部拒掉。

 * 被拒的键**恢复成旧值**（旧板里没有就删掉），而不是让整次写入失败：
 * 一次写入里通常既有合法改动也有越界项，整份拒绝会让调用方看不出哪里错了。
 * 每一处都在返回值里列出来，界面/Agent 能如实说"这几处没写进去"。
 */
export function auditExternalBoardWrite(
  previous: unknown,
  nodes: readonly unknown[],
): { nodes: unknown[]; rejected: BoardPatchRejection[] } {
  const previousNodes = (previous as { nodes?: Array<Record<string, unknown>> } | null)?.nodes ?? [];
  const previousById = new Map(previousNodes.map((node) => [String(node.id ?? ''), node]));
  const rejected: BoardPatchRejection[] = [];

  const next = nodes.map((raw) => {
    if (raw === null || typeof raw !== 'object') return raw;
    const node = raw as Record<string, unknown>;
    const base = previousById.get(String(node.id ?? '')) ?? {};
    const changed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (JSON.stringify(base[key]) !== JSON.stringify(value)) changed[key] = value;
    }
    const decision = decideNodePatch(changed, { actor: 'external' });
    if (decision.rejected.length === 0) return node;

    const cleaned: Record<string, unknown> = { ...node };
    for (const item of decision.rejected) {
      rejected.push({
        node_id: String(node.id ?? ''),
        node_name: String(node.name ?? ''),
        key: item.key,
        reason: item.reason,
        instead: item.instead,
      });
      if (Object.prototype.hasOwnProperty.call(base, item.key)) cleaned[item.key] = base[item.key];
      else delete cleaned[item.key];
    }
    return cleaned;
  });

  return { nodes: next, rejected };
}
