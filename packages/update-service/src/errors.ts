/* ============================================================
  期音科技 · 更新服务的错误
   ------------------------------------------------------------
  更新这条链路上，**每一种失败都必须能被单独认出来**：

    · 没配通道 / 没配公钥     → 用户自己能修（去配置），不是"更新失败"
    · 签名不对               → 可能是被投毒，必须和"网络抖了"分开
    · 哈希对不上             → 包坏了或被人动过
    · 版本回退 / 低于桥接版本 → 是**拒绝**，不是失败（更新器主动做的判断）
    · 下载失败               → 重试有意义

  全都塞进一句"更新失败"，用户除了再点一次没有别的动作可做，
  而这几种情况的正确动作是完全不同的。
   ============================================================ */

export type UpdateErrorCode =
  /** 还没有配置更新通道地址（或公钥）——用户自己能补上 */
  | 'UPDATE_NOT_CONFIGURED'
  /** 清单结构不合法 */
  | 'UPDATE_MANIFEST_INVALID'
  /** 签名验证不通过 */
  | 'UPDATE_SIGNATURE_INVALID'
  /** 文件内容与清单里的哈希不一致 */
  | 'UPDATE_FILE_HASH_MISMATCH'
  /** 清单里出现了逃出目标目录的路径 */
  | 'UPDATE_PATH_ESCAPE'
  /** 版本比当前更低（或 counter 更小）——拒绝回滚 */
  | 'UPDATE_ROLLBACK_REFUSED'
  /** 当前版本太老，必须先升到桥接版本 */
  | 'UPDATE_BRIDGE_REQUIRED'
  /** 下载过程失败 */
  | 'UPDATE_DOWNLOAD_FAILED'
  /** 当前状态不允许这个操作（例如还没下载就想安装） */
  | 'UPDATE_STATE_CONFLICT';

export class UpdateError extends Error {
  readonly code: UpdateErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: UpdateErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
    this.detail = detail;
  }
}

export function isUpdateError(error: unknown): error is UpdateError {
  return error instanceof UpdateError;
}
