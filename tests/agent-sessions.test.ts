import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MESSAGE_LIMIT,
  SESSION_LIMIT,
  TITLE_LIMIT,
  deleteSession,
  isValidSessionId,
  listSessions,
  pruneMessages,
  readSession,
  renameSession,
  saveSession,
  sessionsDir,
  sortSessions,
  titleFromMessages,
  type StoredMessage,
} from '../apps/local-api/src/agent/agent-sessions.js';

/* ============================================================
  对话会话库（本地）

  这一组用例的重点不是"能存能读"，而是三条**安全/边界**：
    ① 会话 id 会被拼进文件路径 → 渲染层能传 id 进来，必须过白名单，
       否则 `../../` 就能把工作目录外面的东西删掉；
    ② 会话与消息都要有上限，超了要裁，而且**裁了要留一句话**；
    ③ 坏文件不能让整个列表崩掉。
  ============================================================ */

const tempDirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qiyin-session-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* 清理失败不影响断言 */ }
  }
});

const message = (role: StoredMessage['role'], text: string): StoredMessage =>
  ({ id: `${role}-${text.length}`, role, text });

describe('会话 id 的白名单', () => {
  it('只放行字母数字与连字符', () => {
    expect(isValidSessionId('session-abc123')).toBe(true);
    expect(isValidSessionId('a')).toBe(true);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('../../evil')).toBe(false);
    expect(isValidSessionId('a/b')).toBe(false);
    expect(isValidSessionId('a\\b')).toBe(false);
    expect(isValidSessionId('会话')).toBe(false);
    expect(isValidSessionId('x'.repeat(65))).toBe(false);
    expect(isValidSessionId(123)).toBe(false);
  });

  it('路径穿越的 id 读不出东西、也删不掉东西', () => {
    const dir = workspace();
    const outside = join(dir, 'outside.json');
    writeFileSync(outside, '{"id":"outside","messages":[]}', 'utf8');
    expect(readSession(dir, '../outside')).toBeNull();
    expect(deleteSession(dir, '../outside')).toBe(false);
    /* 外面那个文件还在 */
    expect(readFileSync(outside, 'utf8')).toContain('outside');
  });

  it('保存时给的非法 id 会被换成主进程自己生成的', () => {
    const dir = workspace();
    const saved = saveSession(dir, { id: '../../evil', messages: [message('user', '你好')] });
    expect(isValidSessionId(saved.id)).toBe(true);
    expect(saved.id.startsWith('session-')).toBe(true);
    /* 工作目录里只多了这一个文件 */
    expect(listSessions(dir)).toHaveLength(1);
  });
});

