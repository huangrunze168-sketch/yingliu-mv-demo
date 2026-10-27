/* ============================================================
  API-003「文件上传接口（含大小与类型校验）」的量化验收。

  矩阵要的是"一批伪造文件 100% 被拒"。这里用 30 条夹具：

    10 条合法（九种媒体类型的真文件头）→ 必须 201，且拿到 sha256 命名的 Artifact；
    10 条伪装（扩展名与内容不符 / 声明类型与内容不符 / 根本没有文件头）→ 必须 415；
    10 条超限（内容合法但体积超过上限）→ 必须 413。

  除了状态码，还要数**磁盘上留下了什么**：被拒的上传不能留下半个文件、
  也不能留下 `.part` 中间产物。只看状态码的话，"拒了但文件已经在盘上"是看不出来的。
   ============================================================ */

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../../apps/local-api/src/server.js';
import { command, recordAcceptance } from './_acceptance.js';

const MAX_BYTES = 1024;
const root = mkdtempSync(join(tmpdir(), 'qiyin-acceptance-upload-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/* ---- 九种媒体类型的真文件头（只够通过 magic 校验，不需要能解码） ---- */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const GIF = Buffer.from('GIF89a0123', 'ascii');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.from([1, 2, 3])]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.from([1, 2, 3])]);
const OGG = Buffer.from('OggS0123456789', 'ascii');
const MP3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'binary');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from([1, 2, 3, 4, 5])]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.from([1, 2, 3])]);

const LEGAL = [
  { name: 'a.png', type: 'image/png', body: PNG },
  { name: 'a.jpg', type: 'image/jpeg', body: JPEG },
  { name: 'a.jpeg', type: 'image/jpeg', body: JPEG },
  { name: 'a.gif', type: 'image/gif', body: GIF },
  { name: 'a.webp', type: 'image/webp', body: WEBP },
  { name: 'a.wav', type: 'audio/wav', body: WAV },
  { name: 'a.ogg', type: 'audio/ogg', body: OGG },
  { name: 'a.mp3', type: 'audio/mpeg', body: MP3 },
  { name: 'a.webm', type: 'video/webm', body: WEBM },
  { name: 'a.mov', type: 'video/mp4', body: MP4 },
] as const;

const FORGED = [
  { id: 'exe 冒充 png', name: 'malware.png', type: 'image/png', body: Buffer.from('MZ this is not png', 'ascii') },
  { id: 'png 用 exe 扩展名', name: 'picture.exe', type: 'image/png', body: PNG },
  { id: 'png 声明成 pdf', name: 'doc.png', type: 'application/pdf', body: PNG },
  { id: 'gif 冒充 png', name: 'sticker.png', type: 'image/png', body: GIF },
  { id: 'mp4 声明成 png', name: 'clip.png', type: 'image/png', body: MP4 },
  { id: 'wav 用 mp3 扩展名', name: 'song.mp3', type: 'audio/mpeg', body: WAV },
  { id: '没有文件头', name: 'blob.png', type: 'image/png', body: Buffer.from('just some text', 'ascii') },
  { id: 'webm 声明成 mp4', name: 'movie.mp4', type: 'video/mp4', body: WEBM },
  { id: 'ogg 用 mp3 扩展名', name: 'voice.mp3', type: 'audio/mpeg', body: OGG },
  { id: 'jpeg 冒充 png', name: 'photo.png', type: 'image/png', body: JPEG },
] as const;

function oversized(body: Buffer): Buffer {
  return Buffer.concat([body, Buffer.alloc(MAX_BYTES)]);
}

