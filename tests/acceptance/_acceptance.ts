/* ============================================================
  验收用例的公共辅助。

  为什么每个条目单独落一个指标文件：验收结论必须**能被脚本读出来**，
  而不是留在某个人的对话里。汇总脚本（`scripts/acceptance-run.mjs`）读这一目录，
  把「哪一条达标、达标时那组数字是多少」写成机器可读的报告。

  指标文件的键就是矩阵条目 id（CAN-004 / FLOW-003 / …），
  一个条目一份，互不覆盖。
   ============================================================ */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const METRICS_DIR = resolve('.data/acceptance-metrics');

export function recordAcceptance(itemId: string, detail: Record<string, unknown>): void {
  mkdirSync(METRICS_DIR, { recursive: true });
  writeFileSync(
    resolve(METRICS_DIR, `${itemId}.json`),
    `${JSON.stringify({ item: itemId, ...detail }, null, 2)}\n`,
    'utf8',
  );
}

/** 与仓库既有测试同款：一条带 command_id 的领域命令。 */
export function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:acceptance', type, payload, ...extras };
}

/** 从错误里取出领域错误码；不是领域错误时返回 '(非领域错误)'。 */
export function domainCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '(非领域错误)';
}

/** 跑一次「预期会被拒」的命令，把领域错误码取回来（顺带断言它确实抛了）。 */
export function rejectionCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return domainCode(error);
  }
  return '(未被拒绝)';
}
