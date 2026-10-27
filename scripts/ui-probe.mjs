/* ============================================================
   UI 探针：起应用 → 连 CDP → 读 DOM / 截图
   ------------------------------------------------------------
   为什么需要它：以前验证界面靠「截图后肉眼看」，而截图这条路踩过一串坑——
   截图进程不是 DPI 感知的，拿到的窗口尺寸被系统缩放改过，底部工具栏永远在
   画面之外；按进程名捞窗口还会捞到别的 Electron 应用；渲染产物被 Chromium
   缓存，看到的其实是旧包。这三个坑叠在一起，会让「看起来没问题」和
   「其实没渲染」完全分不清。

   改成走 CDP 之后，判断依据不再是像素，而是页面里的真实 DOM：
   元素的 getBoundingClientRect、computed style、文本内容都能直接读回来，
   不再受缩放、窗口层级、缓存影响（缓存问题另由主进程 clearCache 解决）。

   用法：
     # 只读 DOM，把结果打到 stdout
     node scripts/ui-probe.mjs --eval "document.querySelectorAll('.cv-dock button').length"

     # 读复杂逻辑时把表达式放文件里，避免命令行转义
     node scripts/ui-probe.mjs --eval-file .data/probe-canvas.js --shot .data/ui-canvas.png

     # 先点一下导航再量（--pre 在 --eval 之前跑，用来切视图）
     node scripts/ui-probe.mjs --pre "document.querySelector('[data-nav=canvas]').click()" --eval-file .data/probe-canvas.js

     # 跑完不退出应用，方便接着手动点
     node scripts/ui-probe.mjs --keep --shot .data/ui-home.png

   参数：
     --eval <js>        在页面里求值的表达式（结果会 JSON 序列化后打印）
     --eval-file <path> 从文件读表达式（与 --eval 二选一）
     --pre <js>         在求值/截图之前先执行的一段脚本（常用来切视图）
   --shot <path>      截图输出路径
     --clip x,y,w,h     只截这一块（CSS 像素）；canvas 里的东西在整屏图里太小，看它用这个
    --drag x1,y1,x2,y2 真实指针拖拽（CDP 输入事件，可重复给多次）。
                       合成 PointerEvent 过不了 setPointerCapture，拖不动节点，所以走这条路
    --clip-selector <s> 只截这个元素（自动量它的位置与尺寸），比手写 --clip 稳
    --scale <n>        截图放大倍数（配合 --clip，默认 1）
   --wait <ms>        求值/截图前额外等待（默认 1500ms）
     --ready <selector> 等待该选择器出现再继续（默认 '#root > *'）
    --keep             结束后保留应用进程
    --app-dir <path>   启动另一个应用目录（默认本仓库）。
                       本地能力后端就会**真的**起不来——比在页面里假装它挂了可信。
   ============================================================ */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.QIYIN_CDP_PORT ?? 9222);

