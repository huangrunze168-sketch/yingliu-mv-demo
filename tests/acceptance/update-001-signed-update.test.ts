/* ============================================================
  UPDATE-001「签名更新、A/B 安装、失败回滚」的量化验收。

  这条的验收口径是三个数：

    ① **篡改样本拒绝率 100%**：清单里任何一处被改过，都装不上；
    ② **A/B 两面同时在盘上**：第二次更新之后，新旧两个槽都还在，
       回滚只是把指针指回去（不需要网络、不需要重新下载）；
    ③ **启动失败自动回滚**：新版连续起不来时，下一次启动前就已经回到上一版。

  这一条不联网：清单由测试自己签（用的是**发布工具同一个签名函数**），
  文件由测试自己给。要验的不是"能不能下载"，而是那几个一旦写错就会静默出事的判断。
   ============================================================ */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  UpdateService, UpdateStore, generateUpdateKeyPair, keyIdOf, sha256Hex, signManifest,
  type UpdateFetch, type UpdateManifest,
} from '@qiyin/update-service';
import { recordAcceptance } from './_acceptance.js';

const root = mkdtempSync(join(tmpdir(), 'qiyin-acceptance-update-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const KEYS = generateUpdateKeyPair();
const CHANNEL = 'https://updates.example.test/stable/latest.json';

/** 一份"待发布"的载荷：五个文件，其中一个在子目录里。 */
const PAYLOAD: Record<string, string> = {
  'app/main.js': 'console.log("main 0.4.0");',
  'app/preload.js': 'console.log("preload 0.4.0");',
  'app/renderer/index.html': '<!doctype html><title>小QTV</title>',
  'resources/license.txt': '期音科技',
  'resources/models.json': '{"models":[]}',
};

function writePayload(dir: string, files: Record<string, string> = PAYLOAD): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

/** 与 `scripts/update-sign.mts` 走同一个签名函数，保证发布端与客户端算法一致。 */
function buildSignedManifest(overrides: Partial<Parameters<typeof signManifest>[0]> = {}): UpdateManifest {
  return signManifest({
    schema: 'xqtv.update-manifest@1',
    version: '0.4.0',
    channel: 'stable',
    counter: 13,
    minSupportedVersion: '0.2.0',
    publishedAt: '2026-09-21T02:00:00.000Z',
    notes: '修了导出画幅',
    files: Object.entries(PAYLOAD).map(([path, content]) => ({
      path,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256Hex(content),
    })),
    build: { commit: 'deadbee', builder: 'ci@qiyin', builtAt: '2026-09-21T02:00:00.000Z' },
    ...overrides,
  }, KEYS.privateKey, keyIdOf(KEYS.publicKey));
}

/** 离线网络实现：只从内存里取文件，绝不联网。 */
function offlineFetch(manifest: unknown, files: Record<string, string> = PAYLOAD): UpdateFetch & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readJson(url: string) {
      calls.push(url);
      return manifest;
    },
    async writeToFile(url: string, targetPath: string, options = {}) {
      calls.push(url);
      const relative = Object.keys(files).find((path) => url.endsWith(path));
      if (relative === undefined) throw new Error(`离线包缺文件：${url}`);
      const content = files[relative] ?? '';
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, content, 'utf8');
      options.onProgress?.(Buffer.byteLength(content, 'utf8'), Buffer.byteLength(content, 'utf8'));
      return { bytes: Buffer.byteLength(content, 'utf8'), paused: false };
    },
  };
}

function makeService(storeRoot: string, currentVersion: string, fetchImpl: UpdateFetch) {
  const store = new UpdateStore(storeRoot);
  return new UpdateService({
    store,
    currentVersion,
    channelUrl: CHANNEL,
    publicKey: KEYS.publicKey,
    fetch: fetchImpl,
  });
}

