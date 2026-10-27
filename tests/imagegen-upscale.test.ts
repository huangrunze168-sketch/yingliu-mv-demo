import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createImageGenAdapter,
  createImageGenBackend,
  UPSCALE_RESOLUTIONS,
  type ImageGenRunRequest,
  type ImageGenRunner,
} from '@qiyin/imagegen-adapter';

/* ============================================================
  即梦的图片高清放大（`imagegen image_upscale`）。

  参数依据是**真实的命令帮助**：

    Usage: imagegen image_upscale [flags]
      --image string             local input image path
      --resolution_type string   supported values: 2k, 4k, 8k
      --poll int                 submit then poll query_result for up to N seconds

  这份测试盯两件事：
   ① 命令形状（子命令名 + 参数名 + 本地绝对路径）；
   ② **档位夹取**——那个字段必填且严格校验，给错值会在提交之后被拒，
      而那时用户已经等了一轮。
   ============================================================ */

function fakeRunner(): { runner: ImageGenRunner; calls: ImageGenRunRequest[] } {
  const calls: ImageGenRunRequest[] = [];
  const runner: ImageGenRunner = {
    async run(request: ImageGenRunRequest) {
      calls.push(request);
      const sub = request.args[0];
      if (sub === 'image_upscale') {
        return { code: 0, stdout: JSON.stringify({ submit_id: 'u-1', gen_status: 'success', credit_count: 3 }), stderr: '' };
      }
      if (sub === 'query_result') {
        const dir = request.args.find((arg) => arg.startsWith('--download_dir='))?.split('=')[1] ?? tmpdir();
        const file = join(dir, 'upscaled.png');
        writeFileSync(file, Buffer.from('PNG:upscaled'), 'utf8');
        return {
          code: 0, stderr: '',
          stdout: JSON.stringify({
            submit_id: 'u-1', gen_status: 'success', credit_count: 3,
            result_json: { images: [{ path: file, width: 4096, height: 4096, image_url: 'https://example.test/up.png' }] },
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
  return { backend: createImageGenBackend(createImageGenAdapter({ runner, executable: 'imagegen' })), calls };
}

describe('即梦·图片高清放大', () => {
  it('命令形状：image_upscale + 本地路径 + resolution_type', async () => {
    const { backend: b, calls } = backend();
    const image = join(tmpdir(), 'up-source.png');
    writeFileSync(image, Buffer.from('PNG:small'), 'utf8');
    const media = await b.upscaleImage({
      imageFile: image,
      resolution: '4k',
      outputDir: mkdtempSync(join(tmpdir(), 'qiyin-up-')),
      label: 'shot-01-upscale',
    });

    const submit = calls.find((call) => call.args[0] === 'image_upscale');
    expect(submit?.args).toContain(`--image=${image}`);
    expect(submit?.args).toContain('--resolution_type=4k');
    /* 结果落的是 CLI 写回的本地路径，而不是我们拼的名字 */
    expect(media.files[0]?.endsWith('upscaled.png')).toBe(true);
    expect(media.cost).toEqual({ unit: 'credit', amount: 3 });
    expect(media.task_ref).toBe('u-1');
  });

  it('档位写成大写也能用（界面上的 2K / 4K 会被折成小写）', async () => {
    const { backend: b, calls } = backend();
    await b.upscaleImage({
      imageFile: join(tmpdir(), 'up-source.png'),
      resolution: '4K',
      outputDir: mkdtempSync(join(tmpdir(), 'qiyin-up-')),
      label: 'shot-02-upscale',
    });
    expect(calls.find((call) => call.args[0] === 'image_upscale')?.args).toContain('--resolution_type=4k');
  });

  it('档位不在 2k/4k/8k 里时夹到 2k，而不是把错值传给上游', async () => {
    /*
      传一个它不认的值，用户要先等一轮提交、再收到一句参数错误。
      所以这一层必须先把值收进合法集合（2k 是最便宜的一档，拿它兜底）。
    */
    const { backend: b, calls } = backend();
    await b.upscaleImage({
      imageFile: join(tmpdir(), 'up-source.png'),
      resolution: '16k',
      outputDir: mkdtempSync(join(tmpdir(), 'qiyin-up-')),
      label: 'shot-03-upscale',
    });
    expect(calls.find((call) => call.args[0] === 'image_upscale')?.args).toContain('--resolution_type=2k');
  });

  it('档位清单与 CLI 帮助里那三个一致（写死在这里，防止悄悄加档）', () => {
    expect([...UPSCALE_RESOLUTIONS]).toEqual(['2k', '4k', '8k']);
  });
});
