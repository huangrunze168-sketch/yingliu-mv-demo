import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { TimelineDocumentContract } from '@qiyin/contracts';

type TimelineExportPhase = 'queued' | 'preparing' | 'rendering' | 'finalizing' | 'completed' | 'failed' | 'canceled' | 'unknown';
export interface TimelineExportState { request_id: string; project_id: string; phase: TimelineExportPhase; progress: number; created_at: string; updated_at: string; artifact_id?: string; media_type?: string; bytes?: number; file_name?: string; relative_path?: string; error?: string; }
export interface ExportMedia { artifactId: string; path: string; mediaType: string; }
export interface TimelineExportStart { requestId: string; projectId: string; workspaceDir: string; document: TimelineDocumentContract; media: Map<string, ExportMedia>; width?: number; height?: number; onComplete(outputPath: string, relativePath: string): Promise<{ artifactId: string; mediaType: string; bytes: number; fileName: string }>; }

const active = new Map<string, ChildProcess>();
const canceled = new Set<string>();
const stateFile = (workspaceDir: string, requestId: string) => resolve(workspaceDir, '.qiyin-canvas', 'exports', `${requestId}.json`);
function save(path: string, state: TimelineExportState) { mkdirSync(dirname(path), { recursive: true }); const partial = `${path}.${process.pid}.part`; writeFileSync(partial, JSON.stringify(state, null, 2), 'utf8'); renameSync(partial, path); }
export function readTimelineExport(workspaceDir: string, requestId: string): TimelineExportState | null { const path = stateFile(workspaceDir, requestId); if (!existsSync(path)) return null; try { return JSON.parse(readFileSync(path, 'utf8')) as TimelineExportState; } catch { return null; } }
function update(workspaceDir: string, state: TimelineExportState, patch: Partial<TimelineExportState>): TimelineExportState { const next = { ...state, ...patch, updated_at: new Date().toISOString() }; save(stateFile(workspaceDir, state.request_id), next); return next; }
const seconds = (ms: number) => (ms / 1000).toFixed(3);
const escapeDrawText = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'").replaceAll('%', '\\%');

