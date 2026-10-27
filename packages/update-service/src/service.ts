/* ============================================================
  期音科技 · 更新服务
   ------------------------------------------------------------
  一次更新的完整生命周期（每一步都能被单独观测）：

    未配置 ──check──▶ 检查中 ──▶ 有新版 / 已是最新
                                     │
                                  download（逐文件验哈希）
                                     │
                                   已就绪 ──activate──▶ 切到新槽（health = pending）
                                                            │
                                                   下次启动 markHealthy
                                                            │
                                              启动失败 → 自动切回上一槽

  三条不许偷懒的规矩：

    · **先验后装**：任何一个文件哈希不对，整包作废、staging 清空、指针不动；
    · **故障可退**：新槽起不来时，旧槽还在盘上，回滚不需要网络也不需要重新下载；
      没有"百分之几"这种编出来的数。
   ============================================================ */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { UpdateError, type UpdateErrorCode } from './errors.js';
import {
  assertSafeRelativePath, parseManifest, sha256Hex, verifyManifestSignature, type UpdateManifest,
} from './manifest.js';
import { assertUpgradeAllowed } from './policy.js';
import { UpdateStore, defaultUpdateState, type SlotInfo, type UpdatePrefs, type UpdateState } from './store.js';

export interface FetchFileOptions {
  /** 边下边报：已收到多少字节 / 清单说总共多少字节 */
  onProgress?: (received: number, bytes: number) => void;
  /** 返回 true 表示"用户按了暂停"——这不是失败，是停下来 */
  shouldPause?: () => boolean;
}

export interface FetchFileResult {
  bytes: number;
  paused: boolean;
}

/** 网络这一层是可注入的：验收用例不需要真联网，也不该真联网。 */
export interface UpdateFetch {
  readJson(url: string): Promise<unknown>;
  writeToFile(url: string, targetPath: string, options?: FetchFileOptions): Promise<FetchFileResult>;
}

export type UpdatePhase =
  /** 没配通道或没配公钥——用户自己能补 */
  | 'unconfigured'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'paused'
  | 'ready'
  | 'current'
  | 'error';

export interface UpdateFailure {
  code: string;
  message: string;
  /** 是"我们主动拒绝"还是"这次没成"——界面上该说的两句话完全不同 */
  refused: boolean;
}

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  /** 本机指针当前指向的槽（A/B 的 A 面或 B 面） */
  activeSlot: SlotInfo | null;
  /**
   * 指针指向的槽**是不是我现在跑的这一版**。

   * `false` 表示"已经切槽了，但这次启动跑的还是旧的可执行文件"——
   * 也就是还差"启动器按指针拉起对应槽"这一步（打包相关）。
   * 这个字段存在的意义是：**别把"还没生效"当成"起不来"**。
   */
  activationApplied: boolean;
  availableVersion: string | null;
  /** 回滚的兜底目标：安装目录里那一版（还没切过槽时为 null） */
  baseVersion: string | null;
  notes: string | null;
  publishedAt: string | null;
  build: UpdateManifest['build'] | null;
  fileCount: number;
  totalBytes: number;
  receivedBytes: number;
  stagedVersion: string | null;
  slots: string[];
  prefs: UpdatePrefs;
  lastRollback: UpdateState['lastRollback'];
  failure: UpdateFailure | null;
}

export interface UpdateServiceOptions {
  store: UpdateStore;
  /** 当前正在运行的版本（桌面端传 `app.getVersion()`） */
  currentVersion: string;
  /** 清单地址；null = 未配置 */
  channelUrl: string | null;
  /** 更新公钥（PEM）；null = 未配置 */
  publicKey: string | null;
  fetch: UpdateFetch;
  /** 允许新槽启动几次还不确认健康就回滚（默认 1 次） */
  maxBootAttempts?: number;
  now?: () => string;
}

const REFUSED_CODES = new Set(['UPDATE_NOT_CONFIGURED', 'UPDATE_ROLLBACK_REFUSED', 'UPDATE_BRIDGE_REQUIRED']);

