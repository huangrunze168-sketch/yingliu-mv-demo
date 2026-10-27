import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ImageGenNotInstalledError } from './errors.js';
import { createProcessImageGenRunner, type ImageGenRunner } from './runner.js';
import { ImageGenAdapter, type ImageGenAdapterOptions } from './adapter.js';

export * from './errors.js';
export * from './runner.js';
export * from './adapter.js';
export * from './backend.js';

/**
 * 定位 imagegen 可执行文件。
 *
 * 顺序：显式传入 → 环境变量 → 用户级安装目录（本机实测是 `%USERPROFILE%\bin`）
 * → PATH 上的名字。
 */
export function resolveImageGenExecutable(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const fromEnv = process.env.QIYIN_IMAGEGEN_PATH;
  if (fromEnv) candidates.push(fromEnv);
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    candidates.push(join(home, 'bin', 'imagegen.exe'), join(home, 'bin', 'imagegen'));
    candidates.push(join(home, '.imagegen', 'imagegen.exe'), join(home, '.imagegen', 'imagegen'));
    // 兼容旧安装名
    candidates.push(join(home, 'bin', 'dreamina.exe'), join(home, 'bin', 'dreamina'));
    candidates.push(join(home, '.dreamina', 'dreamina.exe'), join(home, '.dreamina', 'dreamina'));
  }
  // 最后交给 PATH：存在性检查查不到 PATH，这里用裸名字让 spawn 自己解析
  candidates.push('imagegen.exe', 'imagegen');
  candidates.push('dreamina.exe', 'dreamina');

  for (const candidate of candidates) {
    if (
      candidate === 'imagegen' || candidate === 'imagegen.exe'
      || candidate === 'dreamina' || candidate === 'dreamina.exe'
    ) return candidate;
    if (existsSync(candidate)) return candidate;
  }
  throw new ImageGenNotInstalledError('未找到图像生成服务可执行文件', { candidates });
}

export interface CreateImageGenAdapterOptions extends ImageGenAdapterOptions {
  executable?: string;
  /** 仅供测试注入；生产调用不传。 */
  runner?: ImageGenRunner;
}

export function createImageGenAdapter(options: CreateImageGenAdapterOptions = {}): ImageGenAdapter {
  const executable = options.executable ?? resolveImageGenExecutable();
  const runner = options.runner ?? createProcessImageGenRunner({
    executable,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return new ImageGenAdapter(runner, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.longTimeoutMs === undefined ? {} : { longTimeoutMs: options.longTimeoutMs }),
  });
}
