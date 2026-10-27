import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  modeInputRange,
  settingsForMode,
  supportedModeTypes,
  type CanvasModelSchemaResult,
} from '@qiyin/canvas-adapter';

/* ============================================================

   在 2026-09 的真实输出（只截取该命令的完整 stdout）。

   为什么值得为它写测试：这两张表决定了"片段重拍能不能提交"与
   "提交时要写哪些参数"。写错了不会报错——CLI 对不认识的 --set 键
   通常是静默忽略——只会表现成"我明明设了却没生效"。
   ============================================================ */

/*
  用 readFileSync 而不是 `import ... from '*.json'`：
  本仓库是 NodeNext，静态 JSON import 需要 `with { type: 'json' }`，
  而那个语法还要看打包器认不认。测试里读文件更直接，也没有额外前提。
*/
const schema = JSON.parse(
  readFileSync(new URL('./fixtures/canvas-model-star-video-2.5.json', import.meta.url), 'utf8'),
) as CanvasModelSchemaResult;

describe('supportedModeTypes', () => {
  it('读出这个模型**需要素材**的那些模式', () => {
    const modes = supportedModeTypes(schema);
    expect(modes).toContain('singleImage2video');
    /*
      这两条是"片段重拍"与"智能续写"能做的**唯一依据**。
      没有它们，界面上那两项就只能靠猜或者点了才知道。
    */
    expect(modes).toContain('videoEdit2video');
    expect(modes).toContain('videoExtend2video');
  });

  it('`text2video` 不在这张表里——它不需要素材（这条被测试逼出来过）', () => {
    /*
      一开始我把 `modeType.items` 当成"该模型支持的全部模式"，
      测试一跑就红了：文生视频不在里面。
      真实含义是「需要输入素材的模式表」，值是该模式的输入数量区间；
      `text2video` 不需要素材，所以只出现在 config.settings 里。
    */
    expect(supportedModeTypes(schema)).not.toContain('text2video');
    expect(settingsForMode(schema, 'text2video')).toContain('duration');
  });

  it('拿不到 schema 时返回空数组——调用方据此说"查不到能力"，而不是当成支持', () => {
    expect(supportedModeTypes({ nameOrId: 'x', modelName: 'x', modelKey: 'x' })).toEqual([]);
    expect(supportedModeTypes({ nameOrId: 'x', modelName: 'x', modelKey: 'x', schema: {} })).toEqual([]);
  });
});

describe('modeInputRange', () => {
  it('重拍恰好要 1 个视频输入', () => {
    expect(modeInputRange(schema, 'videoEdit2video')).toEqual([1, 1]);
  });

  it('图生视频可以给多个参考图', () => {
    expect(modeInputRange(schema, 'image2video')).toEqual([1, 30]);
  });

  it('查不到就返回 null，不假设输入数量', () => {
    expect(modeInputRange(schema, 'text2video')).toBeNull();
    expect(modeInputRange(schema, 'unknown')).toBeNull();
  });
});

describe('settingsForMode', () => {
  it('重拍用的是 duration_auto 与 ratio_auto，不是 duration 与 ratio', () => {
    expect(settingsForMode(schema, 'videoEdit2video'))
      .toEqual(['ratio_auto', 'resolution', 'duration_auto', 'enableSound']);
  });

  it('图生视频用的是 duration 与 ratio——两个模式确实不一样', () => {
    /**/
    expect(settingsForMode(schema, 'singleImage2video'))
      .toEqual(['ratio', 'resolution', 'duration', 'enableSound']);
  });

  it('没登记的模式返回空数组，不编一套默认参数', () => {
    expect(settingsForMode(schema, 'someUnknownMode')).toEqual([]);
  });
});
