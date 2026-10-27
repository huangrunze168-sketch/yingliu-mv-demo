/* ============================================================
  UPDATE-001：签名更新 / A-B 安装 / 失败回滚。

  这些用例**不联网**：清单由测试自己签、文件由测试自己给。
  要验的不是"能不能下载"，而是那几条一旦写错就会静默出事的判断：

    · 没配公钥时会不会照样装（必须不装）；
    · 签名不对时会不会照样装（必须不装）；
    · 把旧版本重新签一遍发过来会不会照样装（防重放，必须不装）；
    · 装到一半坏了，指针会不会已经被改（必须没改）；
    · 新版起不来，能不能自己回到上一版，且**不需要网络**。
   ============================================================ */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UpdateService, UpdateStore, parseManifest, sha256Hex, signManifest, generateUpdateKeyPair,
  type UpdateFetch, type UpdateManifest,
} from '@qiyin/update-service';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix = 'qiyin-update-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const KEYS = generateUpdateKeyPair();
const IMPOSTOR_KEYS = generateUpdateKeyPair();

const FILES: Record<string, string> = {
  'app/main.js': 'console.log("main v-next");',
  'app/renderer.js': 'console.log("renderer v-next");',
  'resources/notes.txt': '更新说明',
};

interface PackageOptions {
  version?: string;
  counter?: number;
  minSupportedVersion?: string;
  privateKey?: string;
  files?: Record<string, string>;
  tamperAfterSign?: (manifest: UpdateManifest) => UpdateManifest;
}

function buildManifest(options: PackageOptions = {}): UpdateManifest {
  const files = options.files ?? FILES;
  const draft = {
    schema: 'xqtv.update-manifest@1' as const,
    version: options.version ?? '0.4.0',
    channel: 'stable',
    counter: options.counter ?? 12,
    minSupportedVersion: options.minSupportedVersion ?? '0.2.0',
    publishedAt: '2026-09-21T00:00:00.000Z',
    notes: '这一版修了什么',
    baseUrl: 'https://updates.example.test/stable/0.4.0',
    files: Object.entries(files).map(([path, content]) => ({
      path,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256Hex(content),
    })),
    build: { commit: 'abc1234', builder: 'ci@example', builtAt: '2026-09-21T00:00:00.000Z' },
  };
  const signed = signManifest(draft, options.privateKey ?? KEYS.privateKey, 'key-main');
  return options.tamperAfterSign === undefined ? signed : options.tamperAfterSign(signed);
}

/**
 * 假网络。

 * `overrides` 用来模拟"服务端给的字节和清单说的不一样"，
 * `failOn` 用来模拟中途断线。
 */
function fakeFetch(
  manifest: unknown,
  files: Record<string, string> = FILES,
  options: {
    overrides?: Record<string, string>;
    failOn?: string;
    /** 第一个数据块落盘之后回调一次（用来在下载中途按暂停） */
    onFirstChunk?: () => void;
  } = {},
): UpdateFetch & { requested: string[] } {
  const requested: string[] = [];
  let chunkSeen = false;
  return {
    requested,
    async readJson(url: string) {
      requested.push(url);
      return manifest;
    },
    async writeToFile(url: string, targetPath: string, fileOptions = {}) {
      requested.push(url);
      const relative = Object.keys(files).find((path) => url.endsWith(`/${path}`) || url.endsWith(path));
      if (relative === undefined) throw new Error(`假网络里没有这个文件：${url}`);
      if (options.failOn === relative) throw new Error('连接被重置');

      const content = options.overrides?.[relative] ?? files[relative] ?? '';
      mkdirSync(join(targetPath, '..'), { recursive: true });
      const half = Math.floor(content.length / 2);
      writeFileSync(targetPath, content.slice(0, half));
      fileOptions.onProgress?.(Buffer.byteLength(content.slice(0, half), 'utf8'), Buffer.byteLength(content, 'utf8'));
      if (!chunkSeen) {
        chunkSeen = true;
        options.onFirstChunk?.();
      }
      if (fileOptions.shouldPause?.() === true) {
        return { bytes: half, paused: true };
      }
      writeFileSync(targetPath, content);
      fileOptions.onProgress?.(Buffer.byteLength(content, 'utf8'), Buffer.byteLength(content, 'utf8'));
      return { bytes: Buffer.byteLength(content, 'utf8'), paused: false };
    },
  };
}

