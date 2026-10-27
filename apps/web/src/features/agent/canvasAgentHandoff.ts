export interface CanvasAgentHandoff {
  schema: 'xiaoqtv.canvas-agent-handoff.v1';
  text: string;
  createdAt: string;
  skill?: { id: string; version: string; name: string };
  references?: Array<{ id: string; kind: 'asset' | 'shot' | 'node'; label: string }>;
}

const MAX_HANDOFF_AGE_MS = 10 * 60 * 1000;

export function canvasAgentHandoffKey(projectId: string) {
  return `qiyin.canvas.agent-handoff.${projectId}`;
}

export function createCanvasAgentHandoff(text: string, skill?: CanvasAgentHandoff['skill'], references?: CanvasAgentHandoff['references']): CanvasAgentHandoff {
  return {
    schema: 'xiaoqtv.canvas-agent-handoff.v1',
    text: text.trim(),
    createdAt: new Date().toISOString(),
    ...(skill ? { skill } : {}),
    ...(references?.length ? { references: references.slice(0, 20) } : {}),
  };
}

export function parseCanvasAgentHandoff(raw: string | null, now = Date.now()): CanvasAgentHandoff | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CanvasAgentHandoff>;
    if (value.schema !== 'xiaoqtv.canvas-agent-handoff.v1' || typeof value.text !== 'string' || !value.text.trim() || typeof value.createdAt !== 'string') return null;
    const createdAt = Date.parse(value.createdAt);
    if (!Number.isFinite(createdAt) || now - createdAt > MAX_HANDOFF_AGE_MS || createdAt - now > 60_000) return null;
    const skill = value.skill;
    if (skill !== undefined && (typeof skill.id !== 'string' || typeof skill.version !== 'string' || typeof skill.name !== 'string')) return null;
    const references = value.references;
    if (references !== undefined && (!Array.isArray(references) || references.length > 20 || references.some(reference => !reference || typeof reference.id !== 'string' || !['asset', 'shot', 'node'].includes(reference.kind) || typeof reference.label !== 'string'))) return null;
    return { schema: value.schema, text: value.text.trim(), createdAt: value.createdAt, ...(skill ? { skill } : {}), ...(references?.length ? { references } : {}) };
  } catch {
    return null;
  }
}
