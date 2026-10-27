import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PluginError, parsePluginManifest, validatePluginConsistency, verifyPluginSignature,
  type PluginCapability, type PluginManifest, type PluginPermission, type PluginProviderDeclaration,
} from './manifest.js';

/* ============================================================
  期音科技 · 插件宿主
   ------------------------------------------------------------
  做三件事：**发现 → 验签 → 带权限门加载**。

  权限门是这一层最实质的东西：插件拿到的 `api` 对象不是完整宿主能力，
  而是一个按声明裁剪过的**代理**——没声明 `network` 的插件去摸 `fetch`
  会当场抛错，说明"你没声明这个权限"。这比"文档里写一句请勿滥用"强得多，
  因为它把越权变成了一个**看得见的错误**。

  但要说清它挡不住什么：同进程加载的插件完全可以绕开这个代理，
  自己 `import('node:fs')`。所以权限门的真实作用是
  "让**守规矩的插件**不必拿到全部能力"，以及"让**越权动作留下痕迹**"，
  不是沙箱。沙箱要子进程 + 受限 IPC 或 WASM（见 `describePluginLimits()`）。
   ============================================================ */

/** 宿主提供给插件的全部能力面。每一组都对应一条权限声明。 */
export interface PluginHostApi {
  /** `files:plugin-dir` —— 只能读写插件自己目录里的文件 */
  readPluginFile(relativePath: string): string;
  writePluginFile(relativePath: string, content: string): void;
  /** `files:user-media-read` —— 路径由宿主给出，插件不能自己拼 */
  readUserMedia(absolutePath: string): Buffer;
  /** `files:project-write` —— 只能写进指定项目的工作目录 */
  writeProjectFile(projectId: string, relativePath: string, bytes: Buffer): string;
  /** `network` */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** `process:spawn` */
  spawn(command: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** `clipboard` */
  readClipboard(): string;
  writeClipboard(text: string): void;
  /** `secrets:own-provider` —— 只拿得到这个插件自己的那份凭据 */
  getProviderSecret(providerId: string): string | null;
}

/** 每个方法对应哪条权限。表在这里、不在文档里——文档不会拦人。 */
const API_PERMISSION: Readonly<Record<keyof PluginHostApi, PluginPermission>> = {
  readPluginFile: 'files:plugin-dir',
  writePluginFile: 'files:plugin-dir',
  readUserMedia: 'files:user-media-read',
  writeProjectFile: 'files:project-write',
  fetch: 'network',
  spawn: 'process:spawn',
  readClipboard: 'clipboard',
  writeClipboard: 'clipboard',
  getProviderSecret: 'secrets:own-provider',
};

export interface PluginProviderDescriptor {
  provider_id: string;
  label: string;
  capabilities: PluginCapability[];
  /** 插件自己实现的三件套；宿主按 `capabilities` 决定调哪个 */
  generate?: (request: unknown) => Promise<unknown>;
  edit?: (request: unknown) => Promise<unknown>;
}

export interface PluginToolDescriptor {
  tool_id: string;
  label: string;
  describe(): string;
  invoke(input: unknown): Promise<unknown>;
}

export interface PluginRegistration {
  manifest: PluginManifest;
  providers: PluginProviderDescriptor[];
  tools: PluginToolDescriptor[];
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  kind: PluginManifest['kind'];
  capabilities: PluginCapability[];
  permissions: PluginPermission[];
  /** 清单里声明的 Provider（**不执行插件代码**就知道"装了哪些、各自支持什么"） */
  providers: PluginProviderDeclaration[];
  dir: string;
  /** `refused` 的插件**不会被加载**，`reason` 就是为什么 */
  status: 'ok' | 'refused';
  reason?: string;
}

export interface PluginHostOptions {
  /**
   * 按插件构造它的能力面。

   * 为什么是"按插件"而不是一份共享的 API：像 `readPluginFile` 这种能力
   * 必须绑定到**这个插件自己的目录**——共享一份的话，宿主就得在每次调用时
   * 再问一次"现在是谁在调"，而那正是最容易搞错的地方。
   * 让宿主在加载时把上下文（清单 + 目录）交给应用来构造，权限边界就落在构造处。
   */
  apiFactory: (context: { manifest: PluginManifest; dir: string }) => PluginHostApi;
  /** 已信任的发布者公钥（key_id → PEM）。空表示"谁都不信" */
  trustedKeys?: ReadonlyMap<string, string>;
}

export class PluginHost {
  readonly #apiFactory: PluginHostOptions['apiFactory'];
  readonly #trusted = new Map<string, string>();
  readonly #installed = new Map<string, InstalledPlugin>();

