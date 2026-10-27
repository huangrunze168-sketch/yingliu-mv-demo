#!/usr/bin/env node
/*
  期音科技 · 小QTV 页面抓取通道（CDP）
  ------------------------------------
  内置浏览器控制面在这台机器上是坏的（`cua.getState()` 一直返回
  `Codex auth token is unavailable`），所以改用**独立可调试 Chrome**：

      chrome.exe --remote-debugging-port=9222 --remote-allow-origins=* \
                 --user-data-dir=<独立 profile> https://www.liblib.tv/

  这个脚本就是那条通道的客户端。用 Node 24 自带的 WebSocket，不引任何依赖。

  子命令：
    targets                     列出调试目标（页面、iframe、worker）
    nav <url>                   让页面跳到某个地址
    eval <file.js>              在页面里跑一段脚本，打印返回值（JSON）
    eval-inline "<js>"          同上，脚本直接写在命令行
    dom [selector]              抓一份 DOM（默认整页 HTML，给了选择器就抓那一段的 outerHTML）
    text [selector]             抓可见文本（默认 body）
    net <秒数> [过滤词]          监听 Network，打印这段时间里的请求
    console <秒数>               监听 console 输出
    click <选择器>               在元素中心派发一次真实鼠标点击
    click-text "<文本>"          按可见文本找元素并点它
    shot <文件路径>              截屏

  用法示例：
*/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ENDPOINT = process.env.CANVAS_CDP ?? 'http://127.0.0.1:9222';

/** 一个 CDP 连接：发命令、收事件。 */
class CdpSession {
  #ws;
  #seq = 0;
  #pending = new Map();
  #listeners = new Map();

  static async open(webSocketUrl) {
    const ws = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', (event) => reject(new Error(`WebSocket 连不上：${event.message ?? '未知'}`)), { once: true });
    });
    return new CdpSession(ws);
  }

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const slot = this.#pending.get(message.id);
        if (slot === undefined) return;
        this.#pending.delete(message.id);
        if (message.error) slot.reject(new Error(`${message.error.message}${message.error.data ? ` / ${message.error.data}` : ''}`));
        else slot.resolve(message.result);
        return;
      }
      const bucket = this.#listeners.get(message.method);
      if (bucket === undefined) return;
      for (const handler of bucket) handler(message.params);
    });
  }

  send(method, params = {}) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const bucket = this.#listeners.get(method) ?? [];
    bucket.push(handler);
    this.#listeners.set(method, bucket);
  }

  close() {
    this.#ws.close();
  }
}

async function listTargets() {
  const response = await fetch(`${ENDPOINT}/json/list`);
  return response.json();
}

/** 挑一个页面目标：优先 liblib.tv 的可见页面。 */
async function pageSession() {
  const targets = await listTargets();
  const pages = targets.filter((item) => item.type === 'page' && item.url.startsWith('http'));
  const target = pages.find((item) => item.url.includes('liblib.tv') && item.webSocketDebuggerUrl)
    ?? pages.find((item) => item.webSocketDebuggerUrl);
  if (target === undefined) throw new Error('没有可用的页面目标（Chrome 是不是没开？）');
  const session = await CdpSession.open(target.webSocketDebuggerUrl);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  return { session, target };
}

/** 在页面里求值，返回真值（对象会序列化过来）。 */
async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面里报错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result?.value;
}

/** 元素中心的页面坐标（给 Input.dispatchMouseEvent 用）。 */
const CENTER_OF = `(selector) => {
  const element = document.querySelector(selector);
  if (element === null) return null;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height, text: (element.textContent ?? '').slice(0, 60) };
}`;

async function clickAt(session, x, y) {
  const shared = { x, y, button: 'left', clickCount: 1, buttons: 1 };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...shared, buttons: 0 });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...shared });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...shared });
}

