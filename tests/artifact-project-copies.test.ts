/* ============================================================
  产物副本的**项目归属**（真机上抓出来的那个缺陷）。

  背景：`artifact_id` 是内容哈希，所以同一份文件传到两个项目时，
  `artifacts` 表里**只有一行**；而磁盘上每个项目目录里各有一份副本。
  早先只记一条路径，于是：

    ① 项目 A 上传 → 记 A 的路径
    ② 项目 B 上传同一份 → **顶替**成 B 的路径
    ③ 项目 B 被删（工作目录一起删）→ 记录悬空
    ④ 项目 A 里引用同一产物的节点全部读不到文件

  真机上的症状是剪辑时间轴永远显示"时长未知"，而合成会在更晚的一步才炸。
  这一组用例盯的就是那四步里的每一步。
  ============================================================ */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService, resolveArtifactPath } from '@qiyin/domain';

function service(): ProjectService {
  return new ProjectService(openDatabase(':memory:'));
}

function createProject(target: ProjectService, name: string): string {
  const result = target.execute({
    command_id: randomUUID(), actor: 'user:test', type: 'project.create',
    payload: { name, max_budget_cents: 10_000, rights_confirmed: true },
  }) as { project_id?: string };
  const id = result.project_id;
  if (typeof id !== 'string') throw new Error('建项目失败');
  return id;
}

function publish(target: ProjectService, artifactId: string, projectId: string, path: string, source: string): void {
  target.execute({
    command_id: randomUUID(), actor: 'user:test', type: 'artifact.publish',
    payload: {
      artifact_id: artifactId, media_type: 'video/mp4', bytes: 1024,
      metadata: { artifact_path_relative: path, project_id: projectId, source },
    },
  });
}

function metadataOf(target: ProjectService, artifactId: string): Record<string, unknown> {
  const artifacts = target.listArtifacts() as Array<{ artifact_id: string; metadata: Record<string, unknown> | null }>;
  const found = artifacts.find((item) => item.artifact_id === artifactId);
  if (found === undefined || found.metadata === null) throw new Error('找不到这份产物');
  return found.metadata;
}

/** 领域命令带 CAS：`project.trash` / `project.purge` 都要给当前 revision。 */
function revisionOf(target: ProjectService, projectId: string): number {
  const project = target.getProject(projectId) as { revision?: number };
  return typeof project.revision === 'number' ? project.revision : 0;
}

const CONTENT = `sha256:${'c'.repeat(64)}`;

