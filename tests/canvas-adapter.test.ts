import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CanvasAdapter,
  CanvasAuthError,
  CanvasCommandError,
  CanvasProtocolError,
  createCanvasAdapter,
  extractJson,
  resolveCanvasExecutable,
  type CanvasRunRequest,
  type CanvasRunner,
} from '@qiyin/canvas-adapter';

/**
 *
 * 证明这台机器上确实能操作画布与模型清单。
 * 生成类命令不在测试里跑——它们会真实消耗账户额度。
 */

function fakeRunner(responses: ReadonlyArray<{ code?: number; stdout?: string; stderr?: string }>) {
  const calls: CanvasRunRequest[] = [];
  let index = 0;
  const runner: CanvasRunner = {
    async run(request: CanvasRunRequest) {
      calls.push(request);
      const response = responses[Math.min(index, responses.length - 1)] ?? {};
      index += 1;
      return { code: response.code ?? 0, stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
    },
  };
  return { runner, calls };
}

const ACCOUNT_JSON = JSON.stringify({
  user: { uuid: 'u1', id: 10747818, nickname: '157****7765' },
  activeAccount: { accountId: 5715482, accountName: '157****7765', memberAccount: { memberName: '至尊版VIP' } },
});

describe('输出解析', () => {
  it('纯 JSON 直接解析', () => {
    expect(extractJson('{"ok":true}')).toEqual({ ok: true });
  });

  it('跳过提示行后再解析 —— canvas 会把 [项目范围] 这类提示混进 stdout', () => {
    const stdout = '[项目范围] 新画布将建到当前目录绑定的项目下（workspaceId=9139670）；用 -w 0 可建到根目录。\n'
      + '{\n  "projectMeta": { "uuid": "abc" }\n}\n';
    expect(extractJson(stdout)).toEqual({ projectMeta: { uuid: 'abc' } });
  });

  it('数组输出同样能取出', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('没有任何 JSON 时返回 null', () => {
    expect(extractJson('done')).toBeNull();
  });
});

describe('命令组装与错误分类', () => {
  it('账号信息解析出昵称与套餐', async () => {
    const { runner, calls } = fakeRunner([{ stdout: ACCOUNT_JSON }]);
    const info = await new CanvasAdapter(runner).accountInfo();
    expect(info.user?.nickname).toBe('157****7765');
    expect(info.activeAccount?.memberAccount?.memberName).toBe('至尊版VIP');
    expect(calls[0]?.args).toEqual(['account', 'info']);
  });

  it('按模态检索模型时带上 --type', async () => {
    const { runner, calls } = fakeRunner([{ stdout: JSON.stringify({ matchKind: 'all', matches: [] }) }]);
    await new CanvasAdapter(runner).searchModels({ type: 'video' });
    expect(calls[0]?.args).toEqual(['model', 'search', '--type', 'video']);
  });

  it('建节点时把 sets 逐个翻译成 -s key=value', async () => {
    const { runner, calls } = fakeRunner([{ stdout: JSON.stringify({ nodeKey: 'n1', nodeType: 'image' }) }]);
    await new CanvasAdapter(runner).nodeCreate({
      name: '测试图', type: 'image', prompt: '一只猫',
      sets: { model: 'Z-image Turbo', quality: '1K', ratio: '1:1' },
    });
    expect(calls[0]?.args).toEqual([
      'node', 'create', '测试图', '-t', 'image', '--prompt', '一只猫',
      '-s', 'model=Z-image Turbo', '-s', 'quality=1K', '-s', 'ratio=1:1',
    ]);
  });

  it('凭据失效单独归类 —— 唯一的下一步是重新登录', async () => {
    const { runner } = fakeRunner([{ code: 1, stderr: 'error: 未登录，请先执行 canvas login\n' }]);
    await expect(new CanvasAdapter(runner).accountInfo()).rejects.toBeInstanceOf(CanvasAuthError);
  });

  it('普通命令失败归为命令错误，并带出 CLI 的原始说明', async () => {
    const { runner } = fakeRunner([{ code: 1, stderr: "error: unknown option '-t'\n" }]);
    const error = await new CanvasAdapter(runner).nodeRun('x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CanvasCommandError);
    expect((error as CanvasCommandError).message).toContain("unknown option '-t'");
    expect((error as CanvasCommandError).exitCode).toBe(1);
  });

  it('成功退出但没有 JSON 时报协议错误，而不是给出空结果', async () => {
    const { runner } = fakeRunner([{ code: 0, stdout: 'done\n' }]);
    await expect(new CanvasAdapter(runner).accountInfo()).rejects.toBeInstanceOf(CanvasProtocolError);
  });
});

function findExecutable(): string | null {
  try {
    const path = resolveCanvasExecutable();
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

const executable = findExecutable();
const workspace = 'C:\\Users\\Administrator\\Documents\\视频平台\\.tools\\canvas-workspace';
const describeReal = executable === null || !existsSync(workspace) ? describe.skip : describe;

describeReal('Canvas 适配器·真实 CLI（只读命令）', () => {
  const adapter = () => createCanvasAdapter({
    executable: executable as string, cwd: workspace, timeoutMs: 120_000,
  });

  it('能读到已登录账号与套餐', async () => {
    const info = await adapter().accountInfo();
    expect(info.user?.nickname).toBeTruthy();
    expect(info.activeAccount?.accountName).toBeTruthy();
  }, 120_000);

  it('能列出图片与视频模型', async () => {
    const images = await adapter().searchModels({ type: 'image' });
    expect(images.matches.length).toBeGreaterThan(0);
    expect(images.matches.some((match) => match.modelKey === 'z-image')).toBe(true);

    const videos = await adapter().searchModels({ type: 'video' });
    expect(videos.matches.length).toBeGreaterThan(0);
  }, 180_000);

  /**
   * **一条钉住 CLI 边界的测试**（不是钉我们的实现）。
   *
   * （`volcano-subtitle-eraser`，modality video，properties 为空，
   * 带格式 / 2K / 3 秒三条规则）。但那**不等于 CLI 能调度它**——
   * `node create -s model=` 只认 `model search` 里的生成模型名，
   * 实测把三种写法都试过（modelKey / toolKey / checkpointId）全被拒。
   *
   * 所以这一条按"**现在是什么样**"断死：模型拉得到、但不在可选名单里。
   * 哪天 CLI 把工具模型放出来了，这条测试会红——那正是该去把去字幕做出来的时候。
   * 反过来，谁要是想"顺手接一下去字幕"，跑一遍这里就能看到为什么不行。
   */
  it('去字幕用的工具模型：**拉得到 schema，但选不到**（这就是那条边界）', async () => {
    const schema = await adapter().modelSchema('智能擦除') as unknown as {
      modelKey: string;
      modelName: string;
      modality?: string;
      schema?: { properties?: Record<string, unknown>; rules?: Array<{ check?: string }> };
    };
    expect(schema.modelKey).toBe('volcano-subtitle-eraser');
    expect(schema.modelName).toBe('智能擦除');
    expect(schema.modality).toBe('video');
    /* properties 为空：这个模型没有任何设置项，也就没有"参数传错"的余地 */
    expect(schema.schema?.properties).toEqual({});
    const checks = (schema.schema?.rules ?? []).map((rule) => rule.check);
    expect(checks).toEqual(expect.arrayContaining(['videoFormat', 'videoMaxResolution', 'videoMinDuration']));

    /*
      但它**不在任何一类 `model search` 的结果里**——而 `node create -s model=`
      只认那份名单。四类都查一遍：只要有一类里出现了它，这条断言就会红，
      那一刻说明 CLI 变了。
    */
    const searched: string[] = [];
    for (const type of ['video', 'image', 'text', 'audio'] as const) {
      const result = await adapter().searchModels({ type });
      searched.push(...result.matches.flatMap((match) => [match.modelKey, match.modelName]));
    }
    expect(searched).not.toContain('智能擦除');
    expect(searched).not.toContain('volcano-subtitle-eraser');
  }, 180_000);
});
