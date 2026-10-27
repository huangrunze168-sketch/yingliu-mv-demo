/* ============================================================

   为什么要这份清单：复刻界面时每个位置都要选图标。
   图标**资源**是人家的（不能用），但"这个位置需要一个什么语义的图标"
   我们就能在自己的图标集里挑一个语义相当的。

   ============================================================ */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = resolve(process.cwd(), 'third-party', 'canvas-bundle');
const OUT = join(DIR, '_icons.md');

const icons = new Set();
for (const name of readdirSync(DIR)) {
  if (!name.endsWith('.js')) continue;
  const text = readFileSync(join(DIR, name), 'utf8');
  for (const match of text.matchAll(/"canvas:([a-zA-Z0-9:_-]{2,44})"/g)) {
    if (match[1]) icons.add(match[1]);
  }
}

const sorted = [...icons].sort();

/*
  分组：取名字里第一段（到第一个 `-` 或 `:` 为止）。
  这样 `arrow-down-left` / `arrow-step-back` 会归到 `arrow`，
  `3d-add` 归到 `3d`。分组只是给人看的索引，不改变清单本身。
*/
const groups = new Map();
for (const icon of sorted) {
  const head = icon.split(/[-:]/)[0] ?? icon;
  if (!groups.has(head)) groups.set(head, []);
  groups.get(head).push(icon);
}

const lines = [
  '# 小QTV 用到的图标名',
  '',
  `> 来源：\`third-party/canvas-bundle/\` 里的 JS chunk · 生成脚本 \`scripts/extract-canvas-icons.mjs\``,
  `> 共 ${sorted.length} 个（去重后），按名字的第一段分组`,
  '',
  '用途：复刻界面时查"这个位置该用什么语义的图标"。',
  '**图标资源本身不可用**（那是对方的视觉资产），要的是语义对应关系——',
  '知道"这里是个 3D 图标"就够了，自己画一个或挑一个语义相当的。',
  '',
  '## 分组概览',
  '',
  '| 前缀 | 数量 |',
  '| --- | --- |',
];
for (const [head, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`| \`${head}\` | ${list.length} |`);
}
lines.push('');
for (const [head, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`## ${head}（${list.length}）`, '');
  lines.push(list.map((icon) => `\`${icon}\``).join(' · '));
  lines.push('');
}
writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');

console.log(`图标名 ${sorted.length} 个 → ${OUT}`);
console.log('分组前 12：');
for (const [head, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
  console.log(`  ${head.padEnd(16)} ${list.length}`);
}
