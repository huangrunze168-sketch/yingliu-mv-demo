import type { GenerationBackend } from '@qiyin/generation-backend';
import { createCanvasAdapter, createCanvasBackend, resolveCanvasExecutable } from '@qiyin/canvas-adapter';
import { createImageGenAdapter, createImageGenBackend, resolveImageGenExecutable } from '@qiyin/imagegen-adapter';
import {
  createVideogenAdapter,
  createVideogenBackend,
  resolveVideogenScript,
} from '@qiyin/videogen-adapter';
import {
  STUB_BACKEND_ID,
  STUB_BACKEND_LABEL,
  createStubBackend,
  stubBackendEnabled,
} from './stub-backend.js';
import {
  createPluginBackend, isPluginBackendId, pluginBackendId, type PluginBackendSource,
} from './plugin-backend.js';

export * from './plugin-backend.js';

/* ============================================================
   期音科技 · 生成后端装配
   ------------------------------------------------------------
   这里只做一件事：把「用户说了用哪家」变成「一个 GenerationBackend」。

   为什么要单独一个包：CLI 与桌面端都需要这段装配，而生成服务本身
   不该认识任何一家适配器（那正是它可以被替换的原因）。
   放在任何一侧的适配器包里都会绕成环，所以它单独存在。

   两家的执行模型完全不同——

     小QTV   画布节点：需要一个绑定了画布的工作目录
     图像生成服务     异步任务：不需要工作目录，认的是账号本身

   装配的时候就把这个差异吃掉，调用方只给「哪一家」加必要的参数。
   ============================================================ */

/**
 * `stub` 是**仅测试用**的本地假后端（见 stub-backend.ts 顶上那四条规矩）：
 * 默认连选项都不存在，只有 `QIYIN_STUB_BACKEND=1` 时才能被选中。
 */
export type GenerationBackendId = 'canvas' | 'imagegen' | 'videogen' | 'stub';

/**
 * 一个可以被选中的后端引用：内置的四个，或者**签名插件注册进来的 Provider**。
 *
 * 插件那条路用 `plugin:<provider_id>` 前缀，永远不会和内置的撞名。
 */
export type BackendRef = GenerationBackendId | `plugin:${string}`;

export const GENERATION_BACKEND_LABELS: Readonly<Record<GenerationBackendId, string>> = {
  canvas: 'LibTV 画布（外部服务）',
  imagegen: '图像生成服务',
  videogen: '视频生成服务',
  stub: STUB_BACKEND_LABEL,
};

export function isGenerationBackendId(value: string): value is GenerationBackendId {
  return value === 'canvas' || value === 'imagegen' || value === 'videogen' || value === STUB_BACKEND_ID;
}

/* ============================================================
  插件 Provider 注册表
   ------------------------------------------------------------
  注册发生在应用启动时（扫描插件目录、验签、按清单登记），而
  **加载第三方代码推迟到第一次真正用到它**——所以这张表里存的是
  "清单声明 + 一个 resolve 函数"，不是已经加载好的后端。
   ============================================================ */

const PLUGIN_BACKENDS = new Map<string, PluginBackendSource>();

export function registerPluginBackends(sources: readonly PluginBackendSource[]): void {
  PLUGIN_BACKENDS.clear();
  for (const source of sources) {
    const id = pluginBackendId(source.providerId);
    if (PLUGIN_BACKENDS.has(id)) {
      throw new Error(`两个插件都注册了同一个 Provider id：${source.providerId}（${id}）`);
    }
    PLUGIN_BACKENDS.set(id, source);
  }
}

export function pluginBackendEntries(): Array<{
  id: `plugin:${string}`;
  label: string;
  capabilities: readonly string[];
  /** 清单声明的鉴权方式，界面用它来列"这家可以怎么登" */
  authMethods: readonly string[];
}> {
  return [...PLUGIN_BACKENDS.entries()].map(([id, source]) => ({
    id: id as `plugin:${string}`,
    label: source.label,
    capabilities: source.capabilities,
    authMethods: source.authMethods,
  }));
}

/** 给人看的后端名：内置的用表里的名字，插件的用它的 label。 */
export function labelForBackend(id: string): string {
  if (isGenerationBackendId(id)) return GENERATION_BACKEND_LABELS[id];
  return PLUGIN_BACKENDS.get(id)?.label ?? id;
}

/**
 * 解析用户给的后端名；不认识就报错，而不是悄悄退回默认值。
 *
 * `stub` **额外**要求开了 `QIYIN_STUB_BACKEND=1`：没开时它跟不认识的字符串一样会被拒，
 * 并且把原因说清楚（"它不出真图，只用来验证链路"）——
 * 悄悄放行会让一个假后端混进正常选择里。
 */
export function parseBackendId(raw: string | undefined, fallback: BackendRef = 'canvas'): BackendRef {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === STUB_BACKEND_ID) {
    if (stubBackendEnabled()) return STUB_BACKEND_ID;
    throw new Error(
      `本地假后端只能在 QIYIN_STUB_BACKEND=1 时使用（它不出真图，只用来验证生成链路）`,
    );
  }
  if (isGenerationBackendId(normalized)) return normalized;
  if (isPluginBackendId(normalized)) {
    if (PLUGIN_BACKENDS.has(normalized)) return normalized;
    throw new Error(
      `这个插件后端没有登记：${raw}。它可能没装、没被信任、或者清单校验没通过——到「模型与连接」里看一眼插件列表`,
    );
  }
  const available = [...PLUGIN_BACKENDS.keys()];
  throw new Error(
    `未知的生成后端：${raw}（可用：canvas | imagegen | videogen${available.length === 0 ? '' : ` | ${available.join(' | ')}`}）`,
  );
}