  constructor(options: PluginHostOptions) {
    this.#apiFactory = options.apiFactory;
    for (const [keyId, pem] of options.trustedKeys ?? []) this.#trusted.set(keyId, pem);
  }

  /**
   * 信任一把发布者公钥。

   * 这是**人的决定**：签名的意义在于"我认这个发布者"，
   * 自动信任任何能签名的东西等于没有签名。
   */
  trustPublisher(keyId: string, publicKeyPem: string): void {
    if (keyId.trim() === '' || publicKeyPem.trim() === '') {
      throw new PluginError('PLUGIN_MANIFEST_INVALID', '信任一个发布者需要 key_id 与公钥');
    }
    this.#trusted.set(keyId, publicKeyPem);
  }

  trustedPublishers(): string[] {
    return [...this.#trusted.keys()].sort();
  }

  /** 扫一个目录：里面每个子目录放一个 `plugin.json` + 它的代码。 */
  scan(root: string): InstalledPlugin[] {
    this.#installed.clear();
    if (!existsSync(root)) return [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const manifestPath = join(dir, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      const inspected = this.#inspect(dir, manifestPath, entry.name);
      const existing = this.#installed.get(inspected.id);
      if (existing !== undefined) {
        /*
          两个插件声称同一个 id：**两个都不加载**。
          挑一个"赢"会带来一个说不清的问题——用户看到的 id 究竟是谁在跑？
          这是插件系统里最容易造成"我明明更新了插件、行为却没变"的坑。
        */
        const reason = `插件 id 冲突（${existing.dir} 与 ${dir} 都声称是 ${inspected.id}）：两个都不加载，请改名或删掉一个`;
        this.#installed.set(inspected.id, { ...existing, status: 'refused', reason });
        continue;
      }
      this.#installed.set(inspected.id, inspected);
    }
    return this.list();
  }

  list(): InstalledPlugin[] {
    return [...this.#installed.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * 加载一个插件。

   * 被拒的插件**不加载**：`status` 是 `refused` 就直接抛，理由原样带出来。
   * 加载时把宿主能力按声明裁成一个代理交给它，然后要求它导出 `register(api)`。
   */
  async load(id: string): Promise<PluginRegistration> {
    const installed = this.#installed.get(id);
    if (installed === undefined) {
      throw new PluginError('PLUGIN_NOT_FOUND', `没有这个插件：${id}（先 scan 一次目录）`);
    }
    if (installed.status !== 'ok') {
      throw new PluginError('PLUGIN_REFUSED', `插件 ${id} 没有被接受，不能加载：${installed.reason ?? '未说明原因'}`);
    }
    const manifest = this.#manifestOf(installed.dir);
    const entryPath = resolve(installed.dir, manifest.entry);
    if (!entryPath.startsWith(resolve(installed.dir) + sep)) {
      throw new PluginError('PLUGIN_PATH_ESCAPE', `插件 ${id} 的入口越出了它的目录：${manifest.entry}`);
    }
    if (!existsSync(entryPath)) {
      throw new PluginError('PLUGIN_ENTRY_MISSING', `插件 ${id} 的入口文件不存在：${manifest.entry}`);
    }

    const module = await import(pathToFileURL(entryPath).href) as {
      register?: (api: PluginHostApi) => unknown;
    };
    if (typeof module.register !== 'function') {
      throw new PluginError('PLUGIN_API_MISMATCH', `插件 ${id} 没有导出 register(api)：${manifest.entry}`);
    }
    const registered = await module.register(
      guardApi(manifest, this.#apiFactory({ manifest, dir: installed.dir })),
    ) as {
      providers?: unknown; tools?: unknown;
    } | undefined;
    const providers = normalizeProviders(manifest, registered?.providers);

    /*
      注册结果必须与清单**完全一致**。

      两个方向都要拦：
        · 少注册 → 界面按清单显示"支持出图"，点下去却没有那个 Provider；
        · 多注册 → 清单里没有的东西悄悄跑起来，用户与审计都看不到它。
      清单是签名覆盖的，所以"清单说什么就是什么"这句话才成立。
    */
    const declared = new Set(manifest.providers.map((provider) => provider.provider_id));
    const actual = new Set(providers.map((provider) => provider.provider_id));
    const missing = [...declared].filter((id) => !actual.has(id));
    const extra = [...actual].filter((id) => !declared.has(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new PluginError(
        'PLUGIN_REGISTRATION_MISMATCH',
        `插件 ${manifest.id} 注册的 Provider 与清单不一致`
          + (missing.length > 0 ? `；清单里有但没注册：${missing.join('、')}` : '')
          + (extra.length > 0 ? `；注册了但清单里没有：${extra.join('、')}` : ''),
      );
    }
    for (const provider of providers) {
      const declaration = manifest.providers.find((item) => item.provider_id === provider.provider_id);
      const declaredCapabilities = new Set(declaration?.capabilities ?? []);
      const overreach = provider.capabilities.filter((capability) => !declaredCapabilities.has(capability));
      if (overreach.length > 0) {
        throw new PluginError(
          'PLUGIN_REGISTRATION_MISMATCH',
          `插件 ${manifest.id} 的 Provider ${provider.provider_id} 声称支持清单里没声明的能力：${overreach.join('、')}`,
        );
      }
    }

    return {
      manifest,
      providers,
      tools: normalizeTools(manifest, registered?.tools),
    };
  }

  #manifestOf(dir: string): PluginManifest {
    const raw = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as unknown;
    return parsePluginManifest(raw);
  }

  #inspect(dir: string, manifestPath: string, id: string): InstalledPlugin {
    const refused = (reason: string): InstalledPlugin => ({
      /*
        清单读不出来时用**目录名**当 id：总得有个身份把它列出来给用户看，
        而"哪个目录坏了"正是用户此刻唯一能处理的线索。
      */
      id, name: id, version: '—', kind: 'tool', capabilities: [], permissions: [], dir, status: 'refused', reason,
      providers: [],
    });
    let manifest: PluginManifest;
    try {
      manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      validatePluginConsistency(manifest);
      verifyPluginSignature(manifest, this.#trusted);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const partial = (() => {
        try {
          const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            id?: unknown; name?: unknown; version?: unknown; kind?: unknown;
          };
          return {
            id: typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : id,
            name: typeof parsed.name === 'string' ? parsed.name : id,
            version: typeof parsed.version === 'string' ? parsed.version : '—',
            kind: parsed.kind === 'provider' ? 'provider' as const : 'tool' as const,
          };
        } catch {
          return { id, name: id, version: '—', kind: 'tool' as const };
        }
      })();
      return { ...refused(reason), ...partial };
    }
    const entryPath = resolve(dir, manifest.entry);
    if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
      return {
        id: manifest.id, name: manifest.name, version: manifest.version, kind: manifest.kind,
        capabilities: manifest.capabilities, permissions: manifest.permissions, dir,
        providers: manifest.providers,
        status: 'refused', reason: `入口文件不存在：${manifest.entry}`,
      };
    }
    return {
      id: manifest.id, name: manifest.name, version: manifest.version, kind: manifest.kind,
      capabilities: manifest.capabilities, permissions: manifest.permissions, dir,
      providers: manifest.providers, status: 'ok',
    };
  }
}

/**
 * 按声明裁剪宿主能力。

 * 没声明就**在访问那一刻抛错**，而不是返回 `undefined`——
 * 后者会让插件在更远的地方炸（`api.fetch is not a function`），
 * 而那句话看不出真正的原因（"你没声明 network"）。
 */
export function guardApi(manifest: PluginManifest, api: PluginHostApi): PluginHostApi {
  return new Proxy(api, {
    get(target, property, receiver) {
      const permission = API_PERMISSION[property as keyof PluginHostApi];
      if (permission !== undefined && !manifest.permissions.includes(permission)) {
        throw new PluginError(
          'PLUGIN_PERMISSION_DENIED',
          `插件 ${manifest.id} 没有声明 ${permission}，不能调用 ${String(property)}`,
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function normalizeProviders(manifest: PluginManifest, raw: unknown): PluginProviderDescriptor[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new PluginError('PLUGIN_API_MISMATCH', `插件 ${manifest.id} 的 providers 必须是数组`);
  return raw.map((item) => {
    const row = item as { provider_id?: unknown; label?: unknown; capabilities?: unknown };
    if (typeof row.provider_id !== 'string' || row.provider_id === '') {
      throw new PluginError('PLUGIN_API_MISMATCH', `插件 ${manifest.id} 注册了一个没有 provider_id 的 Provider`);
    }
    const capabilities = Array.isArray(row.capabilities) ? row.capabilities : [];
    /* 声明的能力必须是清单里声明过的子集：不能"加载时说支持一件事、实际干另一件事" */
    for (const capability of capabilities) {
      if (!manifest.capabilities.includes(capability as PluginCapability)) {
        throw new PluginError(
          'PLUGIN_API_MISMATCH',
          `插件 ${manifest.id} 注册的 Provider 声称支持 ${String(capability)}，但清单里没有声明它`,
        );
      }
    }
    return {
      provider_id: row.provider_id,
      label: typeof row.label === 'string' && row.label !== '' ? row.label : row.provider_id,
      capabilities: capabilities as PluginCapability[],
      ...(typeof (item as { generate?: unknown }).generate === 'function'
        ? { generate: (item as PluginProviderDescriptor).generate as (request: unknown) => Promise<unknown> } : {}),
      ...(typeof (item as { edit?: unknown }).edit === 'function'
        ? { edit: (item as PluginProviderDescriptor).edit as (request: unknown) => Promise<unknown> } : {}),
    };
  });
}

function normalizeTools(manifest: PluginManifest, raw: unknown): PluginToolDescriptor[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new PluginError('PLUGIN_API_MISMATCH', `插件 ${manifest.id} 的 tools 必须是数组`);
  return raw.map((item) => {
    const row = item as { tool_id?: unknown; label?: unknown; describe?: unknown; invoke?: unknown };
    if (typeof row.tool_id !== 'string' || row.tool_id === '') {
      throw new PluginError('PLUGIN_API_MISMATCH', `插件 ${manifest.id} 注册了一个没有 tool_id 的工具`);
    }
    if (typeof row.invoke !== 'function') {
      throw new PluginError('PLUGIN_API_MISMATCH', `插件 ${manifest.id} 的工具 ${row.tool_id} 没有 invoke`);
    }
    return {
      tool_id: row.tool_id,
      label: typeof row.label === 'string' && row.label !== '' ? row.label : row.tool_id,
      describe: typeof row.describe === 'function'
        ? () => String((row.describe as () => unknown).call(row))
        : () => row.tool_id as string,
      invoke: (input: unknown) => Promise.resolve((row.invoke as (value: unknown) => unknown).call(row, input)),
    };
  });
}
