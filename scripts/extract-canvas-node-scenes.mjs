/* ============================================================
   抽 小QTV 的"节点快捷场景"定义（图片节点里 `/` 快捷指令那一套）。

   为什么要单独抽：这一份定义把**一个场景需要什么输入、匹配哪个模型、
   暴露哪些参数、在哪些入口出现**写得很全。它是"节点面板长什么样"的
   第一手依据——比对着界面猜参数名可靠得多。

   注意"Fallback"这个词：它是**兜底清单**，真实运行时可能从服务端拉一份更新的。
   所以这里的清单是"代码里写死的那一份"，不代表线上永远只有这些。

   ============================================================ */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = resolve(process.cwd(), 'third-party', 'canvas-bundle');

/** 找出定义这些场景的那个 chunk：里面同时有 `getFallback` 与 `scene:"`。 */
function findSourceChunk() {
  for (const name of readdirSync(DIR)) {
    if (!name.endsWith('.js')) continue;
    const text = readFileSync(join(DIR, name), 'utf8');
    if (text.includes('getFallbackSlashImageItems') && text.includes('scene:"')) {
      return { name, text };
    }
  }
  throw new Error('没找到定义节点场景的 chunk（先跑 fetch-canvas-bundle.mjs）');
}

const { name: sourceName, text } = findSourceChunk();

/*
  切窗口：每个场景从 `scene:"<id>"` 开始，到下一个场景或数组结尾为止。
  用"下一个 `scene:"`"当边界，而不是配对括号——压缩代码里括号嵌套很深，
  配对写错了会静默截断；而 scene 之间不会互相嵌套。
*/
const marks = [...text.matchAll(/scene:"([a-z0-9_]+)"/g)];
const scenes = marks.map((mark, index) => {
  const start = mark.index ?? 0;
  const end = index + 1 < marks.length ? (marks[index + 1]?.index ?? text.length) : Math.min(text.length, start + 4000);
  return { id: mark[1] ?? '', body: text.slice(start, end) };
});

/** 取 `key:translate("xxx")` 里的词条键；取不到就返回 null。 */
function translatedKey(body, field) {
  const match = new RegExp(`${field}:(?:\\(0,[a-zA-Z_$]+\\.[a-zA-Z_$]+\\))?\\("([^"]+)"`).exec(body);
  return match?.[1] ?? null;
}

/** 取一个字符串字面量字段。 */
function stringField(body, field) {
  const match = new RegExp(`${field}:"([^"]*)"`).exec(body);
  return match?.[1] ?? null;
}

/** 取数组字段（只取字符串项）。 */
function arrayField(body, field) {
  const match = new RegExp(`${field}:\\[([^\\]]*)\\]`).exec(body);
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? '');
}

/** 参数名 = 出现在 model:{ … } 里的 originalField 值。 */
function parameters(body) {
  return [...new Set([...body.matchAll(/originalField:"([a-zA-Z_0-9]+)"/g)].map((item) => item[1] ?? ''))];
}

/** 枚举值：`enum:[{value:"x",…}` 或 `enum:["x"]`。 */
function enumValues(body) {
  const values = new Set();
  for (const match of body.matchAll(/enum:\[([^\]]*)\]/g)) {
    for (const item of (match[1] ?? '').matchAll(/value:"([^"]+)"/g)) values.add(item[1] ?? '');
    for (const item of (match[1] ?? '').matchAll(/"([^"]+)"/g)) values.add(item[1] ?? '');
  }
  return [...values];
}

const extracted = scenes.map((scene) => ({
  id: scene.id,
  labelKey: translatedKey(scene.body, 'label'),
  explainKey: translatedKey(scene.body, 'explain'),
  icon: stringField(scene.body, 'icon'),
  inputRequirement: stringField(scene.body, 'inputRequirement'),
  supportModels: arrayField(scene.body, 'supportModels'),
  showIn: arrayField(scene.body, 'showIn'),
  parameters: parameters(scene.body),
  enumValues: enumValues(scene.body),
  isNewFeature: /isNewFeature:!0/.test(scene.body),
}));

/*
  **以词条表为准补全清单**。

  JS 里那份是 `getFallback…Items`——它可能只覆盖一部分场景
  （实测：词条表里有 18 个 `slashScene*`，而 fallback 列表里只有 16 个，
  少的是"场景三视图"和"人像质感调节"）。
  两者都要：词条表给全清单，JS 给参数细节。
*/
let dictionaryForList = {};
try {
  dictionaryForList = JSON.parse(readFileSync(join(DIR, '_strings.json'), 'utf8'));
} catch { /* 没有词条表就跳过补全 */ }
const declaredScenes = Object.entries(dictionaryForList)
  .filter(([key]) => key.startsWith('slashScene'))
  .map(([key, value]) => ({ key, label: String(value) }));