export interface CreateGenerationBackendOptions {
  /**/
  canvasCwd: string;
  canvasExecutable?: string;
  imagegenExecutable?: string;
  /** 视频生成服务 skill 里的 `agent_skill.py`；不给就按官方那三条装法去找。 */
  videogenScriptPath?: string;
  /** python 解释器；这台 Windows 上要用 `python`（`python3` 是商店占位符）。 */
  videogenPython?: string;
  videogenAccessKey?: string;
  videogenSecretKey?: string;
}

export function createGenerationBackend(
  id: BackendRef,
  options: CreateGenerationBackendOptions,
): GenerationBackend {
  if (isPluginBackendId(id)) {
    const source = PLUGIN_BACKENDS.get(id);
    if (source === undefined) {
      throw new Error(`这个插件后端没有登记：${id}（先确认插件已装且通过签名校验）`);
    }
    return createPluginBackend(source);
  }
  if (id === STUB_BACKEND_ID) return createStubBackend();
  if (id === 'imagegen') {
    return createImageGenBackend(createImageGenAdapter({
      ...(options.imagegenExecutable === undefined ? {} : { executable: options.imagegenExecutable }),
    }));
  }
  if (id === 'videogen') {
    /*
      视频生成服务 是**官方 skill 包**（python 脚本），不是单个可执行文件——
      所以这里要先找脚本；找不到时 `create视频生成服务Adapter` 返回 null，
      我们把"怎么装"三句话一并说清楚（不猜路径、也不报一个看不懂的错）。
    */
    const adapter = createVideogenAdapter({
      ...(options.videogenScriptPath === undefined ? {} : { scriptPath: options.videogenScriptPath }),
      ...(options.videogenPython === undefined ? {} : { python: options.videogenPython }),
      ...(options.videogenAccessKey === undefined ? {} : { accessKey: options.videogenAccessKey }),
      ...(options.videogenSecretKey === undefined ? {} : { secretKey: options.videogenSecretKey }),
    });
    if (adapter === null) {
      throw new Error(
        '没找到 视频生成服务 skill 的 agent_skill.py。装法三选一：'
          + 'npx skills add videogenai/videogen-skill / 复制到 ~/.hermes/skills/design/videogen-api / '
          + 'clone 后用 VIDEOGEN_SKILL_SCRIPT 指向它',
      );
    }
    return createVideogenBackend(adapter, {});
  }
  return createCanvasBackend(createCanvasAdapter({
    cwd: options.canvasCwd,
    ...(options.canvasExecutable === undefined ? {} : { executable: options.canvasExecutable }),
  }));
}

export interface BackendAvailability {
  id: GenerationBackendId;
  label: string;
  /** 可执行文件是否找到；没找到时 `detail` 说明找过哪些位置。 */
  installed: boolean;
  detail: string | null;
}

/**
 * 这台机器上有哪些生成后端可用。
 *
 * 界面据此决定「让用户选哪几家」——把不可用的选项也摆出来、点下去才报
 * 「没安装」，是在浪费用户的时间。这里只查可执行文件是否存在，
 * 不做登录检查：登录状态属于账号，`user_credit` / `account info` 才回答那个问题。
 */
export function probeGenerationBackends(): BackendAvailability[] {
  const available = [
    probeOne('canvas', () => resolveCanvasExecutable()),
    probeOne('imagegen', () => resolveImageGenExecutable()),
    /*
      视频生成服务 的"装没装"看的是**脚本在不在**（那三条装法落到的位置），
      凭据（AK/SK）不在这一层判——它只是"能不能跑"，而"跑得通"要真调一次 API。
      详情里把这两件事分开说，免得用户以为装了就等于能用。
    */
    probeOne('videogen', () => {
      const script = resolveVideogenScript();
      if (script === null) {
        throw new Error('没找到 agent_skill.py（官方三条装法：npx skills add / ~/.hermes/skills/design/videogen-api / clone + VIDEOGEN_SKILL_SCRIPT）');
      }
      const hasKey = (process.env.LOVART_ACCESS_KEY ?? '') !== '' && (process.env.LOVART_SECRET_KEY ?? '') !== '';
      return hasKey ? `${script}（AK/SK 已配）` : `${script}（还没配 AK/SK）`;
    }),
  ];
  /* 假后端只在开了开关时出现：正常运行的界面上不该看到它 */
  if (stubBackendEnabled()) {
    available.push({
      id: STUB_BACKEND_ID,
      label: STUB_BACKEND_LABEL,
      installed: true,
      detail: '通过 QIYIN_STUB_BACKEND=1 打开：它产出占位图，用来验证生成链路，不花任何钱',
    });
  }
  return available;
}

function probeOne(id: GenerationBackendId, resolveExecutable: () => string): BackendAvailability {
  try {
    return { id, label: GENERATION_BACKEND_LABELS[id], installed: true, detail: resolveExecutable() };
  } catch (error) {
    return {
      id,
      label: GENERATION_BACKEND_LABELS[id],
      installed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
