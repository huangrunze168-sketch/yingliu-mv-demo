/* ============================================================
  期音科技 · 更新清单（`xqtv.update-manifest@1`）
   ------------------------------------------------------------
  这份清单是**唯一的信任来源**：里面写清了"新版是哪一版、由谁在什么时候构建、
  一共哪几个文件、每个文件多少字节和什么哈希"，末尾再用 Ed25519 签一次。

  为什么不用"下载地址 + 版本号"这么简单的格式：
  客户端一旦能自己决定"装什么"，就等于把执行权交给了能改那个地址的人。
  签名把这件事收回来——**只有拿私钥的人能指定装什么**。

  为什么清单里要有 `counter`（单调计数）：
  光比版本号挡不住"把旧版本重新签一遍给你"的重放攻击。
  counter 只增不减，客户端记住见过的最大值，比它小的清单一律不认。

  为什么要有 `minSupportedVersion`（桥接版本）：
  跨大版本的升级往往要先做一次数据迁移。直接跳到最新版会跳过迁移，
  用户的项目库就可能被"升"坏。所以老客户端会被明确要求先升到桥接版本，
  而不是稀里糊涂装上一个它处理不了的新版。
   ============================================================ */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { UpdateError } from './errors.js';

export interface UpdateFileEntry {
  /** 相对路径（相对安装根），只允许正斜杠分隔的普通路径 */
  path: string;
  bytes: number;
  /** 小写十六进制的 sha256 */
  sha256: string;
}

export interface UpdateBuildInfo {
  /** 构建来源：提交号 */
  commit: string;
  /** 构建来源：谁构建的（CI 名或机器名） */
  builder: string;
  builtAt: string;
}

export interface UpdateSignature {
  algorithm: 'ed25519';
  /** 公钥标识；客户端用它确认"这把签名是不是我认的那把" */
  keyId: string;
  /** base64 的签名值 */
  value: string;
}

export interface UpdateManifest {
  schema: 'xqtv.update-manifest@1';
  /** 语义化版本，例如 0.4.0 */
  version: string;
  channel: string;
  /** 单调递增；不参与语义，只用来挡重放 */
  counter: number;
  /** 低于它的客户端必须先升到桥接版本 */
  minSupportedVersion: string;
  publishedAt: string;
  notes: string;
  /** 相对路径的下载前缀；省略时由调用方提供 */
  baseUrl?: string;
  files: readonly UpdateFileEntry[];
  build: UpdateBuildInfo;
  signature: UpdateSignature;
}

const HEX64 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message: string, detail: Record<string, unknown> = {}): never {
  throw new UpdateError('UPDATE_MANIFEST_INVALID', message, detail);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`清单字段缺失或不是字符串：${field}`, { field });
  return value;
}

/**
 * 相对路径的合法性。

 * 更新包会把文件写到用户磁盘上，所以这里按**最坏情况**审：
 * 绝对路径、盘符、`..`、反斜杠、空段一律拒绝——
 * 不靠"目标目录拼接后再检查"，而是根本不让这种路径进入流程。
 */
export function assertSafeRelativePath(path: unknown): string {
  if (typeof path !== 'string' || path === '') fail('文件路径缺失', { path });
  if (/^[A-Za-z]:/.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    throw new UpdateError('UPDATE_PATH_ESCAPE', `文件路径必须是相对路径：${path}`, { path });
  }
  if (path.includes('\\')) throw new UpdateError('UPDATE_PATH_ESCAPE', `文件路径不允许反斜杠：${path}`, { path });
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new UpdateError('UPDATE_PATH_ESCAPE', `文件路径含越界片段：${path}`, { path });
  }
  return path;
}

function parseFileEntry(input: unknown, index: number): UpdateFileEntry {
  if (!input || typeof input !== 'object') fail(`files[${index}] 不是对象`);
  const raw = input as Record<string, unknown>;
  const path = assertSafeRelativePath(raw.path);
  const bytes = raw.bytes;
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    fail(`files[${index}].bytes 必须是非负整数`, { path, bytes });
  }
  const sha256 = requireString(raw.sha256, `files[${index}].sha256`).toLowerCase();
  if (!HEX64.test(sha256)) fail(`files[${index}].sha256 必须是 64 位小写十六进制`, { path, sha256 });
  return { path, bytes, sha256 };
}