/*
  用**词条键**做匹配，不要按 id 猜。

  第一版把 `slashSceneStoryboardNew` 机械地转成 `storyboard_new` 去比 id，
  而真实 id 是 `storyboard_canvas_skill_new`——于是 18 个里只有 1 个匹配上，
  表面看像"这些场景都没有参数定义"。JS 里那份定义本来就带着词条键
  （`label:(0,t.translate)("canvas:slashSceneStoryboardNew")`），拿它反查最准。
*/
const declaredByKey = new Set(extracted.map((scene) => (scene.labelKey ?? '').replace(/^.*:/, '')));

writeFileSync(join(DIR, '_node-scenes.json'), `${JSON.stringify(extracted, null, 2)}\n`, 'utf8');

/*
  词条键 → 中文。

  一个坑：**代码里的键带命名空间**（`canvas:slashSceneStoryboard`），
  而**词条表里的键不带**（`slashSceneStoryboard`）。
  第一版直接拿带前缀的键去查，于是 16 个场景全显示"未在词条表里"——
  看起来像"中文没抓全"，其实是查法不对。所以这里先原样查、再剥前缀查。
*/
let dictionary = {};
try {
  dictionary = JSON.parse(readFileSync(join(DIR, '_strings.json'), 'utf8'));
} catch { /* 没有词条表就只输出键名 */ }
const t = (key) => {
  if (key === null) return '—';
  const direct = dictionary[key];
  if (typeof direct === 'string') return direct;
  const stripped = key.includes(':') ? key.slice(key.indexOf(':') + 1) : null;
  const viaStripped = stripped === null ? undefined : dictionary[stripped];
  return typeof viaStripped === 'string' ? viaStripped : `（未在词条表里：${key}）`;
};

const lines = [
  '# 小QTV 节点快捷场景（图片节点 `/` 那一套）',
  '',
  `> 来源：\`third-party/canvas-bundle/${sourceName}\` · 生成脚本 \`scripts/extract-canvas-node-scenes.mjs\``,
  `> 共 ${extracted.length} 个场景`,
  '',
  '注意：这份定义在代码里叫 `getFallback…Items`——它是**兜底清单**，',
  '真实运行时可能从服务端拉一份更新的。所以"代码里写死的就这些"，',
  '不等于"线上永远只有这些"。',
  '',
  '| 场景 id | 名称 | 说明 | 输入 | 支持模型 | 参数 | 出现位置 | 新功能 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
];
for (const scene of extracted) {
  lines.push([
    `\`${scene.id}\``,
    t(scene.labelKey),
    t(scene.explainKey),
    scene.inputRequirement ?? '—',
    scene.supportModels.length > 0 ? scene.supportModels.map((m) => `\`${m}\``).join(' ') : '—',
    scene.parameters.length > 0 ? scene.parameters.map((p) => `\`${p}\``).join(' ') : '—',
    scene.showIn.length > 0 ? scene.showIn.map((s) => `\`${s}\``).join(' ') : '—',
    scene.isNewFeature ? '是' : '',
  ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
}
lines.push('');
lines.push('## 每个场景的枚举取值');
lines.push('');
for (const scene of extracted) {
  if (scene.enumValues.length === 0) continue;
  lines.push(`- \`${scene.id}\`：${scene.enumValues.map((v) => `\`${v}\``).join(' · ')}`);
}
lines.push('');

/*
  词条表里的全清单：把 fallback 列表漏掉的那些也列出来。
  "有参数定义"一列用来区分——没有的那几个只是词条里有名字，
  JS 的 fallback 列表里没有它们的参数表（可能由服务端下发）。
*/
lines.push('## 词条表里的全清单（含 fallback 列表没有的）');
lines.push('');
lines.push('| 场景 id（词条键） | 名称 | fallback 里有参数定义 |');
lines.push('| --- | --- | --- |');
const guessedId = (key) => key
  .replace(/^slashScene/, '')
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .toLowerCase();
for (const scene of declaredScenes) {
  lines.push(`| \`${scene.key}\` | ${scene.label} | ${declaredByKey.has(scene.key) ? '有' : '—'} |`);
}
lines.push('');
lines.push('## Slash 菜单的分组');
lines.push('');
for (const [key, value] of Object.entries(dictionaryForList)) {
  if (key.startsWith('slashGroup')) lines.push(`- \`${key}\`：${String(value)}`);
}
lines.push('');
lines.push('## 用到的提示文案（节选）');
lines.push('');
for (const [key, value] of Object.entries(dictionaryForList)) {
  if (/^slash(Commands|Hint|ModelNotSupport|OnlySupport)/.test(key)) lines.push(`- \`${key}\`：${String(value)}`);
}
lines.push('');
writeFileSync(join(DIR, '_node-scenes.md'), `${lines.join('\n')}\n`, 'utf8');

console.log(`从 ${sourceName} 抽出 ${extracted.length} 个场景`);
console.log(`词条表里声明的场景：${declaredScenes.length} 个（其中 ${declaredScenes.filter((s) => declaredByKey.has(s.key)).length} 个有参数定义）`);
console.log('产物：_node-scenes.json / _node-scenes.md');
console.log('');
for (const scene of extracted) {
  console.log(`  ${scene.id.padEnd(34)} ${t(scene.labelKey)}`);
}
