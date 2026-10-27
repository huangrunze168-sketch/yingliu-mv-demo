import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findFreePort,
  resolveLocalBackendRoot,
  resolveLocalBackendPython,
  launcherPath,
} from '@qiyin/local-backend-host';

const LOCAL_BACKEND_ROOT = join(process.cwd(), 'vendor', 'local-backend');
const hasLocalBackendSrc = existsSync(join(LOCAL_BACKEND_ROOT, 'main.py'));

describe('LocalBackend 源码探测', () => {
  it.skipIf(!hasLocalBackendSrc)('能定位源码根、嵌入式 Python 与启动器', () => {
    const root = resolveLocalBackendRoot(LOCAL_BACKEND_ROOT);
    expect(existsSync(join(root, 'main.py'))).toBe(true);

    const python = resolveLocalBackendPython(root);
    expect(existsSync(python)).toBe(true);
    expect(python.toLowerCase()).toMatch(/python(w)?\.exe$/);

    const launcher = launcherPath();
    expect(existsSync(launcher)).toBe(true);
    expect(launcher.endsWith('launcher.py')).toBe(true);
  });

  it('源码缺失时给出明确错误而不是静默回退', () => {
    expect(() => resolveLocalBackendRoot('C:\\qiyin-not-exist-xyz')).toThrow(/未找到 LocalBackend 源码目录/);
  });
});

describe('端口分配', () => {
  it('返回可用端口，且不同调用不重复', async () => {
    const [a, b] = await Promise.all([findFreePort(), findFreePort()]);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual(65535);
    // 端口在释放后才重新可分配，因此并发分配应当得到不同端口
    expect(a).not.toBe(b);
  });
});

describe('启动器安全约束', () => {
  it('启动器默认只绑定回环地址', async () => {
    if (!hasLocalBackendSrc) return;
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(launcherPath(), 'utf8');
    // 原 main.py 使用 0.0.0.0，启动器必须覆盖为回环绑定
    expect(source).toContain('127.0.0.1');
    expect(source).not.toMatch(/uvicorn\.run\([\s\S]*host="0\.0\.0\.0"/);
  });
});
