import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { stableStringify } from '@qiyin/update-service';

/* ============================================================
  期音科技 · 插件清单（`xqtv.plugin-manifest@1`）
   ------------------------------------------------------------
  对应矩阵两条缺口：
    · BYOK-003「Provider SDK 与签名插件」
    · CLI-007「外部工具集成（Blender 插件等）」

  插件是**别人写的代码**，会被我们的进程加载。所以清单必须回答四个问题，
  少一个都不许加载：

    ① 这是谁写的（`publisher` + 签名）——签名覆盖清单，**改一个字节就不认**；
    ② 它想干什么（`kind` = provider / tool，`capabilities` 从已知集合里选）；
    ③ 它要碰本机的什么（`permissions` 白名单：文件、网络、命令行、剪贴板…）；
    ④ 它的代码在哪（`entry`，必须是插件目录内的相对路径）。

  **必须说清的边界**：这一版插件是**同进程**加载的（`import()`），
  运行在与主进程同样的权限下。签名与权限门能挡住"冒名顶替"和"多要权限"，
  但**挡不住"你信任的作者写了恶意代码"**——这是与 R-11（Provider 同权限运行）
  同一类的技术债，写在 `describePluginLimits()` 里由界面原样显示。
  真隔离要么子进程 + 受限 IPC，要么 WASM，那是另一件事。
   ============================================================ */

export const PLUGIN_MANIFEST_SCHEMA = 'xqtv.plugin-manifest@1';
export const PLUGIN_API_SCHEMA = 'xqtv.plugin-api@1';

/** 插件能做的最粗粒度分类。`provider` 接生成模型，`tool` 接外部工具。 */
export type PluginKind = 'provider' | 'tool';

