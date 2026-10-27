/**
 *
 * 默认跳过：完整启动嵌入式 Python 后端需要数十秒。
 * 启用方式：
 *
 * 而不是靠单元测试模拟。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalBackendClient, LocalBackendHost } from '@qiyin/local-backend-host';

const execFileAsync = promisify(execFile);
const ENABLED = process.env.QIYIN_LOCAL_BACKEND_INTEGRATION === '1';
const LOCAL_BACKEND_ROOT = join(process.cwd(), 'vendor', 'local-backend');
const HAS_LOCAL_BACKEND = existsSync(join(LOCAL_BACKEND_ROOT, 'main.py'));
const TEST_ASSET_URL = '/assets/qiyin-selftest-1200x800.png';
const ASSET_FILE = join(LOCAL_BACKEND_ROOT, 'assets', 'qiyin-selftest-1200x800.png');

/** 自包含生成测试素材，避免依赖仓库中预先存在的文件。 */
async function ensureTestAsset(): Promise<void> {
  if (existsSync(ASSET_FILE)) return;
  await mkdir(dirname(ASSET_FILE), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x1E6F7A:s=1200x800',
    '-frames:v', '1', ASSET_FILE,
  ]);
}

async function probePngSize(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0',
    file,
  ]);
  const [width, height] = stdout.trim().split(',').map(Number);
  if (!width || !height) throw new Error(`ffprobe 未返回尺寸: ${stdout}`);
  return { width, height };
}

describe.skipIf(!ENABLED || !HAS_LOCAL_BACKEND)('LocalBackend 后端真实链路', () => {
  let host: LocalBackendHost;
  let client: LocalBackendClient;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'qiyin-local-backend-'));
    await ensureTestAsset();
    host = new LocalBackendHost({ startupTimeoutMs: 300_000 });
    const { baseUrl, port } = await host.start();
    expect(port).toBeGreaterThan(0);
    // 必须只监听回环，绝不能是 0.0.0.0
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    client = new LocalBackendClient({ baseUrl, timeoutMs: 120_000 });
  }, 420_000);

  afterAll(async () => {
    await host?.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }, 60_000);

  it('回传后端配置与模型清单', async () => {
    const config = await client.getConfig();
    expect(config.image_model).toBeTruthy();
    expect(Array.isArray(config.image_models)).toBe(true);
    expect(Array.isArray(config.api_providers)).toBe(true);
  }, 120_000);

  it('媒体预览把 1200px 原图缩到请求宽度', async () => {
    const preview = await client.mediaPreview(TEST_ASSET_URL, 256);
    expect(preview.bytes.length).toBeGreaterThan(0);
    expect(preview.contentType).toMatch(/^image\/(webp|png)$/);

    const target = join(tempDir, 'preview.out');
    await writeFile(target, preview.bytes);
    const original = await probePngSize(ASSET_FILE);
    expect(original.width).toBe(1200);
    // webp/png 都能被 ffprobe 读取；只断言被缩小，格式由后端决定
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', target,
    ]);
    const width = Number(stdout.trim().split(',')[0]);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(256);
  }, 120_000);

  it('重复请求命中缓存（字节完全一致）', async () => {
    const first = await client.mediaPreview(TEST_ASSET_URL, 256);
    const second = await client.mediaPreview(TEST_ASSET_URL, 256);
    expect(second.bytes.equals(first.bytes)).toBe(true);
  }, 120_000);

  it('越界路径被后端拒绝，不泄露任意文件', async () => {
    await expect(client.mediaPreview('/assets/../../../windows/win.ini', 128)).rejects.toThrow();
    await expect(client.mediaPreview('C:/Windows/win.ini', 128)).rejects.toThrow();
  }, 120_000);

  it('只读连通性测试不需要真实密钥即可给出明确结果', async () => {
    const result = await client.testConnection({
      base_url: 'http://127.0.0.1:9',
      api_key: 'selftest-invalid-key',
      protocol: 'openai',
    });
    expect(result).toBeTypeOf('object');
    expect(result.ok).toBe(false);
  }, 120_000);

  it('公开定价源返回结构或明确降级，不抛异常', async () => {
    const pricing = await client.pricing();
    expect(pricing).toBeTypeOf('object');
    expect(pricing).toHaveProperty('profiles');
    expect(pricing).toHaveProperty('stale');
  }, 120_000);
});
