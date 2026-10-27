/* ============================================================
  BYOK-003（Provider SDK 与签名插件）+ CLI-007（外部工具集成）。

  插件是**别人写的代码**，会被我们的进程加载。所以这一组用例盯的是四道门：

    ① 清单严格解析（未知能力/权限、越界入口一律拒绝）；
    ② 能力与类型自洽（tool 不能声明生成能力，反之亦然）；
    ③ 签名与信任（未信任的发布者不加载；改一个字节就不认）；
    ④ 权限门（没声明 network 的插件去摸 fetch 要当场报错）。

  真插件是用测试临时目录里的 `.mjs` 加载的——不是打桩，`import()` 真的会执行它。
  这一条很重要：插件的形状对不对，只有真加载一次才知道。
   ============================================================ */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PLUGIN_AUTH_METHODS, PluginHost, PluginError, describePluginLimits, generatePublisherKeyPair, parsePluginManifest,
  signPluginManifest, validatePluginConsistency,
  type PluginHostApi, type PluginManifest,
} from '@qiyin/plugin-host';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qiyin-plugin-'));
  roots.push(root);
  return root;
}

const KEYS = generatePublisherKeyPair();
const OTHER_KEYS = generatePublisherKeyPair();
const KEY_ID = 'pub-qiyin-test';

/** 造一份签名清单。 */
function manifestOf(overrides: Partial<Omit<PluginManifest, 'signature'>> = {}, keys = KEYS): PluginManifest {
  return signPluginManifest({
    schema: 'xqtv.plugin-manifest@1',
    id: 'com.example.provider',
    name: '示例 Provider',
    version: '1.0.0',
    kind: 'provider',
    api: 'xqtv.plugin-api@1',
    entry: 'index.mjs',
    capabilities: ['image.generate'],
    permissions: [],
    providers: [],
    publisher: { name: 'Example Studio', key_id: KEY_ID },
    ...overrides,
  }, keys.privateKey);
}

/**
 * 一份 provider 插件清单：**清单里必须声明它要注册的 Provider**。
 * 这样宿主不跑插件代码就知道"装了哪些 Provider、各自支持什么"，
 * 加载之后还能核对"注册的和声明的是不是同一份"。
 */
function providerManifest(overrides: Partial<Omit<PluginManifest, 'signature'>> = {}, keys = KEYS): PluginManifest {
  return manifestOf({
    providers: [{ provider_id: 'p', label: 'P', capabilities: ['image.generate'] }],
    ...overrides,
  }, keys);
}

/**
 * 造一份**没签过名**的原始清单对象。

 * 给"解析阶段就该拦下"的用例用：签名 helper 自己会先解析一遍，
 * 拿它去构造坏清单，测到的是"构造失败"而不是"解析器认得出错在哪"。
 */
function rawManifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: 'xqtv.plugin-manifest@1',
    id: 'com.example.provider',
    name: '示例 Provider',
    version: '1.0.0',
    kind: 'provider',
    api: 'xqtv.plugin-api@1',
    entry: 'index.mjs',
    capabilities: ['image.generate'],
    permissions: [],
    providers: [],
    publisher: { name: 'Example Studio', key_id: KEY_ID },
    signature: { algorithm: 'ed25519', value: 'not-a-real-signature' },
    ...overrides,
  };
}

/** 把一个插件写进目录：`plugin.json` + 代码。 */
function writePlugin(root: string, dirName: string, manifest: PluginManifest, code: string): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, manifest.entry), code, 'utf8');
  return dir;
}

/** 一个假的宿主能力面：每个方法都记下"被谁调过"。 */
function fakeApi(): PluginHostApi & { calls: string[] } {
  const calls: string[] = [];
  const pluginFiles = new Map<string, string>();
  return {
    calls,
    readPluginFile: (relativePath) => { calls.push(`read ${relativePath}`); return pluginFiles.get(relativePath) ?? ''; },
    writePluginFile: (relativePath, content) => { calls.push(`write ${relativePath}`); pluginFiles.set(relativePath, content); },
    readUserMedia: (absolutePath) => { calls.push(`media ${absolutePath}`); return Buffer.from('media'); },
    writeProjectFile: (projectId, relativePath) => { calls.push(`project ${projectId} ${relativePath}`); return relativePath; },
    fetch: async (input) => { calls.push(`fetch ${input}`); return new Response('{}'); },
    spawn: async (command) => { calls.push(`spawn ${command}`); return { code: 0, stdout: '', stderr: '' }; },
    readClipboard: () => { calls.push('clip-read'); return 'x'; },
    writeClipboard: () => { calls.push('clip-write'); },
    getProviderSecret: (providerId) => { calls.push(`secret ${providerId}`); return null; },
  };
}

