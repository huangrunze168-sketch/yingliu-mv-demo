import { describe, expect, it } from 'vitest';
import { validateVideoModeReferences } from '@qiyin/contracts';
const schema = { config: { settings: Object.fromEntries(['text2video', 'singleImage2video', 'frames2video', 'image2video', 'mixed2video', 'videoEdit2video'].map(mode => [mode, []])) }, properties: { modeType: { items: { singleImage2video: [1, 1], frames2video: [1, 2], image2video: [1, 30], mixed2video: [1, 50], videoEdit2video: [1, 1] }, mixed2videoConfig: { videoMax: 10, imageMax: 30, audioMax: 10 }, videoEdit2videoConfig: { videoMax: 1, imageMaxWithVideo: 30 } } } };
describe('官方视频模式引用规则', () => {
  it('按 schema 模式范围和媒体类型，而不是统一要求至少一张图片', () => {
    expect(validateVideoModeReferences(schema, 'text2video', [])).toBeNull();
    expect(validateVideoModeReferences(schema, 'text2video', ['image/'])).toContain('不能连接');
    expect(validateVideoModeReferences(schema, 'singleImage2video', ['image/', 'image/'])).toContain('1–1');
    expect(validateVideoModeReferences(schema, 'singleImage2video', ['video/'])).toContain('仅接受图片');
    expect(validateVideoModeReferences(schema, 'frames2video', ['image/', 'image/'])).toBeNull();
    expect(validateVideoModeReferences(schema, 'image2video', ['image/', 'video/'])).toContain('仅接受图片');
    expect(validateVideoModeReferences(schema, 'mixed2video', ['audio/', 'image/'])).toBeNull();
    expect(validateVideoModeReferences(schema, 'videoEdit2video', ['video/'])).toBeNull();
    expect(validateVideoModeReferences(schema, 'videoEdit2video', ['video/', 'image/'])).toBeNull();
    expect(validateVideoModeReferences(schema, 'videoEdit2video', ['video/', 'video/'])).toContain('1–1');
  });
  it('未接入模式、缺失 schema 和未知类型都拒绝', () => {
    expect(validateVideoModeReferences(schema, 'videoExtend2video', ['video/'])).toContain('尚未');
    expect(validateVideoModeReferences({}, 'singleImage2video', ['image/'])).toContain('未提供');
    expect(validateVideoModeReferences(schema, 'mixed2video', ['application/pdf'])).toContain('不支持');
  });
});
