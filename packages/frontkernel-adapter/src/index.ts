import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrontkernelNotInstalledError } from './errors.js';
import { createProcessFrontkernelRunner, type FrontkernelRunner } from './runner.js';
import { FrontkernelAdapter, type FrontkernelAdapterOptions } from './adapter.js';

export * from './protocol.js';
export * from './errors.js';
export * from './runner.js';
export * from './adapter.js';
export * from './reap-workers.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 候选路径列表。
 *
 * 抽成纯函数是为了能测：定位失败在界面上的表现只是「前置内核未接入」，
 * 看不出是路径算错了，也不该靠人去数「往上四级」。
 *
 * 为什么不能写死「往上四级」：这段代码可能被构建进不同层级的目标目录，
 * 那时 `HERE` 深处仓库好几层，往上四级可能是**用户目录**，
 * 而不是仓库所在的目录——于是开发时能跑、打成包就找不到内核。
 * 实测就是这么翻车的：界面上一直显示「前置内核未接入」，
 * 而命令行那条路（不打包、HERE 在 packages/ 下）却是好的。
 * 所以改成**逐级向上找**，两种布局都能命中。
 */
export function frontkernelDistributionCandidates(
  here: string,
  env: string | undefined,
  resourcesPath: string | undefined,
): string[] {
  const candidates: string[] = [];
  if (env) candidates.push(resolve(env));
  /**/
  let cursor = resolve(here);
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(cursor, 'vendor', 'frontkernel'));
    candidates.push(join(cursor, 'frontkernel-source'));
    // 兼容旧安装目录名
    candidates.push(join(cursor, 'vendor', 'hypit'));
    candidates.push(join(cursor, 'hypit-source'));
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  if (resourcesPath) candidates.push(join(resourcesPath, 'frontkernel'));
  return candidates;
}

/**
 * 定位 前置内核 发行版。
 *
 * 环境变量 QIYIN_前置内核_ROOT 优先，便于指向别的检出。
 */
export function resolveFrontkernelDistribution(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) {
    candidates.push(resolve(explicit));
  } else {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    candidates.push(...frontkernelDistributionCandidates(HERE, process.env.QIYIN_FRONTKERNEL_ROOT, resourcesPath));
  }
  for (const candidate of candidates) {
    const hasNewLauncher = existsSync(join(candidate, 'bin', 'frontkernel.mjs'));
    // 兼容旧发行版的入口文件名
    const hasLegacyLauncher = existsSync(join(candidate, 'bin', 'hypit.mjs'));
    if ((hasNewLauncher || hasLegacyLauncher) && existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  throw new FrontkernelNotInstalledError('未找到视频内核发行版（缺少 bin/frontkernel.mjs）', { candidates });
}

export interface CreateFrontkernelAdapterOptions {
  distributionRoot?: string;
  cwd?: string;
  timeoutMs?: number;
  longTimeoutMs?: number;
  /** 仅供测试注入；生产调用不传，走真实子进程。 */
  runner?: FrontkernelRunner;
}

/** 按默认布局创建适配器。 */
export function createFrontkernelAdapter(options: CreateFrontkernelAdapterOptions = {}): FrontkernelAdapter {
  const distributionRoot = options.distributionRoot ?? resolveFrontkernelDistribution();
  const runner = options.runner ?? createProcessFrontkernelRunner({
    distributionRoot,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const adapterOptions: FrontkernelAdapterOptions = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.longTimeoutMs === undefined ? {} : { longTimeoutMs: options.longTimeoutMs }),
  };
  return new FrontkernelAdapter(runner, adapterOptions);
}
