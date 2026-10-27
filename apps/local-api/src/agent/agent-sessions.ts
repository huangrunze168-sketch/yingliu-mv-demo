/* ============================================================
  期音科技 · 对话 Agent 的**本地**会话库
  ------------------------------------------------------------
  小QTV 的会话在它自己的服务端（`useCanvasAgentSessionStore` 里有
  `sessions` / `currentSessionId` / `switchSession`，界面上还有一句
  `chatCanvasAgentDeleteFailed`「删除会话失败」）。我们用的是本地 CLI，
  没有那个服务端，所以这里**自己存一份**，存法跟运行留档一致：

      <项目工作目录>/.qiyin-agent/sessions/<会话 id>.json

  为什么存磁盘而不是 localStorage：对话是用户的东西，
  浏览器缓存被清一次就没了。放工作目录里还能跟着项目一起被看到、被备份
  （和 `*.ndjson` 那些原始留档放在同一层）。

  三条硬约束：
    ① **会话 id 必须过白名单**（只允许字母数字与连字符）——它会被拼进文件路径，
       渲染层能传 id 进来，不校验就等于开了一个路径穿越的口子；
    ② 一个项目最多留 30 个会话，单会话最多 200 条消息，超出按"旧的先走"裁掉：
       不裁的话，一个聊了几百轮的项目会把目录堆成几十兆；
    ③ 裁消息时**留下一条说明**（"更早的 N 条已裁掉"），
       而不是让历史无声地短一截——那种"记录对不上"最难查。
  ============================================================ */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 一个项目最多留几个会话 */
export const SESSION_LIMIT = 30;
/** 单个会话最多留几条消息 */
export const MESSAGE_LIMIT = 200;
/** 单条消息入库前的长度上限（超长的回答截断，避免单个文件膨胀） */
const MESSAGE_TEXT_LIMIT = 8000;

/** 会话 id 的白名单：字母、数字、连字符，1–64 位 */
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'agent' | 'tool' | 'reasoning' | 'note' | 'error' | 'plan' | 'approval' | 'progress' | 'asset' | 'selection';
  text: string;
  itemId?: string;
  /** 用户发送消息时选中的 Skill；历史只记不可执行的身份与版本，不复制第三方指令。 */
  skillRef?: { id: string; version: string; name?: string };
  /** `pending` = 在等人（要预算 / 要批准），不是失败——见 data/agentMessages.ts */
  toolState?: 'running' | 'pending' | 'done' | 'failed' | 'unknown';
  /**
   * 在等什么（要填预算 / 要去批准 / 要去选首帧）。
   *
   * 必须存：不存的话，从历史会话里把这一段读回来时，
   * 那一行会变成一个**点不动的**「待确认」——用户以为软件坏了。
   */
  waiting?: { kind: 'budget' | 'gate' | 'first-frame'; nodeIds: string[]; gate?: string };
  count?: number;
}

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
  /** 被裁掉的消息条数（0 表示没裁过） */
  trimmed: number;
}

/** 列表里那一行（不带消息体——列表不需要把每轮对话都读进内存） */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  trimmed: number;
}

export function sessionsDir(workspaceDir: string): string {
  return join(workspaceDir, '.qiyin-agent', 'sessions');
}

/**
 * 收一条渲染层传来的消息。
 *
 * 认不出的角色一律**丢掉**而不是塞成 note：乱角色进库之后，
 * 下次读出来渲染会画出一个谁也不知道是什么的东西。
 */
function sanitizeMessage(value: unknown): StoredMessage | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const role = raw.role;
  if (role !== 'user' && role !== 'agent' && role !== 'tool' && role !== 'reasoning'
    && role !== 'note' && role !== 'error' && role !== 'plan' && role !== 'approval'
    && role !== 'progress' && role !== 'asset' && role !== 'selection') return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `${String(raw.role)}-${Math.random()}`;
  const message: StoredMessage = {
    id: id.slice(0, 120),
    role,
    text: text.slice(0, MESSAGE_TEXT_LIMIT),
  };
  if (typeof raw.itemId === 'string') message.itemId = raw.itemId.slice(0, 120);
  const skillRef = raw.skillRef;
  if (skillRef !== null && typeof skillRef === 'object') {
    const value = skillRef as Record<string, unknown>;
    if (typeof value.id === 'string' && /^[a-z0-9][a-z0-9-]{1,79}$/.test(value.id)
      && typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 80) {
      message.skillRef = { id: value.id, version: value.version, ...(typeof value.name === 'string' ? { name: value.name.slice(0, 120) } : {}) };
    }
  }
  if (raw.toolState === 'running' || raw.toolState === 'pending' || raw.toolState === 'done'
    || raw.toolState === 'failed' || raw.toolState === 'unknown') {
    message.toolState = raw.toolState;
  }
  if (typeof raw.count === 'number' && Number.isFinite(raw.count)) message.count = Math.max(1, Math.floor(raw.count));
  /* 在等什么：kind 认不出就整条丢掉（宁可画成普通待确认，也不画一个点不动的按钮） */
  const waiting = raw.waiting;
  if (waiting !== null && typeof waiting === 'object') {
    const raw2 = waiting as Record<string, unknown>;
    const kind = raw2.kind;
    if (kind === 'budget' || kind === 'gate' || kind === 'first-frame') {
      message.waiting = {
        kind,
        nodeIds: Array.isArray(raw2.nodeIds)
          ? raw2.nodeIds.filter((id): id is string => typeof id === 'string').slice(0, 200)
          : [],
        ...(typeof raw2.gate === 'string' ? { gate: raw2.gate.slice(0, 16) } : {}),
      };
    }
  }
  return message;
}

