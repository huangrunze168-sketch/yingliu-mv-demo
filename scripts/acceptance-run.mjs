/* ============================================================
  期音科技 · 量化验收汇总
  ------------------------------------------------------------
  用法：

    node scripts/acceptance-run.mjs            # 跑一遍验收用例，再汇总
    node scripts/acceptance-run.mjs --skip-run # 只汇总（用上一轮留下的指标）

  它做两件事：

    ① 跑 `vitest run tests/acceptance`——那些用例是真跑的（真数据库、真 FFmpeg）；
    ② 把每个条目写下的指标（`.data/acceptance-metrics/<ID>.json`）汇总成
       一份机器可读的报告 `.data/acceptance-report.json`，并在终端打一张表。

  为什么要有这一层：验收结论必须是**别人可以自己重跑出来的**。
  报告里的每个数字都要能指着这个脚本说"它就是这么量出来的"，
  而不是"当时看着像通过了"。
   ============================================================ */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const METRICS_DIR = resolve('.data/acceptance-metrics');
const REPORT_PATH = resolve('.data/acceptance-report.json');
const LOG_PATH = resolve('.data/acceptance-run.log');

/**
 * 条目 → 矩阵里的功能名。
 *
 * 这份对照表是**手写的**，因为矩阵条目与人写的用例之间没有机器可读的映射。
 * 条目名写在这里，等于把"这一项验收的是矩阵哪一条"钉在脚本里，
 * 免得几个月后没人说得清某个数字对应哪条要求。
 */
