import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Asset, GenerationJob, Shot, TimelineDocument, TimelineExportJob, TimelineTrack } from '../../ports/index.js';
import { ports } from '../../app/useAppData.js';
import { moveTimelineClip, removeTimelineClip, slipTimelineClip, splitTimelineClip, TIMELINE_TRACKS, timelineFromShots, trimTimelineClip } from './timelineDocument.js';

type Tool = 'move' | 'trim' | 'slip' | 'split';
const PX_PER_SECOND = 42;
const TRACK_LABELS: Record<TimelineTrack, string> = { C1: '字幕', V2: '叠加', V1: '主画面', A1: '对白', A2: '音乐' };

export function TimelineEditor({ projectId, shots, jobs, assets }: { projectId: string; shots: Shot[]; jobs: GenerationJob[]; assets: Asset[] }) {
  const [document, setDocument] = useState<TimelineDocument>(() => timelineFromShots(shots));
  const [revision, setRevision] = useState<number | null>(null);
  const [documentRevision, setDocumentRevision] = useState<number | null>(null);
  const [exportJob, setExportJob] = useState<TimelineExportJob | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('move');
  const [status, setStatus] = useState('正在载入时间线…');
  const history = useRef<string[]>([]);
  const dirty = useRef(false);
  const assetUrls = useMemo(() => new Map(assets.filter(asset => asset.previewUrl).map(asset => [asset.id, asset.previewUrl!])), [assets]);

  useEffect(() => {
    let active = true;
    void ports.timeline.load(projectId).then(snapshot => {
      if (!active) return;
      setDocument(snapshot.document ?? timelineFromShots(shots)); setRevision(snapshot.projectRevision); setDocumentRevision(snapshot.documentRevision); setStatus(snapshot.document ? '已载入时间线' : '尚未保存'); history.current = []; dirty.current = false;
    }).catch(error => { if (active) setStatus(error instanceof Error ? error.message : '时间线载入失败'); });
    return () => { active = false; };
  }, [projectId, shots]);

  useEffect(() => {
    if (!dirty.current || revision === null) return;
    const snapshot = document;
    const handle = window.setTimeout(() => {
      setStatus('正在保存…'); dirty.current = false;
      void ports.timeline.save(projectId, revision, snapshot).then(result => { setRevision(result.projectRevision); setDocumentRevision(result.documentRevision); setStatus('已保存'); }).catch(error => { dirty.current = true; setStatus(error instanceof Error ? error.message : '保存失败'); });
    }, 260);
    return () => window.clearTimeout(handle);
  }, [document, projectId, revision]);

  useEffect(() => {
    if (!exportJob || !['queued', 'preparing', 'rendering', 'finalizing'].includes(exportJob.phase)) return;
    const handle = window.setTimeout(() => { void ports.timeline.exportStatus(projectId, exportJob.requestId).then(setExportJob).catch(error => setStatus(error instanceof Error ? error.message : '导出状态读取失败')); }, 500);
    return () => window.clearTimeout(handle);
  }, [exportJob, projectId]);

  useEffect(() => { if (exportJob?.phase === 'completed') setStatus('真实 MP4 导出完成'); else if (exportJob?.phase === 'canceled') setStatus('导出已取消'); else if (exportJob?.phase === 'failed') setStatus(exportJob.error ?? '导出失败'); }, [exportJob]);

  const durationMs = useMemo(() => document.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0), [document.clips]);
  const selected = document.clips.find(clip => clip.id === selectedId) ?? null;
  const commit = (next: TimelineDocument) => {
    if (next === document || JSON.stringify(next) === JSON.stringify(document)) return;
    history.current = [...history.current.slice(-49), JSON.stringify(document)]; dirty.current = true; setDocument(next);
  };
  const undo = () => { const previous = history.current.pop(); if (!previous) return; dirty.current = true; setDocument(JSON.parse(previous) as TimelineDocument); setStatus('已撤销'); };
  const cycleTrack = (direction: -1 | 1) => { if (!selected) return; const index = TIMELINE_TRACKS.indexOf(selected.track); commit(moveTimelineClip(document, selected.id, TIMELINE_TRACKS[Math.max(0, Math.min(TIMELINE_TRACKS.length - 1, index + direction))]!, selected.startMs)); };
  const nudge = (deltaMs: number) => { if (!selected) return; if (tool === 'move') commit(moveTimelineClip(document, selected.id, selected.track, selected.startMs + deltaMs)); else if (tool === 'trim') commit(trimTimelineClip(document, selected.id, deltaMs < 0 ? 'start' : 'end', deltaMs)); else if (tool === 'slip') commit(slipTimelineClip(document, selected.id, deltaMs)); else commit(splitTimelineClip(document, selected.id, selected.startMs + Math.round(selected.durationMs / 2), `clip-${crypto.randomUUID()}`)); };
  const removeSelected = () => { if (!selected) return; commit(removeTimelineClip(document, selected.id)); setSelectedId(null); };
  const pointerEdit = (clipId: string, mode: 'trim-start' | 'trim-end' | 'slip', event: ReactPointerEvent) => {
    event.stopPropagation(); const startX = event.clientX;
    const finish = (up: PointerEvent) => { const deltaMs = Math.round(((up.clientX - startX) / PX_PER_SECOND * 1000) / 100) * 100; if (!deltaMs) return; if (mode === 'slip') commit(slipTimelineClip(document, clipId, deltaMs)); else commit(trimTimelineClip(document, clipId, mode === 'trim-start' ? 'start' : 'end', deltaMs)); };
    window.addEventListener('pointerup', finish, { once: true });
  };
  const dropClip = (track: TimelineTrack, event: DragEvent<HTMLDivElement>) => { event.preventDefault(); const clipId = event.dataTransfer.getData('application/x-qtv-timeline-clip'); if (!clipId) return; const lane = event.currentTarget.getBoundingClientRect(); const startMs = Math.max(0, Math.round(((event.clientX - lane.left + event.currentTarget.scrollLeft) / PX_PER_SECOND * 1000) / 100) * 100); commit(moveTimelineClip(document, clipId, track, startMs)); setSelectedId(clipId); };
  const addAsset = (assetId: string) => {
    const asset = assets.find(item => item.id === assetId); if (!asset || asset.kind === 'document') return;
    const track: TimelineTrack = asset.kind === 'audio' ? 'A1' : 'V1';
    const startMs = document.clips.filter(clip => clip.track === track).reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
    commit({ ...document, clips: [...document.clips, { id: `asset-${crypto.randomUUID()}`, track, label: asset.name, startMs, durationMs: 4_000, sourceOffsetMs: 0, artifactId: asset.id }] });
  };
  const startExport = async () => {
    if (documentRevision === null || dirty.current) { setStatus('请等待时间线保存完成后再导出'); return; }
    try { const job = await ports.timeline.startExport(projectId, documentRevision); setExportJob(job); setStatus('已提交真实 MP4 导出'); }
    catch (error) { setStatus(error instanceof Error ? error.message : '导出启动失败'); }
  };
  const cancelExport = async () => { if (!exportJob) return; try { setExportJob(await ports.timeline.cancelExport(projectId, exportJob.requestId)); setStatus('导出已取消'); } catch (error) { setStatus(error instanceof Error ? error.message : '取消导出失败'); } };
  const completedJobs = jobs.filter(job => job.status === 'succeeded').length;

  return <div className="page timeline-page qtv-pro-timeline">
    <header className="timeline-pro-head"><div><p className="eyebrow">剪辑与成片</p><h1>专业时间线</h1><small>{status} · {(durationMs / 1000).toFixed(1)} 秒</small></div><div className="timeline-tools" role="toolbar" aria-label="时间线工具">{(['move','trim','slip','split'] as Tool[]).map(item => <button type="button" key={item} className={tool === item ? 'active' : ''} aria-pressed={tool === item} onClick={() => setTool(item)}>{item === 'move' ? '移动' : item === 'trim' ? '修剪' : item === 'slip' ? '滑移' : '分割'}</button>)}<button type="button" aria-pressed={document.ripple} className={document.ripple ? 'active' : ''} onClick={() => commit({ ...document, ripple: !document.ripple })}>波纹</button><button type="button" disabled={!history.current.length} onClick={undo}>撤销</button></div></header>
    <div className="timeline-export-bar"><select aria-label="添加真实素材到时间线" defaultValue="" onChange={event => { addAsset(event.target.value); event.currentTarget.value = ''; }}><option value="" disabled>＋ 添加真实素材</option>{assets.filter(asset => asset.kind !== 'document').map(asset => <option key={asset.id} value={asset.id}>{asset.kind === 'audio' ? 'A1' : 'V1'} · {asset.name}</option>)}</select><button type="button" disabled={documentRevision === null || dirty.current || !document.clips.some(clip => clip.artifactId && (clip.track === 'V1' || clip.track === 'V2')) || Boolean(exportJob && ['queued','preparing','rendering','finalizing'].includes(exportJob.phase))} onClick={() => void startExport()}>导出 MP4</button>{exportJob && ['queued','preparing','rendering','finalizing'].includes(exportJob.phase) ? <><span role="status">{exportJob.phase} · {exportJob.progress}%</span><button type="button" onClick={() => void cancelExport()}>取消导出</button></> : null}{exportJob?.phase === 'completed' && exportJob.downloadUrl ? <a href={exportJob.downloadUrl} download>下载 MP4</a> : null}{exportJob?.phase === 'failed' || exportJob?.phase === 'unknown' ? <span role="alert">{exportJob.error ?? '导出状态未知'}</span> : null}</div>
    <div className="timeline-pro-actions"><button type="button" disabled={!selected} onClick={() => cycleTrack(-1)}>上移轨道</button><button type="button" disabled={!selected} onClick={() => cycleTrack(1)}>下移轨道</button><button type="button" disabled={!selected} onClick={() => nudge(-500)}>−0.5 秒</button><button type="button" disabled={!selected} onClick={() => nudge(500)}>+0.5 秒</button><button type="button" disabled={!selected || tool !== 'split'} onClick={() => nudge(0)}>在中点分割</button><button type="button" disabled={!selected} onClick={removeSelected}>删除片段</button><span>{selected ? `${selected.label} · 源偏移 ${(selected.sourceOffsetMs / 1000).toFixed(1)}s` : '选择片段后编辑'}</span></div>
    <section className="timeline-ruler" aria-label="时间标尺">{Array.from({ length: Math.max(2, Math.ceil(durationMs / 5000) + 1) }, (_, index) => <span key={index} style={{ left: `${index * 5 * PX_PER_SECOND}px` }}>{index * 5}s</span>)}</section>
    <section className="timeline-tracks" style={{ '--timeline-width': `${Math.max(720, durationMs / 1000 * PX_PER_SECOND + 80)}px` } as CSSProperties}>
      {TIMELINE_TRACKS.map(track => <div className="timeline-track-row" key={track}><header><b>{track}</b><small>{TRACK_LABELS[track]}</small></header><div className="timeline-track-lane" onDragOver={event => { if (tool === 'move') { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={event => dropClip(track, event)}>{document.clips.filter(clip => clip.track === track).map(clip => <div role="button" tabIndex={0} draggable={tool === 'move'} key={clip.id} className={`timeline-pro-clip tool-${tool}${selectedId === clip.id ? ' selected' : ''}`} style={{ left: `${clip.startMs / 1000 * PX_PER_SECOND}px`, width: `${Math.max(34, clip.durationMs / 1000 * PX_PER_SECOND)}px` }} onDragStart={event => { event.dataTransfer.setData('application/x-qtv-timeline-clip', clip.id); event.dataTransfer.effectAllowed = 'move'; }} onPointerDown={event => { setSelectedId(clip.id); if (tool === 'slip') pointerEdit(clip.id, 'slip', event); }} onClick={event => { setSelectedId(clip.id); if (tool === 'split') { const rect = event.currentTarget.getBoundingClientRect(); const at = clip.startMs + (event.clientX - rect.left) / PX_PER_SECOND * 1000; commit(splitTimelineClip(document, clip.id, at, `clip-${crypto.randomUUID()}`)); } }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setSelectedId(clip.id); }} aria-label={`${clip.label}，${(clip.durationMs / 1000).toFixed(1)} 秒`}><span className="timeline-trim-handle is-start" aria-hidden="true" onPointerDown={event => pointerEdit(clip.id, 'trim-start', event)} />{(clip.track === 'A1' || clip.track === 'A2') && clip.artifactId && assetUrls.get(clip.artifactId) ? <AudioWaveform url={assetUrls.get(clip.artifactId)!} /> : null}<b>{clip.label}</b><small>{(clip.durationMs / 1000).toFixed(1)}s</small><span className="timeline-trim-handle is-end" aria-hidden="true" onPointerDown={event => pointerEdit(clip.id, 'trim-end', event)} /></div>)}</div></div>)}
    </section>
    <footer className="timeline-pro-footer"><span>{document.clips.length} 个片段</span><span>{document.ripple ? '波纹编辑开启' : '覆盖编辑'}</span><span>{completedJobs} 个可用生成产物</span></footer>
  </div>;
}

function AudioWaveform({ url }: { url: string }) {
  const [bars, setBars] = useState<number[]>([]);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    void fetch(url, { signal: controller.signal }).then(response => { if (!response.ok) throw new Error(`audio ${response.status}`); return response.arrayBuffer(); }).then(async bytes => {
      const context = new AudioContext();
      try {
        const audio = await context.decodeAudioData(bytes.slice(0)); const channel = audio.getChannelData(0); const count = 32; const size = Math.max(1, Math.floor(channel.length / count));
        const peaks = Array.from({ length: count }, (_item, index) => { let peak = 0; const end = Math.min(channel.length, (index + 1) * size); for (let cursor = index * size; cursor < end; cursor += Math.max(1, Math.floor(size / 96))) peak = Math.max(peak, Math.abs(channel[cursor] ?? 0)); return peak; });
        const max = Math.max(...peaks, 0.001); if (active) setBars(peaks.map(value => Math.max(0.08, value / max)));
      } finally { void context.close(); }
    }).catch(() => { if (active) setBars([]); });
    return () => { active = false; controller.abort(); };
  }, [url]);
  return <span className="timeline-audio-waveform" aria-label={bars.length ? '真实音频波形' : '音频波形载入中'}>{bars.map((height, index) => <i key={index} style={{ height: `${Math.round(height * 100)}%` }} />)}</span>;
}
