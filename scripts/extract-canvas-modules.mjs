/* ============================================================

   为什么这件事值当：
     `_canvas.md` 只是**筛选视图**——7913 条词条里只有 1541 条（画布相关）被抽出，
     剩下 6372 条从没被看过。而第 6 轮要统改的是**除画布之外的 8 个模块**，
     恰恰全在那 6372 条里。不切块，改模块就只能靠猜文案。

     那个脚本负责「从 chunk 抽词条」（输入 = 158 个 JS chunk）。

   **筛法不是穷举**：每个模块认领一组前缀（写在下面的 MODULES 里，谁都能复核）。
      - 一轮：按**首词前缀**认领（`directorAddCamera` → `director`），先声明者优先；
      - 二轮：一轮没认领且首词不是归属词的，按**子串**认领
        （`createSubjectModal*` 首词是 create，真正的归属词是 subject）；
        二级命中在模块文档里单独标注，不混进一级统计；
      - 两轮都没认领的词条，一条不丢，全部列进 `_modules-unassigned.md`；
      - 被两个以上模块同时命中的前缀，单列「重叠前缀」表，把歧义摆到台面上。

   产物：

   ============================================================ */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = resolve(process.cwd(), 'third-party', 'canvas-bundle');
const SRC = join(DIR, '_strings.json');

if (!existsSync(SRC)) {
  console.error(`找不到 ${SRC}`);
  console.error('先跑 node scripts/extract-canvas-strings.mjs');
  process.exit(1);
}

const strings = JSON.parse(readFileSync(SRC, 'utf8'));
const entries = Object.entries(strings).sort((a, b) => a[0].localeCompare(b[0]));

