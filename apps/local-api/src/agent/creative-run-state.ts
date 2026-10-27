import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidSessionId } from './agent-sessions.js';

export type CreativeRunPhase = 'starting' | 'running' | 'completed' | 'failed' | 'canceled' | 'unknown';
export interface CreativeRunState {
  sessionId: string;
  messageId: string;
  runId: string | null;
  phase: CreativeRunPhase;
  updatedAt: number;
  /** 用户已明确知晓本轮结果和费用仍未知；不表示供应商账单已核实。 */
  reviewedAt?: number;
}

/** 仅存运行事实，不保存提示词、服务商密钥或原始响应。文件名使用哈希，杜绝消息 ID 路径穿越。 */
function runPath(workspaceDir: string, sessionId: string, messageId: string): string {
  if (!isValidSessionId(sessionId) || typeof messageId !== 'string' || messageId.length < 1 || messageId.length > 120) {
    throw new Error('创作运行标识不合法');
  }
  const digest = createHash('sha256').update(`${sessionId}\0${messageId}`).digest('hex');
  return join(workspaceDir, '.qiyin-agent', 'creative-runs', `${digest}.json`);
}

const phases = new Set<CreativeRunPhase>(['starting', 'running', 'completed', 'failed', 'canceled', 'unknown']);
const terminal = new Set<CreativeRunPhase>(['completed', 'failed', 'canceled', 'unknown']);

export function readCreativeRun(workspaceDir: string, sessionId: string, messageId: string): CreativeRunState | null {
  try {
    const record = JSON.parse(readFileSync(runPath(workspaceDir, sessionId, messageId), 'utf8')) as CreativeRunState;
    if (record.sessionId !== sessionId || record.messageId !== messageId || !phases.has(record.phase)
      || (record.runId !== null && typeof record.runId !== 'string') || !Number.isFinite(record.updatedAt)
      || (record.reviewedAt !== undefined && !Number.isFinite(record.reviewedAt))) return null;
    return record;
  } catch { return null; }
}

/** 一轮只能从运行态进入终态；结束后来的迟到回调不可把状态改成成功。 */
export function saveCreativeRun(
  workspaceDir: string, sessionId: string, messageId: string, phase: CreativeRunPhase, runId: string | null = null,
): CreativeRunState {
  const path = runPath(workspaceDir, sessionId, messageId);
  const previous = readCreativeRun(workspaceDir, sessionId, messageId);
  if (previous && terminal.has(previous.phase)) return previous;
  const record: CreativeRunState = { sessionId, messageId, runId: runId ?? previous?.runId ?? null, phase, updatedAt: Date.now() };
  return writeRunRecord(workspaceDir, path, record);
}

/** 用户确认知晓「未知」事实后才能继续下一轮；不篡改上轮的未知状态。 */
export function acknowledgeUnknownCreativeRun(workspaceDir: string, sessionId: string, messageId: string): CreativeRunState | null {
  const path = runPath(workspaceDir, sessionId, messageId);
  const previous = readCreativeRun(workspaceDir, sessionId, messageId);
  if (previous?.phase !== 'unknown') return null;
  if (previous.reviewedAt) return previous;
  return writeRunRecord(workspaceDir, path, { ...previous, reviewedAt: Date.now(), updatedAt: Date.now() });
}

function writeRunRecord(workspaceDir: string, path: string, record: CreativeRunState): CreativeRunState {
  const dir = join(workspaceDir, '.qiyin-agent', 'creative-runs');
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temp, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return record;
}
