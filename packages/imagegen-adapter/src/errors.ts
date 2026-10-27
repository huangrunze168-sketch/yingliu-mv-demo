/* ============================================================
   期音科技 · 图像生成服务 CLI 错误分类
   ------------------------------------------------------------
   分类的意义是「下一步该做什么」，不是「哪个异常类更漂亮」：

     not-installed  → 去装 CLI
     auth           → 去 imagegen login
     compliance     → 去图像生成服务 Web 端用该模型手工生成一次（首次授权）

   `compliance` 单独分出来，是因为它的处置**只有用户能做**：
   重试一万次也不会变好。
   ============================================================ */

export class ImageGenError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
  }
}

export class ImageGenNotInstalledError extends ImageGenError {}
export class ImageGenAuthError extends ImageGenError {}
export class ImageGenCommandError extends ImageGenError {
  constructor(message: string, readonly code: number, details?: Record<string, unknown>) {
    super(message, details);
  }
}
export class ImageGenProtocolError extends ImageGenError {}
/** 图像生成服务要求先在 Web 端用该模型完成一次生成（首次授权）。 */
export class ImageGenComplianceError extends ImageGenError {}
