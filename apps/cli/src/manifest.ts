/* ============================================================
  期音科技 · CLI 能力边界声明（CLI-006）
  ------------------------------------------------------------
  矩阵对这一条的验收口径是两句话，两句都能量：

    「越界命令返回**稳定错误码**率 100%」
    「Manifest **覆盖全部已发布命令**」

  第一句防的是"越界被当成成功"——脚本里 `set -e` 抓不到，链子会带着
  一半成功的状态往下跑（小QTV 那份 `examples/pipes/error-handling.md`
  整篇都在讲这件事）。第二句防的是"清单和实现漂开"：
  新加一个命令却忘了写进清单，用户按清单用就会漏掉它。

  所以这份 manifest 不是文档，是**可被机器核对的声明**：
  测试会把它和 `index.ts` 里的 `case` 列表逐条比对（`tests/cli-manifest.test.ts`），
  对不上就红。同为这个仓库里"声明与实现不许漂开"的第三处
  （前两处是插件清单、Provider 鉴权清单）。

  写 `refuses` 的规矩：**只写这条命令真的会拒绝的事**，而且尽量写成
  用户会踩的那个动作。参考的是 小QTV CLI 那份「常见错误对照」（左错右对）——
  它把"不能做什么"直接摆出来，比一句"请阅读文档"有用得多。
   ============================================================ */

export interface CliCommandSpec {
  name: string;
  summary: string;
  /** 必填参数（`--x`） */
  requires: readonly string[];
  /** 选填参数（`--x`） */
  options: readonly string[];
  /** 这条命令**会花钱**吗。付费路径必须显式标出来，不能让用户猜。 */
  paid: boolean;
  /** 它明确**不做**什么；没有就空数组，不要写套话。 */
  refuses: readonly string[];
}

