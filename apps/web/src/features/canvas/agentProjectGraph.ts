import { CANVAS_NODE_TYPES } from '../../domain/canvas.js';
import { makeCanvasNode, type CanvasEdge, type CanvasNode } from './canvasDocument.js';

type ProjectShot = { shot_id?: unknown; author?: unknown; replacement?: unknown; camera_position?: unknown; duration_ms?: unknown };
type ProjectCandidate = { candidate_id?: unknown; shot_id?: unknown; artifact_id?: unknown; status?: unknown };
type GenerationIntent = { shot_id?: unknown; status?: unknown; clip_artifact_id?: unknown };
type FrameSelection = { shot_id?: unknown; candidate_id?: unknown };
export type AgentProjectSnapshot = {
  shot_fields?: { shots?: ProjectShot[] } | null;
  candidates?: ProjectCandidate[];
  selections?: FrameSelection[];
  image_generations?: GenerationIntent[];
  video_generations?: GenerationIntent[];
};

/** 项目领域事实映射为只读节点；不把生成产物写进浏览器的本地画布文档。 */
export function agentProjectGraph(projectId: string, snapshot: AgentProjectSnapshot): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const shots = (snapshot.shot_fields?.shots ?? []).filter(shot => typeof shot.shot_id === 'string'
    && /^shot-(?:0[1-9]|1[0-2])$/.test(shot.shot_id) && typeof shot.author === 'string' && shot.author.startsWith('agent:'));
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  shots.forEach((shot, index) => {
    const shotId = shot.shot_id as string;
    const plan = makeCanvasNode(CANVAS_NODE_TYPES.aiText, { x: 100, y: 110 + index * 350 }, `project-plan-${shotId}`);
    plan.type = 'qtv';
    plan.measured = { width: 500, height: 350 };
    plan.draggable = false; plan.connectable = false; plan.selectable = false;
    plan.data = { ...plan.data, origin: 'project', label: `分镜 ${shotId}`, prompt: String(shot.replacement ?? ''), status: 'ready' };
    const result = makeCanvasNode(CANVAS_NODE_TYPES.imageEdit, { x: 700, y: 110 + index * 350 }, `project-frame-${shotId}`);
    result.type = 'qtv';
    result.measured = { width: 500, height: 350 };
    result.draggable = false; result.connectable = false; result.selectable = false;
    const candidates = (snapshot.candidates ?? []).filter(item => item.shot_id === shotId && item.status === 'ACTIVE'
      && typeof item.artifact_id === 'string' && /^sha256:[a-f0-9]{64}$/.test(item.artifact_id));
    const selection = (snapshot.selections ?? []).find(item => item.shot_id === shotId);
    const candidate = candidates.find(item => item.candidate_id === selection?.candidate_id) ?? candidates[candidates.length - 1];
    const latest = (snapshot.image_generations ?? []).find(item => item.shot_id === shotId);
    const status = latest?.status === 'ADMITTED' ? 'running' : latest?.status === 'FAILED' ? 'failed' : candidate ? 'ready' : 'draft';
    result.data = {
      ...result.data, origin: 'project', label: `${shotId} · ${selection?.candidate_id === candidate?.candidate_id ? '已选首帧' : '首帧'}`,
      prompt: String(shot.replacement ?? ''), status,
      ...(candidate ? { previewUrl: `/api/v1/agent/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(candidate.artifact_id as string)}` } : {}),
    };
    const video = makeCanvasNode(CANVAS_NODE_TYPES.aiVideo, { x: 1300, y: 110 + index * 350 }, `project-video-${shotId}`);
    video.type = 'qtv';
    video.measured = { width: 500, height: 350 };
    video.draggable = false; video.connectable = false; video.selectable = false;
    const videoIntents = (snapshot.video_generations ?? []).filter(item => item.shot_id === shotId);
    const latestVideo = videoIntents[0];
    const completed = videoIntents.find(item => item.status === 'COMPLETED' && typeof item.clip_artifact_id === 'string'
      && /^sha256:[a-f0-9]{64}$/.test(item.clip_artifact_id));
    const videoStatus = latestVideo?.status === 'ADMITTED' ? 'running' : latestVideo?.status === 'FAILED' ? 'failed' : completed ? 'ready' : 'draft';
    video.data = {
      ...video.data, origin: 'project', label: `${shotId} · 视频片段`, prompt: String(shot.replacement ?? ''), status: videoStatus,
      ...(completed ? { videoUrl: `/api/v1/agent/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(completed.clip_artifact_id as string)}` } : {}),
    };
    nodes.push(plan, result, video);
    edges.push({ id: `project-edge-${shotId}`, source: plan.id, target: result.id, selectable: false, animated: status === 'running' });
    edges.push({ id: `project-video-edge-${shotId}`, source: result.id, target: video.id, selectable: false, animated: videoStatus === 'running' });
  });
  return { nodes, edges };
}
