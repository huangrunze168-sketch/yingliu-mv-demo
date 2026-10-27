import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOL_PHRASES,
  TASK_OP_PHRASES,
  builtinToolDone,
  builtinToolRunning,
  domainErrorCode,
  generationNote,
  generationProgressText,
  generationReceipt,
  pendingFromDomainCode,
  pendingNoteForCode,
  toolReplyOk,
} from '../apps/local-api/src/agent/agent-tool-copy.js';
import { BUILTIN_TOOLS } from '../apps/local-api/src/agent/agent-builtin.js';

/* ============================================================
  动作行的说法。

  这些断言盯的是**界面上的那句话**：它不是函数名，是一套状态词
  ============================================================ */

describe('动作行 · 两条词', () => {
  it('每个动作都有「正在…」与「…已…」两条，且都不是空的', () => {
    const entries = Object.entries(BUILTIN_TOOL_PHRASES);
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const [name, phrase] of entries) {
      expect(phrase.running.startsWith('正在'), `${name} 的开始那条要以「正在」开头`).toBe(true);
      expect(phrase.done.length).toBeGreaterThan(2);
      /*
        失败那条必须**另有说法**：拿"…已…"那套词去画失败，会画出
        「生成已提交 · 失败」这种自己跟自己打架的行（真机上撞到过）。
      */
      expect(phrase.failed.length, `${name} 缺失败那条的说法`).toBeGreaterThan(2);
      expect(phrase.failed).not.toBe(phrase.done);
    }
  });

  it('词表里的名字与工具表**逐个**对得上（漂了就是画了一个不存在的动作）', () => {
    const declared = BUILTIN_TOOLS.map((tool) => tool.function.name).sort();
    expect(Object.keys(BUILTIN_TOOL_PHRASES).sort()).toEqual(declared);
  });

  it('开始那条：单数不写数量，多件事才写', () => {
    expect(builtinToolRunning('add_canvas_nodes', { nodes: [{}, {}, {}] })).toBe('正在编排画布（3 个节点）');
    expect(builtinToolRunning('add_canvas_nodes', { nodes: [{}] })).toBe('正在编排画布');
    expect(builtinToolRunning('connect_canvas_nodes', { edges: [{}, {}] })).toBe('正在连接节点（2 条连线）');
    expect(builtinToolRunning('read_canvas', {})).toBe('正在查找画布');
  });

  /*
    **没登记的 op 才**回落到"正在执行任务（op）"——带上 op 名，比替它编一个中文词诚实。
  */
  it('任务 op 有它自己的说法（不写成笼统的"执行任务"）', () => {
    expect(builtinToolRunning('run_task', { op: 'generate-images' })).toBe('正在生成图片');
    expect(builtinToolRunning('run_task', { op: 'produce' })).toBe('正在合成成片');
    expect(builtinToolDone('run_task', undefined, false, { op: 'produce' })).toBe('成片已合成');
    expect(builtinToolDone('run_task', undefined, true, { op: 'produce' })).toBe('成片没能合成');
  });

  it('没登记的 op 带上 op 名（用户至少知道这一步在跑什么）', () => {
    expect(builtinToolRunning('run_task', { op: '过路的操作' })).toBe('正在执行任务（过路的操作）');
    expect(builtinToolRunning('run_task', {})).toBe('正在执行任务');
  });

  it('op 表里的词与工具白名单一样：只列我们真会跑的', () => {
    for (const [op, phrase] of Object.entries(TASK_OP_PHRASES)) {
      expect(phrase.running.startsWith('正在'), op).toBe(true);
      expect(phrase.failed).not.toBe(phrase.done);
    }
  });

  it('认不出的工具名原样返回（不塞进某一类里替它编一句）', () => {
    expect(builtinToolRunning('gate_approve')).toBe('gate_approve');
    expect(builtinToolDone('gate_approve')).toBe('gate_approve');
  });

  it('没做成的那条不用"已完成"那套词（否则同一行里自相矛盾）', () => {
    expect(builtinToolDone('generate_for_nodes', undefined, true)).toBe('没能生成');
    expect(builtinToolDone('add_canvas_nodes', undefined, true)).toBe('画布节点没能创建');
    /* 但 note 优先：主进程知道真实原因时，用它的说法 */
    expect(builtinToolDone('generate_for_nodes', '待你确认预算', false)).toBe('待你确认预算');
  });
});