/** 这台机器上 `qiyin` CLI 已经发布的全部命令。测试会核对它是否覆盖源码里每个 case。 */
export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    name: 'project:create',
    summary: '建一个项目（预算与权利确认在这一步写死）',
    requires: ['--name'],
    options: ['--budget-cents', '--rights-confirmed', '--command-id'],
    paid: false,
    refuses: ['预算不是"上限提示"：超出它的付费请求会被领域层直接拒绝'],
  },
  { name: 'project:list', summary: '列出本机所有项目', requires: [], options: [], paid: false, refuses: [] },
  { name: 'project:status', summary: '读一个项目的完整状态', requires: ['--project-id'], options: [], paid: false, refuses: [] },
  { name: 'provider:list', summary: '列出已登记的生成后端', requires: [], options: [], paid: false, refuses: [] },
  {
    name: 'gate:approve',
    summary: '人工闸门放行（G0 权利与预算 / G1 拆解锁定 / G2 首帧与视频预算）',
    requires: ['--project-id', '--revision', '--gate'],
    options: ['--budget-cents'],
    paid: false,
    refuses: ['不能跳过 G1 直接批 G2（顺序由领域层强制）'],
  },
  { name: 'kernel:tasks', summary: '列出内核任务（含失败归因）', requires: ['--project-id'], options: [], paid: false, refuses: [] },
  { name: 'source:list', summary: '列出项目里的参考素材', requires: ['--project-id'], options: [], paid: false, refuses: [] },
  { name: 'candidate:list', summary: '列出候选首帧', requires: ['--project-id'], options: [], paid: false, refuses: [] },
  {
    name: 'shot-fields:set',
    summary: '写逐镜七字段',
    requires: ['--project-id', '--revision', '--shot', '--values'],
    options: [],
    paid: false,
    refuses: ['字段少了会被拒：七字段要么齐、要么不改'],
  },
  {
    name: 'candidate:select',
    summary: '选定某镜首帧（G2 的前置）',
    requires: ['--project-id', '--revision', '--shot', '--candidate'],
    options: ['--selection-revision'],
    paid: false,
    refuses: ['未选帧的镜头，付费视频请求会被领域层直接拒绝'],
  },
  {
    name: 'source:register',
    summary: '把磁盘上的文件登记成项目素材（只存相对路径与内容哈希）',
    requires: ['--project-id', '--revision', '--workspace', '--file'],
    options: ['--as'],
    paid: false,
    refuses: ['不接受绝对路径：参考片必须以项目内相对路径收进来'],
  },
  {
    name: 'kernel:check',
    summary: '内核体检（前置内核 是否可用、契约有没有漂）',
    requires: ['--project-id', '--revision', '--source', '--workspace'],
    options: [],
    paid: false,
    refuses: ['只读：不改项目状态'],
  },
  {
    name: 'kernel:plan',
    summary: '内核规划（给拆解排计划，不出钱）',
    requires: ['--project-id', '--revision', '--source', '--workspace'],
    options: ['--package-root'],
    paid: false,
    refuses: ['不做实际生成'],
  },
  {
    name: 'kernel:build',
    summary: '内核构建（本机加工，跑出拆解结果）',
    requires: ['--project-id', '--revision', '--source', '--workspace'],
    options: ['--runtime-profile', '--package-root', '--follow'],
    paid: false,
    refuses: ['这条**不产生生成费用**：全程走本机加工'],
  },
  {
    name: 'kernel:status',
    summary: '查一次内核任务的状态',
    requires: ['--build-id', '--workspace'],
    options: ['--runtime-profile'],
    paid: false,
    refuses: [],
  },
  {
    name: 'kernel:inspect',
    summary: '看一次内核产出里有什么',
    requires: ['--build-id', '--workspace'],
    options: ['--output'],
    paid: false,
    refuses: [],
  },
  {
    name: 'kernel:get',
    summary: '把内核产出取到指定目录',
    requires: ['--build-id', '--output', '--to', '--workspace'],
    options: [],
    paid: false,
    refuses: ['只取这一次构建的结果，不做跨项目搬运'],
  },
  {
    name: 'kernel:analyze',
    summary: '分析参考片（镜头边界候选，本机算）',
    requires: ['--project-id', '--revision', '--workspace', '--media'],
    options: ['--no-seed'],
    paid: false,
    refuses: ['不消耗生成积分：镜头边界候选在本机算'],
  },
  {
    name: 'kernel:candidates',
    summary: '列镜头边界候选',
    requires: ['--project-id', '--revision', '--workspace', '--media'],
    options: [],
    paid: false,
    refuses: [],
  },
  {
    name: 'kernel:transcribe',
    summary: '转录（走 前置内核 / WhisperX，**可能产生服务费用**）',
    requires: ['--project-id', '--revision', '--workspace', '--media', '--language'],
    options: ['--runtime-profile'],
    paid: true,
    refuses: ['不带 --confirm-execution 不会真的提交：先让你核对费用'],
  },
  {
    name: 'film:produce',
    summary: '合成成片（按时间线拼）',
    requires: ['--project-id', '--revision', '--workspace', '--media'],
    options: [],
    paid: false,
    refuses: ['本机跑 ffmpeg：不产生生成费用'],
  },
  {
    name: 'film:evaluate',
    summary: '偏差评估（成片对参考片）',
    requires: ['--project-id', '--revision', '--workspace', '--result'],
    options: [],
    paid: false,
    refuses: ['评估口径是四项可量指标，不做主观画质打分'],
  },
  {
    name: 'backend:list',
    summary: '列出这台机器上有哪些生成后端可用',
    requires: [],
    options: [],
    paid: false,
    refuses: ['只报"装了没有"，不替用户选'],
  },
  {
    name: 'canvas:status',
    summary: '看项目当前绑的是哪张 小QTV 画布',
    requires: ['--workspace'],
    options: [],
    paid: false,
    refuses: [],
  },
  {
    name: 'canvas:bind',
    summary: '绑定一张 小QTV 画布（未绑定时会真的在账号里建一张）',
    requires: ['--workspace'],
    options: ['--name'],
    paid: false,
    refuses: ['不会改动已绑定画布里的节点'],
  },
  {
    name: 'image:generate',
    summary: '按镜出图（走选定的生成后端，**会花钱**）',
    requires: ['--project-id', '--revision', '--workspace', '--model'],
    options: ['--backend', '--canvas-cwd', '--ratio', '--quality', '--cost-cents', '--shots'],
    paid: true,
    refuses: [
      '--model 必填：这条命令不替你挑模型',
      '未批准 G1 时不提交：领域层会拒',
      '预算不足时不提交：先预留、后结算，差额退回',
    ],
  },
  {
    name: 'video:generate',
    summary: '按镜图生视频（**会花钱**）',
    requires: ['--project-id', '--revision', '--workspace', '--model'],
    options: ['--backend', '--canvas-cwd', '--resolution', '--ratio', '--cost-cents'],
    paid: true,
    refuses: [
      '有镜头没选首帧就不提交：G2 的前置是每镜都已选帧',
      '未批准 G2 时不提交',
    ],
  },
  {
    name: 'command',
    summary: '直接发一条领域命令（domain command JSON）',
    requires: ['--file'],
    options: [],
    paid: false,
    refuses: ['不做二次校验：领域层才是唯一判据，它拒了就是拒了'],
  },
  {
    name: 'capabilities',
    summary: '打印这份能力边界声明（命令清单 + 每条明确不做什么）',
    requires: [],
    options: [],
    paid: false,
    refuses: ['这是声明，不是权限系统：它不变更行为，只把边界说清'],
  },
  {
    name: 'reconcile',
    summary: '对账：列出在飞的付费请求、核对预算台账、给出可执行建议',
    requires: ['--project-id'],
    options: [],
    paid: false,
    refuses: [
      '只读：它报告与建议，不改状态',
      '不替用户放弃生成：释放预留要另发命令',
    ],
  },
];