/** 对清单做一处改动，且改动**放在签名之后**（模拟被篡改的发布包）。 */
const TAMPERS: Array<{ name: string; apply: (manifest: UpdateManifest) => UpdateManifest }> = [
  { name: '改版本号', apply: (m) => ({ ...m, version: '9.9.9' }) },
  { name: '改 counter（降级重放）', apply: (m) => ({ ...m, counter: 1 }) },
  { name: '改发布说明', apply: (m) => ({ ...m, notes: '我改过这句话' }) },
  { name: '改通道', apply: (m) => ({ ...m, channel: 'evil' }) },
  { name: '改桥接版本（放开老客户端）', apply: (m) => ({ ...m, minSupportedVersion: '0.0.1' }) },
  { name: '改发布时间', apply: (m) => ({ ...m, publishedAt: '2000-01-01T00:00:00.000Z' }) },
  { name: '改文件哈希', apply: (m) => ({ ...m, files: m.files.map((file, index) => (index === 0 ? { ...file, sha256: 'b'.repeat(64) } : file)) }) },
  { name: '改文件大小', apply: (m) => ({ ...m, files: m.files.map((file, index) => (index === 0 ? { ...file, bytes: file.bytes + 1 } : file)) }) },
  { name: '少一个文件', apply: (m) => ({ ...m, files: m.files.slice(0, -1) }) },
  { name: '多一个文件', apply: (m) => ({ ...m, files: [...m.files, { path: 'app/extra.js', bytes: 1, sha256: 'c'.repeat(64) }] }) },
  { name: '改构建来源', apply: (m) => ({ ...m, build: { ...m.build, commit: 'attacker' } }) },
  { name: '换签名值', apply: (m) => ({ ...m, signature: { ...m.signature, value: Buffer.from('伪造').toString('base64') } }) },
];