/*
  模块 = 第 6 轮要统改的 8 个界面。

  `prefixes` 是**模块认领的前缀**（区分大小写前缀匹配，取 key 的开头）。
  写法一律用小写形态：匹配时先取 key 的 `^([a-z]+)` 段再比对，
  这样 `directorAddCamera` 与 `director:addCamera` 都会落到 `director`。

  `order` 就是优先级：越靠前越先认领。所以**具体模块要写在通用模块前面**，
  比如 `reference`（参考片）必须排在 `img`（素材库）之前，否则
  `referenceImageAlt` 会被素材库抢走。


  **只有首页与项目页有正文 DOM**：资产页、画布页需登录，快照里只剩壳层。
  所以素材库与画布**没有页级证据**，只能靠词条表与截图 —— 这点必须写明，别让人去翻空文件。

  `contains` 是**二级规则**：条目首词不体现归属时才用
  （`createSubjectModal*` 首词 `create`，归属词其实是 `subject`）。
  二级命中在模块文档里带 `（二级规则）` 标注，跟一级分开数。
*/
const MODULES = [
  {
    slug: 'reference',
    name: '参考片 / 拉片',
    why: '拉片入口在首页功能格（homeFeatureGridShotBreakdown），拆解维度=运镜/音乐/分镜；参考图选择器挂在画布节点上。',
    prefixes: ['shot', 'reference', 'screenshot', 'twelveview'],
    contains: ['shotbreakdown', 'analyzevideo', 'refimage', 'videoref'],
    snapshots: [],
  },
  {
    slug: 'director',
    name: '导演台',
    why: '3D 导演台：PMX 模型 + 动捕 + 骨骼 + 高斯泼溅 + 群演阵列 + 手机运镜 + 机位时间轴，另含独立「角色工作室」。',
    prefixes: [
      'director', 'character', 'camera', 'light', 'cinematics', 'angle', 'lens',
      'focus', 'depth', 'pose', 'motion', 'mocap', 'pmx', 'joint', 'env',
      'crowd', 'gaussian', 'mesh', 'glb', 'keyframe', 'track', 'prop',
      'panorama', 'tilt', 'rotate', 'wide', 'zhou',
    ],
    contains: ['character', 'cameramove', 'posestudio', 'bone'],
    snapshots: [],
  },
  {
    slug: 'edit',
    name: '剪辑与成片',
    why: '片段编辑器：字幕 / 转场 / 动画 / 变速 / 时间轴 / 导出（含 Premiere XML）。opening 是片头调色、filler 是语气词音效。',
    prefixes: [
      'clip', 'timeline', 'subtitle', 'transition', 'export', 'stitch', 'vocal',
      'voice', 'filler', 'opening', 'speed', 'trim', 'mute', 'unmute', 'volume',
      'font', 'typography', 'premiere', 'film', 'music', 'sfx', 'overlay',
      'split', 'segment', 'denoise', 'matting', 'outpaint', 'audio', 'edit',
      'publish',
    ],
    contains: ['compose', 'videoclip', 'videotimeline', 'videoseparate', 'videoupscale', 'videoenhance', 'videohd', 'subtitleerase', 'vocalsplit', 'audionode'],
    snapshots: [],
  },
  {
    slug: 'storyboard',
    name: '分镜',
    why: '剧本编辑器 + 分镜表：scriptTable/scriptPreset/scriptField 是表结构，screenplay 是剧本正文，scene/dialogue 是镜头级字段。',
    prefixes: ['storyboard', 'screenplay', 'script', 'scene', 'dialogue', 'plot'],
    contains: ['storyboard', 'scripttable', 'scriptfield', 'scriptpreset', 'screenplay'],
    snapshots: [],
  },
  {
    slug: 'generate',
    name: '生成工作台',
    why: '任务发起与排队：模型能力（seedance 合规校验）、批量、积分消耗与加速队列（skipQueue）。',
    prefixes: [
      'generate', 'generation', 'batch', 'seedance', 'skip', 'model', 'quality',
      'aspect', 'ratio', 'prompt', 'cost', 'credit',
    ],
    contains: ['videocontinuation', 'videogenerator', 'videogroup', 'videomodel', 'videoconfig', 'videoduration', 'videoresolution', 'videosize', 'aspectratio', 'generatornode', 'batchgenerate', 'batchstoryboard', 'batchvideo'],
    snapshots: [],
  },
  {
    slug: 'assets',
    name: '素材库',
    why: '资产（角色/场景/道具）+ 上传素材 + 图片编辑器（imgEditor 修图/超分/宫格切分）+ 主体库。',
    prefixes: [
      'asset', 'material', 'media', 'picture', 'img', 'image', 'library',
      'rating', 'recycle', 'favorite', 'subject', 'visualasset',
    ],
    contains: ['subject', 'createasset', 'batchdeleteasset', 'assetcard', 'assettitle', 'assetlibrary', 'assettracking', 'assetbatchgenerate', 'assetmerge'],
    /* 资产页快照需登录，只渲染出壳层，故不作为本模块证据 */
    snapshots: [],
  },
  {
    slug: 'agent',
    name: 'Agent',
    why: '对话与工具调用：chat / toolCall 状态机、技能（skill）、MCP、slash 提及。参考视频分析正是 Agent 的工具之一。',
    prefixes: ['chat', 'agent', 'skill', 'mcp', 'tool', 'mention', 'followup', 'copilot', 'ask'],
    contains: ['chattoolcall', 'createskill', 'skillskill', 'useskill', 'parsedevagent'],
    snapshots: [],
  },
  {
    slug: 'overview',
    name: '总览 / 项目',
    why: '落地页与项目管理：welcome 是首页区块，home 是功能格，project/history 是项目列表，account/subscription/plan 是账户与订阅。',
    prefixes: [
      'welcome', 'home', 'project', 'recent', 'workspace', 'history', 'folder',
      'nav', 'page', 'share', 'account', 'subscription', 'billing', 'plan',
      'redeem', 'invite', 'team', 'collab', 'profile', 'personal', 'activity',
      'my', 'community',
    ],
    contains: ['createproject', 'createcanvas', 'createfolder', 'createteam', 'switchteam', 'teamrecent', 'projectdetail', 'workspacepanel'],
    snapshots: ['_page-home.html', '_page-project.html'],
  },
];

/*
  已另有归属：这些前缀属于**画布本体**，已经由 `_canvas.md` 覆盖。
  第 6 轮不动画布结构，所以这里只统计、不重复落盘。
*/
const CANVAS_OWNED = ['canvas', 'node', 'nodes', 'edge', 'edges', 'connect', 'connection', 'minimap', 'viewport', 'zoom', 'toolbar', 'group', 'undo', 'redo', 'tidy', 'snap'];

/** 取 key 的前缀：在**原始驼峰**上取小写首段（directorAddCamera → director）。 */
function prefixOf(key) {
  return (/^([a-z]+)/.exec(key) ?? [null, '(非小写开头)'])[1];
}

/* ---------- 归类：一轮按首词前缀，二轮按子串（先声明者优先） ---------- */
const buckets = new Map(MODULES.map((m) => [m.slug, []]));
/** 二级规则的命中，单独记，模块文档里带标注 */
const tier2 = new Map(MODULES.map((m) => [m.slug, []]));
const unassigned = [];
const canvasOwned = [];
const overlaps = new Map();

const lower = (key) => key.toLowerCase();

