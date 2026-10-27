import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CanvasNotInstalledError } from './errors.js';
import { createProcessCanvasRunner, type CanvasRunner } from './runner.js';
import { CanvasAdapter, type CanvasAdapterOptions } from './adapter.js';

export * from './protocol.js';
export * from './param-normalize.js';
export * from './errors.js';
export * from './runner.js';
export * from './adapter.js';
export * from './canvas.js';
export * from './backend.js';

/**
 *
 * 顺序：显式传入 → 环境变量 → 用户级默认安装目录 → 工作区内的安装目录 → PATH。
 */
export function resolveCanvasExecutable(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const fromEnv = process.env.QIYIN_CANVAS_PATH;
  if (fromEnv) candidates.push(fromEnv);
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    // LibTV CLI 1.1.3 的官方用户级安装路径优先。
    candidates.push(join(home, '.libtv', 'libtv.exe'), join(home, '.libtv', 'libtv'));
    // 兼容早期内部开发版的目录与可执行名。
    candidates.push(join(home, '.canvas', 'canvas.exe'), join(home, '.canvas', 'canvas'));
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new CanvasNotInstalledError('未找到 canvas 可执行文件', { candidates });
}

export interface CreateCanvasAdapterOptions extends CanvasAdapterOptions {
  executable?: string;
  /** 仅供测试注入；生产调用不传。 */
  runner?: CanvasRunner;
}

export function createCanvasAdapter(options: CreateCanvasAdapterOptions = {}): CanvasAdapter {
  const executable = options.executable ?? resolveCanvasExecutable();
  const runner = options.runner ?? createProcessCanvasRunner({
    executable,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return new CanvasAdapter(runner, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.longTimeoutMs === undefined ? {} : { longTimeoutMs: options.longTimeoutMs }),
  });
}
