/* ============================================================

   于是**它的功能名、按钮、提示、报错全在这张表里**。
   比起在界面上一个个点，直接读这张表既全又快，而且是"看代码"不是"猜"。

   产物：

   ============================================================ */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = resolve(process.cwd(), 'third-party', 'canvas-bundle');
const OUT_JSON = join(DIR, '_strings.json');
const OUT_CANVAS = join(DIR, '_canvas.md');

/*
  值里要求含中文：英文值（内部标记、枚举）不是给人看的文案，
  混进来只会把功能清单淹掉。键名限定成驼峰/点号/冒号形态，避免把普通 JSON 数据也抓进来。

  `director:cameraFov` 这种）。第一版正则没带 `:`，于是所有 `xxx:yyy` 形态的键
  全被漏掉——包括节点快捷场景的名字与说明，表现是"抽出来的场景表全是未翻译的键名"。
*/
const PAIR = /"([A-Za-z][A-Za-z0-9_.:]{2,100})":"((?:[^"\\]|\\.){0,160})"/g;
const HAS_CHINESE = /[\u4e00-\u9fa5]/;

const strings = new Map();
let scanned = 0;
for (const name of readdirSync(DIR)) {
  if (!name.endsWith('.js')) continue;
  scanned += 1;
  const text = readFileSync(join(DIR, name), 'utf8');
  for (const match of text.matchAll(PAIR)) {
    const value = match[2] ?? '';
    if (!HAS_CHINESE.test(value)) continue;
    /* 同一个键在不同 chunk 里重复是正常的（分包），保留第一次见到的值 */
    if (!strings.has(match[1])) strings.set(match[1], value);
  }
}

const sorted = [...strings.entries()].sort((a, b) => a[0].localeCompare(b[0]));
writeFileSync(OUT_JSON, `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`, 'utf8');

/*
  画布那一坨的相关键：要么以 canvas 开头，要么名字里带 node / edge / connect /
  toolbar / minimap / zoom / viewport / director（这些都是画布自己的概念）。
  这是**筛法**不是穷举——筛选条件写在代码里，谁都能复核。
*/
const CANVAS_PATTERNS = [
  /^canvas/i,
  /node/i,
  /edge/i,
  /connect/i,
  /minimap/i,
  /viewport/i,
  /zoom/i,
  /toolbar/i,
  /canvas/i,
  /director/i,
];
const canvasEntries = sorted.filter(([key]) => CANVAS_PATTERNS.some((pattern) => pattern.test(key)));

/** 前缀分组：取键名的第一个单词片段，便于人按块读。 */
function groupOf(key) {
  const match = /^([a-z]+)/.exec(key.replace(/^canvas/i, 'canvas')) ?? /^([A-Za-z]+)/.exec(key);
  return (match?.[1] ?? key).toLowerCase();
}

const groups = new Map();
for (const [key, value] of canvasEntries) {
  const group = groupOf(key);
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push([key, value]);
}

const lines = [
  '# 画布· 画布相关词条（从当前前端 chunk 里抽出）',
  '',
  `> 来源：\`third-party/canvas-bundle/\` 里的 ${scanned} 个 JS chunk · 生成脚本 \`scripts/extract-canvas-strings.mjs\``,
  `> 全部词条 ${sorted.length} 条，其中与画布相关的 ${canvasEntries.length} 条`,
  '',
  '筛选口径：键名以 `canvas` 开头，或名字里含 node / edge / connect / minimap /',
  'viewport / zoom / toolbar / director。这是筛法不是穷举——条件写在脚本里，可复核。',
  '',
];
for (const [group, entries] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`## ${group}（${entries.length} 条）`, '');
  lines.push('| 键 | 文案 |', '| --- | --- |');
  for (const [key, value] of entries) {
    lines.push(`| \`${key}\` | ${value.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
}
writeFileSync(OUT_CANVAS, `${lines.join('\n')}\n`, 'utf8');

console.log(`扫描 ${scanned} 个 chunk`);
console.log(`词条 ${sorted.length} 条 → ${OUT_JSON}`);
console.log(`画布相关 ${canvasEntries.length} 条 → ${OUT_CANVAS}`);
console.log('');
console.log('分组前 10：');
for (const [group, entries] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
  console.log(`  ${group.padEnd(14)} ${entries.length}`);
}
