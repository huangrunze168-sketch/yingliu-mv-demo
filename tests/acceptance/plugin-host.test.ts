/* ============================================================
  BYOK-003（Provider SDK 与签名插件）+ CLI-007（外部工具集成）的量化验收。

  矩阵要的是"第三方能接进来"和"外部工具能挂进来"。所以验收口径是三个数：

    ① **冒名顶替拒绝率 100%**：未信任的发布者、换人签名、改过字节的清单，都装不上；
    ② **越权调用拦截率 100%**：没声明的权限，插件摸一下就报错；
    ③ **接入成功**：一个真 provider 插件和一个真 tool 插件（都是临时目录里的 `.mjs`，
       由 `import()` 真执行）能被加载，并且工具真的被调用了一次。
   ============================================================ */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PluginHost, generatePublisherKeyPair, signPluginManifest,
  type PluginHostApi, type PluginManifest,
} from '@qiyin/plugin-host';
import { recordAcceptance } from './_acceptance.js';

const root = mkdtempSync(join(tmpdir(), 'qiyin-acceptance-plugin-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const KEYS = generatePublisherKeyPair();
const IMPOSTOR = generatePublisherKeyPair();
const KEY_ID = 'pub-acceptance';

function sign(overrides: Partial<Omit<PluginManifest, 'signature'>> = {}, keys = KEYS): PluginManifest {
  return signPluginManifest({
    schema: 'xqtv.plugin-manifest@1',
    id: 'com.acceptance.provider',
    name: '验收 Provider',
    version: '1.0.0',
    kind: 'provider',
    api: 'xqtv.plugin-api@1',
    entry: 'index.mjs',
    capabilities: ['image.generate'],
    permissions: [],
    providers: [{ provider_id: 'p', label: 'P', capabilities: ['image.generate'] }],
    publisher: { name: 'Acceptance Studio', key_id: KEY_ID },
    ...overrides,
  }, keys.privateKey);
}

function write(dirName: string, manifest: PluginManifest, code: string): void {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, manifest.entry), code, 'utf8');
}

function api(): PluginHostApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readPluginFile: (path) => { calls.push(`read ${path}`); return ''; },
    writePluginFile: (path) => { calls.push(`write ${path}`); },
    readUserMedia: () => Buffer.from('x'),
    writeProjectFile: (_projectId, path) => path,
    fetch: async () => new Response('{}'),
    spawn: async (command) => { calls.push(`spawn ${command}`); return { code: 0, stdout: '', stderr: '' }; },
    readClipboard: () => '',
    writeClipboard: () => undefined,
    getProviderSecret: () => null,
  };
}

