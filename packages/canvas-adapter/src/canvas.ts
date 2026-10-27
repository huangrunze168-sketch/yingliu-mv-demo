import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanvasAdapter } from './adapter.js';

/* ============================================================
   期音科技 · 画布与项目绑定
   ------------------------------------------------------------
   于是所有项目的节点都往同一张画布上堆，而且换台机器就没有这张画布了。

   现在的规则是：**一个产品项目 = 一个 小QTV 工作目录**，
   因此：

     · 换机器、换会话，只要带上项目目录，画布归属就跟着走；
     · 两个项目的节点不会互相污染（`node create` / `download` 都按 cwd 解析画布）；

   实测确认的两个返回体（不是猜的）：

     · `project create` 返回 `{ projectMeta: { uuid: "…" } }`；
     · `project use` 返回 `{ projectUuid: "…" }`，并写出 `.libtv/project.json`。
   ============================================================ */

export interface CanvasBinding {
  /** 画布 UUID —— `project use` 认的是它，不是数字 id。 */
  canvasUuid: string;
  /** 画布所属的 小QTV 项目（工作区）id；画布不在任何项目下时为 null。 */
  workspaceId: number | null;
  /**/
  dir: string;
}

/** LibTV CLI 1.1.3 写入的官方目录；`.canvas` 只用于兼容早期开发版。 */
const BINDING_DIR = '.libtv';
const LEGACY_BINDING_DIR = '.canvas';
const BINDING_FILE = 'project.json';

export function canvasBindingPath(dir: string): string {
  return join(dir, BINDING_DIR, BINDING_FILE);
}

function canvasBindingCandidates(dir: string): string[] {
  return [canvasBindingPath(dir), join(dir, LEGACY_BINDING_DIR, BINDING_FILE)];
}

export function hasCanvasBinding(dir: string): boolean {
  return readCanvasBinding(dir) !== null;
}

/**
 * 读取目录上的画布绑定。
 *
 * 读不出来（文件不存在、JSON 坏了、缺 `projectUuid`）一律返回 `null`——
 * 调用方据此判断「还没绑」，而不是把一个半截的绑定当成可用的。
 */
export function readCanvasBinding(dir: string): CanvasBinding | null {
  for (const file of canvasBindingCandidates(dir)) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { projectUuid?: unknown; workspaceId?: unknown };
      if (typeof parsed.projectUuid !== 'string' || parsed.projectUuid.length === 0) continue;
      return {
        canvasUuid: parsed.projectUuid,
        workspaceId: typeof parsed.workspaceId === 'number' ? parsed.workspaceId : null,
        dir,
      };
    } catch {
      // 官方绑定损坏时继续尝试旧目录；两边都不可用才返回 null。
    }
  }
  return null;
}

export interface EnsureCanvasOptions {
  /**/
  dir: string;
  /** 新建画布时用的名字；已绑定时忽略。 */
  name: string;
}

/**
 * 确保目录上有一张可用的画布。
 *
 * 已绑定就直接返回，不会重复新建——每次生成都建一张画布，是最快把用户账号
 * 塞满垃圾的方式，而且会让「这张画布属于哪个项目」重新变得不可知。
 */
export async function ensureCanvasBinding(
  adapter: CanvasAdapter,
  options: EnsureCanvasOptions,
): Promise<{ binding: CanvasBinding; created: boolean }> {
  const existing = readCanvasBinding(options.dir);
  if (existing !== null) return { binding: existing, created: false };

  mkdirSync(options.dir, { recursive: true });
  const created = await adapter.createCanvas(options.name, { cwd: options.dir });
  const bound = await adapter.useCanvas(created.canvasUuid, { cwd: options.dir });
  const binding = readCanvasBinding(options.dir);
  if (binding === null) {
    throw new Error(`画布已创建（${bound.canvasUuid}）但绑定文件没能读出，请检查 ${canvasBindingPath(options.dir)}`);
  }
  return { binding, created: true };
}