describe('动作行 · 完成那条', () => {
  it('有 note 就用 note（真实数量比"编排已完成"有用）', () => {
    expect(builtinToolDone('add_canvas_nodes', '已创建 3 个画布节点')).toBe('已创建 3 个画布节点');
    expect(builtinToolDone('generate_for_nodes', '待你确认预算')).toBe('待你确认预算');
  });

  it('note 是空串或空白时不顶用，回落到词表（免得画出一行空的）', () => {
    expect(builtinToolDone('add_canvas_nodes', '   ')).toBe('画布编排已完成');
    expect(builtinToolDone('read_canvas')).toBe('画布已读取');
  });

  it('note 前后的空白会收掉（主进程拼字符串时容易带上）', () => {
    expect(builtinToolDone('read_canvas', ' 画布已读取（17 个节点 / 0 条连线） '))
      .toBe('画布已读取（17 个节点 / 0 条连线）');
  });
});

/*
  「这次调用到底办成了没有」与「是不是在等人」。

  这两条判错过的后果不一样但都很重：
    · 判成"办成了" → 界面上写「已提交 N 组生成」，而实际一组都没提交（**说假话**）；
    · 把闸门拒绝判成"失败" → 用户去查是不是坏了，而正确答案是"你去点一下批准"。
*/
describe('工具回复 · 办成没办成', () => {
  it('内层 ok 优先：外层只是"送到了"，内层才是"办成了"', () => {
    expect(toolReplyOk({ ok: true, data: { ok: false, body: { error: { code: 'SHOT_FIELDS_REQUIRED' } } } }))
      .toBe(false);
    expect(toolReplyOk({ ok: true, data: { ok: true, data: { 生成结果: [] } } })).toBe(true);
  });

  it('内层没有 ok 字段时看外层（项目对象、列表、命令结果那几路）', () => {
    expect(toolReplyOk({ ok: true, data: [{ id: 'p1' }] })).toBe(true);
    expect(toolReplyOk({ ok: true, data: { revision: 3 } })).toBe(true);
    expect(toolReplyOk({ ok: false, reason: '不在白名单里' })).toBe(false);
  });
});

describe('工具回复 · 错误码的两种形状', () => {
  it('抛出来的那种（闸门拒绝）：码在外层', () => {
    expect(domainErrorCode({ ok: false, domain_error: true, code: 'G1_REQUIRED' })).toBe('G1_REQUIRED');
  });

  it('返回的那种（前置检查没过）：码埋在内层', () => {
    expect(domainErrorCode({ ok: true, data: { ok: false, body: { error: { code: 'SHOT_FIELDS_REQUIRED' } } } }))
      .toBe('SHOT_FIELDS_REQUIRED');
  });

  it('抠不到就是 null（不猜一个码出来）', () => {
    expect(domainErrorCode({ ok: false, reason: '未知的 tool' })).toBeNull();
    expect(domainErrorCode({ ok: true, data: { ok: false, body: {} } })).toBeNull();
  });
});