function service(
  root: string,
  fetchImpl: UpdateFetch,
  overrides: { currentVersion?: string; publicKey?: string | null; channelUrl?: string | null; maxBootAttempts?: number } = {},
) {
  const store = new UpdateStore(root);
  const instance = new UpdateService({
    store,
    currentVersion: overrides.currentVersion ?? '0.3.0',
    channelUrl: overrides.channelUrl === undefined ? 'https://updates.example.test/stable/latest.json' : overrides.channelUrl,
    publicKey: overrides.publicKey === undefined ? KEYS.publicKey : overrides.publicKey,
    fetch: fetchImpl,
    ...(overrides.maxBootAttempts === undefined ? {} : { maxBootAttempts: overrides.maxBootAttempts }),
  });
  return { store, instance };
}

describe('UPDATE-001 · 签名与策略', () => {
  it('没配通道或公钥时明确说"未配置"，而不是假装检查过了', async () => {
    const root = tempRoot();
    const { instance } = service(root, fakeFetch({}), { channelUrl: null });
    const status = await instance.check();

    expect(status.phase).toBe('unconfigured');
    expect(status.failure?.code).toBe('UPDATE_NOT_CONFIGURED');
    expect(status.failure?.refused).toBe(true);
  });

  it('合法清单：能看出有新版、总字节与文件数都来自清单', async () => {
    const root = tempRoot();
    const manifest = buildManifest();
    const { instance } = service(root, fakeFetch(manifest));
    const status = await instance.check();
    const declared = manifest.files.reduce((sum, file) => sum + file.bytes, 0);

    expect(status.phase).toBe('available');
    expect(status.availableVersion).toBe('0.4.0');
    expect(status.fileCount).toBe(3);
    expect(status.totalBytes).toBe(declared);
    expect(status.build?.commit).toBe('abc1234');
  });

  it('别人签的清单装不了（签名必须对上我们认的那把公钥）', async () => {
    const root = tempRoot();
    const manifest = buildManifest({ privateKey: IMPOSTOR_KEYS.privateKey });
    const { instance } = service(root, fakeFetch(manifest));
    const status = await instance.check();

    expect(status.phase).toBe('error');
    expect(status.failure?.code).toBe('UPDATE_SIGNATURE_INVALID');
    expect(status.failure?.refused).toBe(false);
  });

  it('签完之后被改过的清单同样不认（签名覆盖的字节变了）', async () => {
    const root = tempRoot();
    const manifest = buildManifest({ tamperAfterSign: (signed) => ({ ...signed, version: '9.9.9' }) });
    const { instance } = service(root, fakeFetch(manifest));
    const status = await instance.check();

    expect(status.failure?.code).toBe('UPDATE_SIGNATURE_INVALID');
  });

  it('把旧版本重新签一遍发过来也装不上（counter 与版本双重防回滚）', async () => {
    const root = tempRoot();
    const first = buildManifest({ version: '0.5.0', counter: 20 });
    const { instance } = service(root, fakeFetch(first));
    await instance.check();
    await instance.download();

    /* 用同一把私钥签一个更旧的版本：签名合法，但顺序不对 */
    const replay = buildManifest({ version: '0.4.0', counter: 19 });
    const second = service(root, fakeFetch(replay));
    const status = await second.instance.check();

    expect(status.phase).toBe('error');
    expect(status.failure?.code).toBe('UPDATE_ROLLBACK_REFUSED');
    expect(status.failure?.refused).toBe(true);
  });

  it('当前版本低于桥接版本时，明确要求先装桥接版本', async () => {
    const root = tempRoot();
    const manifest = buildManifest({ version: '1.0.0', minSupportedVersion: '0.9.0' });
    const { instance } = service(root, fakeFetch(manifest), { currentVersion: '0.3.0' });
    const status = await instance.check();

    expect(status.failure?.code).toBe('UPDATE_BRIDGE_REQUIRED');
    expect(status.failure?.message).toContain('0.9.0');
  });

  it('清单里写越界路径直接被挡下（更新包不能在磁盘上乱走）', () => {
    expect(() => parseManifest({ ...buildManifest(), files: [{ path: '../evil.exe', bytes: 1, sha256: 'a'.repeat(64) }] }))
      .toThrow(/相对路径|越界片段/);
    expect(() => parseManifest({ ...buildManifest(), files: [{ path: 'C:/evil.exe', bytes: 1, sha256: 'a'.repeat(64) }] }))
      .toThrow(/相对路径/);
  });
});

