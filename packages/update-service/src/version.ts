/* ============================================================
  期音科技 · 版本号比较
   ------------------------------------------------------------
  只认 `major.minor.patch`（可带 `-预发布`）。不去实现完整的 SemVer 范围语法——
  更新器需要回答的问题只有一个："这个清单比我现在装的更新吗"，
  以及"我现在这版够不够老，得先走桥接版本"。

  预发布版小于同号正式版：0.4.0-beta < 0.4.0。这一条很重要——
  否则一个 beta 用户会永远停在 beta 上，正式版发布时他被判成"已是最新"。
   ============================================================ */

export interface ParsedVersion {
  parts: readonly [number, number, number];
  prerelease: string | null;
}

export function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (match === null) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

/** `< 0` 表示 a 更旧，`> 0` 表示 a 更新，`0` 表示同版。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    /* 认不出来的版本号不能"当成相等"——那会让降级检查形同虚设 */
    throw new Error(`无法比较的版本号：${left === null ? a : b}`);
  }
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}
