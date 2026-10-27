import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/* ============================================================
  期音科技 · 元素组合（跨图框选元素 → 合成一张新图）
   ------------------------------------------------------------
  对应矩阵 IMG-006「焦点编辑（跨图框选元素组合）」。

  对标依据是 小QTV 线上词条里那一组：

    imgToolbarEditElements   = 编辑元素
    imageLayerMerge          = 合并
    imageLayerMergeSuccess   = 图层合并完成
    imageLayerMergeFailed    = 图层合并失败，请重试
    openingTextMergeHint     = 添加文字并调整样式，确认后合并生成新图片（**不消耗积分**）

  最后那句是这一层存在的理由：**合成是本机加工，不花钱**。
  所以它不该走生成后端、不该占预算、也不该等模型——它就是 ffmpeg 的 crop + overlay。

  边界（与音频分离那条一样，必须一起交出去）：

    · 这是**像素拼装**，不是"模型把两个元素融合成一张自然的图"。边缘、光影、
      透视都不会自动对齐；要那种效果得走生成后端（局部重绘）。
    · 顺序即语义：图层按给定顺序自下而上叠，后一个盖住前一个。
   ============================================================ */

export function describeCompositeLimits(): string {
  return '元素组合是本机像素拼装（不消耗积分、不调用模型）：把框选的元素按顺序叠到画布上，'
    + '不做光影/透视融合。要"融进画面"的效果请走局部重绘那条路。';
}

export interface CompositeLayer {
  /** 源图绝对路径 */
  file: string;
  /** 源图上的框选区域（像素） */
  crop: { x: number; y: number; width: number; height: number };
  /** 放到画布上的位置（像素，左上角） */
  at: { x: number; y: number };
  /** 缩放（1 = 原样）。省略即 1。 */
  scale?: number;
}

export interface CompositeRequest {
  canvas: { width: number; height: number; color?: string };
  /** **自下而上**：数组第一个在最底下 */
  layers: readonly CompositeLayer[];
  outputPath: string;
}

export interface CompositePlan {
  args: string[];
  notes: string[];
}

/**
 * 拼出 ffmpeg 参数。

 * 纯函数：界面可以用它预告"会做成什么样"，主进程用它去跑——同一份计划，
 * 不会出现"界面画的是一个样、跑出来是另一个样"。

 * 越界的东西一律**钳进画布并记一条 note**：裁掉的图层看起来"成功"了，
 * 而用户拿到的是缺一块的图，那种失败最难发现。
 */
export function planElementComposite(request: CompositeRequest): CompositePlan {
  const notes: string[] = [];
  const width = Math.max(2, Math.round(request.canvas.width));
  const height = Math.max(2, Math.round(request.canvas.height));
  if (request.layers.length === 0) throw new Error('没有可组合的元素：先在图上框选至少一处');

  const filters: string[] = [];
  const inputs: string[] = [];
  /* 先铺一层底色：透明画布导出 PNG 会有 alpha，很多下游（贴图、导出）不认 */
  filters.push(`color=c=${request.canvas.color ?? 'black'}:s=${width}x${height}[base]`);
  let last = 'base';

  request.layers.forEach((layer, index) => {
    if (!existsSync(layer.file)) throw new Error(`第 ${index + 1} 个元素的源文件不在：${layer.file}`);
    const cropWidth = Math.max(1, Math.round(layer.crop.width));
    const cropHeight = Math.max(1, Math.round(layer.crop.height));
    const scale = layer.scale === undefined || !Number.isFinite(layer.scale) || layer.scale <= 0 ? 1 : layer.scale;
    const drawWidth = Math.max(1, Math.round(cropWidth * scale));
    const drawHeight = Math.max(1, Math.round(cropHeight * scale));
    /* 位置钳进画布：越界时记一条 note，让用户知道它被挪过 */
    const rawX = Math.round(layer.at.x);
    const rawY = Math.round(layer.at.y);
    const x = Math.min(Math.max(0, rawX), Math.max(0, width - drawWidth));
    const y = Math.min(Math.max(0, rawY), Math.max(0, height - drawHeight));
    if (x !== rawX || y !== rawY) {
      notes.push(`第 ${index + 1} 个元素放在画布外，已挪到 (${x}, ${y})`);
    }
    if (drawWidth > width || drawHeight > height) {
      notes.push(`第 ${index + 1} 个元素比画布还大（${drawWidth}×${drawHeight}），会被画布裁掉一部分`);
    }

    inputs.push('-i', layer.file);
    const inputIndex = index + 1;
    const label = `L${index}`;
    filters.push(
      `[${inputIndex}:v]crop=${cropWidth}:${cropHeight}:${Math.max(0, Math.round(layer.crop.x))}:${Math.max(0, Math.round(layer.crop.y))}`
        + `,scale=${drawWidth}:${drawHeight}[${label}]`,
    );
    const out = `ov${index}`;
    filters.push(`[${last}][${label}]overlay=${x}:${y}:format=auto[${out}]`);
    last = out;
  });
  filters.push(`[${last}]format=yuv420p[outv]`);

  return {
    args: [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      /*
        画布底色是**第 0 路输入**（lavfi 的 color 源），图层从第 1 路开始。
        一开始漏了这一路，ffmpeg 会把 `-f lavfi` 当成给第一个图层文件的格式说明，
        报一句离起因很远的错——把输入顺序写在这里，免得再踩。
      */
      '-f', 'lavfi', '-i', `color=c=${request.canvas.color ?? 'black'}:s=${width}x${height}`,
      ...inputs,
      '-filter_complex', filters.join(';'),
      '-map', '[outv]', '-frames:v', '1', '-y', request.outputPath,
    ],
    notes,
  };
}

export type CompositeResult =
  | { ok: true; bytes: number; notes: string[] }
  | { ok: false; reason: string };

export async function composeElements(request: CompositeRequest): Promise<CompositeResult> {
  let plan: CompositePlan;
  try {
    plan = planElementComposite(request);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  mkdirSync(dirname(request.outputPath), { recursive: true });
  rmSync(request.outputPath, { force: true });
  const result = await run('ffmpeg', plan.args, 5 * 60_000);
  if (!result.ok) return { ok: false, reason: result.error || 'ffmpeg 执行失败' };
  if (!existsSync(request.outputPath)) return { ok: false, reason: 'ffmpeg 报成功，但没有产出文件' };
  const bytes = statSync(request.outputPath).size;
  if (bytes === 0) return { ok: false, reason: '组合产出了空文件' };
  return { ok: true, bytes, notes: [...plan.notes, describeCompositeLimits()] };
}

function run(command: string, args: readonly string[], timeout: number): Promise<{ ok: boolean; error: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) return resolve({ ok: true, error: '' });
      const tail = String(stderr ?? '').trim().split('\n').slice(-3).join(' ').trim();
      return resolve({ ok: false, error: tail || '命令执行失败' });
    });
  });
}
