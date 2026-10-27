import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acknowledgeUnknownCreativeRun, readCreativeRun, saveCreativeRun } from '../apps/local-api/src/agent/creative-run-state.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const workspace = () => { const dir = mkdtempSync(join(tmpdir(), 'qiyin-run-')); roots.push(dir); return dir; };

it('运行状态持久化且不写提示词或密钥，终态不被迟到回调覆盖', () => {
  const dir = workspace();
  const id = 'session-1';
  saveCreativeRun(dir, id, 'message-1', 'starting');
  saveCreativeRun(dir, id, 'message-1', 'running', 'run-1');
  expect(readCreativeRun(dir, id, 'message-1')).toMatchObject({ phase: 'running', runId: 'run-1' });
  saveCreativeRun(dir, id, 'message-1', 'unknown');
  saveCreativeRun(dir, id, 'message-1', 'completed');
  expect(readCreativeRun(dir, id, 'message-1')).toMatchObject({ phase: 'unknown', runId: 'run-1' });
  const reviewed = acknowledgeUnknownCreativeRun(dir, id, 'message-1');
  expect(reviewed).toMatchObject({ phase: 'unknown', reviewedAt: expect.any(Number) });
  expect(acknowledgeUnknownCreativeRun(dir, id, 'message-1')?.reviewedAt).toBe(reviewed?.reviewedAt);
  expect(acknowledgeUnknownCreativeRun(dir, id, 'message-2')).toBeNull();
  const file = join(dir, '.qiyin-agent', 'creative-runs', readdirSync(join(dir, '.qiyin-agent', 'creative-runs'))[0]!);
  const stored = readFileSync(file, 'utf8');
  expect(stored).not.toContain('API_KEY');
  expect(stored).not.toContain('prompt');
  expect(readCreativeRun(dir, id, 'message-2')).toBeNull();
});

it('路径遍历 ID 无法创建工作目录外的运行文件', () => {
  const dir = workspace();
  expect(() => saveCreativeRun(dir, '../outside', 'message', 'starting')).toThrow('标识不合法');
  expect(() => saveCreativeRun(dir, 'session', 'x'.repeat(121), 'starting')).toThrow('标识不合法');
  const record = saveCreativeRun(dir, 'session', '../unicode-企图', 'running');
  expect(record.phase).toBe('running');
  expect(readdirSync(join(dir, '.qiyin-agent', 'creative-runs'))).toHaveLength(1);
});