/**
 * 裁到上限。**裁掉的部分要留一句话**：`trimmed` 计数 + 一条提示消息。
 * 只删不说是最糟的——用户翻历史时会以为 Agent 少说了什么。
 */
export function pruneMessages(messages: readonly StoredMessage[], trimmedBefore = 0): { messages: StoredMessage[]; trimmed: number } {
  if (messages.length <= MESSAGE_LIMIT) return { messages: [...messages], trimmed: trimmedBefore };
  const source = messages.filter(item => !(item.role === 'note' && item.id.startsWith('trimmed-')));
  const lastPlanIndex = source.findLastIndex(item => item.role === 'plan');
  if (lastPlanIndex >= 0 && lastPlanIndex < source.length - MESSAGE_LIMIT) {
    // 长期制作对话不能把仍在使用的方案、审批、选帧与最后的逐镜产物裁掉。
    // 其余消息继续滚动裁剪；领域项目和付费请求台账仍是权威状态。
    const pinned = new Set<number>([lastPlanIndex]);
    const lastPlan = source[lastPlanIndex]!;
    const latest = new Map<string, number>();
    for (let index = lastPlanIndex + 1; index < source.length; index++) {
      const item = source[index]!;
      if (item.role === 'approval' && item.text === lastPlan.id) latest.set('approval', index);
      if (item.role !== 'asset' && item.role !== 'selection' && item.role !== 'progress') continue;
      try {
        const value = JSON.parse(item.text) as { shotId?: unknown; kind?: unknown; phase?: unknown; artifactId?: unknown };
        if (item.role === 'selection' && typeof value.shotId === 'string') latest.set(`selection:${value.shotId}`, index);
        if (item.role === 'asset' && typeof value.shotId === 'string') latest.set(`asset:${value.kind === 'video' ? 'video' : 'image'}:${value.shotId}`, index);
        if (item.role === 'progress' && (value.kind === 'video' || value.kind === 'image') && value.phase !== 'running') latest.set(`progress:${value.kind}`, index);
      } catch { /* 非结构化日志不留作制作事实。 */ }
    }
    for (const index of latest.values()) pinned.add(index);
    const start = Math.max(0, source.length - Math.max(1, MESSAGE_LIMIT - pinned.size));
    const kept = source.filter((_, index) => index >= start || pinned.has(index));
    const totalTrimmed = trimmedBefore + source.length - kept.length;
    return { trimmed: totalTrimmed, messages: [{ id: `trimmed-${Date.now()}`, role: 'note', text: `更早的 ${totalTrimmed} 条消息已裁掉（当前方案与已核验制作状态保留）` }, ...kept] };
  }
  const dropped = messages.length - MESSAGE_LIMIT;
  const kept = messages.slice(dropped);
  const note: StoredMessage = {
    id: `trimmed-${Date.now()}`,
    role: 'note',
    text: `更早的 ${dropped + trimmedBefore} 条消息已裁掉（单会话最多留 ${MESSAGE_LIMIT} 条）`,
  };
  return { messages: [note, ...kept], trimmed: dropped + trimmedBefore };
}

/** 标题：第一条用户消息的前 24 字；没有就用兜底那句 */
export function titleFromMessages(messages: readonly StoredMessage[], fallback = '新对话'): string {
  const first = messages.find((message) => message.role === 'user');
  if (first === undefined || first.text.trim() === '') return fallback;
  const text = first.text.trim().replace(/\s+/g, ' ');
  return text.length > 24 ? text.slice(0, 24) : text;
}

