import type { CanvasEdge, CanvasNode } from './canvasDocument.js';
import { isRunnableCanvasGenerationNode } from '../../domain/canvas.js';

/** 小QTV 自建安全门槛：每一笔外部生成须指明节点与模型，未知单价不得伪称零费用。 */
export function canvasNodeConsentText(node: CanvasNode, index: number, total: number): string {
  const interrupted = node.data.status === 'unknown'
    ? '\n注意：此节点上次运行在页面离开时中断观察，结果与已产生费用均未核实。请先到服务商账户核对；若仍继续，可能重复计费。\n'
    : '';
  return `即将执行第 ${index}/${total} 个真实生成节点：\n「${node.data.label}」\n模型：${node.data.model ?? '未选择'}\n${interrupted}\n当前无法核实服务商准确单价。请确认素材使用权，并明确同意本次可能产生的费用；取消则停止本节点及后续节点，已完成的调用及费用不会撤销。`;
}

/** 上游成功产生新版本后，沿依赖边标记后续生成节点待重做；旧资产保留但必须标为上一版。 */
export function invalidateCanvasDependents(nodes: CanvasNode[], edges: CanvasEdge[], sourceId: string): CanvasNode[] {
  const stale = new Set<string>();
  const queue = [sourceId];
  while (queue.length) {
    const source = queue.shift()!;
    for (const edge of edges) {
      if (edge.source !== source || edge.target === sourceId || stale.has(edge.target)) continue;
      stale.add(edge.target);
      queue.push(edge.target);
    }
  }
  return nodes.map(node => {
    if (!stale.has(node.id) || node.data.origin === 'project' || !isRunnableCanvasGenerationNode(node.data.kind)) return node;
    const data = { ...node.data, status: 'draft' as const };
    delete data.jobId;
    delete data.progress;
    return { ...node, data };
  });
}

export class CanvasDagError extends Error {
  constructor(message: string) { super(message); this.name = 'CanvasDagError'; }
}

/**
 * 为单节点或“运行全部”生成稳定的拓扑执行计划。
 * 上传、文本等非付费节点只作为已存在的输入，不会被错误路由到生成后端。
 */
export function canvasExecutionPlan(nodes: CanvasNode[], edges: CanvasEdge[], targetId?: string): string[] {
  const runnable = nodes.filter(node => node.data.origin !== 'project' && isRunnableCanvasGenerationNode(node.data.kind));
  const runnableById = new Map(runnable.map(node => [node.id, node]));
  if (targetId && !runnableById.has(targetId)) throw new CanvasDagError('目标节点不可运行');

  const dependencies = new Map<string, Set<string>>(runnable.map(node => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (runnableById.has(edge.source) && runnableById.has(edge.target)) dependencies.get(edge.target)!.add(edge.source);
  }

  const included = new Set<string>();
  const visitAncestors = (id: string) => {
    if (included.has(id)) return;
    included.add(id);
    for (const dependency of dependencies.get(id) ?? []) visitAncestors(dependency);
  };
  if (targetId) visitAncestors(targetId); else for (const node of runnable) included.add(node.id);

  const indegree = new Map<string, number>();
  for (const id of included) indegree.set(id, [...(dependencies.get(id) ?? [])].filter(dependency => included.has(dependency)).length);
  const ready = runnable.filter(node => included.has(node.id) && indegree.get(node.id) === 0).map(node => node.id);
  const ordered: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const [candidate, candidateDependencies] of dependencies) {
      if (!included.has(candidate) || !candidateDependencies.has(id)) continue;
      const next = (indegree.get(candidate) ?? 0) - 1;
      indegree.set(candidate, next);
      if (next === 0) ready.push(candidate);
    }
  }
  if (ordered.length !== included.size) throw new CanvasDagError('画布生成依赖存在环路，无法运行');
  const dirty = new Set<string>();
  for (const id of ordered) {
    const node = runnableById.get(id)!;
    if (id === targetId || node.data.status !== 'ready' || !node.data.artifactId || [...(dependencies.get(id) ?? [])].some(dependency => dirty.has(dependency))) dirty.add(id);
  }
  return ordered.filter(id => dirty.has(id));
}
