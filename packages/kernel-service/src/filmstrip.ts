/* ============================================================
   逐帧拉片：抽哪些时间点
   ------------------------------------------------------------
     nodeTypeShotBreakdown=逐帧拉片 · shotBreakdownStart=开始拉片 · shotBreakdownRunning=拉片中

   "拉片"是把一段视频摊开成若干帧来看。抽哪些时间点是这一层唯一要决定的事，
   而它**只有一条规则值得讲清楚**：见下面 `planFrameTimes` 的注释。

   纯函数：不碰文件、不碰内核，才能单独验它。
   ============================================================ */

/** 一次拉片最多抽这么多帧。再多就应该分段拉了——面板也放不下。 */
export const FILMSTRIP_MAX_FRAMES = 60;

/** 不指定数量时的默认帧数：一屏能看完，也够看清一段的走位。 */
export const FILMSTRIP_DEFAULT_FRAMES = 12;

export interface PlanFrameTimesInput {
  /** 素材时长（秒）。非有限或 ≤ 0 时返回空数组。 */
  durationSeconds: number;
  /** 想抽几帧；会被夹到 [1, FILMSTRIP_MAX_FRAMES]。 */
  count: number;
}

/**
 * 沿整段时长均分，**取每一段的中点**。

 * 为什么不取端点：0 秒那一帧在一段真实素材里常常是片头黑场或台标，
 * 最后一帧常常是片尾停格。用端点抽出来的"第一帧/最后一帧"看着像坏掉的图，
 * 而用户会以为是自己选了不合适的素材。
 *
 * 中点也不会让首尾内容丢掉：12 帧覆盖的是一段一段的中点，
 * 视觉上仍然铺满整段；而"这一段里到底发生了什么"恰恰是中点最清楚。
 */
export function planFrameTimes(input: PlanFrameTimesInput): number[] {
  const duration = input.durationSeconds;
  if (!Number.isFinite(duration) || duration <= 0) return [];

  const count = Math.min(
    FILMSTRIP_MAX_FRAMES,
    Math.max(1, Number.isFinite(input.count) ? Math.round(input.count) : FILMSTRIP_DEFAULT_FRAMES),
  );

  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const seconds = duration * ((index + 0.5) / count);
    /* 三位小数：毫秒级精度对"看一帧"没有意义，但会让时间码显示得很脏 */
    times.push(Number(seconds.toFixed(3)));
  }
  return times;
}
