/* ============================================================
  期音科技 · **仅测试用**的本地假后端
  ------------------------------------------------------------
  为什么要有它：生成这条主链路（提交 → 出图 → 入库 → 画布贴图 → 回执）
  一直**没法端到端验证**——真跑一次要花用户的钱。于是只能验失败路径
  （没预算 / 闸门没批 / 没挂镜头），而"成功那次到底对不对"全靠读代码。

  这个后端把那条路补齐：它产出**真的 PNG 文件**（像素由提示词算出来，
  所以每镜的内容哈希不同、候选不会互相顶掉），然后走**完全同一条**领域链路
  （入库、候选、画布贴图、回执计数）。

  四条硬规矩，缺一条它就会变成"假装能生成"：
    ① **只在 `QIYIN_STUB_BACKEND=1` 时可用**（正常运行下它连选项都不出现）；
    ② label 里写明「仅测试用，不出真图」——它出现在界面上，用户看得见；
    ③ 每次产出都带一条 `notes`：**这是占位图，不是模型产出**。
       `notes` 会一路显示到生成回执里，用户不会把它当作品；
    ④ 报 `cost: 0`——它真的不花钱，账目上也不该记钱。
  ============================================================ */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import {
  UnsupportedCapabilityError,
  type BackendAudioRequest,
  type BackendImageRequest,
  type BackendMedia,
  type GenerationBackend,
} from '@qiyin/generation-backend';

export const STUB_BACKEND_ID = 'stub';
export const STUB_BACKEND_LABEL = '本地假后端（仅测试用，不出真图）';
export const STUB_BACKEND_NOTE =
  '这是本地假后端生成的占位图：像素由提示词哈希算出来，不是模型产出，也不代表任何真实风格';

/** 只有明确开了这个开关，假后端才会被装配出来（默认关着） */
export function stubBackendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QIYIN_STUB_BACKEND === '1';
}

/**
 * 每一镜假装跑多久（毫秒，默认 0）。
 *
 * 为什么需要它：真后端一镜要几十秒到几分钟，而假后端是**瞬间**返回的——
 * 于是"生成期间的心跳"这件事在真机上根本观测不到（还没来得及看就跑完了）。
 * 这个旋钮只给验证用：`QIYIN_STUB_DELAY_MS=1500` 之后，逐镜进度就能被看见。
 */
export function stubDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.QIYIN_STUB_DELAY_MS ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 10_000) : 0;
}

/* ---------- 一个够用的 PNG 编码器 ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * 按一串字节画一张纯色 PNG（宽高固定 512×512）。
 *
 * 自己编码而不是塞一段固定的 base64：**内容必须跟着提示词变**。
 * 否则同一批多个镜头会产出同一份字节 → 同一个内容哈希 → 同一个 artifact，
 * 候选之间互相顶掉，验出来的"出了几张"就是假的。
 */
function encodePng(seed: Uint8Array, width = 512, height = 512): Buffer {
  const [r, g, b] = [seed[0] ?? 0, seed[1] ?? 0, seed[2] ?? 0];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; /* 每行的过滤器字节：0 = None */
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      /* 竖条纹，让这张图一眼能看出不是真照片 */
      const band = ((x >> 4) & 1) === 0 ? 0 : 28;
      raw[at] = Math.min(255, r + band);
      raw[at + 1] = Math.min(255, g + band);
      raw[at + 2] = Math.min(255, b + band);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   /* 位深 */
  ihdr[9] = 2;   /* 颜色类型：真彩色 */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function createStubBackend(): GenerationBackend {
  return {
    id: STUB_BACKEND_ID,
    label: STUB_BACKEND_LABEL,
    capabilities: {
      image: true,
      videoFromImage: false,
      videoEdit: false,
      imageShortcut: false,
      imageUpscale: false,
      /* 假后端也不假装会做音频 */
      audioSpeech: false,
      audioMusic: false,
    },

    async generateAudio(request: BackendAudioRequest): Promise<BackendMedia> {
      throw new UnsupportedCapabilityError(this.label, request.kind === 'music' ? 'audioMusic' : 'audioSpeech');
    },

    async generateImage(request: BackendImageRequest): Promise<BackendMedia> {
      /* 假装跑一会儿（只在验证心跳时打开，见 stubDelayMs 的说明） */
      const delay = stubDelayMs();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      /* 同一个提示词 + 同一个镜头 → 同一张图（可重复，便于对账） */
      const digest = createHash('sha256')
        .update(`${request.model}\n${request.prompt}\n${request.label}`)
        .digest();
      const file = join(request.outputDir, `stub-${request.label}-${digest.toString('hex').slice(0, 12)}.png`);
      writeFileSync(file, encodePng(digest));
      return {
        files: [file],
        source_url: null,
        task_ref: `stub-${digest.toString('hex').slice(0, 8)}`,
        cost: { amount: 0, unit: 'cent' },
        notes: [STUB_BACKEND_NOTE],
      };
    },

    async generateVideoFromImage(): Promise<BackendMedia> {
      throw new UnsupportedCapabilityError(STUB_BACKEND_LABEL, 'videoFromImage');
    },
    async editVideo(): Promise<BackendMedia> {
      throw new UnsupportedCapabilityError(STUB_BACKEND_LABEL, 'videoEdit');
    },
    async applyImageShortcut(): Promise<BackendMedia> {
      throw new UnsupportedCapabilityError(STUB_BACKEND_LABEL, 'imageShortcut');
    },
    async upscaleImage(): Promise<BackendMedia> {
      throw new UnsupportedCapabilityError(STUB_BACKEND_LABEL, 'imageUpscale');
    },
  };
}
