import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuthMethod, CredentialRecord } from './types.js';

/* ============================================================
  期音科技 · 凭据仓库
   ------------------------------------------------------------
  三条硬要求，缺一条就不该拿来存密钥：

    ① **落盘必须加密**。明文写一个 `credentials.json` 是很多人第一步会写的东西，
       它的问题不是"理论上会被读"，而是**备份软件、云同步、杀毒扫描日志**
       都会顺手把这个文件带走。用 AES-256-GCM 加上独立主密钥，
       至少让"拷走文件"不等于"拿到密钥"。

    ② **主密钥与密文分开放**。密钥单独一个文件（0600），
       密文一个文件。这样用户可以只备份密文，或者只备份密钥。

    ③ **读接口不回显密钥**。`list()` 只给"哪家 Provider、用的哪种方式"，
       要真的取用必须显式 `get()`。界面上显示状态用 `list()`，
       它天然没有可泄的字段。

  **说清它挡不住什么**：主密钥就在同一台机器的同一个目录下，
  能读到密文的人通常也能读到密钥。这套加密防的是"文件被顺手拷走"，
  不是"本机被完全攻陷"。跟 Electron `safeStorage` 相比，
  我们少了对系统钥匙串的依赖，代价就是上面这一句——
  这个取舍写在 `describeCredentialStoreLimits()` 里，由界面原样显示。
   ============================================================ */

export const CREDENTIAL_FILE_SCHEMA = 'xqtv.provider-credentials@1';

/** 不含任何密钥字段的凭据摘要，专门给界面用。 */
export interface CredentialSummary {
  providerId: string;
  method: AuthMethod;
}

/** 策略只依赖这一个接口，因此测试可以塞一个内存实现进来。 */
export interface CredentialVault {
  get(providerId: string): CredentialRecord | null;
  set(providerId: string, record: CredentialRecord): void;
  delete(providerId: string): void;
  list(): CredentialSummary[];
}

/** 密文文件读不出来（密钥换了、文件被截断、版本不认识）。 */
export class CredentialStoreCorruptError extends Error {
  constructor(readonly reason: string) {
    super(`凭据文件无法读取：${reason}`);
    this.name = 'CredentialStoreCorruptError';
  }
}

export interface CredentialStoreOptions {
  /** 密文文件；目录不存在会自动建。 */
  filePath: string;
  /** 主密钥文件。 */
  keyPath: string;
}

interface EncryptedEnvelope {
  schema: string;
  iv: string;
  tag: string;
  data: string;
}

/** 内存实现：测试用，或者用户明确选择"这次不落盘"。 */
export function createMemoryVault(initial?: Record<string, CredentialRecord>): CredentialVault {
  const map = new Map<string, CredentialRecord>(Object.entries(initial ?? {}));
  return {
    get: (providerId) => map.get(providerId) ?? null,
    set: (providerId, record) => { map.set(providerId, record); },
    delete: (providerId) => { map.delete(providerId); },
    list: () => [...map.entries()].map(([providerId, record]) => ({ providerId, method: record.method })),
  };
}

export class CredentialStore implements CredentialVault {
  readonly #filePath: string;
  readonly #keyPath: string;
  #records: Map<string, CredentialRecord> | null = null;

  constructor(options: CredentialStoreOptions) {
    this.#filePath = options.filePath;
    this.#keyPath = options.keyPath;
  }

  get(providerId: string): CredentialRecord | null {
    return this.#load().get(providerId) ?? null;
  }

  set(providerId: string, record: CredentialRecord): void {
    const records = this.#load();
    records.set(providerId, record);
    this.#flush(records);
  }

  delete(providerId: string): void {
    const records = this.#load();
    if (!records.delete(providerId)) return;
    this.#flush(records);
  }

  list(): CredentialSummary[] {
    return [...this.#load().entries()].map(([providerId, record]) => ({ providerId, method: record.method }));
  }

  /** 已配置的 Provider 数量。界面上的"已连接 3 个"用这个，不必展开明细。 */
  get size(): number {
    return this.#load().size;
  }

  #load(): Map<string, CredentialRecord> {
    if (this.#records !== null) return this.#records;
    if (!existsSync(this.#filePath)) {
      this.#records = new Map();
      return this.#records;
    }
    let envelope: EncryptedEnvelope;
    try {
      envelope = JSON.parse(readFileSync(this.#filePath, 'utf8')) as EncryptedEnvelope;
    } catch (error) {
      throw new CredentialStoreCorruptError(`文件不是合法 JSON（${String(error)}）`);
    }
    if (envelope.schema !== CREDENTIAL_FILE_SCHEMA) {
      throw new CredentialStoreCorruptError(`未知的 schema：${String(envelope.schema)}`);
    }
    const key = this.#readKey();
    let plain: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      plain = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      /* 认证标签对不上：要么密钥不匹配，要么密文被改过。
         这两种情况都不能"当作空仓库"糊过去——那会让用户的凭据无声消失。 */
      throw new CredentialStoreCorruptError(`解密失败（密钥不匹配或密文被篡改）：${String(error)}`);
    }
    const parsed = JSON.parse(plain) as Record<string, CredentialRecord>;
    this.#records = new Map(Object.entries(parsed));
    return this.#records;
  }

  #flush(records: Map<string, CredentialRecord>): void {
    const key = this.#readKey(true);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plain = Buffer.from(JSON.stringify(Object.fromEntries(records)), 'utf8');
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      schema: CREDENTIAL_FILE_SCHEMA,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    mkdirSync(dirname(this.#filePath), { recursive: true });
    /* 先写临时文件再改名：写一半断电时，旧文件仍然完整，不会留下半个密文。 */
    const temporary = `${this.#filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.#filePath);
  }

  #readKey(create: boolean = false): Buffer {
    if (existsSync(this.#keyPath)) {
      const key = readFileSync(this.#keyPath);
      if (key.length !== 32) {
        throw new CredentialStoreCorruptError(`主密钥长度应为 32 字节，实际 ${key.length}`);
      }
      return key;
    }
    if (!create) {
      /* 密文在、密钥不在——典型场景是用户只拷了其中一个文件。
         这里必须报错，不能新建一把密钥去解旧密文。 */
      throw new CredentialStoreCorruptError('找不到主密钥文件（credentials.key）');
    }
    const key = randomBytes(32);
    mkdirSync(dirname(this.#keyPath), { recursive: true });
    writeFileSync(this.#keyPath, key, { mode: 0o600 });
    return key;
  }
}

/** 界面上要原样显示的局限，避免用户以为"加密了就等于绝对安全"。 */
export function describeCredentialStoreLimits(): string[] {
  return [
    '凭据用 AES-256-GCM 加密后写入本机；主密钥是同目录下的独立文件（0600）。',
    '能读到本机那两个文件的人可以解出凭据——这防的是"文件被拷走"，不是"整机被攻陷"。',
    '界面只显示"配没配"，不回显任何密钥；导出的项目包里不含凭据。',
  ];
}

/** 彻底抹掉一个凭据文件（用户点"清空全部凭据"时用）。 */
export function purgeCredentialFiles(options: CredentialStoreOptions): void {
  for (const path of [options.filePath, options.keyPath]) {
    if (existsSync(path)) unlinkSync(path);
  }
}
