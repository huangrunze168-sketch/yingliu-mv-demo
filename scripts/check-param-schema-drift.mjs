#!/usr/bin/env node
/*
  期音科技 · 参数定义与线上 schema 的漂移检查
  --------------------------------------------
  我们 `data/paramSchema.ts` 里的 `paramDefs` / `modelSettings` 是**早期抓的一份**，
  而模型的 schema 一直在变。已经实测到一处：

    quality   我们的枚举只有 [auto/自适应]（一项）
              线上 properties 里是 low/medium/high/xhigh/max 五档
              → 界面上根本选不到「低画质」，而线上能选

  与其等一个个撞见，不如写个检查把差异列出来：

    1) 对每个字段，比 paramDefs 的 enum 与 properties 里同名字段的 enum（值集合）
    2) 列出「我们有、线上没有」「线上有、我们没有」「两边数量不一致」

  用法：
    node scripts/check-param-schema-drift.mjs
  退出码：0 = 没发现差异；1 = 有差异（方便挂进 CI）
*/

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paramSchemaPath = resolve(projectRoot, 'apps', 'desktop', 'renderer', 'src', 'data', 'paramSchema.ts');
const propertiesPath = resolve(projectRoot, 'apps', 'desktop', 'renderer', 'src', 'data', 'modelProperties.ts');

/** 把 `export const X: T = {...};` 里那一段 JSON 抠出来（这两个文件里都是纯字面量） */
function readLiteral(file, marker) {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`找不到 ${marker}（${file}）`);
  const from = text.indexOf('{', start);
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(from, index + 1));
    }
  }
  throw new Error(`字面量没有闭合：${marker}`);
}

const paramDefs = readLiteral(paramSchemaPath, 'export const paramDefs');
const modelProperties = readLiteral(propertiesPath, 'export const MODEL_PROPERTIES');

/** 把 enum 归一成"值的集合"——两边形状不同：
 *  我们的 paramDefs: [{ value, label }]
 *  线上 properties:  [{ value, displayName }] 或者干脆是 ["1:1","16:9"] 这种裸字符串 */
const valueSetOf = (enumValue) => {
  if (!Array.isArray(enumValue)) return null;
  return enumValue.map((item) => (item !== null && typeof item === 'object' ? item.value : item));
};

/** 线上 properties 里出现过的所有字段名 → 它们的 enum */
const onlineEnums = new Map();
for (const props of Object.values(modelProperties)) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || typeof value !== 'object') continue;
    const set = valueSetOf(value.enum);
    if (set === null || set.length === 0) continue;
    if (!onlineEnums.has(key)) onlineEnums.set(key, new Map());
    onlineEnums.get(key).set(JSON.stringify(set), set);
  }
}

const rows = [];
for (const [name, def] of Object.entries(paramDefs)) {
  const mine = valueSetOf(def?.enum);
  if (mine === null) continue;
  const candidates = onlineEnums.get(name);
  if (candidates === undefined) continue;   // 线上这个字段没有 enum（自由文本之类），跳过

  const mineKey = JSON.stringify(mine);
  /* 线上同一个字段在不同模型上枚举可能不同；只要有一份与我们对得上就算没漂 */
  if (candidates.has(mineKey)) continue;

  const online = [...candidates.values()].sort((a, b) => b.length - a.length)[0];
  rows.push({
    字段: name,
    我们的选项: mine.join(' / '),
    线上选项: online.join(' / '),
  });
}

if (rows.length === 0) {
  console.log('没发现枚举漂移：paramDefs 里带 enum 的字段都与线上某一份对得上。');
  process.exit(0);
}

console.log(`发现 ${rows.length} 处枚举漂移（我们手上的 vs 线上 properties）：\n`);
for (const row of rows) {
  console.log(`· ${row.字段}`);
  console.log(`    我们：${row.我们的选项}`);
  console.log(`    线上：${row.线上选项}\n`);
}
console.log('注意：线上同一字段在不同模型上枚举可能不同，这里只取"差异最大的那一份"作对照。');
process.exit(1);