/** 严格解析：缺字段、类型不对、版本号格式不对，都当清单损坏处理。 */
export function parseManifest(input: unknown): UpdateManifest {
  if (!input || typeof input !== 'object') fail('清单不是对象');
  const raw = input as Record<string, unknown>;
  if (raw.schema !== 'xqtv.update-manifest@1') fail(`清单 schema 不是 xqtv.update-manifest@1：${String(raw.schema)}`);

  const version = requireString(raw.version, 'version');
  if (!VERSION.test(version)) fail(`version 不是语义化版本：${version}`, { version });
  const minSupportedVersion = requireString(raw.minSupportedVersion, 'minSupportedVersion');
  if (!VERSION.test(minSupportedVersion)) fail(`minSupportedVersion 不是语义化版本：${minSupportedVersion}`, { minSupportedVersion });

  const counter = raw.counter;
  if (typeof counter !== 'number' || !Number.isInteger(counter) || counter < 0) {
    fail('counter 必须是非负整数', { counter });
  }

  if (!Array.isArray(raw.files) || raw.files.length === 0) fail('files 必须是非空数组');
  const files = raw.files.map((entry, index) => parseFileEntry(entry, index));
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) fail(`文件路径重复：${file.path}`, { path: file.path });
    seen.add(file.path);
  }

  const buildRaw = raw.build;
  if (!buildRaw || typeof buildRaw !== 'object') fail('build 缺失');
  const build = buildRaw as Record<string, unknown>;

  const signatureRaw = raw.signature;
  if (!signatureRaw || typeof signatureRaw !== 'object') fail('signature 缺失');
  const signature = signatureRaw as Record<string, unknown>;
  if (signature.algorithm !== 'ed25519') fail(`不支持的签名算法：${String(signature.algorithm)}`);

  const baseUrl = raw.baseUrl;
  return {
    schema: 'xqtv.update-manifest@1',
    version,
    channel: requireString(raw.channel, 'channel'),
    counter,
    minSupportedVersion,
    publishedAt: requireString(raw.publishedAt, 'publishedAt'),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    ...(typeof baseUrl === 'string' && baseUrl !== '' ? { baseUrl } : {}),
    files,
    build: {
      commit: requireString(build.commit, 'build.commit'),
      builder: requireString(build.builder, 'build.builder'),
      builtAt: requireString(build.builtAt, 'build.builtAt'),
    },
    signature: {
      algorithm: 'ed25519',
      keyId: requireString(signature.keyId, 'signature.keyId'),
      value: requireString(signature.value, 'signature.value'),
    },
  };
}

/**
 * 稳定序列化：键排序、数组保序、丢掉 `undefined`。

 * 签名算的是**这些字节**，所以两边（签名端与验证端）必须逐字节一致。
 * 用 `JSON.stringify` 直接序列化会跟着对象的键顺序变——同样的内容、
 * 不同的构造顺序就会算出不同的签名，那是最难查的一类"签名不通过"。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** 签名覆盖的字节：清单**去掉 signature 之后**的稳定序列化。 */
export function canonicalManifestPayload(manifest: UpdateManifest): Buffer {
  const { signature: _signature, ...rest } = manifest;
  return Buffer.from(stableStringify(rest), 'utf8');
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 校验签名。公钥用 PEM；导入失败也按"签名不合法"处理，并说明原因。 */
export function verifyManifestSignature(manifest: UpdateManifest, publicKeyPem: string): void {
  const payload = canonicalManifestPayload(manifest);
  const signature = Buffer.from(manifest.signature.value, 'base64');
  let ok = false;
  try {
    ok = verify(null, payload, createPublicKey(publicKeyPem), signature);
  } catch (error) {
    throw new UpdateError('UPDATE_SIGNATURE_INVALID', '更新公钥无法使用（PEM 格式不对？）', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!ok) {
    throw new UpdateError('UPDATE_SIGNATURE_INVALID', '清单签名与更新公钥不匹配：这不是我们签发的更新包', {
      keyId: manifest.signature.keyId,
    });
  }
}

/** 签名（发布侧用；`scripts/update-sign.mts` 调它，保证两边序列化完全一致）。 */
export function signManifest(
  manifest: Omit<UpdateManifest, 'signature'> & { signature?: UpdateSignature },
  privateKeyPem: string,
  keyId: string,
): UpdateManifest {
  const { signature: _ignored, ...rest } = manifest;
  const payload = canonicalManifestPayload({ ...rest, signature: { algorithm: 'ed25519', keyId, value: '' } });
  const value = sign(null, payload, createPrivateKey(privateKeyPem)).toString('base64');
  return parseManifest({ ...rest, signature: { algorithm: 'ed25519', keyId, value } });
}

/** 生成一对更新密钥（只用于本地演练与测试；正式发布请用离线保管的私钥）。 */
export function generateUpdateKeyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** 从 PEM 公钥算一个稳定标识，用作 `keyId`。 */
export function keyIdOf(publicKeyPem: string): string {
  return sha256Hex(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).slice(0, 16);
}