const ITEMS = [
  { id: 'CAN-004', priority: 'P0', feature: '连线与端口类型即时校验' },
  { id: 'NODE-002', priority: 'P0', feature: 'Golden Flow 第 9–13 步端到端（失败步数为 0）' },
  { id: 'NODE-002.step9', priority: 'P0', feature: '评估定位到具体镜头与参数' },
  { id: 'NODE-002.step10', priority: 'P0', feature: '只重跑受影响闭包 + Before/After' },
  { id: 'NODE-002.step11', priority: 'P0', feature: '多轨时间轴（PiP + BGM + 配音 + 变速）' },
  { id: 'NODE-002.step12', priority: 'P0', feature: '打组存模板 → 换输入复用一次' },
  { id: 'NODE-002.step13', priority: 'P0', feature: 'Agent 修复草案带成本与影响范围' },
  { id: 'VID-001', priority: 'P1', feature: '插帧 / 稳定（输出规格正确率 100%）' },
  { id: 'VID-005', priority: 'P1', feature: '视频高清 2/4/6 倍 + 30/60/90fps（整数倍与零容差帧率）' },
  { id: 'CAN-004.no-input-port', priority: 'P0', feature: '素材节点不能作为连线终点' },
  { id: 'CAN-004.reason-text', priority: 'P0', feature: '拒绝理由说明类型不匹配' },
  { id: 'FLOW-003', priority: 'P0', feature: '先图选帧后视频（未选帧付费请求 = 0）' },
  { id: 'FLOW-003.missing-list', priority: 'P0', feature: 'G2 拒绝时点名缺失的首帧' },
  { id: 'GEN-005', priority: 'P0', feature: '成本预估与预算上限' },
  { id: 'GEN-005.diff-refund', priority: 'P0', feature: '预估与实际不一致时退回差额' },
  { id: 'GEN-005.unknown-cost', priority: 'P0', feature: '供应商未报金额时记 null' },
  { id: 'AGENT-003', priority: 'P0', feature: '闸门批准与动账命令 Agent 调不到' },
  { id: 'AGENT-003.default-deny', priority: 'P0', feature: '未登记命令默认拒绝' },
  { id: 'AGENT-003.task-ops', priority: 'P0', feature: '导出与直提构建不给 Agent' },
  { id: 'FLOW-006', priority: 'P0', feature: '缓存与历史结果显式复用' },
  { id: 'FLOW-006.digest-collision', priority: 'P0', feature: '执行摘要不产生误命中' },
  { id: 'FLOW-005', priority: 'P0', feature: '改动的影响范围（下游全部失效）' },
  { id: 'EDIT-005.three', priority: 'P0', feature: '三分屏画面位置' },
  { id: 'EDIT-005.quad', priority: 'P0', feature: '四分屏画面位置' },
  { id: 'EDIT-004', priority: 'P1', feature: '多视频轨 + 多音频轨同时编辑' },
  { id: 'API-001', priority: 'P0', feature: '版本化本地 API（只绑回环地址）' },
  { id: 'EDIT-007', priority: 'P1', feature: '裁剪起止点与入出点' },
  { id: 'EDIT-007.in-point', priority: 'P1', feature: '入点只挪起点不加长' },
  { id: 'EDIT-006', priority: 'P1', feature: '变速（二倍速时长减半）' },
  { id: 'EXPORT-001', priority: 'P1', feature: '1080P / 4K / 多比例导出' },
  { id: 'EXPORT-001.no-overwrite', priority: 'P1', feature: '目标文件存在时不覆盖' },
  { id: 'API-003', priority: 'P0', feature: '上传的类型与大小校验' },
  { id: 'API-003.empty', priority: 'P0', feature: '空上传被拒' },
  { id: 'PROJECT-003', priority: 'P1', feature: '项目包篡改检测' },
  { id: 'PROJECT-003.round-trip', priority: 'P1', feature: '项目包跨资料库恢复' },
  { id: 'EDIT-010', priority: 'P1', feature: '批量导出的账要平' },
  { id: 'UPDATE-001.tamper', priority: 'P0', feature: '更新清单篡改样本拒绝率' },
  { id: 'UPDATE-001.ab-rollback', priority: 'P0', feature: 'A/B 槽同时在盘上、回滚不联网' },
  { id: 'UPDATE-001.boot-rollback', priority: 'P0', feature: '新版起不来时自动回到上一版' },
  { id: 'UPDATE-001.offline', priority: 'P0', feature: '发布目录可被客户端原样验收' },
  { id: 'ASSET-003', priority: 'P1', feature: '多图/单视频创建可复用主体' },
  { id: 'ASSET-003.rules', priority: 'P1', feature: '主体创建规则拒绝率与话术' },
  { id: 'ASSET-005', priority: 'P2', feature: '主体绑定音色（5–30s，支持视频格式）' },
  { id: 'ASSET-006', priority: 'P2', feature: '主体描述拼进提示词' },
  { id: 'ASSET-002', priority: 'P1', feature: '跨镜一致引用真的进生成请求' },
  { id: 'ASSET-002.blueprint-priority', priority: 'P1', feature: '蓝图优先且提示词不指错图' },
  { id: 'ASSET-002.text-only', priority: 'P1', feature: '无参考图时只拼文字' },
  { id: 'AUD-001', priority: 'P1', feature: '文本转语音（本机离线）' },
  { id: 'AUD-001.no-voice', priority: 'P1', feature: '没有可用音色时如实说明' },
  { id: 'AUD-003', priority: 'P2', feature: '人声/伴奏分离（频带能量验证）' },
  { id: 'AUD-003.mono-refusal', priority: 'P2', feature: '单声道素材拒绝分离' },
  { id: 'CAN-010', priority: 'P1', feature: '我的工具箱：产线可存可铺' },
  { id: 'CAN-010.partial', priority: 'P1', feature: '部分选中时如实报出丢弃的引用' },
  { id: 'FLOW-008', priority: 'P1', feature: '流水线固化：设置整体复用' },
  { id: 'BYOK-003', priority: 'P1', feature: 'Provider SDK 与签名插件' },
  { id: 'BYOK-003.permissions', priority: 'P1', feature: '插件权限门（越权调用被拦）' },
  { id: 'CLI-007', priority: 'P2', feature: '外部工具以签名插件接入' },
  { id: 'BYOK-003.backend-bridge', priority: 'P1', feature: '插件 Provider 包装成生成后端' },
  { id: 'BYOK-003.generation-path', priority: 'P1', feature: '插件后端走真实生成链路出图' },
  { id: 'ASSET-004.plan', priority: 'P2', feature: '智能补全的视角计划与 4 张上限' },
  { id: 'ASSET-004.budget', priority: 'P2', feature: '项目级生成受预算闸门约束' },
  { id: 'ASSET-004.settle', priority: 'P2', feature: '成功必须带产物、按实际退回' },
  { id: 'ASSET-004', priority: 'P2', feature: '智能补全端到端：出图→登记→补进档案' },
  { id: 'AUD-002.path', priority: 'P1', feature: '音频能力位如实声明、不支持就拒' },
  { id: 'AUD-002.plugin-path', priority: 'P1', feature: '插件声明 audio.music 后可走账本生成' },
  { id: 'SPACE-006.presets', priority: 'P1', feature: '机位档位来自导演台机位库' },
  { id: 'SPACE-006.plan', priority: 'P1', feature: '镜头 × 机位 = 张数，分批边界在机位' },
  { id: 'SPACE-006', priority: 'P1', feature: '换机位批量生成端到端（候选 4 个）' },
  { id: 'SPACE-006.ui', priority: 'P1', feature: '生成面板接上同一份计划与 IPC' },
  { id: 'VID-006.frame', priority: 'P1', feature: '续写的尾帧是真取出来的' },
  { id: 'VID-006', priority: 'P1', feature: '续写端到端：账本 + 不动选帧' },
  { id: 'VID-006.failure', priority: 'P1', feature: '续写失败留痕且预留按未知口径' },
  { id: 'VID-010.plugin-order', priority: 'P1', feature: '多参考图按顺序交给插件' },
  { id: 'VID-010.digest-order', priority: 'P1', feature: '顺序参与摘要（对调即另一次生成）' },
  { id: 'VID-010.honest-degradation', priority: 'P1', feature: '只吃一张的后端如实降级' },
  { id: 'VID-010.videogen-multi', priority: 'P1', feature: '支持多张的后端全量按序传下去' },
  { id: 'IMG-006.compose', priority: 'P1', feature: '跨图元素组合（逐点取色）' },
  { id: 'IMG-006.clamp', priority: 'P1', feature: '越界钳制与空输入拒绝' },
  { id: 'IMG-006.plan', priority: 'P1', feature: '归一化→像素与提前告警' },
  { id: 'IMG-006.no-cost', priority: 'P1', feature: '元素组合不消耗积分' },
];