/** 等一段时间，期间把事件喂进收集器。 */
async function drain(seconds) {
  await new Promise((resolve) => setTimeout(resolve, Math.round(seconds * 1000)));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { session, target } = await pageSession();
  try {
    switch (command) {
      case 'targets': {
        for (const item of await listTargets()) {
          console.log(`${item.type.padEnd(16)} ${item.url}`);
        }
        return;
      }
      case 'nav': {
        const url = rest[0];
        if (url === undefined) throw new Error('nav 需要 URL');
        const result = await session.send('Page.navigate', { url });
        console.log(JSON.stringify({ navigated: url, frameId: result.frameId }, null, 2));
        return;
      }
      case 'eval':
      case 'eval-inline': {
        const expression = command === 'eval'
          ? readFileSync(rest[0] ?? '', 'utf8')
          : rest.join(' ');
        const value = await evaluate(session, expression);
        console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        return;
      }
      case 'dom': {
        const selector = rest[0];
        const html = await evaluate(session, selector === undefined
          ? 'document.documentElement.outerHTML'
          : `(document.querySelector(${JSON.stringify(selector)})?.outerHTML ?? '（没有匹配的元素）')`);
        console.log(html);
        return;
      }
      case 'text': {
        const selector = rest[0] ?? 'body';
        const text = await evaluate(session, `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '（没有匹配的元素）')`);
        console.log(text);
        return;
      }
      case 'net': {
        const seconds = Number(rest[0] ?? '8');
        const args = rest.slice(1);
        /* 默认只看接口调用（XHR / Fetch）——图片、字体、CSS 会把有用的一百条冲走 */
        const showAll = args.includes('--all');
        const filter = args.find((item) => !item.startsWith('--'));
        const seen = [];
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (params) => {
          seen.push({ at: Date.now(), method: params.request.method, url: params.request.url, type: params.type, post: params.request.postData?.slice(0, 400) });
        });
        session.on('Network.responseReceived', (params) => {
          const hit = [...seen].reverse().find((item) => item.url === params.response.url);
          if (hit !== undefined) hit.status = params.response.status;
        });
        await drain(seconds);
        const rows = seen.filter((item) => (showAll || item.type === 'XHR' || item.type === 'Fetch')
          && (filter === undefined || item.url.includes(filter)));
        for (const row of rows) {
          console.log(`${row.status ?? '...'} ${row.method} ${row.type ?? ''} ${row.url}${row.post === undefined ? '' : `\n      body: ${row.post}`}`);
        }
        console.log(`—— 共 ${rows.length} 条（窗口 ${seconds}s${filter === undefined ? '' : `，过滤「${filter}」`}）`);
        return;
      }
      case 'console': {
        const seconds = Number(rest[0] ?? '8');
        session.on('Runtime.consoleAPICalled', (params) => {
          const text = params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
          console.log(`[${params.type}] ${text}`);
        });
        session.on('Runtime.exceptionThrown', (params) => {
          console.log(`[exception] ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
        });
        await drain(seconds);
        console.log(`—— 监听了 ${seconds}s`);
        return;
      }
      case 'matched': {
        /*
          `matched <选择器>`：把一个元素身上**所有生效的 CSS 规则**列出来（含来源样式表）。

          为什么要它：小QTV 的样式来自跨域 CDN，页面里 `sheet.cssRules` 读不到；
          而"这个类到底定义在哪个文件、规则原文是什么"只有 DevTools 协议答得上——
          `CSS.getMatchedStylesForNode` 是浏览器内核层的接口，不受同源策略限制。
          拿到之后就能把规则原文原样搬走，而不是照着 computed style 自己写一遍。
        */
        const selector = rest[0];
        if (selector === undefined) throw new Error('matched 需要一个选择器');
        await session.send('DOM.enable');
        await session.send('CSS.enable');
        const { root } = await session.send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        if (!nodeId) throw new Error(`没找到元素：${selector}`);
        /*
          伪类规则（`:hover` / `:active`）只有元素**处于那个状态**时才会出现在匹配列表里。
          `CSS.forcePseudoState` 可以替用户把它按住，于是那些规则也能被抓出来——
          不用真的把鼠标挪上去，也不用去猜 `hover:bg-xxx` 的规则体长什么样。
        */
        const forced = rest.slice(1).filter((item) => item.startsWith('--')).map((item) => item.slice(2));
        if (forced.length > 0) {
          await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: forced });
        }
        const styles = await session.send('CSS.getMatchedStylesForNode', { nodeId });
        /* 只留作者样式：浏览器默认样式（user-agent）几十条，会把有用的冲掉 */
        const rows = (styles.matchedCSSRules ?? [])
          .filter((entry) => entry.rule.origin !== 'user-agent')
          .map((entry) => ({
          selector: entry.rule.selectorList.text,
          origin: entry.rule.origin,
          media: (entry.rule.media ?? []).map((item) => item.text).join(' '),
          props: entry.rule.style.cssProperties
            .filter((property) => property.name !== undefined)
            .map((property) => `${property.name}: ${property.value}${property.important ? ' !important' : ''}`),
          }));
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      case 'hover': {
        /* 真鼠标移动（不是派发事件）——CSS :hover 只认这个，派发的事件骗不过它 */
        const point = await evaluate(session, `(${CENTER_OF})(${JSON.stringify(rest[0] ?? '')})`);
        if (point === null || point === undefined) {
          console.log('没找到要悬停的元素');
          return;
        }
        await session.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0,
        });
        console.log(JSON.stringify({ hovered: point }, null, 2));
        return;
      }
      case 'click':
      case 'click-text': {
        const point = command === 'click'
          ? await evaluate(session, `(${CENTER_OF})(${JSON.stringify(rest[0] ?? '')})`)
          : await evaluate(session, `(() => {
              const wanted = ${JSON.stringify(rest.join(' '))};
              const nodes = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], li, div')];
              const hit = nodes.reverse().find((node) => (node.innerText ?? '').trim() === wanted)
                ?? nodes.reverse().find((node) => (node.innerText ?? '').includes(wanted));
              if (hit === undefined) return null;
              const box = hit.getBoundingClientRect();
              return { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height, text: (hit.innerText ?? '').slice(0, 60) };
            })()`);
        if (point === null || point === undefined) {
          console.log('没找到要点的元素');
          return;
        }
        await clickAt(session, point.x, point.y);
        console.log(JSON.stringify({ clicked: point }, null, 2));
        return;
      }
      /*
        click-at <x> <y>：按坐标点。
        为什么需要它：有些菜单项是同一段文字渲染出来的好几层（外层整行 + 内层文字），
        `click-text` 按文本找元素会挑错层；先 `items` 拿到每一行的中心点，再按坐标点最稳。
      */
      case 'click-at': {
        const x = Number(rest[0]);
        const y = Number(rest[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click-at 需要两个数字');
        await clickAt(session, x, y);
        console.log(JSON.stringify({ clickedAt: { x, y } }, null, 2));
        return;
      }
      /*
        items "<正则>"：列出页面上**可见且带文字**的元素（行级），带它们各自的中心点。
        用来点那些没有 testid、也没有稳定选择器的菜单项。
      */
      case 'items': {
        const pattern = rest[0] ?? '';
        const rows = await evaluate(session, `(() => {
          const wanted = new RegExp(${JSON.stringify(pattern)});
          const seen = [];
          for (const element of document.querySelectorAll('button, [role="menuitem"], [role="button"], div, li, span')) {
            const box = element.getBoundingClientRect();
            if (box.width < 24 || box.height < 14 || box.height > 60) continue;
            if (box.top < 0 || box.left < 0 || box.bottom > window.innerHeight || box.right > window.innerWidth) continue;
            const text = (element.innerText ?? '').trim();
            if (text.length === 0 || text.length > 24 || !wanted.test(text)) continue;
            seen.push({ text, className: String(element.className).slice(0, 60), x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), w: Math.round(box.width), h: Math.round(box.height) });
          }
          return seen.slice(0, 60);
        })()`);
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      /*
        grab <文件名前缀> <输出目录>：把**页面自己已经加载的**脚本原文抄下来。

        为什么要绕页面这一手：小QTV 是 Turbopack 分包，画布上那些"点开才出现"的
        面板（生成卡片里的提示词格子就是其中之一）在**静态 HTML 里根本没有**，
        按 HTML 抓 chunk 一定漏。这些代码只在页面里被拉过一次，
        而页面自己 fetch 同一个 CDN 地址没有跨域与 cookie 问题——
        所以让页面去取，我们把文本收回来落盘，落盘后就能按普通源码读。
      */
      case 'grab': {
        const wanted = rest[0];
        const outDir = rest[1] ?? 'third-party/canvas-live';
        if (wanted === undefined) throw new Error('grab 需要一段文件名');
        const text = await evaluate(session, `(async () => {
          const name = ${JSON.stringify(wanted)};
          const url = performance.getEntriesByType('resource').map((entry) => entry.name)
            .find((item) => item.split('?')[0].endsWith(name));
          if (url === undefined) return null;
          const response = await fetch(url);
          return response.ok ? await response.text() : 'HTTP ' + response.status;
        })()`);
        if (text === null) throw new Error(`页面里没加载过这个资源：${wanted}`);
        const target = `${outDir}/${wanted.split('/').pop()}`;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(target, text);
        console.log(`${target}  ${text.length} 字符`);
        return;
      }
      /*
        listener <选择器>：问清楚"这个元素的事件处理函数写在哪个脚本文件的第几行"。

        为什么需要：画布上后来才出现的那块面板（生成卡片）**没在我们的静态抓取里**，
        而它的类名又拼不出来（字符串是运行时拼的）。但从元素反查监听器是内核级信息，
        拿到的 scriptId 能对上脚本 URL——于是"实现它的到底是哪个文件"就有了答案，
        接着 grab 那个文件就能读到源码。
      */
      case 'listener': {
        const selector = rest[0];
        if (selector === undefined) throw new Error('listener 需要一个选择器');
        const scripts = new Map();
        await session.send('Debugger.enable');
        session.on('Debugger.scriptParsed', (params) => {
          if (params.url) scripts.set(params.scriptId, params.url);
        });
        await drain(1.5);
        const handle = await session.send('Runtime.evaluate', {
          expression: `document.querySelector(${JSON.stringify(selector)})`,
          returnByValue: false,
        });
        const objectId = handle.result?.objectId;
        if (objectId === undefined) throw new Error(`没找到元素：${selector}`);
        const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId });
        console.log(JSON.stringify(listeners.map((item) => ({
          type: item.type,
          scriptUrl: scripts.get(item.scriptId) ?? `#${item.scriptId}`,
          line: item.lineNumber,
          column: item.columnNumber,
        })), null, 2));
        /*
          顺带把监听器所在脚本的**源码**存下来。既然 `Debugger.scriptParsed` 没报出
          URL（这个页面在 enable 之前就解析完了绝大多数脚本），那就直接按 scriptId
          取源码——反正我们只关心"这段代码长什么样"。
        */
        const wantedScript = rest[1];
        if (wantedScript !== undefined) {
          const source = await session.send('Debugger.getScriptSource', { scriptId: String(wantedScript) });
          const out = rest[2] ?? `.data/script-${wantedScript}.js`;
          writeFileSync(out, source.scriptSource);
          console.log(`${out}  ${source.scriptSource.length} 字符`);
        }
        return;
      }
      /*
        intercept-file：把"选文件"的弹窗挡住。

        为什么要它：Agent 输入区那个「添加附件」按钮点下去会调 `input.click()`，
        浏览器就弹出系统文件选择框——**它会把页面卡住**（探针跑一半不动了，
        上一次就是这么挂的）。打开拦截之后，这个动作只会触发一个事件、不会弹窗，
        于是"点开看一眼菜单长什么样"这件事可以安全地做。
      */
      case 'intercept-file': {
        await session.send('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true });
        console.log('已拦截文件选择弹窗');
        return;
      }
      case 'shot': {
        const path = rest[0] ?? '.data/canvas-shot.png';
        /*
          画布页里有 WebGL（React Flow + 3D），整页截屏偶尔会卡住；
          限定 fromSurface + 不抓视口外，能把它拉回来。
        */
        const result = await session.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
        });
        writeFileSync(path, Buffer.from(result.data, 'base64'));
        console.log(`已保存 ${path}`);
        return;
      }
      /*
        type / key：真的敲键盘。
        为什么不能只派发合成事件：contenteditable 里 `@` 要触发下拉，
        靠的是浏览器原生输入（beforeinput/input）——合成事件骗不过 React 的受控逻辑，
        也读不到真实光标位置。
          type "<文本>"                 逐字插入（Input.insertText）
          key Tab|Enter|Escape|Backspace|ArrowDown|ArrowUp|Digit1
      */
      case 'type': {
        const text = rest.join(' ');
        if (text.length === 0) throw new Error('type 需要一段文本');
        await session.send('Input.insertText', { text });
        console.log(JSON.stringify({ typed: text }, null, 2));
        return;
      }
      case 'key': {
        const named = {
          Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
          Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
          Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
          Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
          Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
          ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
          ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
          ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
          ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
        };
        const name = rest[0] ?? '';
        const digit = /^Digit([1-9])$/.exec(name);
        const spec = named[name] ?? (digit
          ? {
              key: digit[1],
              code: `Digit${digit[1]}`,
              windowsVirtualKeyCode: 48 + Number(digit[1]),
              text: digit[1],
            }
          : null);
        if (spec === null) throw new Error(`不认识这个键：${name}`);
        for (const type of ['keyDown', 'keyUp']) {
          await session.send('Input.dispatchKeyEvent', { type, ...spec });
        }
        console.log(JSON.stringify({ key: name }, null, 2));
        return;
      }
      default: {
        console.log(`未知子命令「${command ?? ''}」。当前页面：${target.url}`);
        console.log('可用：targets / nav / eval / eval-inline / dom / text / net / console / click / click-text / hover / matched / shot / type / key');
        process.exitCode = 1;
      }
    }
  } finally {
    session.close();
  }
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});