describe('工具回复 · 在等你的那几个码', () => {
  it('闸门与首帧：只说"等你"，不说"失败"', () => {
    expect(pendingNoteForCode('G1_REQUIRED')).toBe('待你批准 G1 后生成');
    expect(pendingNoteForCode('G2_REQUIRED')).toBe('待你批准 G2 后生成');
    expect(pendingNoteForCode('FIRST_FRAME_REQUIRED')).toBe('待你选定首帧后生成');
  });

  it('别的码一个都不往里塞（那会把它该有的"失败"画成"等你"）', () => {
    for (const code of ['PROMPT_REQUIRED', 'VALIDATION_FAILED', 'SHOT_FIELDS_REQUIRED', 'CANVAS_CANVAS_REQUIRED', 'KERNEL_UNAVAILABLE']) {
      expect(pendingNoteForCode(code)).toBeNull();
    }
    expect(pendingNoteForCode(null)).toBeNull();
  });

  /*
    同一个码还要给出**结构化**的"在等什么"：界面靠它决定那一行点了做什么
    （填预算 / 去批准 / 去选首帧），不靠那句中文去猜。
  */
  it('闸门那个码带着**哪一个闸门**：G1 与 G2 的去处不一样', () => {
    expect(pendingFromDomainCode('G1_REQUIRED', ['n1'])).toEqual({ kind: 'gate', gate: 'G1', nodeIds: ['n1'] });
    expect(pendingFromDomainCode('G2_REQUIRED', ['n1', 'n2'])).toEqual({ kind: 'gate', gate: 'G2', nodeIds: ['n1', 'n2'] });
  });

  it('首帧那个码只说"要去选首帧"（它是人的动作，界面不代做）', () => {
    expect(pendingFromDomainCode('FIRST_FRAME_REQUIRED', ['s1'])).toEqual({ kind: 'first-frame', nodeIds: ['s1'] });
  });

  it('不是那几个码就返回 null，也不带节点', () => {
    expect(pendingFromDomainCode('PROMPT_REQUIRED', ['n1'])).toBeNull();
    expect(pendingFromDomainCode(null)).toBeNull();
    expect(pendingFromDomainCode('G1_REQUIRED')).toEqual({ kind: 'gate', gate: 'G1', nodeIds: [] });
  });
});

/*
  生成这件事的**真实回执**。

  为什么值得单测：生成这条路是阻塞等到出结果的（generateShotImages 里
  `await backend.generateImage` 之后当场把产物读回来入库），所以工具返回时
  东西已经在项目里了。面板上那句「已生成 3 张图片」是用户**唯一能看到的产出凭证**——
  它数错一个数，用户就没法判断这次到底出了什么。
*/
describe('生成回执 · 数产物', () => {
  it('两层套着的形状也认（外层是"送到了"，内层才是结果）', () => {
    const body = {
      ok: true,
      data: { ok: true, data: { generated: [{ reused: false }, { reused: true }], failures: [{}] } },
    };
    expect(generationReceipt(body))
      .toEqual({ generated: 2, failures: 1, reused: 1, notes: [], failureReasons: [] });
  });

  it('平的形状也认（上游哪天不套那层了，不至于读成 0）', () => {
    expect(generationReceipt({ generated: [{}], failures: [] }))
      .toEqual({ generated: 1, failures: 0, reused: 0, notes: [], failureReasons: [] });
  });

  it('读不出来就是 0，不编一个数（宁可少报）', () => {
    expect(generationReceipt({ ok: false, reason: '被闸门拦下了' }))
      .toEqual({ generated: 0, failures: 0, reused: 0, notes: [], failureReasons: [] });
    expect(generationReceipt(null))
      .toEqual({ generated: 0, failures: 0, reused: 0, notes: [], failureReasons: [] });
  });

  /*
    后端自己说的话要跟着回执走到面板上：
    参数被丢掉 / 被改过，或者（测试后端）"我出的是占位图"——都属于
    "用户以为的和实际的不一样"，不能烂在工具结果里只给模型看。
  */
  it('把后端的说明也带出来（参数被调整、产出是占位图）', () => {
    const body = {
      ok: true,
      data: {
        ok: true,
        data: {
          generated: [{ parameter_notes: ['参数「resolution」这个模型不认识，已跳过'] }],
          failures: [],
        },
      },
    };
    expect(generationReceipt(body).notes).toEqual(['参数「resolution」这个模型不认识，已跳过']);
  });
});