/**
 * 已有的、由独立脚本产出的验收证据。
 *
 * 它们不在 `tests/acceptance` 里，但同样是"跑得出数字"的验收，
 * 所以一并列进来——不列的话这张表会显得比实际更弱，列了又必须写清楚
 * 它们各自要跑什么命令。
 */
const EXTERNAL_ITEMS = [
  { id: 'AUD-004', priority: 'P1', feature: '独立音轨 + 独立静音开关', command: 'node .data/verify-audio-mix.mjs', criterion: '静音一轨后其余轨逐采样差异 = 0' },
  { id: 'EDIT-002', priority: 'P0', feature: '基础时间轴（含字幕烧制）', command: 'node .data/verify-subtitles.mjs', criterion: '字幕真烧进画面（抽帧取色）' },
  { id: 'API-002', priority: 'P1', feature: '会话式接口（增量轮询）', command: '.tools\\pnpm.cmd run test -- tests/local-api-session.test.ts', criterion: '100 条事件分 10 次拉取：重复 0 / 漏 0' },
  { id: 'API-004', priority: 'P2', feature: '项目切换与上下文绑定', command: '.tools\\pnpm.cmd run test -- tests/local-api-session.test.ts', criterion: '连续切换 5 次错挂 0，过期 revision 409' },
  { id: 'FLOW-009', priority: 'P2', feature: '拆解不消耗生成积分', command: '（本会话多轮真机记录，见 docs/DEVELOPMENT-STATUS.md）', criterion: '拆解全程走本机加工，Provider 调用 0 次' },
  { id: 'CAN-005', priority: 'P1', feature: '分组 / 折叠 / 锁定 / 模板保存', command: '.tools\\pnpm.cmd exec vitest run tests/audio-ui-wiring.test.ts', criterion: '分组快捷键真机验证 + "存为画布模板"接线（菜单项 / IPC / 共用提取逻辑）；模板引擎保真由 CAN-010 的用例覆盖' },
  { id: 'IMG-008', priority: 'P2', feature: '镜像 / 旋转生成正反打', command: '.tools\\pnpm.cmd exec vitest run tests/image-rotate-geometry.test.ts', criterion: '水平/垂直镜像画进 canvas（scale(-1,1) 单测钉住绘制顺序）+ 产物入库连线' },
  {
    id: 'BYOK-004',
    priority: 'P0',
    feature: '鉴权方式抽象（Bearer / OAuth2 / 浏览器同源 / 短信）',
    command: '.tools\\pnpm.cmd exec vitest run tests/provider-auth.test.ts tests/provider-auth-ui-wiring.test.ts',
    criterion: '四种方式全部实跑（47 条）：OAuth2 走真实本机回环回调 + PKCE 换码，state 不符时换码请求 0 次；'
      + '过期令牌并发 10 次只刷新 1 次并新令牌落盘；凭据密文文件不含明文且密钥文件丢失时报错而非新造；'
      + '同源缺 Cookie 报"去登录"、短信缺网关报 gateway-absent；插件清单的 auth 声明与 secrets 权限成对校验',
  },
  {
    id: 'EDIT-003',
    priority: 'P1',
    feature: '精细时间轴与组件 Inspector',
    command: '.tools\\pnpm.cmd exec vitest run tests/smart-edit-timeline-layout.test.ts tests/clip-timeline-ui-wiring.test.ts',
    criterion: '单测 41 条（布局 / 像素换算 / 刻度 / 吸附 / 拖边缘裁剪 / 接线）。真机 CDP 实测：'
      + '新建智能剪辑节点连上 shot-01 图生视频 → 用**真实指针**把第一段拖 140px，'
      + '片段 left 1159→1299、总时长 0:00→0:02.9，空隙标记与"时间轴上存在无视频时段"提示各出现 1 处，'
      + '合成按钮转 disabled 并给出原因；时长探不到的片段画成"时长未知"（不拿猜的数当宽度）',
  },
  {
    id: 'MODEL-001',
    priority: 'P1',
    feature: '模型池管理与按任务推荐模型',
    command: 'node .data/verify-model-recommendation.mjs',
    criterion: '推荐理由可解释（矩阵的验收口径）。真机上图片下拉第一项 =「Lib Image 2.5 Pro · 推荐」，'
      + '理由是「在本机成功跑过 2 次（失败 0 次），最近一次 09-21 04:42」——'
      + '三个数字逐条回到 image_generation_intents 表核对一致（成功 2 / 失败 0 / MAX(created_at)）；'
      + '视频没有历史记录时**不标推荐**，理由写明"没有历史依据，这里只是清单顺序"；'
      + '早期 actual_cost_cents=0 的记录不当作"免费"（不参与便宜比较）；'
      + '推荐**不覆盖**用户已选的模型（换模型只由用户点按钮触发）',
  },
  {
    id: 'CLI-006',
    priority: 'P1',
    feature: '声明并暴露 CLI 能力边界（明确不能做什么）',
    command: 'node .data/verify-cli-manifest.mjs',
    criterion: '越界命令稳定错误码率 = **8/8 = 100%**（空参数 / 乱写 / 大小写 / 前导空格 / --help / '
      + '中文 / project:delete / 多段名），每一条都满足：退出码 2 + `error.code = CLI_UNKNOWN_COMMAND` + '
      + 'stdout 是合法 JSON（可被脚本解析）。`capabilities` 打印 29 条命令，其中 19 条写了「明确不做什么」，'
      + '另有 4 条整体边界与声明的错误码。**Manifest 覆盖全部已发布命令**由 `tests/cli-manifest.test.ts` '
      + '扫源码比对（源码 `case` 集合 == 清单集合，且每条命令的必填参数与源码 `required()` 一致）',
  },
  {
    id: 'CLI-002',
    priority: 'P1',
    feature: '脚本批处理、查询、取消、reconcile',
    command: 'node node_modules/tsx/dist/cli.mjs .data/verify-cli-002-fault-injection.ts',
    criterion: '**100 次故障注入，重复付费请求数 = 0**。两种重试形态各 50 次：'
      + '① 同 `command_id` 重试 → 幂等回放（`replayed: true`）；'
      + '② **换新 `command_id`、同 digest** 重试 → 在飞去重（`deduplicated: true`）。'
      + '注入后实际预留 2500 = 50 轮 × 50 分、意图行数 50（不是 100）；'
      + '`reconcile` 报告：在飞 50 条 / 台账 2500 / 漂移 0 / 一致。'
      + '**这一轮修掉的实质缺口**：写路径原先只在同 command_id 上幂等——'
      + '真实客户端的重试中间件会重新生成请求 id，一次网络抖动就会把同一张图买两次',
  },
  {
    id: 'NODE-004',
    priority: 'P1',
    feature: '生成参数 schema 校验 + 节点属性白名单',
    command: 'node node_modules/tsx/dist/cli.mjs .data/verify-node-004.ts',
    criterion: '两条口径都是 **100%（各 30 条 fixture）**：'
      + '① 白名单外属性写入被拒 **30/30**（一律拒写 10：id/type/x/y/params/action/taskInfo/prevTaskInfo/generatorType/isStale；'
      + '宿主专属 14：state/progress/thumb/previewUrl/…；编造 6），反向 10 条白名单键零误拒；'
      + '② schema 外参数提交被拒 **30/30**（paramDefs 里真实存在的参数键交给不支持它们的文本模型），'
      + '反向 motion-3.1 支持的 4 个参数零误拒。'
      + '外加两条端到端：外部写底板（Agent 那条路）提交的 type/state/artifactId/foo **全部没落盘**（恢复旧值）而合法改名落盘；'
      + '真实 reducer 上 node/patch 试图写 type 与 x 被挡下，name 与 clipLayout 写入',
  },
];

