import type { CanvasDocumentSnapshot, PersistedCanvasDocument } from '../../ports/index.js';
import { fromPersistedCanvasDocument } from './canvasDocument.js';

const draftKey = (projectId: string) => `qtv-canvas-pending:v1:${encodeURIComponent(projectId)}`;
interface CanvasDraft { version: 1; baseDocumentRevision: number | null; baseSerialized: string; document: PersistedCanvasDocument; updatedAt: string; }
export type CanvasDraftReview = { state: 'none' | 'saved' | 'recoverable' | 'conflict' | 'invalid'; raw?: string; draft?: CanvasDraft };

export function readCanvasDraft(storage: Storage, projectId: string): CanvasDraftReview {
  const raw = storage.getItem(draftKey(projectId));
  if (!raw) return { state: 'none' };
  try {
    const draft = JSON.parse(raw) as CanvasDraft;
    if (draft.version !== 1 || (draft.baseDocumentRevision !== null && (!Number.isSafeInteger(draft.baseDocumentRevision) || draft.baseDocumentRevision < 0)) || typeof draft.baseSerialized !== 'string' || typeof draft.updatedAt !== 'string' || !fromPersistedCanvasDocument(draft.document)) return { state: 'invalid', raw };
    return { state: 'conflict', raw, draft };
  } catch { return { state: 'invalid', raw }; }
}

export function inspectCanvasDraft(storage: Storage, projectId: string, snapshot: CanvasDocumentSnapshot): CanvasDraftReview {
  const entry = readCanvasDraft(storage, projectId);
  if (!entry.draft) return entry;
  if (snapshot.document && !fromPersistedCanvasDocument(snapshot.document)) return { ...entry, state: 'conflict' };
  const remoteSerialized = snapshot.document ? JSON.stringify(snapshot.document) : '';
  if (JSON.stringify(entry.draft.document) === remoteSerialized) return { ...entry, state: 'saved' };
  if (entry.draft.baseDocumentRevision === snapshot.documentRevision && entry.draft.baseSerialized === remoteSerialized) return { ...entry, state: 'recoverable' };
  return { ...entry, state: 'conflict' };
}

export function storeCanvasDraft(storage: Storage, projectId: string, document: PersistedCanvasDocument, baseDocumentRevision: number | null, baseSerialized: string): void {
  storage.setItem(draftKey(projectId), JSON.stringify({ version: 1, baseDocumentRevision, baseSerialized, document, updatedAt: new Date().toISOString() } satisfies CanvasDraft));
}

export function reconcileCanvasDraftAfterSave(storage: Storage, projectId: string, savedDocument: PersistedCanvasDocument, revision: number): void {
  const entry = readCanvasDraft(storage, projectId);
  if (!entry.draft) return;
  if (JSON.stringify(entry.draft.document) === JSON.stringify(savedDocument)) { storage.removeItem(draftKey(projectId)); return; }
  storeCanvasDraft(storage, projectId, entry.draft.document, revision, JSON.stringify(savedDocument));
}

export function discardCanvasDraft(storage: Storage, projectId: string): void { storage.removeItem(draftKey(projectId)); }