/** 解析命令行参数：只认上面列出的那几个，其余一律报错——免得静默忽略拼错的选项 */
function parseArgs(argv) {
  const options = { wait: 1500, ready: '#root > *', keep: false, drags: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} 后面缺少取值`);
      return argv[index];
    };
    switch (flag) {
      case '--eval': options.evalCode = next(); break;
      case '--eval-file': options.evalCode = readFileSync(resolve(next()), 'utf8'); break;
      case '--pre': options.preCode = next(); break;
      /* `--pre` 的读文件版本：准备步骤一长（进画布、整理、设缩放…），
         塞进命令行既难读又容易被 shell 吃掉引号 */
      case '--pre-file': options.preCode = readFileSync(resolve(next()), 'utf8'); break;
      case '--shot': options.shot = resolve(next()); break;
      case '--clip': {
        const parts = next().split(',').map((value) => Number(value.trim()));
        if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
          throw new Error('--clip 需要四个数字：x,y,w,h');
        }
        options.clip = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        break;
      }
      case '--scale': options.scale = Number(next()); break;
      case '--clip-selector': options.clipSelector = next(); break;
      case '--wait': options.wait = Number(next()); break;
      case '--drag': {
        /*
          `--drag x1,y1,x2,y2`：用**真实输入事件**把指针从一点拖到另一点。

          为什么不能用页面里 dispatchEvent 合成：画布的节点拖动会调
          `setPointerCapture(pointerId)`，而合成事件的 pointerId 在浏览器内部并不存在，
          这一步会直接抛 NotFoundError——拖动逻辑刚起步就断了，探针会误报"拖不动"。
          CDP 的 Input.dispatchMouseEvent 走的是真输入路径，Chromium 会照常派发
          pointerdown/move/up，指针捕获因此成立。

          坐标是页面 CSS 像素；可以给多次，按顺序执行。
        */
        const raw = next().split(',');
        const button = (raw[4] ?? 'left').trim();
        if (button !== 'left' && button !== 'middle') {
          throw new Error(`--drag 的第五个取值只认 left / middle，收到 ${button}`);
        }
        const parts = raw.slice(0, 4).map((value) => Number(value.trim()));
        if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
          throw new Error('--drag 需要四个数字：x1,y1,x2,y2');
        }
        options.drags.push({ x1: parts[0], y1: parts[1], x2: parts[2], y2: parts[3], button });
        break;
      }
      case '--viewport': {
        /*
          覆盖页面视口尺寸（CDP `Emulation.setDeviceMetricsOverride`）。
          用处：离群节点的阈值跟视口成正比（`p = 0.8 × max(视口/最小缩放)`），
          窗口小的时候更容易出现"散开的画布"——那是真实用户也会遇到的情形，
          正好用来验证它，而不用把节点拖出一万像素。
        */
        const parts = next().split(',').map((value) => Number(value.trim()));
        if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value) || value <= 0)) {
          throw new Error('--viewport 需要两个正数：宽,高');
        }
        options.viewport = { width: parts[0], height: parts[1] };
        break;
      }
      case '--ready': options.ready = next(); break;
      case '--keep': options.keep = true; break;
      case '--app-dir': options.appDir = resolve(next()); break;
      default: throw new Error(`不认识的参数：${flag}`);
    }
  }
  return options;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * 真实指针拖拽（见 `--drag` 的说明）。
 *
 * 中间插值分步移动，不是"按下 → 直接跳到终点"：画布的拖动是按 pointermove
 * 逐个增量算位移的，一步到底会让它只看到一次移动；分步也更接近人手。
 */
async function performTouchHold(cdp, hold) {
  const duration = Number.isFinite(hold.duration) ? hold.duration : 650;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: hold.x, y: hold.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
  });
  await sleep(duration);
  if (hold.release !== false) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(180);
  }
}

async function performDrag(cdp, drag) {
  const steps = 14;
  const button = drag.button ?? 'left';
  /*
    `modifiers`：CDP 的位掩码（Alt=1 · Ctrl=2 · Meta=4 · Shift=8）。
    带上是"按住某个修饰键点/拖"——画布上「Shift+点击 = 批量选择」那条规则
    就靠它，光按 `drag.button` 是表达不出来的。
  */
  const modifiers = drag.modifiers ?? 0;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x1, y: drag.y1, buttons: 0, modifiers });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: drag.x1, y: drag.y1, button, buttons: button === 'middle' ? 4 : 1, clickCount: 1, modifiers,
  });
  /* 按下之后先停一拍：有些实现会在 pointerdown 里先做选中/记账 */
  await sleep(120);
  for (let step = 1; step <= steps; step += 1) {
    const x = drag.x1 + ((drag.x2 - drag.x1) * step) / steps;
    const y = drag.y1 + ((drag.y2 - drag.y1) * step) / steps;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button, buttons: button === 'middle' ? 4 : 1, modifiers,
    });
    await sleep(28);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: drag.x2, y: drag.y2, button, buttons: 0, clickCount: 1, modifiers,
  });
  await sleep(200);
}

/**
 * 一次**真实按键**（CDP `Input.dispatchKeyEvent`）。

 * 为什么不用页面里 `dispatchEvent(new KeyboardEvent(...))`：
 * 那种合成事件的 `isTrusted` 是 false，`key/code` 也要自己编；
 * 而"按快捷键"这件事本身就该走真输入——真机上撞到过：
 * 合成键能过我们的监听，但过不了某些依赖 `event.code` / 焦点状态的判断，
 * 于是我们会得出"这个快捷键坏了"的错误结论（或反过来）。
 *
 * `key` 写法：`{ key: 'g', ctrl: true, shift: true, alt: true }`
 *   · 单个字符键按 `key` 直接发 `char`/`code`（`g` → keyCode 71）
 *   · `Escape` / `Delete` / `Tab` 这几个走下面那张表
 */
const NAMED_KEYS = {
  Escape: { code: 'Escape', keyCode: 27, text: '' },
  Delete: { code: 'Delete', keyCode: 46, text: '' },
  Backspace: { code: 'Backspace', keyCode: 8, text: '' },
  Tab: { code: 'Tab', keyCode: 9, text: '' },
  Enter: { code: 'Enter', keyCode: 13, text: '' },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37, text: '' },
  ArrowRight: { code: 'ArrowRight', keyCode: 39, text: '' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38, text: '' },
  ArrowDown: { code: 'ArrowDown', keyCode: 40, text: '' },
};

async function performKey(cdp, input) {
  const key = String(input?.key ?? '');
  if (key === '') return;
  const modifiers = (input.ctrl ? 2 : 0) | (input.alt ? 1 : 0) | (input.shift ? 8 : 0) | (input.meta ? 4 : 0);
  const named = NAMED_KEYS[key];
  const isLetter = key.length === 1 && /[a-z0-9]/i.test(key);
  const code = named?.code ?? (isLetter ? `Key${key.toUpperCase()}` : key);
  const keyCode = named?.keyCode ?? (isLetter ? key.toUpperCase().charCodeAt(0) : 0);
  const text = named?.text ?? '';
  /* 按下 → 松开：两个都要发，否则某些实现的状态机会卡在"按着" */
  await cdp.send('Input.dispatchKeyEvent', {
    type: text === '' ? 'rawKeyDown' : 'keyDown',
    modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    ...(text === '' ? {} : { text }),
  });
  await sleep(60);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers, key, code,
    windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  });
  await sleep(120);
}

/**
 * 清掉上一次跑剩下的实例。
 *
 * 必须清：残留进程占着调试端口，新实例起不来，脚本会连到旧页面上去，
 * 于是「改了代码但界面没变」——这个现象会浪费掉大量排查时间。
 * 只杀命令行里含本项目路径的 electron，不碰机器上别的 Electron 应用。
 *
 * ⚠ 这里**必须等它跑完**再启动新实例。
 *
 * 踩过的坑：清理是 `pwsh -Command` 跑的一条 WMI 查询 + Stop-Process，
 * 而 PowerShell 启动到执行查询要一两秒。原来把它 fire-and-forget 之后
 * 只等 1.2 秒就启动应用，于是**查询的快照可能包含刚启动的应用本身**——
 * 它自己的命令行里就有 `replica-studio`，被同一条规则杀掉。
 *
 * 为什么一直没暴露：短求值（读个 DOM、点个按钮）不到一秒就结束了，
 * 根本活不到被杀。而 `produce` 这类要跑好几秒的操作正好撞在窗口里，
 * 表现是「应用突然没了、CDP 连不上、脚本永远卡住」——看起来像应用崩了，
 * 其实是探针自己动的手。
 */
async function killStaleInstances() {
  const script = `
    Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
      Where-Object { $_.CommandLine -like '*replica-studio*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  `;
  const cleanup = spawn('pwsh', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  await new Promise((done) => cleanup.once('close', done));
}

async function waitForTarget() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string');
      if (page) return page;
    } catch {
      /* 端口还没起，接着等 */
    }
    await sleep(300);
  }
  throw new Error(`等不到调试端口 ${PORT} 上的页面，应用可能没起来`);
}