describe('UPDATE-001 · 下载与 A/B 安装', () => {
  it('下载完进 staging、激活后指针切到新槽，旧槽留着（A/B）', async () => {
    const root = tempRoot();
    const manifest = buildManifest();
    const fetchImpl = fakeFetch(manifest);
    const { store, instance } = service(root, fetchImpl);

    await instance.check();
    const downloaded = await instance.download();
    expect(downloaded.phase).toBe('ready');
    expect(downloaded.stagedVersion).toBe('0.4.0');
    expect(downloaded.receivedBytes).toBe(downloaded.totalBytes);
    /* staging 里真的落了文件 */
    expect(readdirSync(store.stagingDir('0.4.0')).sort()).toContain('app');

    const activated = instance.activate();
    expect(activated.phase).toBe('idle');
    expect(activated.activeSlot?.version).toBe('0.4.0');
    /* 还没确认启动成功之前不算装好 */
    expect(activated.activeSlot?.health).toBe('pending');
    /*
      首次更新：盘上只有新槽。旧的一版是**随安装包发出来的那一份**，
      它躺在安装目录里、不由更新器管理——所以这里的"另一面"不是槽。
    */
    expect(activated.slots).toEqual(['0.4.0']);
    expect(activated.stagedVersion).toBeNull();
    expect(existsSync(join(store.slotDir('0.4.0'), 'app', 'main.js'))).toBe(true);
  });

  it('第二次更新后两个槽同时在盘上；回滚回到上一个槽（真正的 A/B）', async () => {
    const root = tempRoot();
    const first = buildManifest({ version: '0.4.0', counter: 12 });
    const { store, instance } = service(root, fakeFetch(first));
    await instance.check();
    await instance.download();
    instance.activate();
    instance.markHealthy();

    const second = buildManifest({ version: '0.5.0', counter: 13 });
    const secondFetch = fakeFetch(second);
    const upgraded = new UpdateService({
      store,
      currentVersion: '0.4.0',
      channelUrl: 'https://updates.example.test/stable/latest.json',
      publicKey: KEYS.publicKey,
      fetch: secondFetch,
    });
    await upgraded.check();
    await upgraded.download();
    const activated = upgraded.activate();

    expect(activated.slots.sort()).toEqual(['0.4.0', '0.5.0']);
    expect(activated.activeSlot?.version).toBe('0.5.0');

    const rolledBack = upgraded.rollback('演练');
    expect(rolledBack.activeSlot?.version).toBe('0.4.0');
    expect(rolledBack.lastRollback).toMatchObject({ from: '0.5.0', to: '0.4.0', reason: '演练' });
    /* 被换下来的那一槽仍然在盘上，可以再试 */
    expect(rolledBack.slots).toContain('0.5.0');
  });

  it('首次更新出问题时，回滚目标为空 = 回到安装目录（那一版永远在）', async () => {
    const root = tempRoot();
    const manifest = buildManifest();
    const { instance } = service(root, fakeFetch(manifest));
    await instance.check();
    await instance.download();
    instance.activate();

    expect(instance.dumpState().previous).toBeNull();
    const rolledBack = instance.rollback('新版起不来');
    expect(rolledBack.activeSlot).toBeNull();
    expect(rolledBack.lastRollback).toMatchObject({ from: '0.4.0', to: '0.3.0' });
    /* 没有指针 = 跑安装目录里的那一版 */
    expect(instance.resolveActiveSlot()).toBeNull();
  });

  it('文件与清单对不上：整包作废、staging 清空、指针不动', async () => {
    const root = tempRoot();
    const manifest = buildManifest();
    const fetchImpl = fakeFetch(manifest, FILES, { overrides: { 'app/renderer.js': 'console.log("被人换过");' } });
    const { store, instance } = service(root, fetchImpl);

    await instance.check();
    const status = await instance.download();

    expect(status.phase).toBe('error');
    expect(status.failure?.code).toBe('UPDATE_FILE_HASH_MISMATCH');
    expect(existsSync(store.stagingDir('0.4.0'))).toBe(false);
    /* 指针没动过：还是"跑安装目录那一版" */
    expect(status.activeSlot).toBeNull();
    expect(status.slots).toEqual([]);
  });

  it('下载中途断线：报下载失败、不留 staging、不切槽', async () => {
    const root = tempRoot();
    const manifest = buildManifest();
    const { store, instance } = service(root, fakeFetch(manifest, FILES, { failOn: 'resources/notes.txt' }));

    await instance.check();
    const status = await instance.download();

    expect(status.failure?.code).toBe('UPDATE_DOWNLOAD_FAILED');
    expect(existsSync(store.stagingDir('0.4.0'))).toBe(false);
    expect(status.activeSlot).toBeNull();
  });

  it('暂停后能恢复：暂停时停在 paused，恢复后补完并进入就绪', async () => {
    const root = tempRoot();
    const manifest = buildManifest();
    let api: UpdateService | undefined;
    let pausedOnce = false;
    const fetchImpl = fakeFetch(manifest, FILES, {
      onFirstChunk: () => {
        if (pausedOnce) return;
        pausedOnce = true;
        api?.pause();
      },
    });
    const { instance } = service(root, fetchImpl);
    api = instance;

    await instance.check();
    const paused = await instance.download();
    expect(paused.phase).toBe('paused');
    expect(paused.receivedBytes).toBeGreaterThan(0);
    expect(paused.receivedBytes).toBeLessThan(paused.totalBytes);

    const resumed = await instance.resume();
    expect(resumed.phase).toBe('ready');
    expect(resumed.receivedBytes).toBe(resumed.totalBytes);
  });

  it('离线包走同一套校验：合法的能装、被改过的装不了', async () => {
    const root = tempRoot();
    const packageDir = join(root, 'local-package');
    for (const [path, content] of Object.entries(FILES)) {
      const target = join(packageDir, path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
    const manifest = buildManifest();
    writeFileSync(join(packageDir, 'update-manifest.json'), JSON.stringify(manifest, null, 2));

    const good = service(join(root, 'good'), fakeFetch(manifest));
    const ok = good.instance.installFromDirectory(packageDir);
    expect(ok.phase).toBe('ready');
    expect(ok.stagedVersion).toBe('0.4.0');

    /* 把包里一个文件改掉：签名对、哈希不对 */
    writeFileSync(join(packageDir, 'app', 'main.js'), 'console.log("被改过");');
    const bad = service(join(root, 'bad'), fakeFetch(manifest));
    const refused = bad.instance.installFromDirectory(packageDir);
    expect(refused.failure?.code).toBe('UPDATE_FILE_HASH_MISMATCH');
    expect(refused.phase).toBe('error');
  });
});

describe('UPDATE-001 · 启动体检与回滚', () => {
  /**
   * 走完"检查 → 下载 → 切槽"，再以**新版的身份**另起一个实例
   * （`currentVersion` = 0.4.0），模拟"重启之后跑的是新槽里那一版"。
   *
   * 这一步是刻意的：更新器必须分得清"指针指着新版"和"我正在跑新版"。
   */
  async function activateAndRestart(root: string) {
    const manifest = buildManifest();
    const store = new UpdateStore(root);
    const installer = new UpdateService({
      store,
      currentVersion: '0.3.0',
      channelUrl: 'https://updates.example.test/stable/latest.json',
      publicKey: KEYS.publicKey,
      fetch: fakeFetch(manifest),
    });
    await installer.check();
    await installer.download();
    const activated = installer.activate();
    const restarted = new UpdateService({
      store,
      currentVersion: '0.4.0',
      channelUrl: 'https://updates.example.test/stable/latest.json',
      publicKey: KEYS.publicKey,
      fetch: fakeFetch(manifest),
    });
    return { store, installer, restarted, activated, manifest };
  }

  it('新版确认健康后不再回滚', async () => {
    const root = tempRoot();
    const { restarted } = await activateAndRestart(root);

    const boot = restarted.bootCheck();
    expect(boot.rolledBack).toBe(false);
    expect(boot.applied).toBe(true);
    expect(boot.status.activeSlot?.health).toBe('pending');

    restarted.markHealthy();
    const healthy = restarted.bootCheck();
    expect(healthy.rolledBack).toBe(false);
    expect(healthy.status.activeSlot?.version).toBe('0.4.0');
    expect(healthy.status.activeSlot?.health).toBe('ok');
    expect(healthy.status.activeSlot?.attempts).toBe(0);
  });

  it('还没重启（跑的还是旧可执行文件）时不记启动尝试、也不回滚', async () => {
    const root = tempRoot();
    const { installer, activated } = await activateAndRestart(root);

    /* 切槽成功，但这一版还没生效 */
    expect(activated.activeSlot?.version).toBe('0.4.0');
    expect(activated.activationApplied).toBe(false);

    const boot = installer.bootCheck();
    expect(boot.applied).toBe(false);
    expect(boot.rolledBack).toBe(false);
    /* 关键：**不能**因为"我还没跑新版"就把它判成起不来 */
    expect(boot.status.activeSlot?.attempts).toBe(0);
    expect(boot.status.activeSlot?.version).toBe('0.4.0');
    expect(boot.status.lastRollback).toBeNull();
  });

  it('新版起不来：下一次启动自动回到上一版，且失败的那一槽还在（能再试）', async () => {
    const root = tempRoot();
    const { store, restarted } = await activateAndRestart(root);

    /* 第一次启动：记一次尝试，应用还没来得及 markHealthy 就崩了 */
    const firstBoot = restarted.bootCheck();
    expect(firstBoot.rolledBack).toBe(false);
    expect(firstBoot.status.activeSlot?.attempts).toBe(1);

    /* 第二次启动：还是 pending → 判定起不来，自动回滚 */
    const secondBoot = restarted.bootCheck();
    expect(secondBoot.rolledBack).toBe(true);
    /* 首次更新：回滚目标为空 = 跑安装目录里那一版 */
    expect(secondBoot.status.activeSlot).toBeNull();
    expect(secondBoot.status.lastRollback?.to).toBe('0.3.0');
    expect(secondBoot.status.lastRollback?.from).toBe('0.4.0');
    expect(secondBoot.status.lastRollback?.reason).toContain('没有确认启动成功');
    /* 回滚不需要网络、也不需要重新下载：两个槽都还在 */
    expect(secondBoot.status.slots).toContain('0.4.0');
    expect(existsSync(store.slotDir('0.4.0'))).toBe(true);
    /* 回滚是正常动作，不该留下 failure */
    expect(secondBoot.status.failure).toBeNull();
  });

  it('槽里的文件事后被人动过：启动体检直接回滚', async () => {
    const root = tempRoot();
    const { store, restarted } = await activateAndRestart(root);
    restarted.markHealthy();

    writeFileSync(join(store.slotDir('0.4.0'), 'app', 'main.js'), 'console.log("被人改过");');
    const boot = restarted.bootCheck();

    expect(boot.rolledBack).toBe(true);
    expect(boot.reason).toContain('文件校验不通过');
    expect(boot.status.activeSlot).toBeNull();
    expect(boot.status.lastRollback?.to).toBe('0.3.0');
  });

  it('没有上一槽时不允许回滚（不假装回过滚）', () => {
    const root = tempRoot();
    const { instance } = service(root, fakeFetch({}));
    const status = instance.rollback('手滑');
    expect(status.failure?.code).toBe('UPDATE_STATE_CONFLICT');
  });

  it('偏好设置与"当前槽"会落盘：换一个实例也读得回来', () => {
    const root = tempRoot();
    const { instance } = service(root, fakeFetch({}));
    instance.setPrefs({ autoDownload: true });

    const reopened = service(root, fakeFetch({})).instance;
    const status = reopened.status();
    expect(status.prefs.autoDownload).toBe(true);
    expect(status.prefs.autoCheck).toBe(true);
    /* 没装过更新时指针为空 = 跑安装目录里的那一版 */
    expect(status.activeSlot).toBeNull();
  });

  it('状态文件坏了不影响启动：备份坏文件、从默认状态继续', () => {
    const root = tempRoot();
    const store = new UpdateStore(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(store.statePath, '{ 这不是 JSON');

    const { instance } = service(root, fakeFetch({}));
    expect(instance.status().activeSlot).toBeNull();
    expect(readdirSync(root).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
  });
});

describe('UPDATE-001 · 槽内容复核', () => {
  it('verifySlot 逐文件比哈希，改动过的文件被点名', async () => {
    const root = tempRoot();
    const manifest = buildManifest();
    const { store, instance } = service(root, fakeFetch(manifest));
    await instance.check();
    await instance.download();
    instance.activate();

    expect(instance.verifySlot('0.4.0')).toEqual({ ok: true, checked: 3, mismatch: [] });
    writeFileSync(join(store.slotDir('0.4.0'), 'resources', 'notes.txt'), '被改过');
    const after = instance.verifySlot('0.4.0');
    expect(after.ok).toBe(false);
    expect(after.mismatch).toEqual(['resources/notes.txt']);
    /* 槽里的清单本身也要在（复核靠它） */
    expect(JSON.parse(readFileSync(join(store.slotDir('0.4.0'), 'update-manifest.json'), 'utf8')).version).toBe('0.4.0');
  });
});
