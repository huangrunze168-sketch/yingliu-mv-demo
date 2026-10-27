/* ============================================================
  CLI-006「声明并暴露 CLI 能力边界」。

  矩阵的验收口径两条，两条都能量，所以这一组用例也两条主线：

    ① 「Manifest **覆盖全部已发布命令**」——把 `index.ts` 里的 `case` 列表
       抠出来，和 manifest 逐条比对。任何新增命令忘了写进清单就会红。
    ② 「越界命令返回**稳定错误码**率 100%」——判定逻辑抽成纯函数在这里测，
       真实进程的退出码与 stderr/stdout 由 `.data/verify-cli-manifest.mjs` 跑。

  为什么扫源码而不是"信任 manifest 自己"：这份清单的价值全在"和实现一致"上，
  一份自己说自己很全的清单等于没有。
  ============================================================ */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLI_COMMANDS, CLI_ERROR_CODES, CLI_LIMITS, findCommand, unknownCommandResponse,
} from '../apps/cli/src/manifest.js';

const source = readFileSync(new URL('../apps/cli/src/index.ts', import.meta.url), 'utf8');

/** 从源码里抠出 `switch (action)` 的 case 分支（到 default 之前）。 */
function extractedCases(): Map<string, string> {
  const switchAt = source.indexOf('switch (action)');
  const body = source.slice(switchAt);
  const end = body.indexOf('\n    default:');
  const scoped = end === -1 ? body : body.slice(0, end);
  const branches = new Map<string, string>();
  const pattern = /case '([^']+)':/g;
  const matches = [...scoped.matchAll(pattern)];
  matches.forEach((match, index) => {
    const from = match.index ?? 0;
    const to = index + 1 < matches.length ? (matches[index + 1]?.index ?? scoped.length) : scoped.length;
    branches.set(match[1] as string, scoped.slice(from, to));
  });
  return branches;
}

/**
 * 一条分支里出现的 `required('--x')` 参数名（去重）。
 *
 * 去重是必须的：`--workspace` 这类参数在源码里会出现在多处
 * 不去重就会把"同一个必填参数"数成两个，和清单对不上。
 */
function requiredArgs(branch: string): string[] {
  const names = [...branch.matchAll(/required\('(--[a-z-]+)'\)/g)].map((match) => match[1] as string);
  return [...new Set(names)].sort();
}

describe('Manifest 覆盖全部已发布命令', () => {
  it('源码里的每个 case 都在 manifest 里，manifest 里的每个命令也都有实现', () => {
    const fromSource = [...extractedCases().keys()].sort();
    const fromManifest = CLI_COMMANDS.map((command) => command.name).sort();
    expect(fromManifest).toEqual(fromSource);
  });

  it('命令名不重复', () => {
    const names = CLI_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('每条命令声明的必填参数，与源码里 required() 的一致', () => {
    const mismatched: Array<{ 命令: string; 源码: string[]; 清单: string[] }> = [];
    for (const [name, branch] of extractedCases()) {
      const spec = findCommand(name);
      if (spec === undefined) continue;
      const actual = requiredArgs(branch);
      const declared = [...spec.requires].sort();
      if (actual.join(',') !== declared.join(',')) {
        mismatched.push({ 命令: name, 源码: actual, 清单: declared });
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('每条命令都有用途说明；付费路径被标出来', () => {
    for (const command of CLI_COMMANDS) {
      expect(command.summary.trim().length).toBeGreaterThan(4);
    }
    const paid = CLI_COMMANDS.filter((command) => command.paid).map((command) => command.name).sort();
    /* 这台机器上只有这两条会真的花钱（转录是外部服务、出图与视频是生成后端） */
    expect(paid).toEqual(['image:generate', 'kernel:transcribe', 'video:generate'].sort());
  });

  it('"明确不做什么"至少写在关键路径上（矩阵要的是边界，不是参数表）', () => {
    const withRefusals = CLI_COMMANDS.filter((command) => command.refuses.length > 0).map((command) => command.name);
    for (const name of ['image:generate', 'video:generate', 'source:register', 'kernel:transcribe', 'command']) {
      expect(withRefusals).toContain(name);
    }
    /* 付费命令必须说清代价相关的边界 */
    expect(findCommand('image:generate')?.refuses.join(' ')).toContain('预算');
    expect(findCommand('video:generate')?.refuses.join(' ')).toContain('选首帧');
  });

  it('整体边界里写明"不绕过领域层"与"不隐藏失败"', () => {
    const all = CLI_LIMITS.join('\n');
    expect(all).toContain('不绕过领域层');
    expect(all).toContain('不隐藏失败');
  });
});

describe('越界命令的稳定错误码', () => {
  it('不认识的命令：码固定、带回原样输入、列出可用命令', () => {
    const response = unknownCommandResponse('image:genrate');
    expect(response.error.code).toBe('CLI_UNKNOWN_COMMAND');
    expect(response.error.code).toBe(CLI_ERROR_CODES.unknownCommand);
    expect(response.error.received).toBe('image:genrate');
    expect(response.error.message).toContain('image:genrate');
    expect(response.error.available).toContain('image:generate');
    expect(response.error.available.length).toBe(CLI_COMMANDS.length);
  });

  it('没给命令（空参数）也走同一个码，只是 received 为空', () => {
    for (const empty of [null, '']) {
      const response = unknownCommandResponse(empty);
      expect(response.error.code).toBe('CLI_UNKNOWN_COMMAND');
      expect(response.error.received).toBeNull();
    }
  });

  it('每一种越界都返回同一个码——这就是"稳定"的意思', () => {
    const samples = ['', 'nope', 'IMAGE:GENERATE', 'image:generate ', '--help', '帮助', 'project:delete'];
    const codes = new Set(samples.map((sample) => unknownCommandResponse(sample).error.code));
    expect([...codes]).toEqual(['CLI_UNKNOWN_COMMAND']);
  });

  it('响应 schema 固定，脚本可以按它解析', () => {
    expect(unknownCommandResponse('x').schema).toBe('replica.cli-error@1');
  });

  it('findCommand 大小写敏感且不吃空格（避免"看起来能用"的别名）', () => {
    expect(findCommand('project:list')?.name).toBe('project:list');
    expect(findCommand('Project:List')).toBeUndefined();
    expect(findCommand(' project:list')).toBeUndefined();
    expect(findCommand(undefined)).toBeUndefined();
    expect(findCommand('')).toBeUndefined();
    expect(findCommand('capabilities')?.name).toBe('capabilities');
  });
});