export function buildTimelineFfmpegArgs(document: TimelineDocumentContract, media: Map<string, ExportMedia>, outputPath: string, width = 1280, height = 720): string[] {
  const durationMs = document.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
  if (durationMs <= 0) throw new Error('时间线为空，无法导出');
  const args = ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=30:d=${seconds(durationMs)}`];
  const inputIndex = new Map<string, number>();
  for (const clip of document.clips) {
    if (!clip.artifactId) continue;
    const item = media.get(clip.artifactId);
    if (!item) throw new Error(`时间线引用的素材不存在：${clip.label}`);
    const index = inputIndex.size + 1; inputIndex.set(clip.id, index);
    if (item.mediaType.startsWith('image/')) args.push('-loop', '1', '-framerate', '30', '-t', seconds(clip.durationMs), '-i', item.path);
    else args.push('-i', item.path);
  }
  const filters: string[] = [`[0:v]setpts=PTS-STARTPTS[base0]`];
  let video = 'base0'; let visualIndex = 0;
  for (const clip of document.clips.filter(item => item.track === 'V1' || item.track === 'V2')) {
    if (!clip.artifactId) continue;
    const item = media.get(clip.artifactId)!; if (!item.mediaType.startsWith('image/') && !item.mediaType.startsWith('video/')) continue;
    const input = inputIndex.get(clip.id)!; const prepared = `visual${visualIndex}`; const next = `video${visualIndex}`;
    const trim = item.mediaType.startsWith('video/') ? `trim=start=${seconds(clip.sourceOffsetMs)}:duration=${seconds(clip.durationMs)},` : `trim=duration=${seconds(clip.durationMs)},`;
    filters.push(`[${input}:v]${trim}setpts=PTS-STARTPTS+${seconds(clip.startMs)}/TB,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2[${prepared}]`);
    filters.push(`[${video}][${prepared}]overlay=eof_action=pass:enable='between(t,${seconds(clip.startMs)},${seconds(clip.startMs + clip.durationMs)})'[${next}]`); video = next; visualIndex += 1;
  }
  let captionIndex = 0;
  for (const clip of document.clips.filter(item => item.track === 'C1')) { const next = `caption${captionIndex}`; filters.push(`[${video}]drawtext=text='${escapeDrawText(clip.label)}':fontcolor=white:fontsize=42:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-96:enable='between(t,${seconds(clip.startMs)},${seconds(clip.startMs + clip.durationMs)})'[${next}]`); video = next; captionIndex += 1; }
  const audioLabels: string[] = [];
  let audioIndex = 0;
  for (const clip of document.clips.filter(item => item.track === 'A1' || item.track === 'A2')) {
    if (!clip.artifactId) continue; const item = media.get(clip.artifactId)!; if (!item.mediaType.startsWith('audio/') && !item.mediaType.startsWith('video/')) continue;
    const input = inputIndex.get(clip.id)!; const label = `audio${audioIndex}`; filters.push(`[${input}:a]atrim=start=${seconds(clip.sourceOffsetMs)}:duration=${seconds(clip.durationMs)},asetpts=PTS-STARTPTS,adelay=${clip.startMs}|${clip.startMs}[${label}]`); audioLabels.push(label); audioIndex += 1;
  }
  filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${seconds(durationMs)}[silence]`); audioLabels.unshift('silence');
  filters.push(`${audioLabels.map(label => `[${label}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`);
  args.push('-filter_complex', filters.join(';'), '-map', `[${video}]`, '-map', '[aout]', '-t', seconds(durationMs), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', outputPath);
  return args;
}

export function startTimelineExport(input: TimelineExportStart): TimelineExportState {
  const path = stateFile(input.workspaceDir, input.requestId); const existing = readTimelineExport(input.workspaceDir, input.requestId); if (existing) return existing;
  const now = new Date().toISOString(); let state: TimelineExportState = { request_id: input.requestId, project_id: input.projectId, phase: 'queued', progress: 0, created_at: now, updated_at: now }; save(path, state);
  const outputDir = resolve(input.workspaceDir, 'exports'); mkdirSync(outputDir, { recursive: true }); const fileName = `${input.requestId}.mp4`; const outputPath = resolve(outputDir, fileName); const relativePath = `exports/${fileName}`;
  queueMicrotask(() => {
    if (canceled.has(input.requestId)) return;
    try { state = update(input.workspaceDir, state, { phase: 'preparing', progress: 5 }); const args = buildTimelineFfmpegArgs(input.document, input.media, outputPath, input.width, input.height); state = update(input.workspaceDir, state, { phase: 'rendering', progress: 20 });
      const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); active.set(input.requestId, child); let stderr = ''; child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4000); }); child.once('error', error => { active.delete(input.requestId); if (canceled.has(input.requestId)) return; state = update(input.workspaceDir, state, { phase: 'failed', progress: 0, error: error.message }); }); child.once('close', code => { active.delete(input.requestId); if (canceled.has(input.requestId)) return; if (code !== 0) { state = update(input.workspaceDir, state, { phase: 'failed', progress: 0, error: stderr.split(/\r?\n/).filter(Boolean).at(-1) ?? `FFmpeg 退出码 ${code}` }); return; } state = update(input.workspaceDir, state, { phase: 'finalizing', progress: 95 }); void input.onComplete(outputPath, relativePath).then(result => { state = update(input.workspaceDir, state, { phase: 'completed', progress: 100, artifact_id: result.artifactId, media_type: result.mediaType, bytes: result.bytes, file_name: result.fileName, relative_path: relativePath }); }).catch(error => { state = update(input.workspaceDir, state, { phase: 'failed', progress: 0, error: error instanceof Error ? error.message : '导出收尾失败' }); }); });
    } catch (error) { state = update(input.workspaceDir, state, { phase: 'failed', progress: 0, error: error instanceof Error ? error.message : '导出启动失败' }); }
  });
  return state;
}
export function cancelTimelineExport(workspaceDir: string, requestId: string): TimelineExportState | null { const state = readTimelineExport(workspaceDir, requestId); if (!state || ['completed','failed','canceled'].includes(state.phase)) return state; canceled.add(requestId); active.get(requestId)?.kill('SIGKILL'); active.delete(requestId); return update(workspaceDir, state, { phase: 'canceled', progress: 0 }); }
export function recoverTimelineExport(workspaceDir: string, requestId: string): TimelineExportState | null { const state = readTimelineExport(workspaceDir, requestId); if (!state) return null; if (['queued','preparing','rendering','finalizing'].includes(state.phase) && !active.has(requestId)) return update(workspaceDir, state, { phase: 'unknown', error: '服务重启导致导出进程状态未知，请检查导出目录后再决定是否重试。' }); return state; }