export class UpdateService {
  readonly #store: UpdateStore;
  readonly #currentVersion: string;
  readonly #channelUrl: string | null;
  readonly #publicKey: string | null;
  readonly #fetch: UpdateFetch;
  readonly #maxBootAttempts: number;
  readonly #now: () => string;

  #state: UpdateState;
  #manifest: UpdateManifest | null = null;
  #phase: UpdatePhase;
  #receivedBytes = 0;
  #failure: UpdateFailure | null = null;
  #pauseRequested = false;

  constructor(options: UpdateServiceOptions) {
    this.#store = options.store;
    this.#currentVersion = options.currentVersion;
    this.#channelUrl = options.channelUrl;
    this.#publicKey = options.publicKey;
    this.#fetch = options.fetch;
    this.#maxBootAttempts = options.maxBootAttempts ?? 1;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#state = this.#store.readState();
    this.#phase = this.#isConfigured() ? 'idle' : 'unconfigured';
  }

  #isConfigured(): boolean {
    return (this.#channelUrl ?? '') !== '' && (this.#publicKey ?? '') !== '';
  }

  #persist(): void {
    this.#store.writeState(this.#state);
  }

  #fail(code: UpdateErrorCode, message: string, phase: UpdatePhase = 'error'): UpdateError {
    this.#failure = { code, message, refused: REFUSED_CODES.has(code) };
    this.#phase = phase;
    return new UpdateError(code, message);
  }

  status(): UpdateStatus {
    const current = this.#state.current;
    return {
      phase: this.#phase,
      currentVersion: this.#currentVersion,
      activeSlot: current,
      activationApplied: current === null || current.version === this.#currentVersion,
      availableVersion: this.#manifest?.version ?? null,
      baseVersion: this.#state.baseVersion,
      notes: this.#manifest?.notes ?? null,
      publishedAt: this.#manifest?.publishedAt ?? null,
      build: this.#manifest?.build ?? null,
      fileCount: this.#manifest?.files.length ?? 0,
      totalBytes: this.#manifest?.files.reduce((sum, file) => sum + file.bytes, 0) ?? 0,
      receivedBytes: this.#receivedBytes,
      stagedVersion: this.#state.stagedVersion,
      slots: this.#store.listSlots(),
      prefs: this.#state.prefs,
      lastRollback: this.#state.lastRollback,
      failure: this.#failure,
    };
  }

  setPrefs(prefs: Partial<UpdatePrefs>): UpdatePrefs {
    this.#state = { ...this.#state, prefs: { ...this.#state.prefs, ...prefs } };
    this.#persist();
    return this.#state.prefs;
  }

  /**
   * 检查更新：拉清单 → 验签 → 过策略 → 比版本。

   * 三种结果都要说清楚：有新版（available）、已是最新（current）、
   * 以及**拒绝**（比如清单比本机见过的版本更旧）。拒绝也是结论，不是错误。
   */
  async check(): Promise<UpdateStatus> {
    if (!this.#isConfigured()) {
      this.#failure = {
        code: 'UPDATE_NOT_CONFIGURED',
        message: this.#channelUrl === null
          ? '还没有配置更新通道地址，无法检查更新'
          : '还没有配置更新公钥，无法验证更新包',
        refused: true,
      };
      this.#phase = 'unconfigured';
      return this.status();
    }

    this.#phase = 'checking';
    this.#failure = null;
    this.#manifest = null;
    try {
      const raw = await this.#fetch.readJson(this.#channelUrl as string);
      const manifest = parseManifest(raw);
      this.#accept(manifest);
    } catch (error) {
      if (error instanceof UpdateError) {
        this.#failure = { code: error.code, message: error.message, refused: REFUSED_CODES.has(error.code) };
        this.#phase = 'error';
        return this.status();
      }
      this.#fail('UPDATE_DOWNLOAD_FAILED', `检查更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return this.status();
  }

  /** 验签 + 策略 + 定相；清单一律走这里，别的入口不许直接设 #manifest。 */
  #accept(manifest: UpdateManifest): void {
    verifyManifestSignature(manifest, this.#publicKey as string);
    const decision = assertUpgradeAllowed(manifest, {
      currentVersion: this.#currentVersion,
      highest: this.#state.highest,
    });
    this.#manifest = manifest;
    this.#receivedBytes = 0;
    this.#phase = decision.kind === 'current' ? 'current' : 'available';
  }

  /**
   * 下载整包到 staging。

   * 每下完一个文件就**当场验哈希**：不等到最后再统一验，
   * 因为"哪一条坏了"这件事只有在文件还在手边时才说得清。
   */
  async download(): Promise<UpdateStatus> {
    const manifest = this.#manifest;
    if (manifest === null) {
      this.#fail('UPDATE_STATE_CONFLICT', '还没有可下载的版本，请先检查更新');
      return this.status();
    }
    if (manifest.version === this.#currentVersion) {
      this.#fail('UPDATE_STATE_CONFLICT', `当前已经是 ${manifest.version}，不需要下载`);
      return this.status();
    }

    this.#pauseRequested = false;
    this.#failure = null;
    this.#phase = 'downloading';
    const staging = this.#store.stagingDir(manifest.version);
    if (!existsSync(staging)) mkdirSync(staging, { recursive: true });
    const base = (manifest.baseUrl ?? '').replace(/\/+$/, '');

    try {
      let doneBytes = 0;
      for (const file of manifest.files) {
        assertSafeRelativePath(file.path);
        const target = join(staging, file.path);
        if (this.#alreadyVerified(target, file.sha256)) {
          doneBytes += file.bytes;
          this.#receivedBytes = doneBytes;
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        const result = await this.#fetch.writeToFile(this.#urlFor(base, file.path), target, {
          onProgress: (received) => {
            /* 进度按"已完成文件 + 这个文件已收到"报，不重复计数 */
            this.#receivedBytes = doneBytes + received;
          },
          shouldPause: () => this.#pauseRequested,
        });
        if (result.paused) {
          this.#phase = 'paused';
          this.#state = { ...this.#state, stagedVersion: manifest.version };
          this.#persist();
          return this.status();
        }
        const actual = sha256Hex(readFileSync(target));
        const actualBytes = statSync(target).size;
        if (actual !== file.sha256 || actualBytes !== file.bytes) {
          this.#store.removeStaging(manifest.version);
          this.#fail('UPDATE_FILE_HASH_MISMATCH', `文件校验不通过：${file.path}（期望 ${file.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
          return this.status();
        }
        doneBytes += file.bytes;
        this.#receivedBytes = doneBytes;
      }

      /* 把清单一起放进 staging：安装完还要照着它复核一遍槽里的文件 */
      writeFileSync(join(staging, 'update-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      this.#state = {
        ...this.#state,
        stagedVersion: manifest.version,
        highest: this.#raiseHighest(manifest),
      };
      this.#persist();
      this.#phase = 'ready';
    } catch (error) {
      if (error instanceof UpdateError) {
        this.#fail(error.code, error.message);
        return this.status();
      }
      this.#store.removeStaging(manifest.version);
      this.#fail('UPDATE_DOWNLOAD_FAILED', `下载失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return this.status();
  }

  #alreadyVerified(path: string, sha256: string): boolean {
    if (!existsSync(path)) return false;
    try {
      return sha256Hex(readFileSync(path)) === sha256;
    } catch {
      return false;
    }
  }

  #urlFor(base: string, path: string): string {
    return base === '' ? path : `${base}/${path}`;
  }

  /** 见过的最高版本只增不减——这一条就是防重放的记忆。 */
  #raiseHighest(manifest: UpdateManifest): { version: string; counter: number } {
    const highest = this.#state.highest;
    if (highest === null || manifest.counter >= highest.counter) {
      return { version: manifest.version, counter: manifest.counter };
    }
    return highest;
  }

  pause(): UpdateStatus {
    if (this.#phase === 'downloading') this.#pauseRequested = true;
    return this.status();
  }

  resume(): Promise<UpdateStatus> {
    if (this.#phase !== 'paused') return Promise.resolve(this.status());
    return this.download();
  }

  /**
   * 离线安装：从本地目录读 `update-manifest.json`，逐文件核对后进 staging。

   * 与在线下载走**同一套校验**（验签 + 策略 + 逐个哈希）。
   * 离线包之所以敢放宽的只有"从哪来"，不是"信不信"。
   */
  installFromDirectory(dir: string): UpdateStatus {
    const manifestPath = join(dir, 'update-manifest.json');
    if (!existsSync(manifestPath)) {
      this.#fail('UPDATE_MANIFEST_INVALID', `这个目录里没有 update-manifest.json：${dir}`);
      return this.status();
    }
    try {
      const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      this.#accept(manifest);
      const staging = this.#store.createStaging(manifest.version);
      for (const file of manifest.files) {
        const source = join(dir, file.path);
        if (!existsSync(source)) {
          throw new UpdateError('UPDATE_FILE_HASH_MISMATCH', `本地更新包里缺少文件：${file.path}`, { path: file.path });
        }
        const bytes = readFileSync(source);
        if (sha256Hex(bytes) !== file.sha256 || bytes.length !== file.bytes) {
          throw new UpdateError('UPDATE_FILE_HASH_MISMATCH', `本地更新包里的文件与清单不一致：${file.path}`, { path: file.path });
        }
        const target = join(staging, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
      writeFileSync(join(staging, 'update-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      this.#state = { ...this.#state, stagedVersion: manifest.version, highest: this.#raiseHighest(manifest) };
      this.#persist();
      this.#receivedBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
      this.#phase = 'ready';
    } catch (error) {
      if (this.#manifest !== null) this.#store.removeStaging(this.#manifest.version);
      if (error instanceof UpdateError) {
        this.#fail(error.code, error.message);
      } else {
        this.#fail('UPDATE_MANIFEST_INVALID', `本地更新包无法使用：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return this.status();
  }

  /**
   * 切槽（A/B 安装的那一步）。

   * 指针切过去之后，新槽标成 `pending`：**在它证明自己能起来之前，不算装好**。
   * 旧槽原样留在盘上——回滚就是把指针指回去。
   */
  activate(): UpdateStatus {
    const version = this.#state.stagedVersion;
    if (version === null || this.#phase !== 'ready') {
      this.#fail('UPDATE_STATE_CONFLICT', '还没有准备就绪的版本，先下载（或离线导入）再安装');
      return this.status();
    }
    try {
      this.#store.promoteStaging(version);
      const now = this.#now();
      const next: SlotInfo = { version, health: 'pending', attempts: 0, activatedAt: now };
      this.#state = {
        ...this.#state,
        previous: this.#state.current,
        current: next,
        stagedVersion: null,
        /*
          第一次切槽时把"安装目录里那一版"记下来。
          之后再回滚，目标就是它——而不是"我现在跑的版本"。
        */
        baseVersion: this.#state.current === null ? this.#currentVersion : this.#state.baseVersion,
      };
      this.#persist();
      /*
        指针切过去了，但**还没证明能起来**：所以回到 idle，
        用 `activeSlot.health === 'pending'` 表达"待确认"，
        而不是对外说一句"已是最新"。
      */
      this.#phase = 'idle';
    } catch (error) {
      this.#fail('UPDATE_STATE_CONFLICT', `切换版本失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return this.status();
  }

  /** 启动成功后调用：把当前槽标成健康。 */
  markHealthy(): UpdateStatus {
    const current = this.#state.current;
    if (current !== null && current.health !== 'ok') {
      this.#state = { ...this.#state, current: { ...current, health: 'ok', attempts: 0 } };
      this.#persist();
    }
    if (this.#phase !== 'downloading' && this.#phase !== 'paused') this.#phase = 'idle';
    return this.status();
  }

  /**
   * 逐文件复核某个槽。

   * 装完之后槽里的文件仍可能被人改动或被杀毒软件删掉，
   * 所以"这个槽可信"不是装完那一刻的结论，而是每次启动都要重新问一次的问题。
   */
  verifySlot(version: string): { ok: boolean; checked: number; mismatch: string[] } {
    const slot = this.#store.slotDir(version);
    const manifestPath = join(slot, 'update-manifest.json');
    if (!existsSync(manifestPath)) return { ok: false, checked: 0, mismatch: ['update-manifest.json 不在槽里'] };
    try {
      const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      const mismatch: string[] = [];
      for (const file of manifest.files) {
        const target = join(slot, file.path);
        if (!existsSync(target) || sha256Hex(readFileSync(target)) !== file.sha256) mismatch.push(file.path);
      }
      return { ok: mismatch.length === 0, checked: manifest.files.length, mismatch };
    } catch (error) {
      return { ok: false, checked: 0, mismatch: [error instanceof Error ? error.message : String(error)] };
    }
  }

  /**
   * 启动时体检：新槽要么自证健康，要么被换掉。

   * 这一段是回滚真正生效的地方——它跑在**界面出来之前**，
   * 不需要用户点任何按钮，也不需要网络。
   *
   * 但有一件事必须先分清：**"指针指着新版"不等于"我现在跑的是新版"**。
   * 若指针指向的版本不是我正在跑的版本，说明这次启动还没真正切过去
   * （可执行文件还是旧的那个）。这时既不该记一次启动尝试，
   * 更不该回滚——把"还没生效"当成"起不来"会让每次更新都被自己撤掉。
   */
  bootCheck(): { rolledBack: boolean; reason: string | null; applied: boolean; status: UpdateStatus } {
    const current = this.#state.current;
    if (current === null) return { rolledBack: false, reason: null, applied: true, status: this.status() };

    if (current.version !== this.#currentVersion) {
      return { rolledBack: false, reason: null, applied: false, status: this.status() };
    }

    const integrity = this.verifySlot(current.version);
    if (!integrity.ok) {
      const reason = `当前槽 ${current.version} 的文件校验不通过（${integrity.mismatch.slice(0, 3).join('、')}）`;
      this.rollback(reason);
      return { rolledBack: true, reason, applied: true, status: this.status() };
    }

    if (current.health === 'pending') {
      const attempts = current.attempts + 1;
      if (attempts > this.#maxBootAttempts) {
        const reason = `新版本 ${current.version} 连续 ${current.attempts} 次没有确认启动成功`;
        this.rollback(reason);
        return { rolledBack: true, reason, applied: true, status: this.status() };
      }
      this.#state = { ...this.#state, current: { ...current, attempts } };
      this.#persist();
    }
    return { rolledBack: false, reason: null, applied: true, status: this.status() };
  }

  /**
   * 回滚到上一槽。

   * 两种回滚目标，分开说清楚：

     · `previous` 是一个槽（装过一次以上更新）→ 指针指回那个槽；
     · `previous` 为空（**第一次**更新就出问题）→ 指针指回"安装目录"。
       安装目录里是随安装包发出去的那一版，它一直在，
       不需要我们先把它复制成槽——所以首次更新的回滚同样成立。

   * 回滚之后 `previous` 指向**刚被换下来的那个版本**，而不是清空：
   用户想让新版再试一次时，那个槽还在盘上。
   */
  rollback(reason: string): UpdateStatus {
    const current = this.#state.current;
    if (current === null) {
      this.#fail('UPDATE_STATE_CONFLICT', '当前没有切换过的版本，没有可回滚的目标');
      return this.status();
    }
    const previous = this.#state.previous;
    const now = this.#now();
    this.#state = {
      ...this.#state,
      current: previous === null ? null : { ...previous, health: 'ok', attempts: 0, activatedAt: now },
      previous: current,
      stagedVersion: null,
      lastRollback: {
        at: now,
        from: current.version,
        to: previous?.version ?? this.#state.baseVersion ?? this.#currentVersion,
        reason,
      },
    };
    this.#persist();
    this.#phase = 'idle';
    /* 回滚是**正常动作**，不留 failure——它已经把系统带回可用状态了 */
    this.#failure = null;
    return this.status();
  }

  /** 当前应当运行哪个槽（启动路径用它；未装过更新时返回 null，按安装目录跑）。 */
  resolveActiveSlot(): { version: string; dir: string; health: SlotInfo['health'] } | null {
    const current = this.#state.current;
    if (current === null) return null;
    return { version: current.version, dir: this.#store.slotDir(current.version), health: current.health };
  }

  /** 仅供测试与诊断：把内部状态原样交出来 */
  dumpState(): UpdateState {
    return this.#state;
  }

  static emptyState(): UpdateState {
    return defaultUpdateState();
  }
}