describe('生成回执 · 面板上那句话', () => {
  const base = { images: 0, videos: 0, reused: 0, failedShots: 0, skippedNodes: 0, okGroups: 1, waitingNote: null };

  it('说产出，不说"提交了几组"（活已经干完了）', () => {
    expect(generationNote({ ...base, images: 3 })).toBe('已生成 3 张图片');
    expect(generationNote({ ...base, videos: 2 })).toBe('已生成 2 段视频');
    expect(generationNote({ ...base, images: 2, videos: 1 })).toBe('已生成 2 张图片 + 1 段视频');
  });

  it('复用要单独说：那几张**没花钱**，用户有权知道', () => {
    expect(generationNote({ ...base, images: 3, reused: 2 }))
      .toBe('已生成 3 张图片（其中 2 个是复用，没花钱）');
  });

  it('有失败、有被跳过的节点都写清楚（不含糊成一句"已完成"）', () => {
    expect(generationNote({ ...base, images: 2, failedShots: 1, skippedNodes: 1 }))
      .toBe('已生成 2 张图片（1 个镜头失败）（另有 1 个节点没参与）');
  });

  it('一张都没出的时候如实说 0，并把它在等谁说出来', () => {
    expect(generationNote({ ...base, okGroups: 0, waitingNote: '待你确认预算' })).toBe('待你确认预算');
    expect(generationNote({ ...base, okGroups: 0, waitingNote: null })).toBe('一组都没生成');
    expect(generationNote({ ...base, okGroups: 2 })).toBe('已生成 0 张（2 组跑完但没有产物）');
  });

  /*
    "一组跑完但一张没出"**不是完成**，而且必须说清为什么。
    真机上撞到的那次原因是「项目 revision 冲突」——那句话才是能动手的东西；
    只写"0 张（1 组跑完但没有产物）"等于什么都没说。
  */
  it('一个都没出：把**真实原因**写出来，而不是"跑完但没有产物"', () => {
    expect(generationNote({ ...base, okGroups: 1, failureReasons: ['项目 revision 冲突'] }))
      .toBe('没能生成（项目 revision 冲突）');
  });

  it('原因太长就截断', () => {
    const text = generationNote({ ...base, okGroups: 1, failureReasons: ['x'.repeat(200)] });
    expect(text.startsWith('没能生成（')).toBe(true);
    expect(text.length).toBeLessThan(90);
  });

  it('后端有话说就跟在后面（"这是占位图"必须让用户看见）', () => {
    expect(generationNote({ ...base, images: 1, notes: ['这是本地假后端生成的占位图'] }))
      .toBe('已生成 1 张图片（这是本地假后端生成的占位图）');
  });

  it('后端那句话太长就截断，不把一整段塞进那一行', () => {
    const long = 'x'.repeat(200);
    const text = generationNote({ ...base, images: 1, notes: [long] });
    expect(text).toContain('…）');
    expect(text.length).toBeLessThan(120);
  });
});

/*
  生成过程中的心跳（跑完一镜更新一次那一行）。

  为什么必须报：真后端一镜几十秒到几分钟，而这条调用是**阻塞**的——
  没有心跳，界面上从头到尾只有「正在生成（3 个节点）」，用户分不清是在跑还是卡死了。
*/
describe('生成进度 · 那一行字', () => {
  it('报第几镜、共几镜', () => {
    expect(generationProgressText({ done: 1, total: 3 })).toBe('正在生成（1/3 镜）');
    expect(generationProgressText({ done: 3, total: 3 })).toBe('正在生成（3/3 镜）');
  });

  it('只有一镜时不写成"1/1"也说得通，但仍然是同一句话（不特殊化，少一种分支）', () => {
    expect(generationProgressText({ done: 1, total: 1 })).toBe('正在生成（1/1 镜）');
  });

  it('总数为 0（理论上不该发生）时回落到不带数字的说法，不写出"1/0"', () => {
    expect(generationProgressText({ done: 0, total: 0 })).toBe('正在生成');
  });
});
