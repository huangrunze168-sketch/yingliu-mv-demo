import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ============================================================
  测试收尾：把临时工作目录收干净。

   为什么需要它：很多测试用 `mkdtempSync` 在系统临时目录里建工作目录
   （生成产物、成片 Source、导出目标都写在那儿），但**建了不删**——
   跑一次全量测试多十几个，实测攒到 81 个。
   它们不占多少空间，但会让"临时目录里到底有什么"变得没法看，
   排查别的环境问题时全是噪声。

   为什么放在 globalSetup 的 teardown 而不是各测试自己清理：
   一个测试失败时，它里的清理语句多半也跑不到——那正是最需要清理的时候。
   这里在整个 run 结束时统一扫一遍，无论中间挂了几条。

  只删 `qiyin-` 前缀的目录：那是本仓库测试自己建的名字，
  别人的临时目录一概不碰。

   **为什么还要看目录年龄**（这条是踩出来的，不是预防性的）：
   只按名字删的话，两个 vitest 同时在跑时，先结束的那个会把**另一个
   还在用**的临时目录删掉。实测症状很难认：`kernel-integration` 里
   抽帧那条报 `ffmpeg ... Error opening input: No such file or directory`，
   指向一个 30 秒前刚写好的 `reference.mp4`——单跑同一文件 10/10 通过。

   于是收尾按**两条规则**删，两条都满足才动手：

     ① 目录年龄超过 `STALE_AFTER_MS`（久到不可能是任何还在跑的 run 的）；
     ② 或者这个目录**在本次 run 开始之前就存在**、且年龄超过 `STALE_AFTER_MS_LIVE`。

   第②条是为了不攒垃圾：只有第①条的话，10 分钟窗口内连着跑几次，
   目录就会一茬一茬地堆下来（实测堆到 178 个）。

   **门槛为什么是 5 分钟而不是 2 分钟**：2 分钟那一版又踩了一次。
   机器被占满时，一次全量测试实测跑到 **205 秒**，而且单个测试文件也可能
   跑上一两分钟；于是"我开跑前就在、但它的文件还在写"的目录会被判成遗留，
   另一个 run 当场报 `No such file or directory`。目录的 mtime 在文件被
   增删时会刷新，所以真正在干活的目录通常是"旧目录但新 mtime"——
   门槛越靠近"单次 run 的可能时长"，越不容易误伤。
   代价是少于 5 分钟的那些这次收不掉，留到下一次运行再收。
   ============================================================ */

/** 任何情况下，超过这个"最后修改时间距现在"的目录都算遗留 */
const STALE_AFTER_MS = 10 * 60 * 1000;
/** 本次 run 开始前就存在的目录：放够这么久才算遗留（要盖过"一次长跑"的时长） */
const STALE_AFTER_MS_LIVE = 5 * 60 * 1000;

/** run 开始时快照下来的目录名；teardown 用它区分"我开跑前就在"与"这次刚建的" */
let preexisting: Set<string> = new Set();

export function setup(): void {
  preexisting = new Set(
    readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('qiyin-'))
      .map((entry) => entry.name),
  );
}

export function teardown(): void {
  const root = tmpdir();
  const now = Date.now();
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('qiyin-')) continue;
    const path = join(root, entry.name);
    try {
      const age = now - statSync(path).mtimeMs;
      const stale = age >= STALE_AFTER_MS
        || (preexisting.has(entry.name) && age >= STALE_AFTER_MS_LIVE);
      if (!stale) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* 删不掉就算了：临时目录清理失败不该让测试结果变红 */
    }
  }
  if (removed > 0) {
    console.log(`[global-setup] 已清理 ${removed} 个测试临时目录（qiyin-*）`);
  }
}