describe('会话的存与读', () => {
  it('存一次就能读回来，标题取第一条用户消息', () => {
    const dir = workspace();
    const saved = saveSession(dir, {
      messages: [
        message('note', '已补入项目上下文'),
        message('user', '把第 3 个分镜改成夜景'),
        message('agent', '好'),
      ],
    });
    expect(saved.title).toBe('把第 3 个分镜改成夜景');
    const back = readSession(dir, saved.id);
    expect(back?.messages.map((item) => item.role)).toEqual(['note', 'user', 'agent']);
  });

  it('再存一次是**更新**同一个会话，不会多出一个', () => {
    const dir = workspace();
    const first = saveSession(dir, { messages: [message('user', '第一句')] });
    const second = saveSession(dir, { id: first.id, messages: [message('user', '第一句'), message('agent', '第二句')] });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(listSessions(dir)).toHaveLength(1);
    expect(readSession(dir, first.id)?.messages).toHaveLength(2);
  });

  it('认不出的角色被丢掉，不让乱数据进库', () => {
    const dir = workspace();
    const saved = saveSession(dir, {
      messages: [
        { id: 'x', role: 'wizard', text: '我是谁' },
        { id: 'y', role: 'user', text: '正常那句' },
      ],
    });
    expect(saved.messages).toHaveLength(1);
    expect(saved.messages[0]?.text).toBe('正常那句');
  });

  /*
    「待确认」那一行上的动作（填预算 / 去批准）跟着消息一起存。
    不存的话，从历史里把这一段读回来时那一行会变成**点不动的**待确认，
    用户只会以为软件坏了。
  */
  it('"在等什么"跟着消息存下来、读回来还在', () => {
    const dir = workspace();
    const saved = saveSession(dir, {
      messages: [{
        id: 'w1', role: 'tool', text: '待你确认预算', itemId: 'call_1',
        toolState: 'pending', waiting: { kind: 'budget', nodeIds: ['agent-1', 'agent-2'] },
      }],
    });
    expect(saved.messages[0]?.waiting).toEqual({ kind: 'budget', nodeIds: ['agent-1', 'agent-2'] });
  });

  it('认不出的"在等什么"整条丢掉（宁可画成普通待确认，也不画一个点不动的按钮）', () => {
    const dir = workspace();
    const saved = saveSession(dir, {
      messages: [{
        id: 'w2', role: 'tool', text: '待你确认', toolState: 'pending',
        waiting: { kind: 'teleport', nodeIds: ['agent-1'] },
      }],
    });
    expect(saved.messages[0]?.waiting).toBeUndefined();
    /* 但这一行本身还在（状态是好的，只是没有动作可点） */
    expect(saved.messages[0]?.text).toBe('待你确认');
  });

  it('坏文件不进列表（一个坏文件不该把整个历史带崩）', () => {
    const dir = workspace();
    saveSession(dir, { messages: [message('user', '好的那个')] });
    mkdirSync(sessionsDir(dir), { recursive: true });
    writeFileSync(join(sessionsDir(dir), 'broken.json'), '{不是 JSON', 'utf8');
    expect(listSessions(dir)).toHaveLength(1);
  });

  it('删除：删得掉返回 true，删不存在的返回 false', () => {
    const dir = workspace();
    const saved = saveSession(dir, { messages: [message('user', '这句')] });
    expect(deleteSession(dir, saved.id)).toBe(true);
    expect(deleteSession(dir, saved.id)).toBe(false);
    expect(listSessions(dir)).toEqual([]);
  });
});

describe('上限与裁剪', () => {
  it('超过条数上限时裁掉最旧的，并在最前面留一句话', () => {
    const many = Array.from({ length: MESSAGE_LIMIT + 5 }, (_value, index) => message('user', `第 ${index} 句`));
    const pruned = pruneMessages(many);
    expect(pruned.messages).toHaveLength(MESSAGE_LIMIT + 1);
    expect(pruned.trimmed).toBe(5);
    expect(pruned.messages[0]?.role).toBe('note');
    expect(pruned.messages[0]?.text).toContain('5 条');
    /* 留下的是最近的 */
    expect(pruned.messages[pruned.messages.length - 1]?.text).toBe(`第 ${MESSAGE_LIMIT + 4} 句`);
  });

  it('没超上限时一个字都不动', () => {
    const few = [message('user', '一'), message('agent', '二')];
    const pruned = pruneMessages(few);
    expect(pruned.messages).toEqual(few);
    expect(pruned.trimmed).toBe(0);
  });

  it('裁剪计数会累计（第二次裁的时候把上一次的也算上）', () => {
    const many = Array.from({ length: MESSAGE_LIMIT + 2 }, (_value, index) => message('user', `x${index}`));
    const pruned = pruneMessages(many, 5);
    expect(pruned.trimmed).toBe(7);
    expect(pruned.messages[0]?.text).toContain('7 条');
  });

  it('长期创作裁剪保留现行方案、批准、选帧和逐镜产物，版本连续递增', () => {
    const dir = workspace();
    const foundation: StoredMessage[] = [
      { id: 'plan-current', role: 'plan', text: '{"kind":"plan"}' },
      { id: 'approval-current', role: 'approval', text: 'plan-current' },
      { id: 'frame-current', role: 'selection', text: '{"shotId":"shot-01","artifactId":"sha256:abc"}' },
      { id: 'image-current', role: 'asset', text: '{"shotId":"shot-01","kind":"image"}' },
      { id: 'video-current', role: 'asset', text: '{"shotId":"shot-01","kind":"video"}' },
    ];
    const old = saveSession(dir, { messages: [...foundation, ...Array.from({ length: 215 }, (_, index) => ({ id: `activity-${index}`, role: 'tool' as const, text: `日志 ${index}` }))] });
    expect(old.messages.length).toBeLessThanOrEqual(MESSAGE_LIMIT + 1);
    for (const anchor of foundation) expect(old.messages.some(item => item.id === anchor.id)).toBe(true);
    const next = saveSession(dir, { id: old.id, messages: [...old.messages, { id: 'latest', role: 'agent', text: '继续创作' }] });
    expect(next.trimmed + next.messages.length).toBe(old.trimmed + old.messages.length + 1);
    for (const anchor of foundation) expect(readSession(dir, next.id)!.messages.some(item => item.id === anchor.id)).toBe(true);
  });

  it('会话数量超过上限时，旧的被清掉', () => {
    const dir = workspace();
    let last = '';
    for (let index = 0; index < SESSION_LIMIT + 3; index += 1) {
      /* updatedAt 递增，保证"旧的"是可判定的 */
      last = saveSession(dir, { messages: [message('user', `会话 ${index}`)] }, 1_000 + index).id;
    }
    const list = listSessions(dir);
    expect(list.length).toBeLessThanOrEqual(SESSION_LIMIT);
    /* 最后写进去的那个一定还在 */
    expect(list.some((item) => item.id === last)).toBe(true);
  });

  it('列表按最近改动排前面', () => {
    const dir = workspace();
    const old = saveSession(dir, { messages: [message('user', '旧的')] }, 1_000);
    const fresh = saveSession(dir, { messages: [message('user', '新的')] }, 9_000);
    expect(listSessions(dir).map((item) => item.id)).toEqual([fresh.id, old.id]);
    expect(sortSessions(listSessions(dir))[0]?.id).toBe(fresh.id);
  });
});

