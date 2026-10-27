/* ============================================================
   画布缺口对照：把 小QTV 画布词条逐条拿到我们源码里找
   ------------------------------------------------------------
         （从 小QTV 前端 chunk 抽出的画布相关词条，含每条的中文文案）
   做法  对每条文案，在 apps/ / packages/ 的源码与文档里做子串搜索；
         搜不到 = 这个词条代表的**用户可见文案在我们这侧不存在**——
         它未必等于"功能没做"（可能只是措辞不同），但它是排查缺口的起点，
         而且比人工回忆可靠：词条表是机器从对方的真实前端里抽出来的。
   输出  .data/canvas-gap.md（按分类分组，未命中的在前）

   用法：node scripts/canvas-gap-report.mjs
   ============================================================ */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = join(root, 'third-party/canvas-bundle/_canvas.md');
const outFile = join(root, '.data/canvas-gap.md');

/** 扫描哪些目录：只扫我们自己写的代码与文档，不扫抓来的第三方源码 */
const SCAN_DIRS = ['apps', 'packages', 'tests', 'docs'];
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.md', '.json']);
/** 这些目录里的东西不算"我们实现了"：抓来的参考实现、依赖、构建产物 */
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'dist-electron', 'release', 'third-party', 'vendor', '.git']);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (SCAN_EXT.has(full.slice(full.lastIndexOf('.')))) files.push(full);
  }
  return files;
}

const sources = SCAN_DIRS.flatMap((dir) => {
  const full = join(root, dir);
  try { return statSync(full).isDirectory() ? walk(full) : []; } catch { return []; }
});
/** 索引：整份源码拼起来做子串搜索就够了（词条是短句，不需要更精细的匹配） */
const haystack = sources.map((file) => readFileSync(file, 'utf8')).join('\n');

/** 解析词条表：`## 分类` 小节下的 `| \`键\` | 文案 |` */
function parseEntries(markdown) {
  const sections = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(\S+)/.exec(line);
    if (heading) {
      current = { name: heading[1], entries: [] };
      sections.push(current);
      continue;
    }
    const row = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (row && current) current.entries.push({ key: row[1], text: row[2] });
  }
  return sections;
}

/** 去掉占位符与多余空白；太短或纯符号的丢掉（没有检索意义） */
function normalize(value) {
  return value.replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
}

const sections = parseEntries(readFileSync(source, 'utf8'));
const parsedTotal = sections.reduce((sum, section) => sum + section.entries.length, 0);
console.log(`[canvas-gap] 词条表解析：${sections.length} 个分类 / ${parsedTotal} 条`);
console.log(`[canvas-gap] 扫描源码：${sources.length} 个文件`);
const lines = [
  '# 画布词条缺口对照（自动生成）',
  '',
  `来源：\`third-party/canvas-bundle/_canvas.md\`；扫描：${SCAN_DIRS.join(' / ')}（${sources.length} 个文件）`,
  '',
  `解析到 ${sections.length} 个分类、${parsedTotal} 条词条。`,
  '',
  '**怎么读这份表**：搜不到 ≠ 功能一定没做，只说明"这个词条对应的文案在我们这侧不存在"；',
  '措辞不同会被误报，所以命中项不列出、未命中项逐条人工过。',
  '',
];

let totalMiss = 0;
let totalHit = 0;
for (const section of sections) {
  const missed = [];
  for (const entry of section.entries) {
    const text = normalize(entry.text);
    /*
      只跳过"没有可检索内容"的词条。

      这里踩过一次坑：第一版写的是 `/^[\d\W_]+$/`，而 JS 的 `\w` 默认只认
      ASCII 字母数字——**汉字属于 `\W`**，于是"扩图""打光"这类纯中文词条
      全被判成符号丢掉，1541 条只剩 106 条进入统计，报告看起来"几乎全覆盖"。
      改用 Unicode 属性：文案里至少要有汉字/字母/数字才值得搜。
    */
    if (text.length < 2 || !/[\p{Script=Han}\p{L}\p{N}]/u.test(text)) continue;
    if (haystack.includes(text)) { totalHit += 1; continue; }
    missed.push(entry);
    totalMiss += 1;
  }
  if (missed.length === 0) continue;
  lines.push(`## ${section.name}：未命中 ${missed.length} / ${section.entries.length}`, '');
  lines.push('| 键 | 文案 |', '| --- | --- |');
  for (const entry of missed) lines.push(`| \`${entry.key}\` | ${entry.text} |`);
  lines.push('');
}

lines.splice(5, 0, `统计：命中 ${totalHit} 条，未命中 ${totalMiss} 条。`, '');

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
console.log(`[canvas-gap] 命中 ${totalHit} / 未命中 ${totalMiss} → ${outFile}`);
