import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { VideogenAdapter } from './adapter.js';
import { createVideogenBackend, type VideogenBackendOptions } from './backend.js';
import { createProcessVideogenRunner, type VideogenRunner } from './runner.js';

export * from './errors.js';
export * from './runner.js';
export * from './adapter.js';
export * from './backend.js';

/* ============================================================
  期音科技 · 视频生成服务 适配器入口
   ------------------------------------------------------------
   它是个**官方 skill 包**（`videogenai/videogen-skill`），装法有三条（官方 README）：

     OpenClaw   npx skills add videogenai/videogen-skill
     Hermes     复制到 ~/.hermes/skills/design/videogen-api
     手动       clone 下来直接用

   三条装法装的是**同一份文件**，所以这里按"脚本在哪"找，而不是按"用哪条装法"。
   找不到时**返回 null 并说清找过哪些位置**——不猜一个路径然后报一个看不懂的错。
   ============================================================ */

const SCRIPT_NAME = join('scripts', 'agent_skill.py');

/** 这些是官方那三条装法会落到的位置（按可能性排序）。 */
export function videogenScriptCandidates(): string[] {
  const home = homedir();
  return [
    resolve(home, '.hermes/skills/design/videogen-api', SCRIPT_NAME),
    resolve(home, '.hermes/skills/design/videogen-skill', SCRIPT_NAME),
    resolve(home, '.openclaw/skills/videogen-skill', SCRIPT_NAME),
    resolve(process.cwd(), 'skills/videogen-skill', SCRIPT_NAME),
  ];
}

/**
 * 找 `agent_skill.py`。
 *
 * 顺序：显式给出 → 环境变量 `VIDEOGEN_SKILL_SCRIPT` → 那三条装法的默认位置。
 * 都没有就返回 null（调用方据此给出"怎么装"的提示）。
 */
export function resolveVideogenScript(explicit?: string): string | null {
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return resolve(explicit);
  const fromEnv = process.env.VIDEOGEN_SKILL_SCRIPT;
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return resolve(fromEnv);
  for (const candidate of videogenScriptCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface CreateVideogenAdapterOptions {
  /** 直接给脚本路径；不给就按 resolve视频生成服务Script 找。 */
  scriptPath?: string;
  /** python 解释器（这台 Windows 上要用 `python`，`python3` 是商店占位符）。 */
  python?: string;
  accessKey?: string;
  secretKey?: string;
  cwd?: string;
  timeoutMs?: number;
  /** 仅供测试注入。 */
  runner?: VideogenRunner;
}

export function createVideogenAdapter(options: CreateVideogenAdapterOptions = {}): VideogenAdapter | null {
  const scriptPath = options.runner === undefined
    ? (options.scriptPath ?? resolveVideogenScript())
    : (options.scriptPath ?? 'videogen-skill');
  if (scriptPath === null) return null;
  const runner = options.runner ?? createProcessVideogenRunner({
    scriptPath,
    ...(options.python === undefined ? {} : { python: options.python }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return new VideogenAdapter({
    runner,
    ...(options.accessKey === undefined ? {} : { accessKey: options.accessKey }),
    ...(options.secretKey === undefined ? {} : { secretKey: options.secretKey }),
    ...(options.timeoutMs === undefined ? {} : { defaultTimeoutMs: options.timeoutMs }),
  });
}

export function createVideogenBackendFromOptions(
  options: CreateVideogenAdapterOptions & VideogenBackendOptions = {},
) {
  const adapter = createVideogenAdapter(options);
  if (adapter === null) {
    throw new Error(
      '没找到 视频生成服务 skill 的 agent_skill.py。装法三选一：'
        + 'npx skills add videogenai/videogen-skill / 复制到 ~/.hermes/skills/design/videogen-api / '
        + 'clone 下来后用 VIDEOGEN_SKILL_SCRIPT 指向它',
    );
  }
  return createVideogenBackend(adapter, options);
}