/** 极简 CDP 客户端：够用就好，不引第三方依赖 */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('连不上调试端口')), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    /*
      给每个 CDP 请求加超时。

      没有超时的后果：页面/主进程一旦没了响应，这个 promise 永远不 settle，
      脚本就卡在那里——看不到任何输出，也分不清是"操作很慢"还是"应用已经没了"。
      实测被这件事耗掉过整轮时间。现在超时就报出来，至少知道该去查什么。
    */
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超过 120 秒没有响应（应用可能已经退出）`));
      }, 120_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      /* 包一层 async：脚本里要 await IPC（如 listProjects），同步箭头函数会直接报语法错 */
      expression: `(async () => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面里求值出错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }
}

/**
 * 等待某个选择器出现。
 *
 * 为什么要等：应用启动到首屏渲染之间有几百毫秒空窗，直接求值会读到空页面，
 * 然后误判成「元素不存在」。
 */
async function waitForReady(cdp, selector) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = await cdp.evaluate(`return Boolean(document.querySelector(${JSON.stringify(selector)}));`);
    if (found) return;
    await sleep(200);
  }
  throw new Error(`等了 30 秒仍没出现 ${selector}`);
}

const options = parseArgs(process.argv.slice(2));

/* 先清干净再启动。顺序不能反——反了就会把自己刚启动的实例杀掉，见函数注释 */
await killStaleInstances();
await sleep(400);