/** 插件可以声明**要**什么权限；没声明的 API 在运行时根本拿不到（见 host.ts）。 */
export const PLUGIN_PERMISSIONS = [
  /** 读写自己插件目录内的文件 */
  'files:plugin-dir',
  /** 读用户选中的素材文件（只读，路径由宿主给） */
  'files:user-media-read',
  /** 把产物写进项目工作目录 */
  'files:project-write',
  /** 访问网络（调用你自己的服务） */
  'network',
  /** 启动本机命令行程序 */
  'process:spawn',
  /** 读写系统剪贴板 */
  'clipboard',
  /** 读取宿主给的凭据（BYOK 的 key；不会拿到别的插件的） */
  'secrets:own-provider',
] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** 插件能声明的能力。分两类，与 `kind` 对应关系在 `validatePluginConsistency` 里判。 */
export const PLUGIN_CAPABILITIES = [
  /* provider 侧 */
  'image.generate',
  'video.fromImage',
  'video.edit',
  'image.upscale',
  'image.shortcut',
  'audio.tts',
  'audio.music',
  /** 音源分离（人声/伴奏）——比中置消除更强的那种；声明它就要真做到 */
  'audio.separate',
  /* tool 侧 */
  'tool.render',
  'tool.analyze',
  'tool.convert',
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/**
 * Provider 打算怎么**拿凭据**（BYOK-004）。

 * 与 `@qiyin/provider-auth` 的 `AuthMethod` 是同一套词，但这里刻意重新声明一份：
 * 插件清单是**跨进程的契约**，不该 import 我们内部的实现包——
 * 那样插件作者就得依赖我们的包版本才能写清单。
 * 两边一旦分叉，`plugin-host.test.ts` 里有一条用例专门盯着。
 */
export const PLUGIN_AUTH_METHODS = ['bearer', 'oauth2', 'browser-same-origin', 'sms', 'none'] as const;
export type PluginAuthMethod = (typeof PLUGIN_AUTH_METHODS)[number];

export interface PluginManifest {
  schema: typeof PLUGIN_MANIFEST_SCHEMA;
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  api: typeof PLUGIN_API_SCHEMA;
  /** 插件目录内的相对路径（`.mjs` / `.js`），必须落在插件目录里 */
  entry: string;
  capabilities: PluginCapability[];
  permissions: PluginPermission[];
  /**
   * 这个插件要注册哪些 Provider（`kind: 'provider'` 时必填、非空）。

   * 为什么要**在清单里**声明，而不是等加载完才知道：宿主有两个需求——
     · 不执行第三方代码就能列出"装了哪些 Provider、各自支持什么"（界面要用）；
     · 加载之后要能核对"它注册的与它声明的**完全一致**"（防"清单说一套、运行时干另一套"）。
   * 少了这一节，这两个需求就只能靠"先把插件跑起来看看"，而"跑起来"正是我们要推迟的那件事。
   */
  providers: PluginProviderDeclaration[];
  publisher: { name: string; key_id: string };
  signature: { algorithm: 'ed25519'; value: string };
}

export interface PluginProviderDeclaration {
  provider_id: string;
  label: string;
  /** 这个 Provider 支持哪些能力；必须是清单 `capabilities` 的子集 */
  capabilities: PluginCapability[];
  /**
   * 这个 Provider 用哪种鉴权。

   * **省略表示 `['none']`**：即"我不需要宿主给我凭据，我自己搞定"。
   * 之所以让省略有意义，是为了不让已有的清单因为加了这个字段而验签失败——
   * 清单里没有的键，序列化出来也不该有。
   */
  auth?: { methods: readonly PluginAuthMethod[] };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
/** Provider id 允许单字符（`p` 也是合法身份）；插件 id 要求至少两个字符，便于一眼区分命名空间 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function fail(message: string): never {
  throw new PluginError('PLUGIN_MANIFEST_INVALID', message);
}

export class PluginError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`插件清单缺少 ${field}`);
  return value;
}

/** 严格解析。任何一处不对都当"清单损坏"处理，绝不"尽力而为"地加载。 */
export function parsePluginManifest(input: unknown): PluginManifest {
  if (input === null || typeof input !== 'object') fail('插件清单不是对象');
  const raw = input as Record<string, unknown>;
  if (raw.schema !== PLUGIN_MANIFEST_SCHEMA) fail(`清单 schema 不是 ${PLUGIN_MANIFEST_SCHEMA}`);

  const id = requireString(raw.id, 'id');
  if (!ID_PATTERN.test(id)) fail(`插件 id 不合法：${id}（只能是小写字母数字与 . _ -）`);
  const kind = raw.kind;
  if (kind !== 'provider' && kind !== 'tool') fail(`插件类型只能是 provider 或 tool：${String(kind)}`);
  if (raw.api !== PLUGIN_API_SCHEMA) fail(`插件 API 版本不认识：${String(raw.api)}（当前只支持 ${PLUGIN_API_SCHEMA}）`);

  const entry = requireString(raw.entry, 'entry');
  if (entry.startsWith('/') || entry.startsWith('\\') || /^[A-Za-z]:/.test(entry)) fail(`entry 必须是插件目录内的相对路径：${entry}`);
  if (entry.includes('..') || entry.includes('\\')) fail(`entry 不允许越界或反斜杠：${entry}`);

  if (!Array.isArray(raw.capabilities)) fail('capabilities 必须是数组');
  const capabilities = raw.capabilities.map((item) => {
    if (typeof item !== 'string' || !(PLUGIN_CAPABILITIES as readonly string[]).includes(item)) {
      fail(`不认识的能力：${String(item)}`);
    }
    return item as PluginCapability;
  });

  if (!Array.isArray(raw.permissions)) fail('permissions 必须是数组');
  const permissions = raw.permissions.map((item) => {
    if (typeof item !== 'string' || !(PLUGIN_PERMISSIONS as readonly string[]).includes(item)) {
      fail(`不认识的权限：${String(item)}`);
    }
    return item as PluginPermission;
  });

  const publisher = raw.publisher as Record<string, unknown> | undefined;
  if (publisher === undefined || publisher === null || typeof publisher !== 'object') fail('清单缺少 publisher');
  const signature = raw.signature as Record<string, unknown> | undefined;
  if (signature === undefined || signature === null || typeof signature !== 'object') fail('清单缺少 signature');
  if (signature.algorithm !== 'ed25519') fail(`不支持的签名算法：${String(signature.algorithm)}`);

  const rawProviders = raw.providers;
  if (rawProviders !== undefined && !Array.isArray(rawProviders)) fail('providers 必须是数组');
  const providers = (rawProviders ?? []).map((item, index) => {
    const row = item as { provider_id?: unknown; label?: unknown; capabilities?: unknown; auth?: unknown };
    const providerId = requireString(row.provider_id, `providers[${index}].provider_id`);
    if (!PROVIDER_ID_PATTERN.test(providerId)) fail(`Provider id 不合法：${providerId}`);
    if (!Array.isArray(row.capabilities)) fail(`providers[${index}].capabilities 必须是数组`);
    const providerCapabilities = row.capabilities.map((capability) => {
      if (typeof capability !== 'string' || !(PLUGIN_CAPABILITIES as readonly string[]).includes(capability)) {
        fail(`不认识的能力：${String(capability)}`);
      }
      if (!capabilities.includes(capability as PluginCapability)) {
        fail(`Provider ${providerId} 声明了清单里没有的能力：${capability}`);
      }
      return capability as PluginCapability;
    });
    let auth: { methods: readonly PluginAuthMethod[] } | undefined;
    if (row.auth !== undefined) {
      const authRow = row.auth as { methods?: unknown };
      if (authRow === null || typeof authRow !== 'object') fail(`providers[${index}].auth 必须是对象`);
      if (!Array.isArray(authRow.methods) || authRow.methods.length === 0) {
        fail(`providers[${index}].auth.methods 必须是非空数组`);
      }
      const methods = authRow.methods.map((method) => {
        if (typeof method !== 'string' || !(PLUGIN_AUTH_METHODS as readonly string[]).includes(method)) {
          fail(`不认识的鉴权方式：${String(method)}（只支持 ${PLUGIN_AUTH_METHODS.join(' / ')}）`);
        }
        return method as PluginAuthMethod;
      });
      /* 同一家 Provider 报两遍一样的登录方式是笔误，不是需求。 */
      if (new Set(methods).size !== methods.length) fail(`providers[${index}].auth.methods 里有重复项`);
      auth = { methods };
    }
    return {
      provider_id: providerId,
      label: requireString(row.label, `providers[${index}].label`),
      capabilities: providerCapabilities,
      ...(auth !== undefined ? { auth } : {}),
    };
  });
  const seenProviderIds = new Set<string>();
  for (const provider of providers) {
    if (seenProviderIds.has(provider.provider_id)) fail(`Provider id 重复：${provider.provider_id}`);
    seenProviderIds.add(provider.provider_id);
  }

  return {
    schema: PLUGIN_MANIFEST_SCHEMA,
    id,
    name: requireString(raw.name, 'name'),
    version: requireString(raw.version, 'version'),
    kind,
    api: PLUGIN_API_SCHEMA,
    entry,
    capabilities,
    permissions,
    providers,
    publisher: {
      name: requireString(publisher.name, 'publisher.name'),
      key_id: requireString(publisher.key_id, 'publisher.key_id'),
    },
    signature: { algorithm: 'ed25519', value: requireString(signature.value, 'signature.value') },
  };
}

/**
 * 能力与类型必须自洽。

 * 一条 `tool` 插件声明 `image.generate` 是说不通的：它既不会被当成生成后端，
 * 又会让用户在界面上看到"这个工具能生成图"。宁可在加载前拒掉。
 */
export function validatePluginConsistency(manifest: PluginManifest): void {
  if (manifest.capabilities.length === 0) {
    throw new PluginError('PLUGIN_MANIFEST_INVALID', `插件 ${manifest.id} 没有声明任何能力：那样加载它没有任何意义`);
  }
  const wantsProvider = manifest.capabilities.some((capability) => !capability.startsWith('tool.'));
  const wantsTool = manifest.capabilities.some((capability) => capability.startsWith('tool.'));
  if (manifest.kind === 'provider' && wantsTool) {
    throw new PluginError('PLUGIN_MANIFEST_INVALID', `插件 ${manifest.id} 是 provider，不能声明工具能力`);
  }
  if (manifest.kind === 'tool' && wantsProvider) {
    throw new PluginError('PLUGIN_MANIFEST_INVALID', `插件 ${manifest.id} 是 tool，不能声明生成能力`);
  }
  if (manifest.kind === 'provider' && manifest.providers.length === 0) {
    throw new PluginError('PLUGIN_MANIFEST_INVALID', `插件 ${manifest.id} 是 provider，但没有声明任何 Provider`);
  }
  if (manifest.kind === 'tool' && manifest.providers.length > 0) {
    throw new PluginError('PLUGIN_MANIFEST_INVALID', `插件 ${manifest.id} 是 tool，不该声明 Provider`);
  }
  /*
    鉴权声明与 `secrets:own-provider` 权限必须**成对出现**，两个方向都要拦：

      ① 说了要登录方式，却没申请读凭据的权限 —— 运行时它拿不到凭据，
         用户在界面上会看到一个"配好了却用不了"的 Provider。说清楚比给惊喜好。

      ② 申请了读凭据的权限，却不说凭据长什么样 —— 那我们不知道给它什么，
         用户也无从配置。这种插件是被自己的清单坑住的。
  */
  const wantsSecrets = manifest.permissions.includes('secrets:own-provider');
  const declaresAuth = manifest.providers.some((provider) =>
    (provider.auth?.methods ?? ['none']).some((method) => method !== 'none'));
  if (declaresAuth && !wantsSecrets) {
    throw new PluginError(
      'PLUGIN_MANIFEST_INVALID',
      `插件 ${manifest.id} 声明了鉴权方式，但没有申请 secrets:own-provider 权限：那样它拿不到凭据`,
    );
  }
  if (wantsSecrets && !declaresAuth) {
    throw new PluginError(
      'PLUGIN_MANIFEST_INVALID',
      `插件 ${manifest.id} 申请了 secrets:own-provider 权限，但没有任何 Provider 声明 auth.methods：`
        + '宿主不知道该给它哪一份凭据',
    );
  }
}

/** 签名覆盖的字节：清单**去掉 signature** 之后的稳定序列化。 */
export function pluginManifestPayload(manifest: PluginManifest): Buffer {
  const { signature: _signature, ...rest } = manifest;
  return Buffer.from(stableStringify(rest), 'utf8');
}

/**
 * 验签：只认宿主**已信任**的那把公钥。

 * 与更新包用的是同一套办法（Ed25519 + 稳定序列化）——那套已经跑过一遍，
 * 再发明一种只会多一类"两边算的字节不一样"的怪问题。
 */
export function verifyPluginSignature(manifest: PluginManifest, trustedKeys: ReadonlyMap<string, string>): void {
  const pem = trustedKeys.get(manifest.publisher.key_id);
  if (pem === undefined) {
    throw new PluginError(
      'PLUGIN_PUBLISHER_UNTRUSTED',
      `这个插件的发布者还没被信任（key_id=${manifest.publisher.key_id}）：先确认发布者，再把它的公钥加进信任列表`,
    );
  }
  let ok = false;
  try {
    ok = verify(null, pluginManifestPayload(manifest), createPublicKey(pem), Buffer.from(manifest.signature.value, 'base64'));
  } catch (error) {
    throw new PluginError('PLUGIN_SIGNATURE_INVALID', `信任列表里那把公钥没法用（PEM 格式不对？）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!ok) {
    throw new PluginError('PLUGIN_SIGNATURE_INVALID', `插件 ${manifest.id} 的签名与发布者公钥不匹配：这个包被人动过，或者不是他签的`);
  }
}

/** 给用户看的边界说明（界面原样显示）。 */
export function describePluginLimits(): string {
  return '插件与主程序同进程运行（`import()`），签名与权限门能挡住冒名顶替和多要权限，'
    + '但挡不住"你信任的作者写了恶意代码"。真隔离需要子进程 + 受限 IPC 或 WASM，尚未实现。';
}

/**
 * 给插件清单签名（发布侧用）。

 * 与客户端共用 `pluginManifestPayload`：签名算的是**字节**，
 * 两边各写一遍序列化，迟早出现"看上去都对、签名就是不通过"。
 */
export function signPluginManifest(
  manifest: Omit<PluginManifest, 'signature'> & { signature?: PluginManifest['signature'] },
  privateKeyPem: string,
): PluginManifest {
  const { signature: _ignored, ...rest } = manifest;
  const payload = pluginManifestPayload({
    ...rest,
    signature: { algorithm: 'ed25519', value: '' },
  } as PluginManifest);
  const value = sign(null, payload, createPrivateKey(privateKeyPem)).toString('base64');
  return parsePluginManifest({ ...rest, signature: { algorithm: 'ed25519', value } });
}

/** 生成一对发布者密钥（本地演练与测试用；正式发布请离线保管私钥）。 */
export function generatePublisherKeyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