describe('同一份内容出现在两个项目里', () => {
  it('两个项目的副本都被记住，不是后者顶掉前者', () => {
    const svc = service();
    const a = createProject(svc, '项目A');
    const b = createProject(svc, '项目B');
    publish(svc, CONTENT, a, 'uploads/clip-a.mp4', 'upload');
    publish(svc, CONTENT, b, 'uploads/clip-b.mp4', 'upload');

    const metadata = metadataOf(svc, CONTENT);
    expect(metadata.project_copies).toEqual({ [a]: 'uploads/clip-a.mp4', [b]: 'uploads/clip-b.mp4' });
  });

  it('按项目取路径：A 拿到 A 那份，B 拿到 B 那份', () => {
    const svc = service();
    const a = createProject(svc, '项目A');
    const b = createProject(svc, '项目B');
    publish(svc, CONTENT, a, 'uploads/clip-a.mp4', 'upload');
    publish(svc, CONTENT, b, 'uploads/clip-b.mp4', 'upload');
    const json = JSON.stringify(metadataOf(svc, CONTENT));

    expect(resolveArtifactPath(JSON.parse(json), a)).toBe('uploads/clip-a.mp4');
    expect(resolveArtifactPath(JSON.parse(json), b)).toBe('uploads/clip-b.mp4');
  });

  it('B 被删之后，A 仍然拿得到自己那份（真机上的因果链）', () => {
    const svc = service();
    const a = createProject(svc, '项目A');
    const b = createProject(svc, '项目B');
    publish(svc, CONTENT, a, 'uploads/clip-a.mp4', 'upload');
    publish(svc, CONTENT, b, 'uploads/clip-b.mp4', 'upload');
    /* 项目 B 连同它的工作目录一起消失：先进回收站，再抹掉（purge 要求逐字确认项目名） */
    svc.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.trash',
      project_id: b, expected_revision: revisionOf(svc, b), payload: {},
    });
    svc.execute({
      command_id: randomUUID(), actor: 'user:test', type: 'project.purge',
      project_id: b, expected_revision: revisionOf(svc, b), payload: { confirm_name: '项目B' },
    });

    const json = JSON.stringify(metadataOf(svc, CONTENT));
    expect(resolveArtifactPath(JSON.parse(json), a)).toBe('uploads/clip-a.mp4');
  });

  it('跨项目发布**不算顶替**：那条事件不该报出去（否则会去删别的项目的文件）', () => {
    const svc = service();
    const a = createProject(svc, '项目A');
    const b = createProject(svc, '项目B');
    const superseded: Array<{ projectId: string | null; from: string; to: string }> = [];
    svc.onArtifactSuperseded = (info) => { superseded.push({ projectId: info.projectId, from: info.from, to: info.to }); };

    publish(svc, CONTENT, a, 'uploads/clip-a.mp4', 'upload');
    publish(svc, CONTENT, b, 'uploads/clip-b.mp4', 'upload');
    expect(superseded).toEqual([]);
  });

  it('同一个项目内换落点**才算顶替**：旧文件可以清掉', () => {
    const svc = service();
    const a = createProject(svc, '项目A');
    const superseded: Array<{ from: string; to: string }> = [];
    svc.onArtifactSuperseded = (info) => { superseded.push({ from: info.from, to: info.to }); };

    publish(svc, CONTENT, a, 'uploads/old.mp4', 'upload');
    publish(svc, CONTENT, a, 'uploads/new.mp4', 'upload');
    expect(superseded).toEqual([{ from: 'uploads/old.mp4', to: 'uploads/new.mp4' }]);
    expect(metadataOf(svc, CONTENT).project_copies).toEqual({ [a]: 'uploads/new.mp4' });
  });
});

describe('解析的兼容性', () => {
  it('老数据没有 project_copies：退回顶上那条路径（行为不变）', () => {
    const legacy = { artifact_path_relative: 'uploads/x.mp4', project_id: 'any' };
    expect(resolveArtifactPath(legacy, 'proj-1')).toBe('uploads/x.mp4');
    expect(resolveArtifactPath(legacy, undefined)).toBe('uploads/x.mp4');
  });

  it('没传 projectId 时也只认顶上那条', () => {
    const metadata = { artifact_path_relative: 'uploads/top.mp4', project_copies: { p1: 'uploads/one.mp4' } };
    expect(resolveArtifactPath(metadata, undefined)).toBe('uploads/top.mp4');
    expect(resolveArtifactPath(metadata, 'p1')).toBe('uploads/one.mp4');
  });

  it('frame_path_relative 那条老键也认（生成服务发布的是它）', () => {
    expect(resolveArtifactPath({ frame_path_relative: 'frames/a.jpg' }, 'p')).toBe('frames/a.jpg');
  });

  it('坏 metadata 一律返回 null，不抛', () => {
    expect(resolveArtifactPath(null, 'p')).toBeNull();
    expect(resolveArtifactPath('不是对象', 'p')).toBeNull();
    expect(resolveArtifactPath([], 'p')).toBeNull();
    expect(resolveArtifactPath({}, 'p')).toBeNull();
    expect(resolveArtifactPath({ project_copies: { p: 42 } }, 'p')).toBeNull();
  });

  it('项目在 copies 里有但值不对（空串/非字符串）：退回顶层', () => {
    const metadata = { artifact_path_relative: 'uploads/top.mp4', project_copies: { p: '' } };
    expect(resolveArtifactPath(metadata, 'p')).toBe('uploads/top.mp4');
  });
});
