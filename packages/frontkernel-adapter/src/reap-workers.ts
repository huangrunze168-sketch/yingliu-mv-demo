import { spawn } from 'node:child_process';

/* ============================================================
   回收内核留下的孤儿 worker。
   ------------------------------------------------------------
   它们**并不总是退出**；我们的调用超时/被强杀时更是必然留下。
   Windows 杀父进程不会连带杀子进程，于是它们变成孤儿，一个约 130MB。

   这台机器上的一次实测：攒了 **71 个**孤儿 worker，合计 **8.5 GB** 内存。
   那已经足以让系统开始杀别的进程（那一轮应用莫名消失，很可能就是内存压力）。

   所以：我们启的内核，它的残留由我们收。两条规矩：

     · **只杀"父进程已经不在了"的 worker**——正在跑的构建用着的 worker，父进程还活着，
       绝不能碰（否则会把用户正在跑的渲染打断）；
     · 只认我们自己那份发行版路径（command line 里带这个 launcher 的才算我们的）。
   ============================================================ */

export interface ReapResult {
  killed: number[];
  /** 查询本身失败的原因（环境不允许查询进程表时不该让调用方崩） */
  reason: string | null;
}

/**
 * 两次回收之间的最小间隔。
 *
 * 查一次进程表要起一个 PowerShell（几百毫秒），而内核操作可能很密集，
 * 所以节流；`force` 时不受此限（退出前那一次必须真的执行）。
 */
const MIN_INTERVAL_MS = 30_000;
let lastReapAt = 0;

/**
 *
 * 只在 Windows 上实现：这是产品要打的平台，也是实测出问题的平台。
 * 其它平台返回 `{ killed: [], reason: '非 Windows 平台' }`——**不假装做了**。
 */
export function reapOrphanFrontkernelWorkers(launcher: string, options: { force?: boolean } = {}): Promise<ReapResult> {
  if (process.platform !== 'win32') {
    return Promise.resolve({ killed: [], reason: '非 Windows 平台：本机没有实现进程表查询' });
  }
  const now = Date.now();
  if (options.force !== true && now - lastReapAt < MIN_INTERVAL_MS) {
    return Promise.resolve({ killed: [], reason: null });
  }
  lastReapAt = now;

  /*
    PowerShell 而不是 wmic：wmic 在新版 Windows 上已被移除。
    判据两道：命令行里有我们这个 launcher，且父进程 id 不在存活进程集合里。
  */
  const script = [
    '$alive = @(Get-Process -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)',
    `Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='electron.exe'"`,
    `  | Where-Object { $_.CommandLine -like '*${launcher.replace(/'/g, "''")}*' -and $_.CommandLine -like '*_worker*' -and $alive -notcontains $_.ParentProcessId }`,
    '  | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }',
  ].join('\n');

  return new Promise<ReapResult>((resolve) => {
    const child = spawn('pwsh', ['-NoProfile', '-Command', script], { windowsHide: true });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.once('error', (error) => resolve({ killed: [], reason: error.message }));
    child.once('close', () => {
      const killed = stdout
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      resolve({ killed, reason: null });
    });
  });
}

/** 子进程被杀（超时/中断）时，把它的整棵子树一起收掉。 */
export function killProcessTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ }
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    /* `taskkill /T` 是这里唯一可靠的做法：Windows 上杀父不连带子 */
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}
