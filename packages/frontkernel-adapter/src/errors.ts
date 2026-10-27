/**
 * 前置内核 适配器错误族。
 *
 * 三类失败必须能被调用方区分，否则界面上只能显示一句无用的「操作失败」：
 *   · 内核没装 / 找不到 distribution —— 环境问题，用户需要安装，重试无用；
 *     它不会报错，只会让字段静默变成 undefined。
 */

export class FrontkernelAdapterError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'FrontkernelAdapterError';
  }
}

/** 找不到 前置内核 distribution（未安装或路径不对）。 */
export class FrontkernelNotInstalledError extends FrontkernelAdapterError {
  constructor(message: string, detail?: unknown) {
    super(message, detail);
    this.name = 'FrontkernelNotInstalledError';
  }
}

/**/
export class FrontkernelCommandError extends FrontkernelAdapterError {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: number,
    readonly help?: string,
  ) {
    super(message);
    this.name = 'FrontkernelCommandError';
  }
}

/**
 * 契约漂移：响应格式与本适配器记录的版本不符。
 *
 * 单独成类而不是并进 `前置内核CommandError`，是因为这条要能触发告警与人工复核，
 * 而不是被当成一次普通的命令失败重试掉。
 */
export class FrontkernelContractDriftError extends FrontkernelAdapterError {
  constructor(
    message: string,
    readonly expectedFormat: string,
    readonly actualFormat: unknown,
  ) {
    super(message, { expectedFormat, actualFormat });
    this.name = 'FrontkernelContractDriftError';
  }
}

/** 命令输出不是可解析的 JSON。 */
export class FrontkernelProtocolError extends FrontkernelAdapterError {
  constructor(message: string, detail?: unknown) {
    super(message, detail);
    this.name = 'FrontkernelProtocolError';
  }
}