/**
 * 整个 CLI 层面的边界（不分命令）。

 * 这几条都是"这台机器上的 CLI **不会**做的事"——用户最容易误解的地方。
 */
export const CLI_LIMITS: readonly string[] = [
  '不做"猜测式补全"：缺参数一律报错并给出稳定错误码，不替你填默认值。',
  '不绕过领域层：任何写操作都走同一条 Domain Command，CLI 不是一条旁路。',
  '不隐藏失败：业务结果走 stdout，失败走 stderr 且退出码非 0。',
  '不碰磁盘上不属于本项目的东西：路径越界一律拒绝。',
  /* 这条是写故障注入验收脚本时踩出来的（先记在这儿，省得下一个人再踩） */
  '重试要**原样重发**（连当时的 `--revision` 一起）：幂等指纹覆盖整条命令，'
    + '"同 command_id + 新 revision"会被判成"同一个 id 用在不同命令上"而拒绝——'
    + '那不是幂等失败，而是你发的已经是一发新请求。',
];

/** 稳定的错误码。**越界命令必须是第一个**——矩阵那一条验收要的就是它。 */
export const CLI_ERROR_CODES = {
  unknownCommand: 'CLI_UNKNOWN_COMMAND',
  missingArgument: 'VALIDATION_FAILED',
} as const;

/** 未知命令时给用户的回应：稳定错误码 + 可用命令清单。 */
export interface UnknownCommandResponse {
  schema: 'replica.cli-error@1';
  error: {
    code: typeof CLI_ERROR_CODES.unknownCommand;
    message: string;
    /** 拿到的那个名字原样带回来，用户才知道自己打错在哪 */
    received: string | null;
    /** 可用命令名（不含参数），便于脚本与人都能直接用 */
    available: string[];
    /** 想看每条命令的边界，跑这个 */
    hint: string;
  };
}

export function unknownCommandResponse(received: string | null): UnknownCommandResponse {
  const shown = received === null || received === '' ? '（没给命令）' : received;
  return {
    schema: 'replica.cli-error@1',
    error: {
      code: CLI_ERROR_CODES.unknownCommand,
      message: `不认识的命令：${shown}`,
      received: received === null || received === '' ? null : received,
      available: CLI_COMMANDS.map((command) => command.name),
      hint: '跑 `qiyin capabilities` 看每条命令的用途、参数与明确不做的事',
    },
  };
}

/** 按名字找一条命令；找不到返回 undefined（调用方据此走 unknownCommandResponse）。 */
export function findCommand(name: string | undefined): CliCommandSpec | undefined {
  if (name === undefined || name === '') return undefined;
  return CLI_COMMANDS.find((command) => command.name === name);
}
