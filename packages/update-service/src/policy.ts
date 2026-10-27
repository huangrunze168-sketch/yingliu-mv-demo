/* ============================================================
  期音科技 · 更新策略（什么时候**不许**装）
   ------------------------------------------------------------
  更新器里最容易被忽略、后果又最重的一类逻辑，是"拒绝"：

    · **降级**：有人把一个更早的版本重新签一遍发给你。装上就回到了
      那些已经修掉的漏洞上，而且用户毫无察觉——所以除了比版本号，
      还要比 `counter`（只增不减）。
    · **跳版本**：跨大版本升级通常要跑数据迁移。老客户端直接跳到最新版，
      迁移被跳过，用户的项目库可能被"升"坏。这种情况要明确要求先装桥接版本。

  这两条都是**主动拒绝**，不是失败：界面上该说的是"这次不装，原因是……"，
  而不是"更新失败，请重试"——后者会让用户一直点，而点多少次都不该装上。
   ============================================================ */

import { UpdateError } from './errors.js';
import type { UpdateManifest } from './manifest.js';
import { compareVersions } from './version.js';

export interface UpdateFacts {
  /** 当前正在运行的版本 */
  currentVersion: string;
  /** 本机见过的最高版本与最大 counter（挡住重放） */
  highest: { version: string; counter: number } | null;
}

export type UpdateDecision =
  | { kind: 'current' }
  | { kind: 'available' };

/** 允许装的判断；不满足就抛（错误码区分"降级"与"需要桥接版本"）。 */
export function assertUpgradeAllowed(manifest: UpdateManifest, facts: UpdateFacts): UpdateDecision {
  const highest = facts.highest;
  if (highest !== null && manifest.counter < highest.counter) {
    throw new UpdateError('UPDATE_ROLLBACK_REFUSED', '这份清单比本机见过的版本更旧，按防回滚策略拒绝', {
      manifestCounter: manifest.counter,
      highestCounter: highest.counter,
      highestVersion: highest.version,
    });
  }

  const vsCurrent = compareVersions(manifest.version, facts.currentVersion);
  if (vsCurrent < 0) {
    throw new UpdateError('UPDATE_ROLLBACK_REFUSED', `这份清单是更旧的版本 ${manifest.version}，不覆盖当前 ${facts.currentVersion}`, {
      manifestVersion: manifest.version,
      currentVersion: facts.currentVersion,
    });
  }
  if (highest !== null && compareVersions(manifest.version, highest.version) < 0) {
    throw new UpdateError('UPDATE_ROLLBACK_REFUSED', `这份清单比本机见过的最高版本 ${highest.version} 更旧，拒绝安装`, {
      manifestVersion: manifest.version,
      highestVersion: highest.version,
    });
  }

  if (compareVersions(facts.currentVersion, manifest.minSupportedVersion) < 0) {
    throw new UpdateError(
      'UPDATE_BRIDGE_REQUIRED',
      `当前 ${facts.currentVersion} 不能直接升到 ${manifest.version}：先装桥接版本 ${manifest.minSupportedVersion} 再做这一步`,
      {
        currentVersion: facts.currentVersion,
        targetVersion: manifest.version,
        bridgeVersion: manifest.minSupportedVersion,
      },
    );
  }

  return vsCurrent === 0 ? { kind: 'current' } : { kind: 'available' };
}
