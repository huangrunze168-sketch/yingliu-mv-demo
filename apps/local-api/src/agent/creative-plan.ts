import { z } from 'zod';
import type { ShotField } from '@qiyin/contracts';

const shot = z.object({
  id: z.string().regex(/^shot-(?:0[1-9]|1[0-2])$/, '镜头编号必须为 shot-01 至 shot-12'),
  title: z.string().trim().min(1).max(80),
  visual: z.string().trim().min(1).max(800),
  narration: z.string().trim().max(400),
  durationSeconds: z.number().int().min(1).max(60),
});

export const creativePlanSchema = z.object({
  kind: z.literal('plan'),
  title: z.string().trim().min(1).max(100),
  direction: z.string().trim().min(1).max(600),
  aspectRatio: z.enum(['9:16', '16:9', '1:1']),
  shots: z.array(shot).min(1).max(12),
}).refine(value => new Set(value.shots.map(item => item.id)).size === value.shots.length, '镜头编号不能重复');

export type CreativePlan = z.infer<typeof creativePlanSchema>;

/** 将已确认的导演方案编译为项目镜头事实；时间轴和镜头 ID 后续用于真实任务及局部重做。 */
export function shotsFromPlan(plan: CreativePlan, author: string): ShotField[] {
  let start = 0;
  return plan.shots.map(shot => {
    const duration = shot.durationSeconds * 1000;
    const result: ShotField = {
      shot_id: shot.id, t0_ms: start, t1_ms: start + duration, duration_ms: duration,
      shot_size: 'unknown', camera_position: `${shot.title}（${plan.aspectRatio}）`,
      camera_move: '按镜头画面描述', lighting: plan.direction,
      sound: shot.narration || '无旁白', replacement: shot.visual,
      confidence: 1, source: 'human', author,
    };
    start += duration;
    return result;
  });
}

export function parseCreativePlan(text: string): CreativePlan | null {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!raw.startsWith('{') || raw.length > 8000) return null;
  try {
    const result = creativePlanSchema.safeParse(JSON.parse(raw) as unknown);
    return result.success ? result.data : null;
  } catch { return null; }
}

/** 只规划、不消耗生成额度。模型回应是澄清问句或可验证的 JSON 方案。 */
export function planningPrompt(current: string, history: Array<{ role: string; text: string }>): string {
  const context = history.filter(item => item.role === 'user' || item.role === 'agent' || item.role === 'plan')
    .slice(-8).map(item => `${item.role === 'user' ? '用户' : item.role === 'plan' ? '已有分镜方案（逐镜修改时请保留未提及镜头）' : '小Q'}：${item.text.slice(0, item.role === 'plan' ? 5000 : 1000)}`).join('\n');
  return `你是小QTV视频创作导演。此轮只做创意规划，禁止执行生成、修改文件或调用付费工具。\n已有对话：\n${context}\n用户最新输入：${current}\n如果关键要求缺失且无法合理假设，请只用中文问一个必要的澄清问题，不要输出方案。否则仅输出严格 JSON，无代码围栏、无附言。格式：{"kind":"plan","title":"片名","direction":"风格及制作说明","aspectRatio":"9:16","shots":[{"id":"shot-01","title":"镜头标题","visual":"画面、主体、景别、动作、光线","narration":"旁白或空字符串","durationSeconds":5}]}。允许画幅 9:16、16:9、1:1；1–12 镜；每镜 1–60 秒。不声称已经生成任何图片或视频。`;
}