for (const [key, value] of entries) {
  const prefix = prefixOf(key);
  const claimants = MODULES.filter((m) => m.prefixes.includes(prefix)).map((m) => m.slug);

  if (claimants.length > 0) {
    buckets.get(claimants[0]).push([key, value]);
    if (claimants.length > 1) {
      const row = overlaps.get(prefix) ?? { prefix, claimants, count: 0 };
      row.count += 1;
      overlaps.set(prefix, row);
    }
    continue;
  }

  /* 一轮没认领：画布本体的前缀先摘出去，再做二级子串匹配 */
  if (CANVAS_OWNED.includes(prefix)) {
    canvasOwned.push([key, value]);
    continue;
  }

  const k = lower(key);
  const tier2Claimants = MODULES.filter((m) => m.contains.some((c) => k.includes(c))).map((m) => m.slug);
  if (tier2Claimants.length > 0) {
    tier2.get(tier2Claimants[0]).push([key, value]);
    buckets.get(tier2Claimants[0]).push([key, value]);
    continue;
  }

  unassigned.push([prefix, key, value]);
}

/* 未被认领的前缀汇总（按条数降序）——这是「还差什么」的正面清单 */
const strayPrefixes = new Map();
for (const [prefix, , ] of unassigned) strayPrefixes.set(prefix, (strayPrefixes.get(prefix) ?? 0) + 1);

/* ---------- 落盘：每模块一个文件 ---------- */
const tableOf = (rows) => {
  const lines = ['| 键 | 文案 |', '| --- | --- |'];
  for (const [key, value] of rows) lines.push(`| \`${key}\` | ${String(value).replace(/\|/g, '\\|')} |`);
  return lines;
};

const written = [];
for (const module of MODULES) {
  const rows = buckets.get(module.slug) ?? [];
  const secondTier = tier2.get(module.slug) ?? [];
  const secondTierKeys = new Set(secondTier.map(([k]) => k));
  /* 一级：按首词前缀分组；二级命中的条目首词不体现归属，单列一节 */
  const primary = rows.filter(([k]) => !secondTierKeys.has(k));
  const byPrefix = new Map();
  for (const [key, value] of primary) {
    const p = prefixOf(key);
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p).push([key, value]);
  }

  const lines = [
    `# 画布· ${module.name} 词条（从当前前端 chunk 抽出）`,
    '',
    `> 来源：\`third-party/canvas-bundle/_strings.json\`（全部 ${entries.length} 条）· 生成脚本 \`scripts/extract-canvas-modules.mjs\``,
    `> 本模块 **${rows.length} 条** = 一级（首词前缀）${primary.length} 条 + 二级（子串）${secondTier.length} 条`,
    '',
    `认领前缀：${module.prefixes.map((p) => `\`${p}\``).join(' · ')}`,
    ...(module.contains.length
      ? [`二级规则（子串）：${module.contains.map((c) => `\`${c}\``).join(' · ')}`]
      : []),
    '',
    module.why,
    '',
    '> 口径同 `_canvas.md`：**筛法不是穷举**。认领的前缀写在脚本的 `MODULES` 里，可复核；',
    '> 没被认领的词条见 `_modules-unassigned.md`，一条不少。',
    '> 二级规则是给「首词不体现归属」的条目兜底（如 `createSubjectModal*` 归素材库），',
    '> 属附加口径，与一级分开计数，可单独弃用。',
    '',
  ];
  if (module.snapshots.length) {
    lines.push(
      '本模块的整页 DOM 证据（真站 SSR 渲染，甲级）',
      '',
      ...module.snapshots.map((s) => `- \`third-party/canvas-bundle/${s}\``),
      '  蒸馏后的结构与文案见 `_pages.md`。',
      '',
    );
  } else {
    lines.push(
      '本模块**没有页级 DOM 证据**：对应的整页快照需登录，只渲染出壳层。',
      '改这一块只能靠上面的词条表 + `docs/benchmark/` 下的截图。',
      '',
    );
  }
  lines.push(
    '全局壳层证据（三份快照共用，见 `_pages.md`）',
    '',
    '侧边导航 `aside[aria-label=侧边导航]` 分三段：`Canvas Agent` ∣ `首页/项目/资产/创作者挑战赛` ∣ `Blender 插件/Canvas Plugin`，',
    '底部另钉一个 `功能上新`；选中态是**填充式** `bg-nt-bg-overlay-active`；',
    '`新建项目` 是品牌色填充按钮（`bg-nt-bg-brand`）；侧栏收起断点 **992px**（`.b992:hidden`），功能格断点 **768px**。',
    '',
  );

  for (const [prefix, group] of [...byPrefix.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${prefix}（${group.length} 条）`, '', ...tableOf(group), '');
  }

  if (secondTier.length) {
    lines.push(
      `## 二级规则命中（${secondTier.length} 条）`,
      '',
      '这些条目首词不是本模块的归属词（如 `createSubject*`、`videoCompose*`），靠子串规则认领。',
      '',
      ...tableOf([...secondTier].sort((a, b) => a[0].localeCompare(b[0]))),
      '',
    );
  }

  const out = join(DIR, `_modules-${module.slug}.md`);
  writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
  written.push([module, rows.length, primary.length, secondTier.length, out]);
}

