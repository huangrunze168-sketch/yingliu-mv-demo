import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const BACKGROUND_REMOVAL_CAPABILITY = '@frontkernel/background-removal@1#remove-background' as const;

export interface BackgroundRemovalBlobArtifact {
  kind: 'blob';
  resource: string;
  size: number;
  mediaType: string;
  filePath: string;
}

export type BackgroundRemovalTaskPhase = 'queued' | 'running' | 'completed' | 'failed';
export interface BackgroundRemovalTaskEvent { taskId: string; phase: BackgroundRemovalTaskPhase; at: string; error?: string }
export interface BackgroundRemovalResult {
  taskId: string;
  capability: typeof BACKGROUND_REMOVAL_CAPABILITY;
  output: BackgroundRemovalBlobArtifact;
}

export class BackgroundRemovalProviderError extends Error {
  constructor(public readonly code: 'INVALID_SOURCE' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_FAILED' | 'INVALID_OUTPUT', message: string) {
    super(message); this.name = 'BackgroundRemovalProviderError';
  }
}

export function assertBackgroundRemovalSource(source: BackgroundRemovalBlobArtifact): void {
  if (source.kind !== 'blob' || !source.resource.trim() || !Number.isSafeInteger(source.size) || source.size < 0
    || !source.mediaType.startsWith('image/') || !source.filePath.trim()) {
    throw new BackgroundRemovalProviderError('INVALID_SOURCE', 'Background Removal source must be an image Blob Artifact.');
  }
}

export interface BackgroundRemovalRunner {
  probe(): Promise<{ available: boolean; detail: string }>;
  remove(inputPath: string, outputPath: string): Promise<void>;
}

function execute(executable: string, args: readonly string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
    });
  });
}

export function createRembgRunner(options: { executable?: string; argsPrefix?: readonly string[]; timeoutMs?: number } = {}): BackgroundRemovalRunner {
  const executable = options.executable ?? 'rembg';
  const prefix = options.argsPrefix ?? [];
  const timeout = options.timeoutMs ?? 180_000;
  return {
    async probe() {
      try { const result = await execute(executable, [...prefix, '--version'], 8_000); return { available: true, detail: result.stdout.trim() || result.stderr.trim() || executable }; }
      catch (error) { return { available: false, detail: error instanceof Error ? error.message : String(error) }; }
    },
    async remove(inputPath, outputPath) { await execute(executable, [...prefix, 'i', inputPath, outputPath], timeout); },
  };
}

export function isTransparentPng(bytes: Uint8Array): boolean {
  const signature = [137,80,78,71,13,10,26,10];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return false;
  // PNG IHDR 的 color type 位于第 26 个字节；4（灰度+alpha）与 6（RGBA）具备透明通道。
  return bytes[25] === 4 || bytes[25] === 6;
}

export class BackgroundRemovalProvider {
  readonly id = 'local-rembg';
  readonly label = '本地 rembg';
  readonly capability = BACKGROUND_REMOVAL_CAPABILITY;
  constructor(private readonly runner: BackgroundRemovalRunner = createRembgRunner()) {}

  probe() { return this.runner.probe(); }

  async remove(input: { source: BackgroundRemovalBlobArtifact; outputPath: string; onTask?: (event: BackgroundRemovalTaskEvent) => void }): Promise<BackgroundRemovalResult> {
    assertBackgroundRemovalSource(input.source);
    const taskId = randomUUID();
    const report = (phase: BackgroundRemovalTaskPhase, error?: string) => input.onTask?.({ taskId, phase, at: new Date().toISOString(), ...(error ? { error } : {}) });
    report('queued');
    const status = await this.runner.probe();
    if (!status.available) {
      const message = `本地抠图 Provider 不可用：${status.detail}`; report('failed', message);
      throw new BackgroundRemovalProviderError('PROVIDER_UNAVAILABLE', message);
    }
    report('running');
    try {
      await this.runner.remove(input.source.filePath, input.outputPath);
      const bytes = await readFile(input.outputPath);
      if (!isTransparentPng(bytes)) throw new BackgroundRemovalProviderError('INVALID_OUTPUT', '抠图 Provider 没有返回带 Alpha 通道的 PNG');
      const info = await stat(input.outputPath);
      report('completed');
      return { taskId, capability: this.capability, output: { kind: 'blob', resource: `file:${input.outputPath}`, size: info.size, mediaType: 'image/png', filePath: input.outputPath } };
    } catch (error) {
      const normalized = error instanceof BackgroundRemovalProviderError ? error : new BackgroundRemovalProviderError('PROVIDER_FAILED', error instanceof Error ? error.message : String(error));
      report('failed', normalized.message); throw normalized;
    }
  }
}