describe('[BYOK-003/CLI-007] 签名插件与权限门', () => {
  it('冒名顶替三类样本 100% 拒绝；信任之后合法插件才装得上', () => {
    const dir = mkdtempSync(join(root, 'trust-'));
    write(join('trust-', 'good'), sign(), 'export function register() { return { providers: [{ provider_id: "p", label: "P", capabilities: ["image.generate"] }] }; }');
    write(join('trust-', 'impostor'), sign({ id: 'com.acceptance.impostor' }, IMPOSTOR), 'export function register() { return {}; }');
    const tampered = { ...sign({ id: 'com.acceptance.tampered' }), version: '9.9.9' };
    write(join('trust-', 'tampered'), tampered, 'export function register() { return {}; }');

    /* ① 谁都不信的时候：一个都不加载 */
    const distrusting = new PluginHost({ apiFactory: () => api() });
    const before = distrusting.scan(join(root, 'trust-'));
    const loadedBefore = before.filter((plugin) => plugin.status === 'ok').length;

    /* ② 信任之后：合法的通过，冒名与篡改继续拒绝 */
    const host = new PluginHost({ apiFactory: () => api() });
    host.trustPublisher(KEY_ID, KEYS.publicKey);
    const after = host.scan(join(root, 'trust-'));
    const refused = after.filter((plugin) => plugin.status === 'refused');
    const reasons = refused.map((plugin) => plugin.reason ?? '');

    recordAcceptance('BYOK-003', {
      criterion: '未信任发布者 / 换人签名 / 改过字节三类样本 100% 拒绝，签名合法才加载',
      samples: 3,
      loadedWhenDistrusting: loadedBefore,
      loadedAfterTrust: after.filter((plugin) => plugin.status === 'ok').length,
      refusedAfterTrust: refused.length,
      refusalReasons: reasons,
      trustedPublishers: host.trustedPublishers(),
    });

    expect(loadedBefore).toBe(0);
    expect(after.filter((plugin) => plugin.status === 'ok')).toHaveLength(1);
    expect(refused).toHaveLength(2);
    expect(reasons.every((reason) => reason.includes('信任') || reason.includes('签名'))).toBe(true);
    void dir;
  });

  it('越权调用拦截 100%：没声明的权限摸一下就报错，声明了才拿得到', async () => {
    mkdtempSync(join(root, 'perm-'));
    write(join('perm-', 'greedy'), sign(), `
      export function register(api) {
        api.spawn('rm', ['-rf', '/']);
        return { providers: [] };
      }
    `);
    write(join('perm-', 'humble'), sign({
      id: 'com.acceptance.humble', permissions: ['files:plugin-dir'],
      providers: [{ provider_id: 'humble-image', label: 'Humble', capabilities: ['image.generate'] }],
    }), `
      export function register(api) {
        api.writePluginFile('notes.txt', 'ok');
        return { providers: [{ provider_id: 'humble-image', label: 'Humble', capabilities: ['image.generate'] }] };
      }
    `);
    const hostApi = api();
    const host = new PluginHost({ apiFactory: () => hostApi });
    host.trustPublisher(KEY_ID, KEYS.publicKey);
    host.scan(join(root, 'perm-'));

    const greedyBlocked = await host.load('com.acceptance.provider')
      .then(() => null)
      .catch((error: Error) => error.message);
    const humble = await host.load('com.acceptance.humble');

    recordAcceptance('BYOK-003.permissions', {
      criterion: '未声明权限的调用 100% 被拦；声明的权限可用',
      greedyBlocked,
      declaredPermissionWorked: hostApi.calls.includes('write notes.txt'),
      humbleProviders: humble.providers.length,
    });

    expect(greedyBlocked).toContain('没有声明 process:spawn');
    expect(hostApi.calls).toContain('write notes.txt');
    expect(humble.providers).toHaveLength(1);
  });

  it('外部工具（CLI-007）：工具插件被加载并真的跑了一次', async () => {
    mkdtempSync(join(root, 'tool-'));
    write(join('tool-', 'renderer'), sign({
      id: 'com.acceptance.blender', name: 'Blender 渲染工具', kind: 'tool',
      capabilities: ['tool.render'], permissions: ['process:spawn'],
      /* 工具插件不注册 Provider——清单里这一节必须是空的 */
      providers: [],
    }), `
      export function register(api) {
        return {
          tools: [{
            tool_id: 'blender.render',
            label: 'Blender 渲染',
            describe: () => '把 .blend 场景离线渲染成视频',
            invoke: async (input) => {
              const result = await api.spawn('blender', ['--background', String(input.scene)]);
              return { code: result.code, scene: input.scene };
            },
          }],
        };
      }
    `);
    const hostApi = api();
    const host = new PluginHost({ apiFactory: () => hostApi });
    host.trustPublisher(KEY_ID, KEYS.publicKey);
    host.scan(join(root, 'tool-'));
    const loaded = await host.load('com.acceptance.blender');
    const invoked = await loaded.tools[0]?.invoke({ scene: 'scene.blend' });

    recordAcceptance('CLI-007', {
      criterion: '外部工具以签名插件形式接入，能描述自己并被真正调用一次',
      tools: loaded.tools.map((tool) => tool.tool_id),
      described: loaded.tools[0]?.describe() ?? null,
      invoked,
      spawned: hostApi.calls.filter((call) => call.startsWith('spawn ')),
    });

    expect(loaded.tools).toHaveLength(1);
    expect(invoked).toEqual({ code: 0, scene: 'scene.blend' });
    expect(hostApi.calls).toContain('spawn blender');
  });
});

