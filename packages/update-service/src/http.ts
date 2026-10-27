/* ============================================================
  期音科技 · 更新的网络这一层
   ------------------------------------------------------------
  只有两件事：拉清单（JSON）与把一个文件写到本地。

  为什么单独抽一个文件：验收用例不该联网（跑得快、结果确定），
  而在真实环境里这一层要处理超时、断线、HTTP 状态码。
  把可注入的接口留在一边、真实实现留在另一边，
  "不联网也能验收更新器"才成立。

  暂停的语义写在这里：**停在数据块的边界上**，把已经落盘的字节保留着，
  然后如实返回 `paused: true`。恢复时从文件头重下——
  不做 Range 续传，因为要支持断点续传就得信任服务端的 Content-Range，
  而那是一条容易写错、错了又很难发现的路径。宁可多下一次。
   ============================================================ */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { UpdateError } from './errors.js';
import type { FetchFileOptions, FetchFileResult, UpdateFetch } from './service.js';

export interface HttpFetchOptions {
  /** 单次请求超时（毫秒），默认 30 秒 */
  timeoutMs?: number;
  /** 允许注入 fetch（Electron 主进程里就是全局 fetch） */
  fetchImpl?: typeof fetch;
}

export function createHttpFetch(options: HttpFetchOptions = {}): UpdateFetch {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async readJson(url: string): Promise<unknown> {
      const response = await request(doFetch, url, timeoutMs);
      if (!response.ok) {
        throw new UpdateError('UPDATE_DOWNLOAD_FAILED', `拉取更新清单失败：HTTP ${response.status}`, { url, status: response.status });
      }
      try {
        return await response.json();
      } catch (error) {
        throw new UpdateError('UPDATE_MANIFEST_INVALID', `更新清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, { url });
      }
    },

    async writeToFile(url: string, targetPath: string, fileOptions: FetchFileOptions = {}): Promise<FetchFileResult> {
      const response = await request(doFetch, url, timeoutMs);
      if (!response.ok) {
        throw new UpdateError('UPDATE_DOWNLOAD_FAILED', `下载失败：HTTP ${response.status}`, { url, status: response.status });
      }
      if (response.body === null) {
        throw new UpdateError('UPDATE_DOWNLOAD_FAILED', '下载失败：响应没有内容', { url });
      }
      const declaredTotal = Number(response.headers.get('content-length') ?? '0');
      mkdirSync(dirname(targetPath), { recursive: true });

      const stream = createWriteStream(targetPath, { flags: 'w' });
      let received = 0;
      let paused = false;
      try {
        for await (const chunk of response.body) {
          if (fileOptions.shouldPause?.() === true) {
            paused = true;
            break;
          }
          const buffer = Buffer.from(chunk as Uint8Array);
          received += buffer.length;
          if (!stream.write(buffer)) {
            await new Promise<void>((resolve) => stream.once('drain', () => resolve()));
          }
          fileOptions.onProgress?.(received, declaredTotal);
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
        });
        if (paused && typeof response.body.cancel === 'function') {
          /* 用户按了暂停：把响应体关掉，别让连接挂着 */
          await response.body.cancel().catch(() => undefined);
        }
      }
      return { bytes: received, paused };
    },
  };
}

async function request(doFetch: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { signal: controller.signal, redirect: 'follow' });
  } catch (error) {
    throw new UpdateError('UPDATE_DOWNLOAD_FAILED', `请求失败：${error instanceof Error ? error.message : String(error)}`, { url });
  } finally {
    clearTimeout(timer);
  }
}