/* ---------- 落盘：总表 ---------- */
const index = [
  '# 画布词条 · 按模块切开（第 6 轮用）',
  '',
  `> 源：\`_strings.json\`，共 **${entries.length}** 条 · 生成脚本 \`scripts/extract-canvas-modules.mjs\``,
  '> 本目录只做**归类**，不重扫 chunk。画布相关那批另见 `_canvas.md`。',
  '',
  '## 为什么按模块切',
  '',
  '`_canvas.md` 抽了 1541 条画布词条，但第 6 轮要统改的是**除画布外的 8 个模块**，',
  `那 8 个模块的文案全在剩下的 ${entries.length - 1541} 条里，此前一条没被看过。`,
  '',
  '## 模块覆盖（条数降序）',
  '',
  '| 模块 | 词条 | 一级 | 二级 | 文件 |',
  '| --- | ---: | ---: | ---: | --- |',
  ...[...written]
    .sort((a, b) => b[1] - a[1])
    .map(([m, n, primary, second, out]) => `| ${m.name} | ${n} | ${primary} | ${second} | \`${out.split(/[\\/]/).pop()}\` |`),
  '',
  '## 口径',
  '',
  '1. **一级（首词前缀）**：取 key 在原始驼峰上的小写首段（`directorAddCamera` → `director`）。',
  '2. **二级（子串）**：一级没认领、且首词不体现归属的，按子串认领',
  '   （`createSubjectModal*` 首词是 `create`，归属词是 `subject`）。二级单列，可单独弃用。',
  '3. **先声明者优先**：`MODULES` 里的顺序就是优先级，靠前的先认领，因此**不重复计数**。',
  '4. **筛法不是穷举**：认领前缀是人工判定的，写在脚本里，谁都能复核；漏掉的不藏，见下节。',
  '',
  '## 壳层与整页证据',
  '',
  '整页快照的蒸馏（结构大纲 + 可见文本）见 `_pages.md`。要点：',
  '',
  '- **壳层是共用的甲级证据**。侧边导航 `aside[aria-label=侧边导航]` 分三段：',
  '  `Canvas Agent` ∣ `首页 / 项目 / 资产 / 创作者挑战赛` ∣ `Blender 插件 / Canvas Plugin`，底部另钉 `功能上新`。',
  '  选中态是**填充式**（`bg-nt-bg-overlay-active`），`新建项目` 是品牌色填充按钮（`bg-nt-bg-brand`）。',
  '- **断点 768 / 992**：侧栏收起是 `.b992:hidden`；功能格每格 `b768:min-w-[113px] b768:flex-1`。',
  '- **只有首页与项目页有正文 DOM**。资产页、画布页需登录，快照里只剩壳层——',
  '  所以**素材库与画布没有页级证据**，只能靠词条表与截图。',
  '- 首页正文：创作格 6 项（`Minimax H3 Max` / `Seedance 2.5` / `视频生成` / `图片生成` / `音频生成` /',
  '  `智能剪辑`，另有一个小屏才出现的 `更多功能`），`特色功能` 6 项（`深度动作捕捉` / `逐帧拉片` /',
  '  `导演台` / `片段重拍` / `口播视频` / `TV Show`）。',
  '  ⚠️ 模型名与活动名随版本变（页面顶部还有促销倒计时），**别把营销位当产品结构**。',
  '- 项目页正文：`返回 / 全部项目 / 回收站 / 新建文件夹 / 开始创作 / 创建新的视频项目`，',
  '  搜索框 `[placeholder=搜索项目]`，次级按钮用 `bg-btn-secondary / text-btn-secondary-text / bg-btn-secondary-hover`。',
  '',
  '## 对标站的令牌命名（乙级）',
  '',
  '从真 DOM 的 class 名能读出它的令牌分层，改我们自己的令牌时可对照：',
  '',
  '`nt-bg-body` / `nt-bg-overlay` / `nt-bg-overlay-active` / `nt-bg-overlay-hover` /',
  '`nt-bg-float-glass-l1|l2` / `nt-bg-invert` / `nt-bg-brand` / `nt-border-neutral-l1|l3` /',
  '`bg-bg-page` / `text-fg-default` / `input-placeholder` / `bg-btn-secondary` / `--canvas-header-height`。',
  '',
  '这是 **class 名**不是计算后的色值——只能证明「它有这套令牌分层」，不能当颜色依据。',
  '颜色仍以 `docs/benchmark/canvas/2026-09/chunk-*.css` 与截图为准。',
  '',
  '### 重叠前缀（被多个模块认领，实际归给了第一个）',
  '',
];

