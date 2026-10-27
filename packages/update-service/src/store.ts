/* ============================================================
  期音科技 · 更新状态与 A/B 槽
   ------------------------------------------------------------
  磁盘布局（默认根目录 `%APPDATA%/小QTV/updates`）：

    updates/
      state.json              当前槽 / 上一槽 / 见过的最高版本 / 偏好
      staging/<version>/      下载中（还没验完）的包
      slots/<version>/app/    验完并安装好的版本槽

  **A/B 的意思是两个槽都在盘上**：新版装进新槽，指针指过去；
  旧槽原样留着。出问题时把指针指回去就是回滚——不需要"卸载"，
  也不需要用户重新下载。这也是为什么回滚必须能在没有网络时完成。

  写状态用"临时文件 + rename"：rename 在同一个卷上是原子的。
  直接覆盖写的话，正好在那一刻断电会留下半个 JSON，
  而状态文件坏了就等于**不知道自己在哪个槽上**——那是更新器最不该出现的情况。
   ============================================================ */

import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { UpdateError } from './errors.js';

export interface SlotInfo {
  version: string;
  /** `pending` = 已切过去但还没确认能正常启动 */
  health: 'pending' | 'ok';
  /** 这一版已经被尝试启动过几次（用来判断"起不来"） */
  attempts: number;
  activatedAt: string;
}

export interface UpdatePrefs {
  autoCheck: boolean;
  autoDownload: boolean;
}

export interface UpdateState {
  schema: 'xqtv.update-state@1';
  current: SlotInfo | null;
  previous: SlotInfo | null;
  /**
   * **安装目录里那一版**的版本号。

   * 第一次切槽时记下来：那时正在跑的版本就是随安装包发出去的那一版。
   * 有了它，"回滚到安装目录"才说得清是回到哪一版——
   * 而不是在运行新版的时候把"当前版本"错当成回滚目标。
   */
  baseVersion: string | null;
  highest: { version: string; counter: number } | null;
  stagedVersion: string | null;
  prefs: UpdatePrefs;
  lastRollback: { at: string; from: string; to: string; reason: string } | null;
}

const VERSION_DIR = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function defaultUpdateState(): UpdateState {
  return {
    schema: 'xqtv.update-state@1',
    current: null,
    previous: null,
    baseVersion: null,
    highest: null,
    stagedVersion: null,
    prefs: { autoCheck: true, autoDownload: false },
    lastRollback: null,
  };
}

/**
 * 目录名只接受合法版本号。

 * 版本号会被拼进路径，所以它是**输入**。拼之前先卡死格式，
 * 就不存在"清单里写一个 `../..` 当版本号"这种事。
 */
function assertVersionDir(version: string): string {
  if (!VERSION_DIR.test(version)) {
    throw new UpdateError('UPDATE_MANIFEST_INVALID', `版本号不能用作目录名：${version}`, { version });
  }
  return version;
}

export class UpdateStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get statePath(): string {
    return join(this.root, 'state.json');
  }

  /**
   * 读状态。

   * 状态文件损坏时**不让软件起不来**：备份成 `state.json.corrupt-<时间>`，
   * 然后从头开始。丢的只是"上一槽是哪一版"这类信息，
   * 而那是可以重新装回来的；起不来是另一回事。
   */
  readState(): UpdateState {
    if (!existsSync(this.statePath)) return defaultUpdateState();
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<UpdateState>;
      if (parsed.schema !== 'xqtv.update-state@1') throw new Error('schema 不匹配');
      return {
        ...defaultUpdateState(),
        ...parsed,
        prefs: { ...defaultUpdateState().prefs, ...(parsed.prefs ?? {}) },
      };
    } catch {
      const backup = `${this.statePath}.corrupt-${Date.now()}`;
      try { renameSync(this.statePath, backup); } catch { /* 备份失败也要继续起 */ }
      return defaultUpdateState();
    }
  }

  writeState(state: UpdateState): void {
    mkdirSync(this.root, { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.statePath);
  }

  stagingDir(version: string): string {
    return join(this.root, 'staging', assertVersionDir(version));
  }

  slotDir(version: string): string {
    return join(this.root, 'slots', assertVersionDir(version));
  }

  hasSlot(version: string): boolean {
    return existsSync(this.slotDir(version));
  }

  listSlots(): string[] {
    const slotsDir = join(this.root, 'slots');
    if (!existsSync(slotsDir)) return [];
    return readdirSync(slotsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && VERSION_DIR.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  createStaging(version: string): string {
    const dir = this.stagingDir(version);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  removeStaging(version: string): void {
    rmSync(this.stagingDir(version), { recursive: true, force: true });
  }

  /**
   * staging → slots 的搬运。

   * 只有**整包验完**才会走到这里。搬运用 rename：同一卷上是原子的，
   * 不会出现"槽里有半个版本"的中间状态。
   */
  promoteStaging(version: string): string {
    const staging = this.stagingDir(version);
    if (!existsSync(staging)) {
      throw new UpdateError('UPDATE_STATE_CONFLICT', `没有待安装的 ${version}（staging 不存在）`, { version });
    }
    const slot = this.slotDir(version);
    rmSync(slot, { recursive: true, force: true });
    mkdirSync(join(this.root, 'slots'), { recursive: true });
    renameSync(staging, slot);
    return slot;
  }
}
