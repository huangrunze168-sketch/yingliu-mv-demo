/* ============================================================
  Videogen 适配器：解析与四态判定。

  这些用例**不联网、不花钱**——它们盯的是"拿到对方的输出之后我们怎么判"，
  而那正是最容易出错、也最容易悄悄骗过人的地方：

    ① "跑完"不等于"有产物"（对方用 `generation_succeeded: false` 说的，
       我们不许把它抹平成成功）；
    ② "在等人确认"（`pending_confirmation`）既不是成功也不是失败，
       尤其可能涉及付费——必须单独一类抛出来；
    ③ 缺凭据要能和"命令失败"分开（前者用户自己能修）；
    ④ 挑产物按类型来，挑不到就如实说，不拿别的类型凑数。
   ============================================================ */

import { describe, expect, it } from 'vitest';
import {
  VideogenAdapter,
  VideogenCommandError,
  VideogenCredentialError,
  VideogenNoArtifactError,
  VideogenPendingConfirmationError,
  VideogenProtocolError,
  collectArtifacts,
  createVideogenBackend,
  parseVideogenJson,
  resolveVideogenScript,
  type VideogenRunRequest,
  type VideogenRunResult,
  type VideogenRunner,
} from '../packages/videogen-adapter/src/index.js';

/** 假 runner：把预定的输出原样交出去，并记下调用参数（不 spawn、不联网）。 */
function fakeRunner(reply: Partial<VideogenRunResult> & { code: number }): VideogenRunner & { calls: VideogenRunRequest[] } {
  const calls: VideogenRunRequest[] = [];
  return {
    calls,
    run(request: VideogenRunRequest): Promise<VideogenRunResult> {
      calls.push(request);
      return Promise.resolve({ code: reply.code, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' });
    },
  };
}

const okChat = {
  thread_id: 'th-1',
  project_id: 'pj-1',
  final_status: 'done',
  generation_succeeded: true,
  items: [{ artifacts: [{ type: 'image', content: 'https://cdn.videogen.ai/a.png' }] }],
  downloaded: [{ type: 'image', url: 'https://cdn.videogen.ai/a.png', local_path: 'C:/ws/out/videogen_ab.png', new: true }],
};

describe('Videogen · 从 stdout 里挑出 JSON', () => {
  it('纯 JSON 直接解析', () => {
    expect(parseVideogenJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('前面混了日志也能找到最后那份结果', () => {
    const stdout = '正在连接 Videogen…\n已提交\n{"thread_id":"th-9","final_status":"done"}';
    expect(parseVideogenJson(stdout)).toEqual({ thread_id: 'th-9', final_status: 'done' });
  });

  it('找不到 JSON 就抛协议错（不返回空对象蒙混）', () => {
    expect(() => parseVideogenJson('完全没有 JSON')).toThrow(VideogenProtocolError);
    expect(() => parseVideogenJson('')).toThrow(VideogenProtocolError);
  });
});

describe('Videogen · 产物清单', () => {
  it('下载过的带上本地路径，URL 与 items 对齐', () => {
    const artifacts = collectArtifacts(okChat);
    expect(artifacts).toEqual([{
      type: 'image',
      url: 'https://cdn.videogen.ai/a.png',
      localPath: 'C:/ws/out/videogen_ab.png',
    }]);
  });

  it('没下载时只有 URL（本地路径为 null，不假装有文件）', () => {
    const artifacts = collectArtifacts({ items: [{ artifacts: [{ type: 'video', content: 'https://cdn.videogen.ai/v.mp4' }] }] });
    expect(artifacts).toEqual([{ type: 'video', url: 'https://cdn.videogen.ai/v.mp4', localPath: null }]);
  });
});

describe('Videogen · chat 的四种结局', () => {
  it('缺凭据 → 单独一类错（用户自己能修）', async () => {
    const runner = fakeRunner({
      code: 1,
      stderr: 'Error: LOVART_ACCESS_KEY and LOVART_SECRET_KEY must be set (via env vars or --ak/--sk)',
    });
    const adapter = new VideogenAdapter({ runner });
    await expect(adapter.chat({ prompt: 'x', outputDir: 'C:/ws/out' })).rejects.toBeInstanceOf(VideogenCredentialError);
  });

  it('命令失败 → 命令错（带退出码与 stderr 尾巴）', async () => {
    const runner = fakeRunner({ code: 2, stderr: 'boom\nsomething exploded' });
    const adapter = new VideogenAdapter({ runner });
    await expect(adapter.chat({ prompt: 'x', outputDir: 'C:/ws/out' })).rejects.toBeInstanceOf(VideogenCommandError);
  });

  it('在等人确认 → 既不是成功也不是失败，带上待确认内容', async () => {
    const runner = fakeRunner({
      code: 0,
      stdout: JSON.stringify({
        thread_id: 'th-2',
        final_status: 'pending_confirmation',
        pending_confirmation: { reason: '需要确认付费' },
      }),
    });
    const adapter = new VideogenAdapter({ runner });
    const error = await adapter.chat({ prompt: 'x', outputDir: 'C:/ws/out' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VideogenPendingConfirmationError);
    expect((error as VideogenPendingConfirmationError).pending).toEqual({ reason: '需要确认付费' });
  });

  it('跑完但没有产物 → 如实抛出来，并把 Agent 说的话带上', async () => {
    const runner = fakeRunner({
      code: 0,
      stdout: JSON.stringify({
        thread_id: 'th-3',
        final_status: 'done',
        generation_succeeded: false,
        items: [{ text: '这个提示词被内容审核拒了。' }],
        warning: 'Thread ended without producing any artifact.',
      }),
    });
    const adapter = new VideogenAdapter({ runner });
    const error = await adapter.chat({ prompt: 'x', outputDir: 'C:/ws/out' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VideogenNoArtifactError);
    expect((error as VideogenNoArtifactError).agentMessage).toBe('这个提示词被内容审核拒了。');
  });

  it('成功：带上 thread_id、产物与 warning', async () => {
    const runner = fakeRunner({ code: 0, stdout: JSON.stringify({ ...okChat, warning: '有一个工具调用被拒' }) });
    const adapter = new VideogenAdapter({ runner });
    const result = await adapter.chat({ prompt: '一只猫', outputDir: 'C:/ws/out', preferModels: ['seedream'] });
    expect(result.threadId).toBe('th-1');
    expect(result.artifacts[0]?.localPath).toBe('C:/ws/out/videogen_ab.png');
    expect(result.warning).toBe('有一个工具调用被拒');
    /* 参数确实拼到了命令行上 */
    expect(runner.calls[0]?.args).toContain('--prefer-models');
    expect(runner.calls[0]?.args).toContain('--download');
  });
});

describe('Videogen · 后端这一层', () => {
  it('能力声明如实：重拍与场景化能力**不宣称**支持', () => {
    const backend = createVideogenBackend(new VideogenAdapter({ runner: fakeRunner({ code: 0 }) }));
    expect(backend.id).toBe('videogen');
    expect(backend.capabilities.image).toBe(true);
    expect(backend.capabilities.videoFromImage).toBe(true);
    expect(backend.capabilities.imageUpscale).toBe(true);
    expect(backend.capabilities.videoEdit).toBe(false);
    expect(backend.capabilities.imageShortcut).toBe(false);
  });

  it('不支持的两种能力抛 UnsupportedCapabilityError（不假装做了）', async () => {
    const backend = createVideogenBackend(new VideogenAdapter({ runner: fakeRunner({ code: 0 }) }));
    await expect(backend.editVideo({ videoFile: 'a.mp4', prompt: 'x', model: 'm', outputDir: 'C:/ws', label: 'l' }))
      .rejects.toThrow(/不支持/);
    await expect(backend.applyImageShortcut({ imageFile: 'a.png', scene: 'grid', outputDir: 'C:/ws', label: 'l' }))
      .rejects.toThrow(/不支持/);
  });

  it('出图：比例/清晰度拼进提示词，花费报 null（它不给计费信息）', async () => {
    const runner = fakeRunner({ code: 0, stdout: JSON.stringify(okChat) });
    const backend = createVideogenBackend(new VideogenAdapter({ runner }));
    const media = await backend.generateImage({
      prompt: '一只赛博朋克猫', model: 'seedream', ratio: '9:16', quality: '2K',
      outputDir: 'C:/ws/out', label: 'shot-01', settings: { style: 'neon' },
    });
    const prompt = String(runner.calls[0]?.args[runner.calls[0].args.indexOf('--prompt') + 1] ?? '');
    expect(prompt).toContain('一只赛博朋克猫');
    expect(prompt).toContain('画幅 9:16');
    expect(prompt).toContain('清晰度 2K');
    expect(media.files).toEqual(['C:/ws/out/videogen_ab.png']);
    expect(media.cost).toBeNull();
    expect(media.task_ref).toBe('th-1');
    /* 参数是当自然语言交出去的——这件事必须说出来 */
    expect(media.notes.join(' ')).toContain('拼进提示词');
  });

  it('产物类型不对时如实报错，不拿别的类型凑数', async () => {
    const runner = fakeRunner({
      code: 0,
      stdout: JSON.stringify({
        ...okChat,
        items: [{ artifacts: [{ type: 'video', content: 'https://cdn.videogen.ai/v.mp4' }] }],
        downloaded: [{ type: 'video', url: 'https://cdn.videogen.ai/v.mp4', local_path: 'C:/ws/out/v.mp4' }],
      }),
    });
    const backend = createVideogenBackend(new VideogenAdapter({ runner }));
    await expect(backend.generateImage({ prompt: 'x', model: 'm', outputDir: 'C:/ws/out', label: 'l' }))
      .rejects.toThrow(/没有我们要的那种/);
  });

  it('图生视频：首帧必须当附件传下去', async () => {
    const runner = fakeRunner({
      code: 0,
      stdout: JSON.stringify({
        ...okChat,
        items: [{ artifacts: [{ type: 'video', content: 'https://cdn.videogen.ai/v.mp4' }] }],
        downloaded: [{ type: 'video', url: 'https://cdn.videogen.ai/v.mp4', local_path: 'C:/ws/out/v.mp4' }],
      }),
    });
    const backend = createVideogenBackend(new VideogenAdapter({ runner }));
    await backend.generateVideoFromImage({
      imageFile: 'C:/ws/first.png', model: 'm', durationSeconds: 5, outputDir: 'C:/ws/out', label: 'shot-01',
    });
    expect(runner.calls[0]?.args).toContain('C:/ws/first.png');
  });
});

describe('Videogen · 脚本怎么找', () => {
  it('显式给了一个存在的路径就用它', () => {
    expect(resolveVideogenScript('package.json')).toBeTruthy();
  });

  it('给了不存在的路径、环境变量也没有、默认位置也没有 → 返回 null（不猜）', () => {
    const before = process.env.VIDEOGEN_SKILL_SCRIPT;
    delete process.env.VIDEOGEN_SKILL_SCRIPT;
    try {
      expect(resolveVideogenScript('C:/definitely/not/here/agent_skill.py')).toBeNull();
    } finally {
      if (before !== undefined) process.env.VIDEOGEN_SKILL_SCRIPT = before;
    }
  });
});