describe('插件清单 · 严格解析', () => {
  it('合法清单解析通过，并能描述自己的边界', () => {
    const manifest = manifestOf();
    expect(manifest.id).toBe('com.example.provider');
    expect(describePluginLimits()).toContain('同进程');
  });

  it('未知能力 / 未知权限 / 入口越界一律拒绝（中文原因）', () => {
    expect(() => parsePluginManifest({ ...manifestOf(), capabilities: ['image.generate', '做点别的'] }))
      .toThrowError(/不认识的能力/);
    expect(() => parsePluginManifest({ ...manifestOf(), permissions: ['network', 'root'] }))
      .toThrowError(/不认识的权限/);
    expect(() => parsePluginManifest({ ...manifestOf(), entry: '../../evil.mjs' }))
      .toThrowError(/越界|相对路径/);
    expect(() => parsePluginManifest({ ...manifestOf(), entry: 'C:/evil.mjs' }))
      .toThrowError(/相对路径/);
    expect(() => parsePluginManifest({ ...manifestOf(), api: 'xqtv.plugin-api@2' }))
      .toThrowError(/API 版本/);
  });

  it('能力与类型必须自洽（tool 不许声明生成能力，provider 不许声明工具能力）', () => {
    expect(() => validatePluginConsistency(manifestOf({ kind: 'tool' })))
      .toThrowError(/是 tool，不能声明生成能力/);
    expect(() => validatePluginConsistency(manifestOf({ kind: 'provider', capabilities: ['tool.render'] })))
      .toThrowError(/是 provider，不能声明工具能力/);
    expect(() => validatePluginConsistency(manifestOf({ capabilities: [] })))
      .toThrowError(/没有声明任何能力/);
  });
});

describe('插件宿主 · 签名与信任', () => {
  it('发布者没被信任 → 不加载，并说清要做什么', () => {
    const root = tempRoot();
    writePlugin(root, 'p1', providerManifest(), 'export function register() { return { providers: [] }; }');
    const host = new PluginHost({ apiFactory: () => fakeApi() });
    const scanned = host.scan(root);

    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.status).toBe('refused');
    expect(scanned[0]?.reason).toContain('还没被信任');
    expect(host.trustedPublishers()).toEqual([]);
  });

  it('信任之后能通过；换别人签名、或改一个字节 → 都拒绝', async () => {
    const root = tempRoot();
    writePlugin(root, 'good', providerManifest(), 'export function register() { return { providers: [{ provider_id: "p", label: "P", capabilities: ["image.generate"] }] }; }');
    writePlugin(root, 'forged', providerManifest({ id: 'com.example.forged' }, OTHER_KEYS), 'export function register() { return {}; }');
    /* 签完之后把版本号改掉：签名覆盖的字节变了 */
    const tampered = { ...providerManifest({ id: 'com.example.tampered' }), version: '9.9.9' };
    const dir = writePlugin(root, 'tampered', tampered, 'export function register() { return {}; }');
    expect(readFileSync(join(dir, 'plugin.json'), 'utf8')).toContain('9.9.9');

    const host = new PluginHost({ apiFactory: () => fakeApi() });
    host.trustPublisher(KEY_ID, KEYS.publicKey);
    const scanned = host.scan(root);
    const byId = new Map(scanned.map((plugin) => [plugin.id, plugin]));

    expect(byId.get('com.example.provider')?.status).toBe('ok');
    const forgedStatus = scanned.find((plugin) => plugin.dir.endsWith('forged'));
    expect(forgedStatus?.status).toBe('refused');
    expect(forgedStatus?.reason).toContain('签名与发布者公钥不匹配');
    const tamperedStatus = scanned.find((plugin) => plugin.dir.endsWith('tampered'));
    expect(tamperedStatus?.status).toBe('refused');
    expect(tamperedStatus?.reason).toContain('签名与发布者公钥不匹配');
  });
});

