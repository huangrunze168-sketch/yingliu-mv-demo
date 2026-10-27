import type { Shot, TimelineDocument, TimelineTrack } from '../../ports/index.js';

export const TIMELINE_TRACKS: TimelineTrack[] = ['C1', 'V2', 'V1', 'A1', 'A2'];

function shotDurationMs(value: string): number {
  const parts = value.trim().replace(/s$/i, '').split(':').map(Number);
  const seconds = parts.length === 1 ? (parts[0] ?? 0) : parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1_000) : 4_000;
}

export function timelineFromShots(shots: Shot[]): TimelineDocument {
  let cursor = 0;
  return { version: 1, ripple: true, clips: shots.map(shot => {
    const durationMs = shotDurationMs(shot.duration);
    const clip = { id: `shot-${shot.id}`, track: 'V1' as const, label: shot.title, startMs: cursor, durationMs, sourceOffsetMs: 0, shotId: shot.id };
    cursor += durationMs;
    return clip;
  }) };
}

function sorted(document: TimelineDocument): TimelineDocument {
  const rank = new Map(TIMELINE_TRACKS.map((track, index) => [track, index]));
  return { ...document, clips: [...document.clips].sort((a, b) => (rank.get(a.track)! - rank.get(b.track)!) || a.startMs - b.startMs || a.id.localeCompare(b.id)) };
}

export function moveTimelineClip(document: TimelineDocument, id: string, track: TimelineTrack, startMs: number): TimelineDocument {
  const source = document.clips.find(clip => clip.id === id);
  if (!source) return document;
  let clips = document.clips.filter(clip => clip.id !== id);
  if (document.ripple) {
    clips = clips.map(clip => clip.track === source.track && clip.startMs >= source.startMs + source.durationMs ? { ...clip, startMs: clip.startMs - source.durationMs } : clip);
    clips = clips.map(clip => clip.track === track && clip.startMs >= startMs ? { ...clip, startMs: clip.startMs + source.durationMs } : clip);
  }
  return sorted({ ...document, clips: [...clips, { ...source, track, startMs: Math.max(0, Math.round(startMs)) }] });
}

export function trimTimelineClip(document: TimelineDocument, id: string, edge: 'start' | 'end', deltaMs: number): TimelineDocument {
  return sorted({ ...document, clips: document.clips.map(clip => {
    if (clip.id !== id) return clip;
    if (edge === 'end') return { ...clip, durationMs: Math.max(100, clip.durationMs + Math.round(deltaMs)) };
    const applied = Math.max(-clip.sourceOffsetMs, Math.min(clip.durationMs - 100, Math.round(deltaMs)));
    return { ...clip, startMs: clip.startMs + applied, sourceOffsetMs: clip.sourceOffsetMs + applied, durationMs: clip.durationMs - applied };
  }) });
}

export function slipTimelineClip(document: TimelineDocument, id: string, deltaMs: number): TimelineDocument {
  return { ...document, clips: document.clips.map(clip => clip.id === id ? { ...clip, sourceOffsetMs: Math.max(0, clip.sourceOffsetMs + Math.round(deltaMs)) } : clip) };
}

export function splitTimelineClip(document: TimelineDocument, id: string, atMs: number, rightId: string): TimelineDocument {
  const clip = document.clips.find(item => item.id === id);
  if (!clip || atMs <= clip.startMs || atMs >= clip.startMs + clip.durationMs || document.clips.some(item => item.id === rightId)) return document;
  const leftDuration = Math.round(atMs - clip.startMs);
  const right = { ...clip, id: rightId, label: `${clip.label} · B`, startMs: clip.startMs + leftDuration, durationMs: clip.durationMs - leftDuration, sourceOffsetMs: clip.sourceOffsetMs + leftDuration };
  return sorted({ ...document, clips: document.clips.map(item => item.id === id ? { ...item, label: `${item.label} · A`, durationMs: leftDuration } : item).concat(right) });
}

export function removeTimelineClip(document: TimelineDocument, id: string): TimelineDocument {
  const removed = document.clips.find(clip => clip.id === id);
  if (!removed) return document;
  const clips = document.clips.filter(clip => clip.id !== id).map(clip => document.ripple && clip.track === removed.track && clip.startMs >= removed.startMs + removed.durationMs ? { ...clip, startMs: clip.startMs - removed.durationMs } : clip);
  return sorted({ ...document, clips });
}
