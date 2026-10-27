import { describe, expect, it, vi } from 'vitest';
import type { CanvasDocumentPort, PersistedCanvasDocument } from '../apps/web/src/ports/index.js';
import { saveCanvasWithReconciliation } from '../apps/web/src/features/canvas/canvasSave.js';

const local: PersistedCanvasDocument = { version: 2, nodes: [], edges: [] };
const remote: PersistedCanvasDocument = { version: 2, nodes: [{ id: 'remote', type: 'qtv', position: { x: 1, y: 1 }, data: { label: '别人修改' } }], edges: [] };
describe('画布写入异常对账', () => {
  it('服务端提交成功但响应丢失时读取同内容确认成功，不再次写入', async () => {
    const port = { save: vi.fn().mockRejectedValue(new Error('响应断开')), load: vi.fn().mockResolvedValue({ document: local, documentRevision: 8, projectRevision: 9 }) } as CanvasDocumentPort;
    await expect(saveCanvasWithReconciliation(port, 'project', 7, 5, local)).resolves.toEqual({ projectRevision: 9, documentRevision: 8 });
    expect(port.save).toHaveBeenCalledTimes(1);
  });
  it('只有无关项目修订变更时，以远端最新版本重试一次', async () => {
    const port = { save: vi.fn().mockRejectedValueOnce(new Error('PROJECT_REVISION_CONFLICT')).mockResolvedValueOnce({ projectRevision: 11, documentRevision: 11 }), load: vi.fn().mockResolvedValue({ document: remote, documentRevision: 5, projectRevision: 10 }) } as CanvasDocumentPort;
    await expect(saveCanvasWithReconciliation(port, 'project', 7, 5, local)).resolves.toEqual({ projectRevision: 11, documentRevision: 11 });
    expect(port.save).toHaveBeenNthCalledWith(2, 'project', 10, local);
  });
  it('远端画布真被他人修改则阻止覆盖，网络双离线不盲目重试', async () => {
    const originalError = new Error('响应断开');
    const conflict = { save: vi.fn().mockRejectedValue(originalError), load: vi.fn().mockResolvedValue({ document: remote, documentRevision: 10, projectRevision: 10 }) } as CanvasDocumentPort;
    await expect(saveCanvasWithReconciliation(conflict, 'project', 7, 5, local)).rejects.toThrow('未覆盖远端');
    expect(conflict.save).toHaveBeenCalledTimes(1);
    const offline = { save: vi.fn().mockRejectedValue(originalError), load: vi.fn().mockRejectedValue(new Error('离线')) } as CanvasDocumentPort;
    await expect(saveCanvasWithReconciliation(offline, 'project', 7, 5, local)).rejects.toBe(originalError);
    expect(offline.save).toHaveBeenCalledTimes(1);
  });
});