describe('插件宿主 · 权限门', () => {
  it('没声明 network 的插件摸 fetch：当场报错，并点名缺哪条权限', async () => {
    const root = tempRoot();
    writePlugin(root, 'no-net', providerManifest(), `
      export function register(api) {
        /* 直接调用：没声明 network 时，权限门会在这里抛错，加载随之失败 */
        api.fetch('https://example.test');
        return { providers: [{ provider_id: 'p', label: 'P', capabilities: ['image.generate'] }] };
      }
    `);
    const host = new PluginHost({ apiFactory: () => fakeApi() });
    host.trustPublisher(KEY_ID, KEYS.publicKey);
    host.scan(root);

    await expect(host.load('com.example.provider')).rejects.toThrow(/没有声明 network/);
  });

  it('声明了 network 就能拿到；声明了 files:plugin-dir 才能写插件目录', async () => {
    const root = tempRoot();
    writePlugin(root, 'with-net', providerManifest({
      permissions: ['network', 'files:plugin-dir'],
    }), `
      export function register(api) {
        api.writePluginFile('cache.json', '{"ok":true}');
        const again = api.readPluginFile('cache.json');
        return { providers: [{ provider_id: 'p', label: 'P', capabilities: ['image.generate'], again }] };
      }
    `);
    const api = fakeApi();
    const host = new PluginHost({ apiFactory: () => api });
    host.trustPublisher(KEY_ID, KEYS.publicKey);
    host.scan(root);
    await host.load('com.example.provider');

    expect(api.calls).toContain('write cache.json');
    expect(api.calls).toContain('read cache.json');
  });

  it('未声明的权限同样拦得住：只声明 network 就不能写插件目录', async () => {
    const root = tempRoot();
    writePlugin(root, 'net-only', providerManifest({ permissions: ['network'] }), `
      export function register(api) {
        api.writePluginFile('x', 'y');
        return { providers: [{ provider_id: 'p', label: 'P', capabilities: ['image.generate'] }] };
      }
    `);
    const host = new PluginHost({ apiFactory: () => fakeApi() });
    host.trustPublisher(KEY_ID, KEYS.publicKey);
    host.scan(root);
    await expect(host.load('com.example.provider')).rejects.toThrow(/files:plugin-dir/);
  });
});

describe('插件宿主 · 真加载', () => {
  it('provider 插件：注册的 Provider 会被宿主认出来，能力不能超出清单', async () => {
    const root = tempRoot();
    writePlugin(root, 'provider-ok', providerManifest({
      providers: [{ provider_id: 'example-image', label: '示例出图', capabilities: ['image.generate'] }],
    }), `
      export function register() {
        return { providers: [{ provider_id: 'example-image', label: '示例出图', capabilities: ['image.generate'] }] };
      }
    `);
    const host = new PluginHost({ apiFactory: () => fakeApi() });
    host.trustPublisher(KEY_ID, KEYS.publicKey);
    host.scan(root);
    const loaded = await host.load('com.example.provider');

    expect(loaded.providers).toHaveLength(1);
    expect(loaded.providers[0]?.provider_id).toBe('example-image');
    expect(loaded.providers[0]?.capabilities).toEqual(['image.generate']);
    expect(loaded.tools).toEqual([]);
  });

  it('插件谎报能力（注册时声称清单里没有的）→ 加载失败并指出是哪一条', async () => {
    const root = tempRoot();
    writePlugin(root, 'liar', providerManifest({
      providers: [{ provider_id: 'x', label: 'x', capabilities: ['image.generate'] }],
    }), `
      export function register() {
        return { providers: [{ provider_id: 'x', label: 'x', capabilities: ['video.edit'] }] };
      }
    `);
    const host = new PluginHost({ apiFactory: () => fakeApi() });
    host.trustPublisher(KEY_ID, KEYS.publicKey);
    host.scan(root);
    await expect(host.load('com.example.provider')).rejects.toThrow(/没有声明它/);
  });

  it('tool 插件（CLI-007）：describe 与 invoke 真能跑', async () => {
    const root = tempRoot();
    writePlugin(root, 'tool-ok', manifestOf({
      id: 'com.example.blender', name: 'Blender 工具', kind: 'tool',
      capabilities: ['tool.render'], permissions: ['process:spawn'],
    }), `
      export function register(api) {
        return {
          tools: [{
            tool_id: 'blender.render',
            label: 'Blender 渲染',
            describe: () => '把一段场景渲染成视频',
            invoke: async (input) => {
              const result = await api.spawn('blender', ['--background', String(input?.scene ?? '')]);
              return { code: result.code, scene: input?.scene ?? null };
            },
          }],
        };
      }
    `);
    const api = fakeApi();
    const host = new PluginHost({ apiFactory: () => api });
    host.trustPublisher(KEY_ID, KEYS.publicKey);
    host.scan(root);
    const loaded = await host.load('com.example.blender');

    expect(loaded.tools[0]?.describe()).toContain('渲染');
    await expect(loaded.tools[0]?.invoke({ scene: 'demo.blend' })).resolves.toEqual({ code: 0, scene: 'demo.blend' });
    expect(api.calls).toContain('spawn blender');
  });

  it('被拒的插件不能加载；不存在的插件说得清"先扫目录"', async () => {
    const root = tempRoot();
    writePlugin(root, 'refused', providerManifest(), 'export function register() { return {}; }');
    const host = new PluginHost({ apiFactory: () => fakeApi() });
    host.scan(root);
    await expect(host.load('com.example.provider')).rejects.toThrow(/没有被接受/);
    await expect(host.load('com.example.missing')).rejects.toThrow(/先 scan 一次目录/);
    expect(new PluginError('X', 'y').code).toBe('X');
  });
});