/** 列表排序：最近改动的排前面 */
export function sortSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 读一个会话文件；坏了就当没有（不让一个坏文件把整个列表带崩） */
export function readSession(workspaceDir: string, id: string): StoredSession | null {
  if (!isValidSessionId(id)) return null;
  try {
    const text = readFileSync(join(sessionsDir(workspaceDir), `${id}.json`), 'utf8');
    const parsed = JSON.parse(text) as Partial<StoredSession>;
    if (parsed.id !== id || !Array.isArray(parsed.messages)) return null;
    const messages = parsed.messages
      .map(sanitizeMessage)
      .filter((message): message is StoredMessage => message !== null);
    return {
      id,
      title: typeof parsed.title === 'string' ? parsed.title : titleFromMessages(messages),
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      messages,
      trimmed: typeof parsed.trimmed === 'number' ? parsed.trimmed : 0,
    };
  } catch {
    return null;
  }
}

export function listSessions(workspaceDir: string): SessionSummary[] {
  let names: string[] = [];
  try {
    names = readdirSync(sessionsDir(workspaceDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    const session = readSession(workspaceDir, id);
    if (session === null) continue;
    out.push({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      trimmed: session.trimmed,
    });
  }
  return sortSessions(out);
}

export interface SaveSessionInput {
  id?: string;
  title?: string;
  messages: readonly unknown[];
}

/** 写一个会话；id 缺失或非法时**由这里**生成一个新的（渲染层给的 id 不可信） */
export function saveSession(
  workspaceDir: string,
  input: SaveSessionInput,
  now: number = Date.now(),
): StoredSession {
  const existing = isValidSessionId(input.id) ? readSession(workspaceDir, input.id) : null;
  /*
    这里不能写成 `existing?.id ?? isValidSessionId(...) ? … : …`：
    `??` 比三元优先级高，那样写会被解析成 `(existing?.id ?? 布尔) ? … : …`，
    条件永远为真（`?? ` 的结果是字符串或布尔），于是**任何输入都会用 input.id**，
    路径校验等于白做。所以拆成显式三分支。
  */
  let id: string;
  if (existing !== null) id = existing.id;
  else if (isValidSessionId(input.id)) id = input.id;
  else id = randomId();
  const messages = input.messages
    .map(sanitizeMessage)
    .filter((message): message is StoredMessage => message !== null);
  const pruned = pruneMessages(messages, existing?.trimmed ?? 0);
  const session: StoredSession = {
    id,
    title: typeof input.title === 'string' && input.title.trim() !== ''
      ? input.title.trim().slice(0, 60)
      : titleFromMessages(pruned.messages),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages: pruned.messages,
    trimmed: pruned.trimmed,
  };
  mkdirSync(sessionsDir(workspaceDir), { recursive: true });
  writeFileSync(join(sessionsDir(workspaceDir), `${id}.json`), JSON.stringify(session, null, 2), 'utf8');
  pruneOldSessions(workspaceDir, id);
  return session;
}

/** 只留最近 SESSION_LIMIT 个（刚写的那个永远留着） */
function pruneOldSessions(workspaceDir: string, keepId: string): void {
  const all = listSessions(workspaceDir);
  if (all.length <= SESSION_LIMIT) return;
  for (const session of all.slice(SESSION_LIMIT)) {
    if (session.id === keepId) continue;
    try {
      rmSync(join(sessionsDir(workspaceDir), `${session.id}.json`));
    } catch { /* 删不掉就留着：宁可多留一个，也不要因为清理失败影响这次保存 */ }
  }
}

/** 标题的长度上限（列表一行放得下，也防着有人粘一整段进去） */
export const TITLE_LIMIT = 60;

/**
 * 改会话标题。
 *
 * 为什么单独开一个入口而不是复用 `saveSession`：那条路要连消息一起回写，
 * 而"改个名字"不该触发一次全量写入（消息可能已经被裁过，
 * 回写的其实是内存里那份，容易把磁盘上的和界面上的搞成两份）。
 *
 * 空标题、全是空白的标题一律**拒绝**（返回 null），不落成空名字——
 * 列表里出现一行空白比留着旧名字更难查。
 */
export function renameSession(workspaceDir: string, id: unknown, title: unknown): StoredSession | null {
  if (!isValidSessionId(id)) return null;
  if (typeof title !== 'string') return null;
  const trimmed = title.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return null;
  const session = readSession(workspaceDir, id);
  if (session === null) return null;
  const next: StoredSession = {
    ...session,
    title: trimmed.slice(0, TITLE_LIMIT),
    updatedAt: Date.now(),
  };
  mkdirSync(sessionsDir(workspaceDir), { recursive: true });
  writeFileSync(join(sessionsDir(workspaceDir), `${id}.json`), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function deleteSession(workspaceDir: string, id: unknown): boolean {
  if (!isValidSessionId(id)) return false;
  try {
    const target = join(sessionsDir(workspaceDir), `${id}.json`);
    statSync(target);
    rmSync(target);
    return true;
  } catch {
    return false;
  }
}

/** 会话 id：`session-<时间戳>-<随机>`，只含白名单字符 */
function randomId(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
