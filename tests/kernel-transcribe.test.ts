import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { FrontkernelAdapter, type FrontkernelRunner } from '@qiyin/frontkernel-adapter';
import { KernelService, parseFrontkernelTranscript, type KernelTranscribeRequest } from '@qiyin/kernel-service';

const folders: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const transcript = () => ({ format: 'frontkernel.transcript@1', source: '/private/audio.wav', language: 'zh', audio_seconds: 2, passages: [{ text: '你好', start_seconds: 0, end_seconds: 1, words: [{ text: '你好', start_seconds: 0, end_seconds: 1 }] }] });
function folder() { const path = mkdtempSync(join(tmpdir(), 'qiyin-transcribe-security-')); folders.push(path); return path; }
function setup(workspaceDir = folder(), fail = false) {
  writeFileSync(join(workspaceDir, 'input.wav'), '假媒体，不运行实际转录');
  const projects = new ProjectService(openDatabase(':memory:'));
  const projectId = projects.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '安全测试', max_budget_cents: 100, rights_confirmed: true } }).project_id!;
  projects.execute({ command_id: randomUUID(), actor: 'user:test', type: 'gate.approve', project_id: projectId, expected_revision: 1, payload: { gate: 'G0' } });
  const run = vi.fn<FrontkernelRunner['run']>(async (request) => {
    if (fail) throw new Error(`无法读取 ${join(workspaceDir, 'private.json')}`);
    const path = request.args[request.args.indexOf('--to') + 1]!;
    writeFileSync(path, JSON.stringify({ ...transcript(), source: join(workspaceDir, 'input.wav'), extra: workspaceDir }));
    return { code: 0, stderr: '', stdout: JSON.stringify({ format: 'frontkernel.video-cli-transcribe@1', source: join(workspaceDir, 'input.wav'), language: 'zh', audio_seconds: 2, extracted: false, passages: 1, words: 1, path, extra: workspaceDir }) };
  });
  const kernel = new KernelService(projects, new FrontkernelAdapter({ run }));
  const request: KernelTranscribeRequest = { workspaceDir, projectId, expectedRevision: 2, mediaPath: 'input.wav', language: 'zh', executionConfirmed: true };
  return { projects, kernel, request, run };
}

describe('转录授权与磁盘边界', () => {
  it.each([undefined, false, 'true', 1, null])('拒绝非显式授权 %s，且不登记任务', (executionConfirmed) => {
    const { kernel, request, projects, run } = setup();
    expect(() => kernel.transcribeSource({ ...request, executionConfirmed } as KernelTranscribeRequest)).toThrow('显式确认');
    expect(run).not.toHaveBeenCalled();
    expect(projects.listKernelTasks(request.projectId)).toHaveLength(0);
  });
  it.each(['../outside.wav', '..\\outside.wav', '/outside.wav', 'C:\\outside.wav', 'C:outside.wav', 'input.wav:stream'])('拒绝越界路径 %s', (mediaPath) => {
    const { kernel, request, run } = setup();
    expect(() => kernel.transcribeSource({ ...request, mediaPath })).toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['media', 'output'])('拒绝 %s 目录 junction', (kind) => {
    const { kernel, request, run } = setup();
    const outside = folder();
    writeFileSync(join(outside, 'input.wav'), '外部文件');
    symlinkSync(outside, join(request.workspaceDir, kind === 'media' ? 'linked' : 'transcripts'), 'junction');
    expect(() => kernel.transcribeSource({ ...request, mediaPath: kind === 'media' ? 'linked/input.wav' : 'input.wav' })).toThrow('符号链接');
    expect(run).not.toHaveBeenCalled();
  });
  it('持久报告与 transcript 文件不保留官方绝对 source/path 或未知元数据', async () => {
    const { kernel, request, projects } = setup();
    const result = await kernel.transcribeSource(request);
    expect(result.executed).toBe(true);
    expect(result.report?.command.source).toBe('input.wav');
    expect(result.report?.transcript.source).toBe('input.wav');
    const stored = JSON.stringify(projects.listKernelTasks(request.projectId));
    expect(stored).not.toContain(JSON.stringify(request.workspaceDir).slice(1, -1));
    const file = readFileSync(join(request.workspaceDir, result.report!.transcriptRelativePath), 'utf8');
    expect(JSON.parse(file).source).toBe('input.wav');
    expect(JSON.parse(file)).not.toHaveProperty('extra');
  });
  it('失败报告不持久化原始文件系统路径', async () => {
    const { kernel, request, projects } = setup(undefined, true);
    const result = await kernel.transcribeSource(request);
    expect(result.executed).toBe(false);
    expect(JSON.stringify(projects.listKernelTasks(request.projectId))).not.toContain('private.json');
  });
  it('同毫秒同工作区并发调用输出独立，不覆盖文件', async () => {
    const workspace = folder();
    const a = setup(workspace), b = setup(workspace);
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const results = await Promise.all([a.kernel.transcribeSource(a.request), b.kernel.transcribeSource(b.request)]);
    expect(results.every((result) => result.executed)).toBe(true);
    expect(new Set(results.map((result) => result.report!.transcriptRelativePath)).size).toBe(2);
  });
});

describe('官方逐词协议验证', () => {
  it.each([null, true, 42, 'text', []])('非法根节点 %s 是契约错误而非 TypeError', (root) => {
    expect(() => parseFrontkernelTranscript(JSON.stringify(root))).toThrow(/frontkernel.transcript@1/u);
  });
  it.each([-1, null, '1', Infinity])('拒绝非法 audio_seconds %s', (audio_seconds) => {
    expect(() => parseFrontkernelTranscript(JSON.stringify({ ...transcript(), audio_seconds }))).toThrow();
  });
  it.each(['passage', 'word'])('拒绝 %s 非法及倒序时间', (kind) => {
    for (const values of [{ start_seconds: -1 }, { end_seconds: null }, { start_seconds: '0' }, { start_seconds: 2, end_seconds: 1 }, { end_seconds: Infinity }]) {
      const data = transcript();
      Object.assign(kind === 'passage' ? data.passages[0]! : data.passages[0]!.words[0]!, values);
      expect(() => parseFrontkernelTranscript(JSON.stringify(data))).toThrow();
    }
  });
  it('保留官方可选 score，拒绝无效置信度和空词节点', () => {
    const data = transcript();
    Object.assign(data.passages[0]!.words[0]!, { score: 0.9 });
    expect(parseFrontkernelTranscript(JSON.stringify(data)).passages[0]!.words[0]).toHaveProperty('score', 0.9);
    for (const word of [null, true, 1, '词', { text: '词', score: '0.9' }]) {
      expect(() => parseFrontkernelTranscript(JSON.stringify({ ...transcript(), passages: [{ text: '词', words: [word] }] }))).toThrow();
    }
  });
  it('允许官方无法对齐的词缺省时间和空段列表', () => {
    expect(parseFrontkernelTranscript(JSON.stringify({ ...transcript(), passages: [{ text: '词', words: [{ text: '词' }] }] })).passages[0]!.words[0]).toEqual({ text: '词' });
    expect(parseFrontkernelTranscript(JSON.stringify({ ...transcript(), passages: [] })).passages).toEqual([]);
  });
});
