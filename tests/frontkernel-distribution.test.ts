import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { frontkernelDistributionCandidates } from '@qiyin/frontkernel-adapter';

/* ============================================================

   这组测试来自一次真实翻车：定位逻辑原来写死"往上四级"，
   `视频平台/`，但同一段代码打进 `dist-electron/main` 之后，
   往上四级是**用户目录**——于是桌面端一直显示「前置内核未接入」，
   而命令行那条路却是好的。表现只是"内核不可用"，完全看不出是路径算错了。

   所以这里把两种真实布局都钉住。
   ============================================================ */

describe('Frontkernel 发行版候选路径', () => {
  it('源码布局：从 packages/frontkernel-adapter/src 往上能找到仓库旁的 frontkernel-source', () => {
    const here = 'C:\\Users\\Administrator\\Documents\\视频平台\\replica-studio\\packages\\frontkernel-adapter\\src';
    const candidates = frontkernelDistributionCandidates(here, undefined, undefined);
    expect(candidates).toContain('C:\\Users\\Administrator\\Documents\\视频平台\\frontkernel-source');
  });

  it('打包布局：从 dist-electron/main 往上同样能找到', () => {
    const here = 'C:\\Users\\Administrator\\Documents\\视频平台\\replica-studio\\dist-electron\\main';
    const candidates = frontkernelDistributionCandidates(here, undefined, undefined);
    expect(candidates).toContain('C:\\Users\\Administrator\\Documents\\视频平台\\frontkernel-source');
  });

  it('安装脚本的 vendor/frontkernel 路径也能自动发现', () => {
    const root = resolve('repo');
    expect(frontkernelDistributionCandidates(join(root, 'packages', 'frontkernel-adapter', 'src'), undefined, undefined))
      .toContain(join(root, 'vendor', 'frontkernel'));
  });

  it('环境变量优先，放在最前面', () => {
    /* 期望值也用 path.resolve 算：这条测试跑在 Windows 上，
       */
    const override = join(resolve('.'), 'some-other-frontkernel');
    const candidates = frontkernelDistributionCandidates(join(resolve('.'), 'repo', 'dist-electron', 'main'), override, undefined);
    expect(candidates[0]).toBe(resolve(override));
  });

  it('打包成安装包时也认 resources/frontkernel', () => {
    const resources = join(resolve('.'), 'resources');
    const candidates = frontkernelDistributionCandidates(join(resolve('.'), 'app', 'dist-electron', 'main'), undefined, resources);
    expect(candidates).toContain(join(resources, 'frontkernel'));
  });

  it('往上找有上限，不会无限循环', () => {
    const candidates = frontkernelDistributionCandidates('C:\\a\\b', undefined, undefined);
    expect(candidates.length).toBeLessThanOrEqual(14);
  });
});