if (overlaps.size === 0) {
  index.push('无。', '');
} else {
  index.push('| 前缀 | 归属 | 也曾被 | 条数 |', '| --- | --- | --- | ---: |');
  for (const row of [...overlaps.values()].sort((a, b) => b.count - a.count)) {
    index.push(`| \`${row.prefix}\` | ${row.claimants[0]} | ${row.claimants.slice(1).join(', ')} | ${row.count} |`);
  }
  index.push('');
}

index.push(
  '## 画布本体的词条（不在本轮范围）',
  '',
  `前缀 ${CANVAS_OWNED.map((p) => `\`${p}\``).join(' / ')} 共 **${canvasOwned.length}** 条，本轮不动。`,
  '',
  '> 注意两处 `_canvas.md` 的口径差异：`_canvas.md` 用的是**子串**筛选',
  '> （`/node/i`、`/director/i` 命中任意位置），所以它的 1541 条把导演台等模块也算进去了；',
  `> 本表用的是**首词前缀**，${canvasOwned.length} 条才是"首词就属于画布壳层"的那批。两者不冲突，口径不同。`,
  '',
  '## 还没被任何模块认领的词条',
  '',
  `共 **${unassigned.length}** 条，涉及 ${strayPrefixes.size} 个前缀。完整清单见 \`_modules-unassigned.md\`。`,
  '这些不是「没用」——多数是**跨模块通用词汇**（按钮、状态、报错）或**不属于这 8 个模块的区域**',
  '（学院/跟练、计费流水、快捷键面板、真人核验协议）。要收哪个，改脚本里的 `MODULES` 即可。',
  '',
  '条数最多的 20 个未认领前缀：',
  '',
  '| 前缀 | 条数 |',
  '| --- | ---: |',
  ...[...strayPrefixes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([p, c]) => `| \`${p}\` | ${c} |`),
  '',
);
writeFileSync(join(DIR, '_modules-index.md'), `${index.join('\n')}\n`, 'utf8');

/* ---------- 落盘：未认领清单（一条不丢） ---------- */
const unLines = [
  '# 画布词条 · 未被模块认领',
  '',
  `> 来源：\`_strings.json\`（${entries.length} 条）· 生成脚本 \`scripts/extract-canvas-modules.mjs\``,
  `> 共 **${unassigned.length}** 条 / ${strayPrefixes.size} 个前缀。按前缀分组，组内按条数降序。`,
  '',
  '一份**不丢东西**的清单：模块文档里没有的词条都在这里。',
  '多数是跨模块通用词汇（按钮/状态/报错）或这 8 个模块之外的区域。',
  '',
];
const unByPrefix = new Map();
for (const [prefix, key, value] of unassigned) {
  if (!unByPrefix.has(prefix)) unByPrefix.set(prefix, []);
  unByPrefix.get(prefix).push([key, value]);
}
for (const [prefix, rows] of [...unByPrefix.entries()].sort((a, b) => b[1].length - a[1].length)) {
  unLines.push(`## ${prefix}（${rows.length} 条）`, '', ...tableOf(rows), '');
}
writeFileSync(join(DIR, '_modules-unassigned.md'), `${unLines.join('\n')}\n`, 'utf8');

/* ---------- 终端汇报 ---------- */
console.log(`源：${SRC}`);
console.log(`词条 ${entries.length} 条 → ${MODULES.length} 个模块 + 未认领\n`);
console.log('模块覆盖（条数降序）：');
for (const [m, n, primary, second] of [...written].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${m.name.padEnd(14, '　')} ${String(n).padStart(5)}  (一级 ${primary} / 二级 ${second})`);
}
console.log(`\n  画布本体（另有归属）   ${String(canvasOwned.length).padStart(5)}`);
console.log(`  未认领                ${String(unassigned.length).padStart(5)}   ${strayPrefixes.size} 个前缀`);
console.log(`\n重叠前缀 ${overlaps.size} 个：${[...overlaps.values()].map((r) => `${r.prefix}→${r.claimants[0]}`).join(', ') || '无'}`);
console.log('\n未认领条数前 10：');
for (const [p, c] of [...strayPrefixes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${p.padEnd(14)} ${c}`);
}
