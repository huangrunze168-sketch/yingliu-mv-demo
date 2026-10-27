import { spawn } from 'node:child_process';

/* ============================================================
   视频生成服务 skill 的命令执行器。

   视频生成服务 的官方 skill 是个 **Python 脚本**（zerodep），所以这里的"可执行文件"
   是 `python` + 脚本路径两个东西。抽成接口是为了让解析与错误判定
   能脱离真实安装被测试（与 imagegen-adapter 的 runner 同一个理由）。

   ⚠ 这台 Windows 上 `python3` 是 Microsoft Store 的占位符（跑它会弹商店），
   真正能用的是 `python` / `py`。所以默认值给 `python`，并且**允许覆盖**。
   ============================================================ */

export interface VideogenRunRequest {
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  /** 额外的环境变量（例如这一轮才拿到的 AK/SK）。 */
  env?: Readonly<Record<string, string>>;
}

export interface VideogenRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface VideogenRunner {
  run(request: VideogenRunRequest): Promise<VideogenRunResult>;
}

export interface ProcessVideogenRunnerOptions {
  /** python 解释器（默认 `python`）。 */
  python?: string;
  /** skill 里的 `agent_skill.py` 绝对路径。 */
  scriptPath: string;
  cwd?: string;
  timeoutMs?: number;
}

export function createProcessVideogenRunner(options: ProcessVideogenRunnerOptions): VideogenRunner {
  return {
    run(request: VideogenRunRequest): Promise<VideogenRunResult> {
      const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? 300_000;
      return new Promise<VideogenRunResult>((resolve, reject) => {
        const child = spawn(
          options.python ?? 'python',
          [options.scriptPath, ...request.args],
          {
            cwd: request.cwd ?? options.cwd,
            windowsHide: true,
            env: { ...process.env, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8', ...(request.env ?? {}) },
          },
        );
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`videogen ${request.args.join(' ')} 超时（${timeoutMs}ms）`));
        }, timeoutMs);
        child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },
  };
}
