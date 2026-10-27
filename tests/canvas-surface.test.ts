import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canvasBindingPath,
  ensureCanvasBinding,
  CanvasAdapter,
  readCanvasBinding,
  type CanvasRunRequest,
  type CanvasRunner,
} from '@qiyin/canvas-adapter';

/**
 * 画布与项目绑定。
 *
 * 在它之前，生成用的是仓库里一个**写死的**工作目录——所有项目的节点堆在同一张画布上，
 *
 * 这里用可注入执行器覆盖我们这层的判断：什么时候该新建、什么时候必须复用、
 * （`project create` → `{ projectMeta: { uuid } }`，`project use` → `{ projectUuid }`）。
 */

/**/
function canvasRunner() {
  const calls: CanvasRunRequest[] = [];
  const runner: CanvasRunner = {
    async run(request: CanvasRunRequest) {
      calls.push(request);
      const [group, action] = request.args;
      if (group === 'project' && action === 'create') {
        const name = request.args[2] ?? '';
        return { code: 0, stderr: '', stdout: JSON.stringify({ projectMeta: { id: 12792278, uuid: 'uuid-from-create', name } }) };
      }
      if (group === 'project' && action === 'use') {
        const uuid = request.args[2] ?? '';
        const dir = request.cwd ?? process.cwd();
        mkdirSync(dirname(canvasBindingPath(dir)), { recursive: true });
        writeFileSync(canvasBindingPath(dir), JSON.stringify({ projectUuid: uuid }), 'utf8');
        return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, cwd: dir, projectUuid: uuid, name: '画布' }) };
      }
      return { code: 1, stdout: '', stderr: `error: 未预期的命令 ${request.args.join(' ')}` };
    },
  };
  return { runner, calls };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'qiyin-canvas-'));
}

describe('绑定文件读取', () => {
  it('没有绑定文件时为 null —— 调用方据此判断「还没绑」，而不是当成可用', () => {
    expect(readCanvasBinding(tempDir())).toBeNull();
  });

  it('读到 projectUuid 与 workspaceId', () => {
    const dir = tempDir();
    mkdirSync(dirname(canvasBindingPath(dir)), { recursive: true });
    writeFileSync(canvasBindingPath(dir), JSON.stringify({ projectUuid: 'u-1', workspaceId: 9139670 }), 'utf8');
    expect(readCanvasBinding(dir)).toEqual({ canvasUuid: 'u-1', workspaceId: 9139670, dir });
  });

  it('使用 LibTV CLI 1.1.3 的官方 .libtv/project.json 路径', () => {
    expect(canvasBindingPath('C:\\project')).toBe(join('C:\\project', '.libtv', 'project.json'));
  });

  it('兼容读取早期开发版留下的 .canvas/project.json', () => {
    const dir = tempDir();
    const legacy = join(dir, '.canvas', 'project.json');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ projectUuid: 'legacy-u', workspaceId: 7 }), 'utf8');
    expect(readCanvasBinding(dir)).toEqual({ canvasUuid: 'legacy-u', workspaceId: 7, dir });
  });

  it('坏掉的 JSON 或缺 projectUuid 都算「没绑」，而不是抛错让整个面板打不开', () => {
    const broken = tempDir();
    mkdirSync(dirname(canvasBindingPath(broken)), { recursive: true });
    writeFileSync(canvasBindingPath(broken), '{ 这不是 JSON', 'utf8');
    expect(readCanvasBinding(broken)).toBeNull();

    const half = tempDir();
    mkdirSync(dirname(canvasBindingPath(half)), { recursive: true });
    writeFileSync(canvasBindingPath(half), JSON.stringify({ workspaceId: 1 }), 'utf8');
    expect(readCanvasBinding(half)).toBeNull();
  });
});

describe('确保画布绑定', () => {
  it('未绑定时新建一张、绑定它，并把绑定读回来确认', async () => {
    const dir = tempDir();
    const { runner, calls } = canvasRunner();
    const { binding, created } = await ensureCanvasBinding(new CanvasAdapter(runner), { dir, name: '演示 · 复刻画布' });

    expect(created).toBe(true);
    expect(binding.canvasUuid).toBe('uuid-from-create');
    expect(calls.map((call) => call.args[0] + ' ' + call.args[1])).toEqual(['project create', 'project use']);
    expect(calls.every((call) => call.cwd === dir)).toBe(true);
    expect(JSON.parse(readFileSync(canvasBindingPath(dir), 'utf8'))).toEqual({ projectUuid: 'uuid-from-create' });
  });

  it('已绑定时绝不重复新建 —— 每次都建是最快把账号堆满垃圾的方式', async () => {
    const dir = tempDir();
    mkdirSync(dirname(canvasBindingPath(dir)), { recursive: true });
    writeFileSync(canvasBindingPath(dir), JSON.stringify({ projectUuid: '已存在的画布' }), 'utf8');
    const { runner, calls } = canvasRunner();
    const { binding, created } = await ensureCanvasBinding(new CanvasAdapter(runner), { dir, name: '不该被用到' });

    expect(created).toBe(false);
    expect(binding.canvasUuid).toBe('已存在的画布');
    expect(calls).toHaveLength(0);
  });
});
