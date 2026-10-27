/* ============================================================
  期音科技 · 更新清单签名工具
  ------------------------------------------------------------
  用法（在 replica-studio 目录下）：

    # 1) 生成一对更新密钥（私钥请离线保管，别进仓库）
    .\.tools\pnpm.cmd exec tsx scripts\update-sign.mts keygen --out .data\update-keys

    # 2) 对一份待发布目录签名
    .\.tools\pnpm.cmd exec tsx scripts\update-sign.mts sign ^
        --dir release-0.4.0\payload ^
        --version 0.4.0 --counter 13 --channel stable ^
        --private-key .data\update-keys\update-private.pem ^
        --base-url https://example.com/xqtv/stable/0.4.0 ^
        --min-supported-version 0.2.0 --notes "修了什么"

  它做完两件事：

    ① 把目录里每个文件算成 `{path, bytes, sha256}`——客户端会逐条比对；
    ② 用私钥对清单（去掉 signature 的部分）签名，写成 `update-manifest.json`。

  为什么签名必须和客户端共用一份代码：签名算的是**字节**。
  两个地方各自实现一遍"稳定序列化"，只要有一处不同，
  客户端就会说"签名不通过"，而两边看上去都没错。
  所以这里直接 import 客户端那个包，不重写。
   ============================================================ */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  generateUpdateKeyPair, keyIdOf, sha256Hex, signManifest, type UpdateFileEntry,
} from '../packages/update-service/src/index.ts';

interface Args {
  [key: string]: string | true;
}

function parseArgs(argv: readonly string[]): { command: string; flags: Args } {
  const [command = '', ...rest] = argv;
  const flags: Args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return { command, flags };
}

function flag(flags: Args, name: string, fallback?: string): string {
  const value = flags[name];
  if (typeof value === 'string') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`缺少参数 --${name}`);
}

/** 目录里有哪些文件（相对路径一律用正斜杠，跨平台一致）。 */
function listFiles(root: string, current = root): string[] {
  const entries = readdirSync(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, absolute));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(relative(root, absolute).split(sep).join('/'));
  }
  return files.sort();
}

function keygen(flags: Args): void {
  const outDir = resolve(flag(flags, 'out', '.data/update-keys'));
  mkdirSync(outDir, { recursive: true });
  const { publicKey, privateKey } = generateUpdateKeyPair();
  const privatePath = join(outDir, 'update-private.pem');
  const publicPath = join(outDir, 'update-public.pem');
  writeFileSync(privatePath, privateKey, 'utf8');
  writeFileSync(publicPath, publicKey, 'utf8');
  console.log(JSON.stringify({
    privateKey: privatePath,
    publicKey: publicPath,
    keyId: keyIdOf(publicKey),
    提醒: '私钥只用于签名发布，别提交进仓库；客户端只需要公钥',
  }, null, 2));
}

function sign(flags: Args): void {
  const dir = resolve(flag(flags, 'dir'));
  const version = flag(flags, 'version');
  const counter = Number(flag(flags, 'counter'));
  const privateKeyPath = resolve(flag(flags, 'private-key'));
  const channel = flag(flags, 'channel', 'stable');
  const minSupportedVersion = flag(flags, 'min-supported-version', '0.0.0');
  const notes = flag(flags, 'notes', '');
  const baseUrl = typeof flags['base-url'] === 'string' ? flags['base-url'] : undefined;

  if (!Number.isInteger(counter) || counter < 0) throw new Error('--counter 必须是非负整数');
  const privateKey = readFileSync(privateKeyPath, 'utf8');
  const publicKey = readFileSync(join(resolve(privateKeyPath, '..'), 'update-public.pem'), 'utf8');
  const keyId = keyIdOf(publicKey);

  const paths = listFiles(dir).filter((path) => path !== 'update-manifest.json');
  if (paths.length === 0) throw new Error(`目录里没有可发布的文件：${dir}`);
  const files: UpdateFileEntry[] = paths.map((path) => {
    const bytes = readFileSync(join(dir, path));
    return { path, bytes: bytes.length, sha256: sha256Hex(bytes) };
  });

  const signed = signManifest({
    schema: 'xqtv.update-manifest@1',
    version,
    channel,
    counter,
    minSupportedVersion,
    publishedAt: new Date().toISOString(),
    notes,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    files,
    build: {
      commit: flag(flags, 'commit', 'unknown'),
      builder: flag(flags, 'builder', 'local'),
      builtAt: new Date().toISOString(),
    },
  }, privateKey, keyId);

  const manifestPath = join(dir, 'update-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(signed, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    manifest: manifestPath,
    version: signed.version,
    channel: signed.channel,
    counter: signed.counter,
    files: signed.files.length,
    totalBytes: signed.files.reduce((sum, file) => sum + file.bytes, 0),
    keyId,
    /* 把清单本身的哈希也打印出来，便于发布时对账 */
    manifestSha256: `sha256:${createHash('sha256').update(readFileSync(manifestPath)).digest('hex')}`,
    dirSize: paths.reduce((sum, path) => sum + statSync(join(dir, path)).size, 0),
  }, null, 2));
}

const { command, flags } = parseArgs(process.argv.slice(2));
if (command === 'keygen') keygen(flags);
else if (command === 'sign') sign(flags);
else {
  console.log('用法：update-sign.mts keygen --out <目录> | sign --dir <目录> --version <版本> --counter <n> --private-key <pem>');
  process.exitCode = 1;
}