describe('[UPDATE-001] 签名更新 / A-B 安装 / 失败回滚', () => {
  it('篡改样本：12 处改动全部被拒，且一次都不落盘、指针不动', async () => {
    const outcomes: Array<{ sample: string; rejected: boolean; code: string; slots: number }> = [];
    for (const [index, tamper] of TAMPERS.entries()) {
      const serviceRoot = join(root, `tamper-${index}`);
      const tampered = tamper.apply(buildSignedManifest());
      const instance = makeService(serviceRoot, '0.3.0', offlineFetch(tampered));
      const status = await instance.check();
      /* 再试着下载一次：即使检查放过了，下载也必须失败 */
      const afterDownload = await instance.download();
      outcomes.push({
        sample: tamper.name,
        rejected: status.phase === 'error' || afterDownload.phase === 'error',
        code: status.failure?.code ?? afterDownload.failure?.code ?? '(无)',
        slots: status.slots.length + afterDownload.slots.length,
      });
    }
    const rejected = outcomes.filter((row) => row.rejected).length;
    const leftoverSlots = outcomes.reduce((sum, row) => sum + row.slots, 0);

    recordAcceptance('UPDATE-001.tamper', {
      criterion: '清单篡改样本拒绝率 100%（签名覆盖的字节任何一处改动都算）',
      samples: TAMPERS.length,
      rejected,
      leftoverSlots,
      codes: [...new Set(outcomes.map((row) => row.code))],
    });

    expect(rejected).toBe(TAMPERS.length);
    expect(leftoverSlots).toBe(0);
  });

  it('发布→验签→安装→切槽→回滚全链路：A/B 两面都在盘上，回滚不联网', async () => {
    const serviceRoot = join(root, 'full-chain');
    const firstFetch = offlineFetch(buildSignedManifest({ version: '0.4.0', counter: 13 }));
    const installer = makeService(serviceRoot, '0.3.0', firstFetch);

    const checked = await installer.check();
    expect(checked.phase).toBe('available');
    expect(checked.fileCount).toBe(5);
    const downloaded = await installer.download();
    expect(downloaded.failure).toBeNull();
    const activatedFirst = installer.activate();
    expect(activatedFirst.activeSlot?.version).toBe('0.4.0');
    expect(activatedFirst.activeSlot?.health).toBe('pending');

    /* 以新版身份重启：确认健康 */
    const runningNew = makeService(serviceRoot, '0.4.0', offlineFetch(buildSignedManifest()));
    const boot = runningNew.bootCheck();
    expect(boot.applied).toBe(true);
    runningNew.markHealthy();

    /* 第二次更新：0.5.0 */
    const secondFetch = offlineFetch(buildSignedManifest({ version: '0.5.0', counter: 14 }));
    const secondInstall = makeService(serviceRoot, '0.4.0', secondFetch);
    await secondInstall.check();
    await secondInstall.download();
    const activatedSecond = secondInstall.activate();
    expect(activatedSecond.slots.sort()).toEqual(['0.4.0', '0.5.0']);
    expect(activatedSecond.activeSlot?.version).toBe('0.5.0');

    /* 回滚：记录回滚前后的网络调用次数，回滚必须是纯本地的 */
    const callsBefore = secondFetch.calls.length;
    const rolledBack = secondInstall.rollback('演练：新版画面异常');
    const callsAfter = secondFetch.calls.length;

    recordAcceptance('UPDATE-001.ab-rollback', {
      criterion: 'A/B 两面同时在盘上；回滚不新增任何网络请求',
      slotsAfterSecondUpdate: activatedSecond.slots,
      activeAfterActivate: activatedSecond.activeSlot?.version,
      activeAfterRollback: rolledBack.activeSlot?.version,
      rollbackNetworkCalls: callsAfter - callsBefore,
      lastRollback: rolledBack.lastRollback,
      failureAfterRollback: rolledBack.failure,
    });

    expect(rolledBack.activeSlot?.version).toBe('0.4.0');
    expect(rolledBack.lastRollback).toMatchObject({ from: '0.5.0', to: '0.4.0' });
    expect(callsAfter).toBe(callsBefore);
    expect(rolledBack.failure).toBeNull();
  });

  it('启动失败：连续起不来时下一次启动前就已经回滚，失败那一槽留着可再试', async () => {
    const serviceRoot = join(root, 'boot-failure');
    const manifest = buildSignedManifest();
    const installer = makeService(serviceRoot, '0.3.0', offlineFetch(manifest));
    await installer.check();
    await installer.download();
    installer.activate();

    /* 以新版身份启动两次都没确认健康（模拟启动即崩） */
    const runningNew = makeService(serviceRoot, '0.4.0', offlineFetch(manifest));
    const first = runningNew.bootCheck();
    const second = runningNew.bootCheck();

    recordAcceptance('UPDATE-001.boot-rollback', {
      criterion: '新版连续起不来 → 下一次启动前自动回到上一版',
      firstBootRolledBack: first.rolledBack,
      firstBootAttempts: first.status.activeSlot?.attempts ?? 0,
      secondBootRolledBack: second.rolledBack,
      reason: second.reason,
      activeAfterRollback: second.status.activeSlot,
      baseVersion: second.status.baseVersion,
      slotsKept: second.status.slots,
    });

    expect(first.rolledBack).toBe(false);
    expect(first.status.activeSlot?.attempts).toBe(1);
    expect(second.rolledBack).toBe(true);
    expect(second.reason ?? '').toContain('没有确认启动成功');
    /* 首次更新：回滚目标为空 = 回到安装目录里那一版 */
    expect(second.status.activeSlot).toBeNull();
    expect(second.status.baseVersion).toBe('0.3.0');
    /* 失败的那一槽还在盘上（可以再试，不需要重新下载） */
    expect(second.status.slots).toContain('0.4.0');
    expect(readFileSync(join(serviceRoot, 'state.json'), 'utf8')).toContain('0.4.0');
  });

  it('发布目录 → 客户端离线安装：签名清单与文件都能被真机读出来', () => {
    /* 这一条走的是发布工具的真实产物形态：一个目录 + 里面的 update-manifest.json */
    const publishDir = join(root, 'publish-0.4.0');
    writePayload(publishDir);
    const manifest = buildSignedManifest();
    writeFileSync(join(publishDir, 'update-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const serviceRoot = join(root, 'offline-install');
    const instance = makeService(serviceRoot, '0.3.0', offlineFetch(manifest));
    const installed = instance.installFromDirectory(publishDir);
    const activated = instance.activate();

    const filesInSlot = ['app/main.js', 'app/preload.js', 'app/renderer/index.html', 'resources/license.txt', 'resources/models.json'];
    const slotFiles = filesInSlot.filter((path) => existsSync(join(serviceRoot, 'slots', '0.4.0', path)));
    const integrity = instance.verifySlot('0.4.0');

    recordAcceptance('UPDATE-001.offline', {
      criterion: '发布目录能被客户端原样验收（离线包走同一套校验）',
      installedPhase: installed.phase,
      stagedVersion: installed.stagedVersion,
      activeAfterActivate: activated.activeSlot?.version,
      slotFilesPresent: slotFiles.length,
      expectedSlotFiles: filesInSlot.length,
      verifySlot: integrity,
    });

    expect(installed.phase).toBe('ready');
    expect(slotFiles.length).toBe(filesInSlot.length);
    expect(integrity).toEqual({ ok: true, checked: 5, mismatch: [] });
  });
});
