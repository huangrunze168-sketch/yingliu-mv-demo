import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { killProcessTree, reapOrphanFrontkernelWorkers } from './reap-workers.js';

/**
 * 命令执行器。
 *
 * 抽成接口是为了让适配器的解析与漂移判定可以脱离真实安装被测试——
 * 但**真实路径才是默认路径**：测试用的假执行器不得进入生产代码路径。
 */

export interface FrontkernelRunRequest {
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface FrontkernelRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface FrontkernelRunner {
  run(request: FrontkernelRunRequest): Promise<FrontkernelRunResult>;
}

export interface ProcessFrontkernelRunnerOptions {
  /**/
  distributionRoot: string;
  /** Node 可执行文件；默认沿用当前进程，保证与运行环境一致。 */
  nodePath?: string;
  /** 默认工作目录（通常是视频项目目录）。 */
  cwd?: string;
  /** 默认超时；`build` 一类长命令由调用方单独放宽。 */
  timeoutMs?: number;
}

/**
 *
 * 也避免 Windows 上把参数交给 cmd.exe 再转一层的引号陷阱。
 */
export function createProcessFrontkernelRunner(options: ProcessFrontkernelRunnerOptions): FrontkernelRunner {
  const nodePath = options.nodePath ?? process.execPath;
  /**
   * 若这段代码被嵌进 Electron 主进程运行（历史桌面壳形态），必须加
   * `ELECTRON_RUN_AS_NODE=1`。
   *
   * `process.execPath` 在 Electron 主进程里是 `electron.exe`，不是 node。
   * 不报错、不输出、也不退出，只是挂着——表现就是内核状态永远停在「启动中」，
   * 界面上只有一句「前置内核未接入」，完全看不出是启动方式用错了。
   * 加上这个环境变量，同一个可执行文件就以纯 Node 的身份运行脚本。
   * 纯 Node/Web 环境下 `process.versions.electron` 为 undefined，守卫不生效。
   */
  const electronAsNode = process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' };
  const binDir = `${options.distributionRoot.replace(/[\\/]+$/, '')}${separator(options.distributionRoot)}bin${separator(options.distributionRoot)}`;
  // 新发行版入口是 frontkernel.mjs；旧发行版是 hypit.mjs，做兼容回退。
  const launcher = existsSync(`${binDir}frontkernel.mjs`)
    ? `${binDir}frontkernel.mjs`
    : `${binDir}hypit.mjs`;

  return {
    run(request: FrontkernelRunRequest): Promise<FrontkernelRunResult> {
      const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? 120_000;
      return new Promise<FrontkernelRunResult>((resolve, reject) => {
        const child = spawn(nodePath, [launcher, ...request.args], {
          cwd: request.cwd ?? options.cwd ?? options.distributionRoot,
          windowsHide: true,
          env: { ...process.env, NO_COLOR: '1', ...electronAsNode },
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          /*
            超时必须**连子树一起收**：Windows 上 `child.kill()` 只杀直接子进程，
          */
          void killProcessTree(child.pid ?? 0).then(() => {
            void reapOrphanFrontkernelWorkers(launcher, { force: true });
            reject(new Error(`frontkernel ${request.args.join(' ')} 超时（${timeoutMs}ms）`));
          });
        }, timeoutMs);

        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        child.once('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          /*
            **这里刻意不扫**。

            第一版在这里顺手回收，结果把正在后台渲染的 worker 一起杀了——
            内核的设计就是「CLI 提交完就退出，worker 继续把这一刻渲染完」
            （界面上那句"后台 Worker 继续，可离开此页"说的就是这件事）。
            于是"父进程已经没了"根本不能当成"这是残留"，
            它更常见的意思是"它正在干活，而监工已经走了"。

            什么时候能安全回收，只有调用方知道（它知道还有没有在跑的构建）
            ——所以回收交给 main 进程在确认空闲之后再调。
          */
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },
  };
}

function separator(root: string): string {
  return root.includes('\\') ? '\\' : '/';
}