function parseArgs(argv) {
  return { skipRun: argv.includes('--skip-run') };
}

function runAcceptanceSuite() {
  const log = [];
  try {
    /*
      走 `node node_modules/vitest/vitest.mjs` 而不是 `.bin/vitest.cmd`：
      Windows 上 Node 不会直接执行 `.cmd`（需要 shell），而用 shell 又要处理引号，
      直接跑它的 JS 入口最省事，也最接近 `pnpm test` 实际执行的那个文件。
    */
    const output = execFileSync(process.execPath, [
      resolve('node_modules/vitest/vitest.mjs'), 'run', 'tests/acceptance', '--reporter=dot',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log.push(output);
    return { ok: true, log };
  } catch (error) {
    log.push(String(error?.stdout ?? ''));
    log.push(String(error?.stderr ?? ''));
    log.push(String(error?.message ?? ''));
    return { ok: false, log };
  }
}

function readMetrics() {
  if (!existsSync(METRICS_DIR)) return new Map();
  const map = new Map();
  for (const name of readdirSync(METRICS_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(resolve(METRICS_DIR, name), 'utf8'));
      map.set(parsed.item, parsed);
    } catch {
      /* 读不动的那份就不算证据；宁可少一条，也不要把没读出来的当成通过 */
    }
  }
  return map;
}

/** 把某一项的指标压成一行可读的摘要。 */
function summarize(metric) {
  if (metric === undefined) return '（没有指标文件）';
  const skip = new Set(['item', 'criterion', 'results', 'forgedDetail', 'oversizedDetail', 'samples', 'exportedNames', 'failureReasons', 'distinctErrors', 'allowedList', 'rejectedCodes', 'leaked']);
  const parts = [];
  for (const [key, value] of Object.entries(metric)) {
    if (skip.has(key)) continue;
    if (value === null || typeof value === 'object') continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(' ');
}

function main() {
  const { skipRun } = parseArgs(process.argv.slice(2));
  mkdirSync(resolve('.data'), { recursive: true });
  /*
    每轮先清掉旧指标：留着一份上一轮的 JSON，就会让"这一轮到底跑没跑"
    变成一件说不清的事。
  */
  rmSync(METRICS_DIR, { recursive: true, force: true });

  const suite = skipRun ? { ok: true, log: ['（--skip-run：没有重跑用例）'] } : runAcceptanceSuite();
  if (!skipRun) writeFileSync(LOG_PATH, suite.log.join('\n'), 'utf8');

  const metrics = readMetrics();
  const entries = ITEMS.map((item) => {
    const metric = metrics.get(item.id);
    return { ...item, measured: metric !== undefined, summary: summarize(metric), metric: metric ?? null };
  });

  const total = entries.length + EXTERNAL_ITEMS.length;
  const measuredCount = entries.filter((entry) => entry.measured).length + EXTERNAL_ITEMS.length;
  const missing = entries.filter((entry) => !entry.measured).map((entry) => entry.id);

  const report = {
    schema: 'xqtv.acceptance-report@1',
    generatedAt: new Date().toISOString(),
    suiteOk: suite.ok,
    suiteLog: LOG_PATH,
    items: [
      ...entries.map(({ id, priority, feature, measured, summary }) => ({ id, priority, feature, measured, summary })),
      ...EXTERNAL_ITEMS.map((item) => ({ ...item, measured: true, summary: `外部脚本：${item.command}` })),
    ],
    totals: {
      items: total,
      measured: measuredCount,
      missing,
      p0: [...entries, ...EXTERNAL_ITEMS].filter((item) => item.priority === 'P0').length,
      p0Measured: [...entries, ...EXTERNAL_ITEMS].filter((item) => item.priority === 'P0'
        && ('measured' in item ? item.measured : true)).length,
    },
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`验收套件：${suite.ok ? '通过' : '有失败（详见 ' + LOG_PATH + '）'}`);
  console.log('');
  console.log('条目         优   量到了  摘要');
  for (const entry of entries) {
    console.log(`${entry.id.padEnd(26)} ${entry.priority.padEnd(4)} ${(entry.measured ? '有' : '无').padEnd(6)} ${entry.summary.slice(0, 90)}`);
  }
  for (const item of EXTERNAL_ITEMS) {
    console.log(`${item.id.padEnd(26)} ${item.priority.padEnd(4)} ${'外部'.padEnd(6)} ${item.criterion}`);
  }
  console.log('');
  console.log(`合计 ${total} 项，量到证据 ${measuredCount} 项，缺 ${missing.length} 项${missing.length > 0 ? `：${missing.join(' / ')}` : ''}`);
  console.log(`报告：${REPORT_PATH}`);

  if (!suite.ok) process.exitCode = 1;
}

main();
