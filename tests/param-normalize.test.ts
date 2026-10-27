import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeModelParams, type SettingValue } from '@qiyin/canvas-adapter';
import type { CanvasModelSchemaResult } from '@qiyin/canvas-adapter';

/* ============================================================
   参数按模型 schema 收敛。

   这不是"更严谨一点"，而是**必需**：CLI 会因为
   "键不认识 / 取值不在枚举里"直接拒绝整条 `node create`（实测，2026-09）：

     · `-s sequential=1`      → 校验失败：params 顶层不允许设置未知字段「sequential」
     · `-s resolution=1080P`  → 校验失败：不在允许范围。可选: 480p, 720p, 1080p

   而我们的参数字典是从**网页端**扒的，那边写的是 `1080P`。
   ============================================================ */

/**/
const schema = (JSON.parse(
  readFileSync(new URL('./fixtures/canvas-model-star-video-2.5.json', import.meta.url), 'utf8'),
) as CanvasModelSchemaResult).schema;

const normalize = (settings: Record<string, SettingValue>) => normalizeModelParams(settings, schema);

describe('取值规范化（大小写差异是实测出来的）', () => {
  it('网页端的 `1080P` 会被写成 CLI 认的 `1080p`', () => {
    const result = normalize({ resolution: '1080P' });
    expect(result.accepted).toEqual({ resolution: '1080p' });
    expect(result.adjusted).toEqual([{ key: 'resolution', from: '1080P', to: '1080p', why: 'enum' }]);
  });

  it('已经是对的就原样发（不产生多余的"调整"记录）', () => {
    const result = normalize({ resolution: '720p', ratio: '9:16' });
    expect(result.accepted).toEqual({ resolution: '720p', ratio: '9:16' });
    expect(result.adjusted).toEqual([]);
  });

  it('枚举里没有的取值**丢掉**（硬发的结果是整条 create 失败）', () => {
    const result = normalize({ resolution: '4K' });
    expect(result.accepted).toEqual({});
    expect(result.droppedKeys).toEqual(['resolution']);
  });

  it('比例这种枚举项两种写法都认（value 与 displayName）', () => {
    /* ratio 的枚举里 `adaptive` 带 displayName「Auto」 */
    expect(normalize({ ratio: 'adaptive' }).accepted).toEqual({ ratio: 'adaptive' });
    expect(normalize({ ratio: 'Auto' }).accepted).toEqual({ ratio: 'adaptive' });
    expect(normalize({ ratio: '16:9' }).accepted).toEqual({ ratio: '16:9' });
  });
});

describe('键的过滤', () => {
  it('该模型没有的键一概丢掉，并如实报告', () => {
    const result = normalize({ ratio: '9:16', sequential: 1, '不存在的参数键': 42 });
    expect(result.accepted).toEqual({ ratio: '9:16' });
    expect(result.droppedKeys).toEqual(['sequential', '不存在的参数键']);
  });

  it('画布结构字段永远放行（CLI 自己就点名允许 model / prompt / count）', () => {
    const result = normalize({ model: 'Seedance 2.5', prompt: 'x', count: 1, modeType: 'singleImage2video' });
    expect(result.accepted).toEqual({
      model: 'Seedance 2.5', prompt: 'x', count: 1, modeType: 'singleImage2video',
    });
    expect(result.droppedKeys).toEqual([]);
  });

  it('按 originalField 也能对上（属性键与提交名不同的情况）', () => {
    /* 夹具里 resolution 的 originalField 就是 resolution，这里换成真会不同的那一类：
       prompt 的 originalField 是 prompt；用一个"属性键 ≠ originalField"的字段来验太依赖夹具，
       所以直接验 originalField 命中时不丢——用 enableSound（originalField 同名）走一遍。 */
    const result = normalize({ enableSound: 'on' });
    expect(result.accepted).toEqual({ enableSound: 'on' });
  });
});

describe('数字按 min/max 夹取', () => {
  it('时长超过上限会被夹到上限（而不是发出去让 CLI 拒）', () => {
    /* 夹具里 duration 是 min 4 / max 30 / step 1 */
    const result = normalize({ duration: 99 });
    expect(result.accepted).toEqual({ duration: 30 });
    expect(result.adjusted).toEqual([{ key: 'duration', from: 99, to: 30, why: 'clamp' }]);
  });

  it('区间内的数字原样发', () => {
    expect(normalize({ duration: 5 }).accepted).toEqual({ duration: 5 });
  });
});

describe('拿不到 schema 时原样放行', () => {
  it('不懂就不拦：宁可让 CLI 报它自己的错，也不在这里把参数悄悄删掉', () => {
    const result = normalizeModelParams({ sequential: 1, ratio: '9:16' }, undefined);
    expect(result.accepted).toEqual({ sequential: 1, ratio: '9:16' });
    expect(result.droppedKeys).toEqual([]);
  });

  it('没有参数时给出空结果（不是 undefined）', () => {
    expect(normalizeModelParams(undefined, schema)).toEqual({ accepted: {}, droppedKeys: [], adjusted: [] });
  });
});
