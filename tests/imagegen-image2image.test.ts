import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createImageGenAdapter,
  createImageGenBackend,
  type ImageGenRunRequest,
  type ImageGenRunner,
} from '@qiyin/imagegen-adapter';

/* ============================================================
   即梦的图生图。

   参考图这条路在两家 CLI 上完全不同：
     即梦   另一个子命令 `image2image --images=<路径>`
   所以差异必须由后端吃掉，上层只说"用这张参考图"。

   这个文件盯的是**参数真的传对了**：`image2image` 的子命令名、
   `--images` 的完整路径、以及清晰度档位的合法集合
   （`imagegen image2image -h` 写明 4.0–5.0 只认 2k|4k，没有 1k）。
   出图效果要真花钱才能验，不在这一层。
   ============================================================ */

function fakeRunner(): { runner: ImageGenRunner; calls: ImageGenRunRequest[] } {
  const calls: ImageGenRunRequest[] = [];
  const runner: ImageGenRunner = {
    async run(request: ImageGenRunRequest) {
      calls.push(request);
      const sub = request.args[0];
      if (sub === 'image2image' || sub === 'text2image') {
        return { code: 0, stdout: JSON.stringify({ submit_id: 's-1', gen_status: 'success', credit_count: 3 }), stderr: '' };
      }
      if (sub === 'query_result') {
        const file = join(tmpdir(), 'imagegen-i2i.png');
        writeFileSync(file, Buffer.from('PNG:imagegen'), 'utf8');
        return {
          code: 0, stderr: '',
          stdout: JSON.stringify({
            submit_id: 's-1', gen_status: 'success',
            result_json: { images: [{ path: file, width: 1024, height: 1024 }] },
          }),
        };
      }
      return { code: 1, stdout: '', stderr: 'error: unexpected\n' };
    },
  };
  return { runner, calls };
}

function backend() {
  const { runner, calls } = fakeRunner();
  return {
    calls,
    backend: createImageGenBackend(createImageGenAdapter({ runner }), { submitPollSeconds: 0 }),
  };
}

describe('即梦图生图', () => {
  it('给了参考图就走 image2image，并把完整路径放进 --images', async () => {
    const { backend: b, calls } = backend();
    const reference = join(tmpdir(), 'blueprint-shot-01.png');
    await b.generateImage({
      prompt: '按蓝图构图',
      model: '5.0',
      quality: '2K',
      ratio: '16:9',
      outputDir: mkdtempSync(join(tmpdir(), 'qiyin-i2i-')),
      label: 'shot-01',
      referenceImageFile: reference,
    });

    const submit = calls.find((call) => call.args[0] === 'image2image');
    expect(submit).toBeTruthy();
    expect(submit?.args).toContain(`--images=${reference}`);
    expect(submit?.args).toContain('--resolution_type=2k');
    /* 绝不能同时发两条提交：那会花两次钱、出两组图 */
    expect(calls.some((call) => call.args[0] === 'text2image')).toBe(false);
  });

  it('没有参考图走 text2image（两条路不会混）', async () => {
    const { backend: b, calls } = backend();
    await b.generateImage({
      prompt: '自由发挥',
      model: '5.0',
      quality: '2K',
      outputDir: mkdtempSync(join(tmpdir(), 'qiyin-t2i-')),
      label: 'shot-02',
    });
    expect(calls.some((call) => call.args[0] === 'text2image')).toBe(true);
    expect(calls.some((call) => call.args[0] === 'image2image')).toBe(false);
  });

  it('清晰度按模型夹取：image2image 不接受 1k，被换成 2k 而不是照传', async () => {
    const { backend: b, calls } = backend();
    await b.generateImage({
      prompt: 'p',
      model: '5.0',
      /* 我们内部统一写 `1K`；即梦的图生图只认 2k|4k */
      quality: '1K',
      outputDir: mkdtempSync(join(tmpdir(), 'qiyin-i2i-')),
      label: 'shot-03',
      referenceImageFile: join(tmpdir(), 'ref.png'),
    });
    const submit = calls.find((call) => call.args[0] === 'image2image');
    expect(submit?.args).toContain('--resolution_type=2k');
    expect(submit?.args.some((arg) => arg.includes('1k'))).toBe(false);
  });

  it('5.0Pro 允许 1.5k：合法值不该被一起换掉', async () => {
    const { backend: b, calls } = backend();
    await b.generateImage({
      prompt: 'p',
      model: '5.0Pro',
      quality: '1.5K',
      outputDir: mkdtempSync(join(tmpdir(), 'qiyin-i2i-')),
      label: 'shot-04',
      referenceImageFile: join(tmpdir(), 'ref.png'),
    });
    const submit = calls.find((call) => call.args[0] === 'image2image');
    expect(submit?.args).toContain('--resolution_type=1.5k');
  });
});