describe('[API-003] 上传的类型与大小校验', () => {
  it('30 条夹具：合法放行、伪装 100% 拒绝、超限 100% 拒绝，且不留残file', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = service.execute(command('project.create', {
      name: '上传验收', max_budget_cents: 1000, rights_confirmed: true,
    })).project_id as string;
    const app = buildServer(service, undefined, { workspaceRoot: root, uploadMaxBytes: MAX_BYTES });

    const upload = (headers: Record<string, string>, payload: Buffer) => app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/uploads`,
      headers: { 'x-file-name': headers.fileName ?? '', 'content-type': headers.contentType ?? '' },
      payload,
    });

    const legalResults: Array<{ name: string; status: number; artifactId: string }> = [];
    for (const fixture of LEGAL) {
      const response = await upload({ fileName: fixture.name, contentType: fixture.type }, fixture.body);
      legalResults.push({
        name: fixture.name,
        status: response.statusCode,
        artifactId: (response.json() as { artifact_id?: string }).artifact_id ?? '',
      });
    }

    const forgedResults: Array<{ id: string; status: number; code: string }> = [];
    for (const fixture of FORGED) {
      const response = await upload({ fileName: fixture.name, contentType: fixture.type }, fixture.body);
      forgedResults.push({
        id: fixture.id,
        status: response.statusCode,
        code: (response.json() as { error?: { code?: string } }).error?.code ?? '',
      });
    }

    const oversizedResults: Array<{ index: number; status: number; code: string }> = [];
    for (let index = 0; index < 10; index += 1) {
      const fixture = LEGAL[index % LEGAL.length]!;
      const response = await upload(
        { fileName: fixture.name, contentType: fixture.type },
        oversized(fixture.body),
      );
      oversizedResults.push({
        index,
        status: response.statusCode,
        code: (response.json() as { error?: { code?: string } }).error?.code ?? '',
      });
    }

    await app.close();

    const uploadDir = resolve(root, projectId, 'uploads');
    const written = readdirSync(uploadDir);
    const partials = written.filter((name) => name.endsWith('.part'));
    const bytesOnDisk = written.reduce((sum, name) => sum + statSync(resolve(uploadDir, name)).size, 0);

    recordAcceptance('API-003', {
      criterion: '伪装与超限上传拒绝率 100%，且不留半文件',
      fixtures: LEGAL.length + FORGED.length + oversizedResults.length,
      legalAccepted: legalResults.filter((row) => row.status === 201).length,
      forgedRejected: forgedResults.filter((row) => row.status === 415).length,
      oversizedRejected: oversizedResults.filter((row) => row.status === 413).length,
      /*
        两条拒绝发生在 Fastify 自带的那一层，错误体不是我们那套 `error.code` 信封：
          · 声明的 Content-Type 不在已注册的解析器里（如 application/pdf）→ 415；
          · 请求体超过路由 bodyLimit → 413。
        状态码是对的，信封不一致是**已知的**，记在这里以免被当成"都走我们自己的校验"。
      */
      fastifyLevelRejections: [...forgedResults, ...oversizedResults].filter((row) => row.code === '').length,
      forgedDetail: forgedResults,
      oversizedDetail: oversizedResults,
      filesOnDisk: written.length,
      partialFiles: partials,
      bytesOnDisk,
    });

    expect(legalResults.every((row) => row.status === 201)).toBe(true);
    expect(legalResults.every((row) => /^sha256:[a-f0-9]{64}$/.test(row.artifactId))).toBe(true);
    expect(forgedResults.every((row) => row.status === 415)).toBe(true);
    expect(oversizedResults.every((row) => row.status === 413)).toBe(true);
    /* 合法 10 条里有两组内容相同（jpg/jpeg 同一份字节）→ 内容寻址应当只落一个文件 */
    expect(partials).toEqual([]);
    expect(written.length).toBeLessThanOrEqual(LEGAL.length);
    expect(written.length).toBeGreaterThan(0);
    expect(bytesOnDisk).toBeGreaterThan(0);
  }, 60_000);

  it('空内容被拒（不产生空 Artifact）', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = service.execute(command('project.create', {
      name: '空上传', max_budget_cents: 1000, rights_confirmed: true,
    })).project_id as string;
    const app = buildServer(service, undefined, { workspaceRoot: root, uploadMaxBytes: MAX_BYTES });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/uploads`,
      headers: { 'x-file-name': 'empty.png', 'content-type': 'image/png' },
      payload: Buffer.alloc(0),
    });
    await app.close();

    recordAcceptance('API-003.empty', {
      status: response.statusCode,
      code: (response.json() as { error?: { code?: string } }).error?.code ?? '',
    });

    expect(response.statusCode).toBe(400);
  }, 30_000);
});
