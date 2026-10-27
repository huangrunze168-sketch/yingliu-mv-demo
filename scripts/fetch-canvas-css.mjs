#!/usr/bin/env node
/*
  期音科技 · 把 小QTV 的样式表整份下载下来
  ----------------------------------------
  为什么必须下载而不是"抄数值"：
    小QTV 的样式是从 `liblibai-web-static.liblib.cloud` 加载的**跨域**样式表，
    页面里 `sheet.cssRules` 读不到（浏览器直接拦），所以在页面内 grep 类名是没用的。
    而它的类名又是一整套主题 token 类（`border-hair`、`bg-panel-background`、
    `border-canvas-controls-border` …），不是标准 Tailwind 工具类——
    我们项目里没有 Tailwind，**只有把规则原文搬过来才有意义**。

        （`{ "urls": [...] }`，由画布页的 performance 资源清单得到）

  用法：
*/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const listPath = resolve(projectRoot, 'third-party', 'canvas-evidence', 'canvas-css-urls.json');
const outputDir = resolve(projectRoot, 'third-party', 'canvas-css');

const raw = readFileSync(listPath, 'utf8').replace(/^\uFEFF/, '');
const { urls } = JSON.parse(raw);
if (!Array.isArray(urls) || urls.length === 0) throw new Error(`清单里没有 URL：${listPath}`);

mkdirSync(outputDir, { recursive: true });

const index = [];
let failed = 0;
for (const url of urls) {
  const name = basename(new URL(url).pathname);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    writeFileSync(resolve(outputDir, name), text, 'utf8');
    index.push({ name, url, bytes: text.length });
  } catch (error) {
    failed += 1;
    console.error(`失败 ${name}：${error.message}`);
  }
}

writeFileSync(resolve(outputDir, 'index.json'), `${JSON.stringify({ count: index.length, files: index }, null, 2)}\n`, 'utf8');
console.log(`已下载 ${index.length} 个样式表到 ${outputDir}${failed === 0 ? '' : `（${failed} 个失败）`}`);
