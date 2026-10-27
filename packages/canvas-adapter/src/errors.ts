/**
 * 小QTV 适配器错误族。
 *
 * 与 前置内核 适配器同构，分类理由也一样：不同类型要给出**不同的下一步**。
 * 把「没登录」和「模型名写错」混成一句「操作失败」，用户只能反复试。
 */

export class CanvasError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'CanvasError';
  }
}

/**/
export class CanvasNotInstalledError extends CanvasError {
  constructor(message: string, detail?: unknown) {
    super(message, detail);
    this.name = 'CanvasNotInstalledError';
  }
}

/** 凭据缺失或失效——需要重新登录。 */
export class CanvasAuthError extends CanvasError {
  constructor(message: string) {
    super(message);
    this.name = 'CanvasAuthError';
  }
}

/** 命令以非零退出。小QTV 把原因写在 stderr（如 `error: ...`）。 */
export class CanvasCommandError extends CanvasError {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = 'CanvasCommandError';
  }
}

/** 输出中找不到可解析的 JSON。 */
export class CanvasProtocolError extends CanvasError {
  constructor(message: string, detail?: unknown) {
    super(message, detail);
    this.name = 'CanvasProtocolError';
  }
}