/*
  直接起 `electron.exe`，不走 `.bin/electron.cmd` + `shell: true`。

  两个原因，第二个是踩出来的：
    ① 走 shell 会把参数交给 cmd.exe 再转一层，既有注入面，也带来
       Node 的 DEP0190 警告；
    ② **实测**：用 `.cmd` 外壳启动时，调 `produce`（渲染成片，跑好几秒）
       之后应用会以 code=1 退出；同一台机器、同一份产物，直接起 exe 就没事。
       长的求值因此总在"应用已经没了"之后卡住，而短的求值从没撞上，
       所以这个差异藏了很久。
*/
const electronBin = process.platform === 'win32'
  ? resolve(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : resolve(projectRoot, 'node_modules', '.bin', 'electron');
if (!existsSync(electronBin)) throw new Error(`找不到 electron：${electronBin}`);

/*
  `--app-dir` 让同一个探针能启动**另一份应用目录**（默认就是本仓库）。
  它存在的理由：要验"本地能力后端起不来时界面说什么"，最可信的做法是
  让后端真的起不来——把 dist-electron 复制到仓库之外，那里逐级向上找不到
*/
const appDir = options.appDir ?? projectRoot;
if (!existsSync(appDir)) throw new Error(`找不到应用目录：${appDir}`);

/*
  `--keep` 时把应用的输出**重定向到文件**，而不是用管道。

  这一条是踩出来的：为了让探针在 --keep 下能退出，第一版是 `stdout.destroy()`——
  那等于把应用的 stdout 管道拆掉，应用下一次 console.log 就吃到 EPIPE，
  整个主进程**直接退出**。表现是"点了生成成片，应用凭空消失"，
  而真相是探针把它弄死的。改成写文件：应用有正常的落点，探针也能干净退出，
  顺便留一份可查的日志。
*/
const keepLogPath = resolve(projectRoot, '.data', 'app-keep.log');
const keepLogFd = options.keep ? openSync(keepLogPath, 'a') : null;
const app = spawn(electronBin, [appDir, `--remote-debugging-port=${PORT}`], {
  cwd: appDir,
  stdio: keepLogFd === null ? ['ignore', 'pipe', 'pipe'] : ['ignore', keepLogFd, keepLogFd],
  shell: false,
  /*
    `--keep` 时让应用**真正脱离**探针：detached 之后它自成一组，
    探针退出不会把它带走（这一点实测过：不 detached 时，探针一退出应用就没了，
    而应用本身并没有崩——日志里连一行错误都没有）。
  */
  detached: options.keep,
});

let appLog = '';
/*
  `QIYIN_PROBE_VERBOSE=1` 时把应用输出**实时**打到终端。

  为什么需要：默认只在探针失败时把日志一次性打出来，而应用中途死掉时
  探针自己正卡在一个 CDP 请求上——永远等不到失败分支，那些输出就永远看不到，
  等于把死因吞了。排查"应用突然没了"时必须看到它临死前最后几行。
*/
const verbose = process.env.QIYIN_PROBE_VERBOSE === '1';
app.stdout?.on('data', (chunk) => { appLog += chunk.toString(); if (verbose) process.stdout.write(`[app] ${chunk}`); });
app.stderr?.on('data', (chunk) => { appLog += chunk.toString(); if (verbose) process.stdout.write(`[app!] ${chunk}`); });
/* 进程自己退出也要报出来——这是"应用没了"最直接的证据 */
app.on('exit', (code, signal) => {
  if (verbose) process.stdout.write(`[app] 进程退出 code=${code} signal=${signal}\n`);
  else appLog += `\n进程退出 code=${code} signal=${signal}\n`;
});

try {
  const target = await waitForTarget();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitForReady(cdp, options.ready);
  await sleep(options.wait);

  if (options.viewport) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: options.viewport.width,
      height: options.viewport.height,
      deviceScaleFactor: 0,
      mobile: false,
    });
    /* 视口一变，画布容器与节点的屏幕位置全变，量之前先让布局稳定 */
    await sleep(800);
  }

  if (options.preCode) {
    await cdp.evaluate(options.preCode);
    /* 点完之后要给渲染留一拍，否则量到的还是上一个视图的布局 */
    await sleep(600);

    /*
      页面内测量 → 真实拖拽。

      有些坐标只有在页面里量得准（端口很小、位置又随布局变），
      而拖拽必须走 CDP 的真输入才可靠（合成事件的 pointerId 在浏览器里不存在，
      `setPointerCapture` 会直接抛错）。所以 `--pre` 里可以把要拖的坐标写进
      `window.__probeDrags`，这里取出来按顺序执行：

        window.__probeDrags = [{ x1, y1, x2, y2, button?: 'left' | 'middle' }];
      取走之后清空，避免下一次求值重复执行。
    */
    const requested = await cdp.evaluate(
      'const queued = window.__probeDrags ?? null; window.__probeDrags = null; return queued;',
    );
    if (Array.isArray(requested)) {
      for (const drag of requested) {
        if (typeof drag?.x1 === 'number' && typeof drag?.y1 === 'number'
          && typeof drag?.x2 === 'number' && typeof drag?.y2 === 'number') {
          await performDrag(cdp, drag);
        }
      }
    }
  }

  for (const drag of options.drags) {
    await performDrag(cdp, drag);
  }

  /*
    分步脚本：**拖拽 / 按键 / 求值 交替**。

    --pre 里把要按顺序做的事排进 `window.__probeSteps`，这里逐条执行，
    每条的返回值收集起来（同时写回页面 `window.__probeStepResults`，
    好让 --eval 里接着读）：

      window.__probeSteps = [
        { drag: { x1, y1, x2, y2 } },          // 一次真实拖拽
        { key: { key: 'g', ctrl: true } },      // 一次真实按键
        { wait: 500 },                          // 等一会儿
        { eval: "document.querySelectorAll('.cv-group').length" },   // 读个数
      ];

    为什么需要它：一次真拖拽之外还要再插一次"按快捷键"的流程
    （框选 A,B → Ctrl+G → 框选 C,D → Ctrl+G → 跨组框选 → Ctrl+Alt+G），
    而原来只有"一次性队列"，中间插不进第二个动作——「合并分镜组」
    就是因为这个一直没在真机上验过。
  */
  const probeSteps = await cdp.evaluate(
    'const queued = window.__probeSteps ?? null; window.__probeSteps = null; return queued;',
  );
  if (Array.isArray(probeSteps) && probeSteps.length > 0) {
    const results = [];
    for (const [index, step] of probeSteps.entries()) {
      if (step?.drag !== undefined) {
        await performDrag(cdp, step.drag);
        results.push({ 第几步: index + 1, 做了什么: '拖拽', 结果: null });
      } else if (step?.key !== undefined) {
        await performKey(cdp, step.key);
        results.push({ 第几步: index + 1, 做了什么: `按键 ${String(step.key.key)}`, 结果: null });
      } else if (typeof step?.wait === 'number') {
        await sleep(step.wait);
        results.push({ 第几步: index + 1, 做了什么: `等待 ${step.wait}ms`, 结果: null });
      } else if (typeof step?.eval === 'string') {
        const value = await cdp.evaluate(step.eval);
        results.push({ 第几步: index + 1, 做了什么: '求值', 表达式: step.eval, 结果: value });
      }
    }
    await cdp.evaluate(`window.__probeStepResults = ${JSON.stringify(results)};`);
    console.log(JSON.stringify({ 分步结果: results }, null, 2));
  }

  const requestedTouchHolds = await cdp.evaluate(
    'const queued = window.__probeTouchHolds ?? null; window.__probeTouchHolds = null; return queued;',
  );
  if (Array.isArray(requestedTouchHolds)) {
    for (const hold of requestedTouchHolds) {
      if (typeof hold?.x === 'number' && typeof hold?.y === 'number') await performTouchHold(cdp, hold);
    }
  }

  if (options.evalCode) {
    const value = await cdp.evaluate(options.evalCode);
    console.log(JSON.stringify(value, null, 2));
  }

  if (options.shot) {
    /*
      `--clip` 是为了看清 canvas 里的东西：3D 视口在整屏截图里只有两三百像素宽，
      人偶站在里面只有几十像素——"看得见"和"看得出来在做什么"是两件事。
      clip 用 CSS 像素（与 getBoundingClientRect 同一套坐标），scale 负责放大。

      `--clip-selector` 是它的省事版：元素自己量，不必手抄坐标——
      手抄的坐标一旦布局动一点（多一个站位、多一行读数）就截到别处去了。
    */
    let clip = options.clip;
    if (options.clipSelector) {
      const rect = await cdp.evaluate(`
        const node = document.querySelector(${JSON.stringify(options.clipSelector)});
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      `);
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        throw new Error(`--clip-selector 量不到 ${options.clipSelector} 的尺寸`);
      }
      clip = rect;
    }
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip: { ...clip, scale: options.scale ?? 1 } } : {}),
    });
    mkdirSync(dirname(options.shot), { recursive: true });
    writeFileSync(options.shot, Buffer.from(shot.data, 'base64'));
    console.log(`截图已写入 ${options.shot}`);
  }

  /*
    `--keep` 的意思是"把**应用**留着给人工点"，不是"把探针自己挂在这里"。
    以前这行写成 `if (!options.keep) close()`，于是 --keep 跑完探针不退出
    （socket 是一个活 handle），终端一直停在那里，看着像"还在跑"。
  */
  cdp.socket.close();
} catch (error) {
  console.error(`探针失败：${error.message}`);
  if (appLog.trim()) console.error(`应用输出：\n${appLog.slice(-2000)}`);
  process.exitCode = 1;
} finally {
  if (!options.keep) {
    // 用 taskkill 连子进程一起收掉，否则渲染进程会留在后台
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    /*
      再收一次内核 worker 的孤儿。

      应用自己会回收（运行时按空闲判据收、退出时强制收），但**探针是强杀应用的**——
      taskkill 走不到应用的 before-quit，于是内核那些"监工已经走了、自己还在"的 worker
      会留下来。这不影响产品，但会让开发机攒出一堆进程（实测攒到过 8.5 GB）。
      所以探针收尾时顺手按同一条判据扫一遍：只杀父进程已经没了的。
    */
    spawn('pwsh', ['-NoProfile', '-Command', [
      '$alive = @(Get-Process -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)',
      'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\' or Name=\'electron.exe\'"',
      '  | Where-Object { $_.CommandLine -like \'*frontkernel.mjs*\' -and $alive -notcontains $_.ParentProcessId }',
      '  | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    ].join('\n')], { stdio: 'ignore' });
  } else {
    /*
      `--keep`：应用已经不再是我们的子进程（stderr/stdout 落在日志文件里，
      见上面的 openSync），这里把它从我方的进程管理里摘出去，
      探针就能干净退出，而应用继续跑。
    */
    app.unref();
    if (keepLogFd !== null) closeSync(keepLogFd);
  }
  /*
    失败时必须**主动退出**：应用一旦没了，CDP 的 socket 不会自己关闭，
    Node 会因为还握着这个 handle 而永远不退出——表现是"探针卡住、什么都不打印"。
    实测被这件事骗过两次：明明应用已经退出，却以为是"渲染很慢"，白等十几分钟。

    `--keep` 时不能这么干（那时候故意留着应用给人工点）。
  */
  if (process.exitCode !== undefined && process.exitCode !== 0 && !options.keep) {
    process.exit(process.exitCode);
  }
}