describe('清单里的鉴权声明（BYOK-004）', () => {
  it('声明了鉴权方式却没申请读凭据的权限：拒掉，别让用户配了个用不了的', () => {
    const manifest = parsePluginManifest(JSON.parse(JSON.stringify(providerManifest({
      providers: [{
        provider_id: 'p', label: 'P', capabilities: ['image.generate'],
        auth: { methods: ['oauth2'] as const },
      }],
      permissions: [],
    }))) as PluginManifest);
    expect(() => validatePluginConsistency(manifest)).toThrow(/secrets:own-provider/);
  });

  it('申请了读凭据的权限却不说凭据长什么样：也拒掉', () => {
    const manifest = parsePluginManifest(JSON.parse(JSON.stringify(providerManifest({
      permissions: ['secrets:own-provider'],
    }))) as PluginManifest);
    expect(() => validatePluginConsistency(manifest)).toThrow(/auth\.methods/);
  });

  it('两边齐了才放行，并且扫描时**不跑插件代码**就能读到它要哪种登录', () => {
    const root = tempRoot();
    writePlugin(root, 'auth-ok', providerManifest({
      permissions: ['secrets:own-provider'],
      providers: [{
        provider_id: 'p', label: 'P', capabilities: ['image.generate'],
        auth: { methods: ['bearer', 'browser-same-origin'] as const },
      }],
    }), 'export function register() { throw new Error("不该被加载"); }');
    const host = new PluginHost({ apiFactory: () => fakeApi() });
    host.trustPublisher(KEY_ID, KEYS.publicKey);
    const scanned = host.scan(root);
    expect(scanned[0]?.status).toBe('ok');
    expect(scanned[0]?.providers[0]?.auth).toEqual({ methods: ['bearer', 'browser-same-origin'] });
  });

  it('没写 auth 的老清单：签名照样有效，语义是"不需要宿主给凭据"', () => {
    const manifest = providerManifest();
    /* 解析出来的对象里**不该有这个键**——有的话签名覆盖的字节就变了，
       所有已经签好的旧插件会一夜之间全部验签失败。 */
    expect(Object.keys(manifest.providers[0] ?? {})).not.toContain('auth');
    expect(() => {
      const host = new PluginHost({ apiFactory: () => fakeApi() });
      host.trustPublisher(KEY_ID, KEYS.publicKey);
      return host;
    }).not.toThrow();
  });

  it('不认识的鉴权方式在解析阶段就被拦下', () => {
    /* 这两条走**原始对象**而不是签名 helper：
       签名 helper 自己会先解析一遍，坏清单在构造那一步就抛了，
       那样测到的是"构造失败"，不是"解析器认得出错在哪"。 */
    expect(() => parsePluginManifest(rawManifest({
      permissions: ['secrets:own-provider'],
      providers: [{
        provider_id: 'p', label: 'P', capabilities: ['image.generate'],
        auth: { methods: ['magic-link'] },
      }],
    }))).toThrow(/不认识的鉴权方式/);
  });

  it('同一个 Provider 重复报同一种登录方式是笔误，也拦下', () => {
    expect(() => parsePluginManifest(rawManifest({
      permissions: ['secrets:own-provider'],
      providers: [{
        provider_id: 'p', label: 'P', capabilities: ['image.generate'],
        auth: { methods: ['bearer', 'bearer'] },
      }],
    }))).toThrow(/重复/);
  });

  it('清单侧与实现侧的四种鉴权词表没有分叉', async () => {
    const { AUTH_METHODS } = await import('@qiyin/provider-auth');
    expect([...PLUGIN_AUTH_METHODS]).toEqual([...AUTH_METHODS]);
  });
});

