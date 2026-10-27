import { spawn } from 'node:child_process';

/**
 * 命令执行器。
 *
 * 抽成接口是为了让解析与错误判定可以脱离真实安装被测试；
 */

export interface CanvasRunRequest {
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface CanvasRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CanvasRunner {
  run(request: CanvasRunRequest): Promise<CanvasRunResult>;
}

export interface ProcessCanvasRunnerOptions {
  /**/
  executable: string;
  /**/
  cwd?: string;
  timeoutMs?: number;
}

export function createProcessCanvasRunner(options: ProcessCanvasRunnerOptions): CanvasRunner {
  return {
    run(request: CanvasRunRequest): Promise<CanvasRunResult> {
      const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? 180_000;
      return new Promise<CanvasRunResult>((resolve, reject) => {
        const child = spawn(options.executable, [...request.args], {
          cwd: request.cwd ?? options.cwd,
          windowsHide: true,
          env: { ...process.env, NO_COLOR: '1' },
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`LibTV CLI 调用超时（${timeoutMs}ms）；任务结果与费用未知，请核对目标画布和账户记录后再决定是否重试。`));
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
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },
  };
}