describe('标题', () => {
  it('取第一条用户消息并压掉换行', () => {
    expect(titleFromMessages([message('user', '  把第 3 个\n分镜改成夜景  ')])).toBe('把第 3 个 分镜改成夜景');
  });

  it('没有用户消息就回落', () => {
    expect(titleFromMessages([message('note', '已补入项目上下文')])).toBe('新对话');
  });

  it('过长的标题截到 24 字', () => {
    const long = 'x'.repeat(100);
    expect(titleFromMessages([message('user', long)])).toHaveLength(24);
  });
});

describe('重命名', () => {
  it('改完读回来就是新名字，消息一个字没动', () => {
    const dir = workspace();
    const saved = saveSession(dir, { messages: [message('user', '原来的第一句')] });
    const renamed = renameSession(dir, saved.id, '夜景改光');
    expect(renamed?.title).toBe('夜景改光');
    const back = readSession(dir, saved.id);
    expect(back?.title).toBe('夜景改光');
    expect(back?.messages).toHaveLength(1);
    expect(back?.messages[0]?.text).toBe('原来的第一句');
  });

  it('空标题与全空白一律拒绝（列表里出现一行空白比留着旧名字更难查）', () => {
    const dir = workspace();
    const saved = saveSession(dir, { messages: [message('user', '这句')] });
    expect(renameSession(dir, saved.id, '   ')).toBeNull();
    expect(renameSession(dir, saved.id, '')).toBeNull();
    expect(renameSession(dir, saved.id, 42)).toBeNull();
    expect(readSession(dir, saved.id)?.title).toBe('这句');
  });

  it('换行与连续空格会被压平，过长的截到上限', () => {
    const dir = workspace();
    const saved = saveSession(dir, { messages: [message('user', '这句')] });
    expect(renameSession(dir, saved.id, '  夜景   改光\n第二行 ')?.title).toBe('夜景 改光 第二行');
    expect(renameSession(dir, saved.id, 'x'.repeat(200))?.title).toHaveLength(TITLE_LIMIT);
  });

  it('改一个不存在的会话（或非法 id）返回 null，不会造出一个新文件', () => {
    const dir = workspace();
    expect(renameSession(dir, 'session-not-there', '随便')).toBeNull();
    expect(renameSession(dir, '../evil', '随便')).toBeNull();
    expect(listSessions(dir)).toEqual([]);
  });
});
