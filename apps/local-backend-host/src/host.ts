import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface LocalBackendHostOptions {
  /** 本地能力后端 源码根目录；省略时按开发/打包两种布局自动探测。 */
  rootDir?: string;
  /** 嵌入式 python 可执行文件；省略时按 rootDir 推导。 */
  pythonPath?: string;
  /** 固定端口；省略时自动分配空闲端口。 */
  port?: number;
  /** 绑定地址，固定为回环，不允许改成对外地址。 */
  host?: string;
  /** 启动超时，毫秒。 */
  startupTimeoutMs?: number;
  /** 健康检查间隔，毫秒。 */
  pollIntervalMs?: number;
  /** 后端日志回调，用于任务中心展示。 */
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface LocalBackendHostStatus {
  running: boolean;
  baseUrl: string | null;
  port: number | null;
  pid: number | null;
  rootDir: string;
}

export class LocalBackendHostError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'LocalBackendHostError';
  }
}

/** 只在回环地址上监听；此约束是硬编码的，避免把无鉴权后端暴露到局域网。 */
const LOOPBACK = '127.0.0.1';

/**
 * 从当前文件位置逐级向上，列出所有祖先目录。
 *
 * 为什么不能写死 `../..`：这段代码可能被构建进不同层级的目标目录，
 * `import.meta.url` 的层级随之改变——
 * 按源码目录层级算出来的路径就会指错地方，运行时后端报
 * 「未找到 本地能力后端 源码目录」，API 设置页读不到平台与模型。
 * （历史上打包场景实测踩到：窗口正常打开，页面却写着「本地能力后端尚未就绪」。）
 */
function ancestors(start: string, levels: number): string[] {
  const out: string[] = [];
  let current = start;
  for (let index = 0; index < levels; index += 1) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function projectRootCandidates(): string[] {
  const candidates: string[] = [];
  /**
   * 都在同一串祖先里，因此逐级向上找一次就同时覆盖两种。
   */
  for (const base of ancestors(HERE, 6)) candidates.push(join(base, 'vendor', 'local-backend'));
  // 从仓库根启动（`electron .`）时 cwd 就是仓库根，作为兜底
  candidates.push(join(process.cwd(), 'vendor', 'local-backend'));
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(join(resourcesPath, 'local-backend'));
  return [...new Set(candidates)];
}

export function resolveLocalBackendRoot(explicit?: string): string {
  const candidates = explicit ? [resolve(explicit)] : projectRootCandidates();
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'main.py'))) return candidate;
  }
  throw new LocalBackendHostError('未找到 LocalBackend 源码目录（本地能力后端缺少 main.py）', { candidates });
}

export function resolveLocalBackendPython(rootDir: string, explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new LocalBackendHostError(`指定的 python 不存在: ${explicit}`);
    return explicit;
  }
  const candidates = [
    join(rootDir, 'python', 'python.exe'),
    join(rootDir, 'python', 'pythonw.exe'),
    join(rootDir, 'python', 'bin', 'python3'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
    throw new LocalBackendHostError('未找到嵌入式 Python 运行时', { rootDir, candidates });
}

export function launcherPath(): string {
  // 同样要向上逐级找：构建产物里层级可能与源码布局不同。
  const candidates = ancestors(HERE, 6).flatMap((base) => [
    join(base, 'launcher.py'),
    join(base, 'local-backend-host', 'launcher.py'),
    join(base, 'apps', 'local-backend-host', 'launcher.py'),
  ]);
  candidates.push(join(process.cwd(), 'apps', 'local-backend-host', 'launcher.py'));
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(join(resourcesPath, 'local-backend-host', 'launcher.py'));
  for (const candidate of [...new Set(candidates)]) {
    if (existsSync(candidate)) return candidate;
  }
    throw new LocalBackendHostError('未找到本地能力后端启动器 launcher.py', { candidates });
}

export function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolvePort(port));
      } else {
      server.close(() => reject(new LocalBackendHostError('无法分配空闲端口')));
      }
    });
  });
}

async function probeHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/config`, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class LocalBackendHost {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private baseUrl: string | null = null;
  private logRing: string[] = [];
  private readonly options: LocalBackendHostOptions;

  constructor(options: LocalBackendHostOptions = {}) {
    this.options = options;
  }

  get status(): LocalBackendHostStatus {
    return {
      running: this.child !== null && this.child.exitCode === null,
      baseUrl: this.baseUrl,
      port: this.port,
      pid: this.child?.pid ?? null,
      rootDir: this.options.rootDir ? resolve(this.options.rootDir) : '',
    };
  }

  /** 后端日志尾部，用于崩溃诊断。 */
  recentLogs(limit = 40): string[] {
    return this.logRing.slice(-limit);
  }

  async start(): Promise<{ baseUrl: string; port: number }> {
    if (this.child && this.child.exitCode === null) {
      if (!this.baseUrl || this.port === null) throw new LocalBackendHostError('后端状态不一致');
      return { baseUrl: this.baseUrl, port: this.port };
    }

    const rootDir = resolveLocalBackendRoot(this.options.rootDir);
    const pythonPath = resolveLocalBackendPython(rootDir, this.options.pythonPath);
    const launcher = launcherPath();
    const port = this.options.port ?? (await findFreePort());
    const host = LOOPBACK;
    const startupTimeoutMs = this.options.startupTimeoutMs ?? 180_000;
    const pollIntervalMs = this.options.pollIntervalMs ?? 500;

    this.logRing = [];
    const child = spawn(pythonPath, ['-B', launcher], {
      cwd: rootDir,
      windowsHide: true,
      env: {
        ...process.env,
        QIYIN_LOCAL_BACKEND_ROOT: rootDir,
        QIYIN_LOCAL_BACKEND_PORT: String(port),
        QIYIN_LOCAL_BACKEND_HOST: host,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.port = port;
    this.baseUrl = `http://${host}:${port}`;

    const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logRing.push(`[${stream}] ${line}`);
        if (this.logRing.length > 500) this.logRing.shift();
        this.options.onLog?.(line, stream);
      }
    };
    child.stdout?.on('data', capture('stdout'));
    child.stderr?.on('data', capture('stderr'));

    const exited = new Promise<never>((_, reject) => {
      child.once('exit', (code) => {
        this.child = null;
        this.baseUrl = null;
        reject(new LocalBackendHostError(`本地能力后端进程已退出（code=${code}）`, this.recentLogs()));
      });
      child.once('error', (error) => reject(new LocalBackendHostError(`无法启动本地能力后端: ${error.message}`)));
    });

    const ready = (async () => {
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
        if (await probeHealth(`http://${host}:${port}`, 3_000)) {
          return { baseUrl: `http://${host}:${port}`, port };
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      throw new LocalBackendHostError(`本地能力后端启动超时（${startupTimeoutMs}ms）`, this.recentLogs());
    })();

    try {
      return await Promise.race([ready, exited]);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    this.port = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolveStop();
      }, 8_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveStop();
      });
      child.kill();
    });
  }
}
