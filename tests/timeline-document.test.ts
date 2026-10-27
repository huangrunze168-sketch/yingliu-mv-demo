import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import type { DomainCommand } from '@qiyin/contracts';
import { moveTimelineClip, removeTimelineClip, slipTimelineClip, splitTimelineClip, timelineFromShots, trimTimelineClip } from '../apps/web/src/features/timeline/timelineDocument.js';

it('时间线支持 Move/Trim/Slip/Split/Ripple 且保持确定性', () => {
  const initial = timelineFromShots([
    { id: 'a', title: '镜头 A', scene: '', status: 'ready', duration: '00:04', prompt: '' },
    { id: 'b', title: '镜头 B', scene: '', status: 'ready', duration: '3s', prompt: '' },
  ]);
  expect(initial.clips.map(clip => [clip.startMs, clip.durationMs])).toEqual([[0, 4000], [4000, 3000]]);
  const moved = moveTimelineClip(initial, 'shot-a', 'V2', 1000);
  expect(moved.clips.find(clip => clip.id === 'shot-b')?.startMs).toBe(0);
  const trimmed = trimTimelineClip(moved, 'shot-a', 'start', 500);
  expect(trimmed.clips.find(clip => clip.id === 'shot-a')).toMatchObject({ startMs: 1500, durationMs: 3500, sourceOffsetMs: 500 });
  const slipped = slipTimelineClip(trimmed, 'shot-a', 750);
  expect(slipped.clips.find(clip => clip.id === 'shot-a')?.sourceOffsetMs).toBe(1250);
  const split = splitTimelineClip(slipped, 'shot-a', 3000, 'right');
  expect(split.clips.filter(clip => clip.track === 'V2')).toHaveLength(2);
  const removed = removeTimelineClip(split, 'shot-b');
  expect(removed.clips.some(clip => clip.id === 'shot-b')).toBe(false);
});

it('时间线文档通过项目 revision 原子持久化并拒绝旧版本覆盖', () => {
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '时间线', max_budget_cents: 0, rights_confirmed: true } }).project_id!;
  const document = { version: 1 as const, ripple: true, clips: [{ id: 'c1', track: 'V1' as const, label: '镜头', startMs: 0, durationMs: 1000, sourceOffsetMs: 0 }] };
  const command = (expected_revision: number): DomainCommand => ({ command_id: randomUUID(), actor: 'user:test', type: 'timeline-document.replace', project_id: projectId, expected_revision, payload: { document } });
  const saved = service.execute(command(1));
  expect(saved.project_revision).toBe(2);
  expect((service.getProject(projectId) as { timeline_document: { document: typeof document } }).timeline_document.document).toEqual(document);
  expect(() => service.execute(command(1))).toThrow(/版本|revision/i);
});
