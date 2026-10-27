import type { CanvasDocumentPort, PersistedCanvasDocument } from '../../ports/index.js';

/** 校验远端状态后重试一次画布写入；绝不以项目 revision 变化推断画布被改写。 */
export async function saveCanvasWithReconciliation(
  port: CanvasDocumentPort,
  projectId: string,
  expectedProjectRevision: number,
  knownDocumentRevision: number | null,
  document: PersistedCanvasDocument,
): Promise<{ projectRevision: number; documentRevision: number }> {
  try { return await port.save(projectId, expectedProjectRevision, document); }
  catch (error) {
    let latest;
    try { latest = await port.load(projectId); }
    catch { throw error; }
    // 请求可能已提交但响应丢失；相同文档就是已保存，不能再写一次。
    if (latest.document && JSON.stringify(latest.document) === JSON.stringify(document) && latest.documentRevision !== null) {
      return { projectRevision: latest.projectRevision, documentRevision: latest.documentRevision };
    }
    if (latest.documentRevision !== knownDocumentRevision) throw new Error('画布内容已在其他位置更新；本地编辑未覆盖远端，请复制所需节点后重新载入。');
    return port.save(projectId, latest.projectRevision, document);
  }
}
