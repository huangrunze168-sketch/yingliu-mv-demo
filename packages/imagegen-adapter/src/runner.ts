import { spawn } from 'node:child_process';

/** 命令执行器。抽成接口是为了让解析与错误判定可以脱离真实安装被测试。 */

export interface ImageGenRunRequest {
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface ImageGenRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ImageGenRunner {
  run(request: ImageGenRunRequest): Promise<ImageGenRunResult>;
}

export interface ProcessImageGenRunnerOptions {
  executable: string;
  cwd?: string;
  timeoutMs?: number;
}

export function createProcessImageGenRunner(options: ProcessImageGenRunnerOptions): ImageGenRunner {
  return {
    run(request: ImageGenRunRequest): Promise<ImageGenRunResult> {
      const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? 300_000;
      return new Promise<ImageGenRunResult>((resolve, reject) => {
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
          reject(new Error(`imagegen ${request.args.join(' ')} 超时（${timeoutMs}ms）`));
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
