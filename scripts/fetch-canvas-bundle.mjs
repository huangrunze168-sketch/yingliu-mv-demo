/* ============================================================
   把 小QTV 前台的前端代码抓下来。

   为什么要这么做：目标里那句"不要靠想象"只能靠**读它的代码**满足——
   小QTV 是个 SPA，画布的功能、交互、快捷键、词条全在打包出来的 JS 里。
   点页面只能看到"用起来是什么样"，读代码才看得到"它是怎么做的、
   还有哪些入口没露出来"。

   为什么不用浏览器：这台机器上的浏览器自动化通道当前不可用
   （Codex auth token 报错）。而首页 HTML 里就列着全部 chunk，
   直接抓比开浏览器更全（连懒加载入口都能拿到）。


   为什么要抓多个路由：Next.js 按路由切 chunk，**画布那一大坨代码不在首页里**。
   实测差距很大：首页 79 个 chunk，`/canvas` 一个路由就带出 260 个。
   只抓首页会得出"画布代码不存在"的错误结论。
   ============================================================ */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROUTES = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['https://www.liblib.tv/', 'https://www.liblib.tv/canvas', 'https://www.liblib.tv/project', 'https://www.liblib.tv/assets'];
const OUT_DIR = resolve(process.cwd(), 'third-party', 'canvas-bundle');

/** 抓一个地址；失败时把原因带出来，不静默跳过。 */
async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      /* 不带 UA 时有的 CDN 会回 403；这是普通浏览器的 UA，不是伪装 */
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'accept': '*/*',
    },
  });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.text();
}

mkdirSync(OUT_DIR, { recursive: true });

/** 路由名 → 文件名：`https://host/canvas?x` 存成 `_page-canvas.html` */
function pageFileName(route) {
  const path = new URL(route).pathname.replace(/\/+$/, '') || '/';
  return `_page-${path === '/' ? 'home' : path.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '')}.html`;
}

/* 每个路由的 HTML 里都列着它需要的 chunk；合并去重后再下载 */
const urls = [];
for (const route of ROUTES) {
  try {
    const html = await fetchText(route);
    writeFileSync(join(OUT_DIR, pageFileName(route)), html, 'utf8');
    /*
      连 CSS 一起抓：动画（@keyframes / transition）全在样式里，
      而"交互与动画显示"正是要扒的东西之一。只抓 JS 会漏掉这一半。
    */
    const found = [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1]))]
      .filter((url) => url.startsWith('http'));
    console.log(`${route} → ${(html.length / 1024).toFixed(0)} KB，${found.length} 个 JS/CSS`);
    urls.push(...found);
  } catch (error) {
    console.log(`${route} → 抓取失败：${error.message ?? error}`);
  }
}
const uniqueUrls = [...new Set(urls)];
console.log(`合计 ${uniqueUrls.length} 个去重后的 chunk`);

let ok = 0;
let skipped = 0;
const failed = [];
/* 分批并发：一次全推上去容易被 CDN 限流，而串行 77 个太慢 */
const batchSize = 8;
for (let index = 0; index < uniqueUrls.length; index += batchSize) {
  const batch = uniqueUrls.slice(index, index + batchSize);
  await Promise.all(batch.map(async (url) => {
    /*
      文件名用 URL 的**末段**（chunk 哈希本身就是唯一的），
      前缀只留能区分的部分——不然一屏都是 `liblibai-web-static.liblib.cloud__…`。
    */
    const name = new URL(url).pathname.split('/').pop() ?? url.replace(/[^A-Za-z0-9._-]+/g, '__');
    /* 已经抓过的**直接跳过，连请求都不发**：重跑只为补 CSS，不该再把几百个 JS 下一遍 */
    if (existsSync(join(OUT_DIR, name))) {
      skipped += 1;
      ok += 1;
      return;
    }
    try {
      const text = await fetchText(url);
      writeFileSync(join(OUT_DIR, name), text, 'utf8');
      ok += 1;
    } catch (error) {
      failed.push(String(error.message ?? error));
    }
  }));
  process.stdout.write(`\r已抓 ${ok}/${uniqueUrls.length}`);
}
console.log('');
console.log(`完成：${ok} 个成功，${failed.length} 个失败`);
for (const item of failed.slice(0, 10)) console.log('  失败：' + item);
console.log(`产物目录：${OUT_DIR}`);
