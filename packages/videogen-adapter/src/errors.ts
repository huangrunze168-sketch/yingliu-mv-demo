/* ============================================================
  期音科技 · 视频生成服务 适配器的失败分类
   ------------------------------------------------------------
   视频生成服务 的官方 skill（`videogenai/videogen-skill`）会把**四种完全不同的情况**
   混在一条命令里返回，而这四种对用户的意义差得很远：

     ① 没配 AK/SK            → 用户自己能修（去 视频生成服务 平台拿 key）
     ② 命令跑失败            → 看 stderr
     ③ 跑完了但**没有产物**   → 内容审核拒了 / 超时 / 模型压根没调生成工具
                               （对方自己的判据是 `generation_succeeded: false`）
     ④ 跑完了、**卡在等人确认** → 它那边有 `final_status: pending_confirmation`，
                               这一步很可能涉及付费，**不能当成功**

   把这四种分出来，界面才能给出"下一步该做什么"，而不是一律"生成失败"。
   ============================================================ */

/** ① 缺凭据：`LOVART_ACCESS_KEY` / `LOVART_SECRET_KEY`（或 `--ak` / `--sk`）。 */
export class VideogenCredentialError extends Error {
  constructor(readonly detail: string) {
    super(`视频生成服务 没配凭据：${detail}（到 视频生成服务 平台的头像菜单 → AK/SK Management 拿，然后设 LOVART_ACCESS_KEY / LOVART_SECRET_KEY）`);
    this.name = 'VideogenCredentialError';
  }
}

/** ② 命令失败（非零退出，且不是上面那两种可识别的形态）。 */
export class VideogenCommandError extends Error {
  constructor(readonly code: number, readonly stderrTail: string, readonly args: readonly string[]) {
    super(`videogen 命令失败（退出码 ${code}）：${stderrTail.length > 0 ? stderrTail : args.join(' ')}`);
    this.name = 'VideogenCommandError';
  }
}

/** ③ 跑完了但没有产物——原样带上它给的 warning 与 agent 说的话。 */
export class VideogenNoArtifactError extends Error {
  constructor(readonly threadId: string, readonly warning: string | null, readonly agentMessage: string | null) {
    const why = warning ?? agentMessage ?? '这一轮没有产出任何文件';
    super(`视频生成服务 跑完了，但没有产物：${why}`);
    this.name = 'VideogenNoArtifactError';
  }
}

/**
 * ④ 卡在等人确认。
 *
 * 这不是失败——对方在 `pending_confirmation` 里给了要确认的内容，
 * 但我们**不替用户点那个确认**（可能涉及付费）。所以把它作为一个明确的、
 * 带数据的错误抛出来，由界面问用户。
 */
export class VideogenPendingConfirmationError extends Error {
  constructor(readonly threadId: string, readonly pending: unknown) {
    super(`视频生成服务 这一轮在等你确认（thread ${threadId}）：确认后才会继续`);
    this.name = 'VideogenPendingConfirmationError';
  }
}

/** 返回体不是我们认识的形状——协议漂移，应当显式暴露而不是当空结果。 */
export class VideogenProtocolError extends Error {
  constructor(readonly detail: string, readonly raw: string) {
    super(`videogen 输出看不懂（协议可能变了）：${detail}`);
    this.name = 'VideogenProtocolError';
  }
}
