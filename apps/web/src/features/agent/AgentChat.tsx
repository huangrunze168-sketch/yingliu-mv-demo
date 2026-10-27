import { useEffect, useRef, useState, type FormEvent } from 'react';
import { requiresAgentConfirmation } from '../../domain/agentActions';
import { agentClient, type AgentMessage, type AgentSessionSummary } from './agentClient';
import { dialogue, latestFailure, toolActivities } from './agentDisplay';
import './agent-chat.css';
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';
const STARTER_PROMPTS = [
  ['分析项目', '分析当前项目，并告诉我最值得先做的下一步。'],
  ['规划分镜', '根据当前项目中的素材，规划一版可执行的短视频分镜。'],
  ['检查素材', '检查当前项目还缺少哪些素材，并按优先级列出。'],
  ['生成建议', '结合当前画布，给出图片或视频生成建议，不要直接消耗额度。'],
] as const;

export function AgentChat({ projectId }: { projectId: string }) {
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [revision, setRevision] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [input, setInput] = useState(() => window.sessionStorage.getItem('qiyin.agent.draft') ?? '');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestVersion = useRef(0);
  const sending = useRef(false);
  const pendingSend = useRef<{ sessionId: string; text: string; messageId: string } | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { window.sessionStorage.removeItem('qiyin.agent.draft'); }, []);

  useEffect(() => {
    const version = ++requestVersion.current;
    setLoading(true);
    setSessionId(null);
    setMessages([]);
    setError('');
    setPolling(false);
    setRunId(null);
    pendingSend.current = null;
    void agentClient.list(projectId).then(async list => {
      if (version !== requestVersion.current) return;
      setSessions(list);
      if (list.length) await openSession(list[0].id, version);
      else setLoading(false);
    }).catch(reason => {
      if (version === requestVersion.current) { setError(errorText(reason)); setLoading(false); }
    });
    return () => { requestVersion.current++; };
  }, [projectId]);

  async function openSession(id: string, version = ++requestVersion.current) {
    if (pendingSend.current?.sessionId !== id) pendingSend.current = null;
    setLoading(true);
    setPolling(false);
    setRunId(null);
    setError('');
    try {
      const session = await agentClient.get(projectId, id);
      if (version !== requestVersion.current) return;
      if (pendingSend.current?.sessionId === id && session.messages.some(message => message.id === pendingSend.current?.messageId)) {
        pendingSend.current = null;
        setInput('');
        setPendingAction(null);
      }
      setSessionId(id);
      setMessages(session.messages);
      setRevision(session.session_revision);
      setCursor(session.session_revision);
      // 快照之后可能新增了超过单页上限的消息；即使 run 已结束，也要拉完全部增量。
      let after = session.session_revision;
      while (version === requestVersion.current) {
        const state = await agentClient.events(projectId, id, after);
        if (version !== requestVersion.current) return;
        if (state.events.length) setMessages(current => {
          const known = new Set(current.map(message => message.id));
          return [...current, ...state.events.filter(message => !known.has(message.id))];
        });
        setCursor(state.next_cursor);
        setRevision(state.session_revision);
        setRunId(state.run_id ?? null);
        if (state.next_cursor >= state.session_revision) {
          setPolling(!state.done);
          break;
        }
        if (state.next_cursor <= after) throw new Error('消息同步中断，请重试连接。');
        after = state.next_cursor;
      }
    } catch (reason) {
      if (version === requestVersion.current) setError(errorText(reason));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!sessionId || !polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let nextCursor = cursor;
    let failures = 0;
    async function poll() {
      try {
        const update = await agentClient.events(projectId, sessionId!, nextCursor);
        if (stopped) return;
        if (update.next_cursor < nextCursor) throw new Error('消息游标回退，请重新连接。');
        if (update.next_cursor === nextCursor && update.session_revision > nextCursor) throw new Error('消息同步中断，请重新连接。');
        failures = 0;
        setError('');
        nextCursor = update.next_cursor;
        setCursor(nextCursor);
        setRevision(update.session_revision);
        setRunId(update.run_id ?? null);
        if (update.events.length) setMessages(current => {
          const known = new Set(current.map(message => message.id));
          return [...current, ...update.events.filter(message => !known.has(message.id))];
        });
        // done 只表示运行结束，不表示事件已经取完：超过 100 条时必须继续翻页。
        if (nextCursor < update.session_revision) timer = setTimeout(poll, 0);
        else if (!update.done) timer = setTimeout(poll, 900);
        else {
          setPolling(false);
          setRunId(null);
          void agentClient.list(projectId).then(setSessions).catch(() => {});
        }
      } catch (reason) {
        if (stopped) return;
        failures++;
        if (failures < 4) timer = setTimeout(poll, Math.min(4000, 500 * 2 ** (failures - 1)));
        else { setError(errorText(reason)); setPolling(false); }
      }
    }
    timer = setTimeout(poll, 100);
    return () => { stopped = true; clearTimeout(timer); };
  }, [projectId, sessionId, polling]);

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, polling]);

  async function retryConnection() {
    if (sessionId) { await openSession(sessionId); return; }
    setLoading(true);
    try {
      const list = await agentClient.list(projectId);
      setSessions(list);
      if (list.length) await openSession(list[0].id);
      else setError('');
    } catch (reason) { setError(errorText(reason)); }
    finally { setLoading(false); }
  }

  async function createSession() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const session = await agentClient.create(projectId);
      setSessions(await agentClient.list(projectId));
      await openSession(session.id);
      setPendingAction(null);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  async function dispatch(text: string) {
    if (sending.current || polling) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      let activeId = sessionId;
      let activeRevision = revision;
      if (!activeId) {
        const created = await agentClient.create(projectId);
        activeId = created.id;
        activeRevision = created.session_revision;
        setSessionId(activeId);
        void agentClient.list(projectId).then(setSessions).catch(() => {});
      }
      // 网络断线可能发生在服务端已收下请求之后：重试必须复用原 message_id。
      const previous = pendingSend.current;
      const messageId = previous?.sessionId === activeId && previous.text === text ? previous.messageId : crypto.randomUUID();
      pendingSend.current = { sessionId: activeId, text, messageId };
      const result = await agentClient.send(projectId, activeId, messageId, text, activeRevision);
      if (result.duplicate) {
        const latest = await agentClient.get(projectId, activeId);
        setMessages(latest.messages);
        setRevision(latest.session_revision);
        setCursor(latest.session_revision);
      } else {
        setMessages(current => current.some(message => message.id === messageId) ? current : [...current, { id: messageId, role: 'user', text }]);
        setRevision(result.session_revision);
        setCursor(result.session_revision);
      }
      pendingSend.current = null;
      setRunId(result.run_id);
      setInput('');
      setPendingAction(null);
      setPolling(true);
    } catch (reason) {
      setError(errorText(reason));
      const pending = pendingSend.current;
      if (pending) {
        try {
          const latest = await agentClient.get(projectId, pending.sessionId);
          setMessages(latest.messages);
          setRevision(latest.session_revision);
          setCursor(latest.session_revision);
          if (latest.messages.some(message => message.id === pending.messageId)) {
            // 响应丢失，但服务端确实已经收下：恢复事件轮询，不让用户再发一遍。
            pendingSend.current = null;
            setInput('');
            setPendingAction(null);
            setError('');
            setPolling(true);
          }
        } catch { /* 服务离线：保留草稿与相同 message_id，等待重试。 */ }
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy || polling || pendingAction) return;
    if (requiresAgentConfirmation(text)) { setPendingAction(text); return; }
    void dispatch(text);
  }

  async function cancelRun() {
    if (!sessionId || !runId) return;
    setBusy(true);
    try {
      await agentClient.cancel(projectId, sessionId, runId);
      setRunId(null);
      // 继续轮询以获取服务端写入的最终状态，不能提前宣布成功。
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  const conversation = dialogue(messages);
  const activities = toolActivities(messages);
  const failure = error || (!polling ? latestFailure(messages) : '');
  const projectLabel = projectId.length > 18 ? `${projectId.slice(0, 8)}…${projectId.slice(-4)}` : projectId;
  const chooseStarter = (prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => composerInputRef.current?.focus());
  };
  return <div className="page agent-page">
    <div className="module-toolbar"><div><p className="eyebrow">Agent 工作台</p><h2>项目助手</h2></div><button className="primary" type="button" disabled={busy || loading} onClick={() => void createSession()}>＋ 新会话</button></div>
    <div className="agent-chat-layout">
      <nav className="agent-session-list panel" aria-label="项目会话">
        <strong>项目会话</strong>
        {sessions.length === 0 && <p>还没有对话。输入问题即可开始。</p>}
        {sessions.map(session => <button type="button" key={session.id} className={session.id === sessionId ? 'active' : ''} aria-current={session.id === sessionId ? 'true' : undefined} disabled={busy} onClick={() => { setPendingAction(null); void openSession(session.id); }}>{session.title}</button>)}
      </nav>
      <div className="agent-panel panel">
        <div className="agent-header"><div className="agent-orb">✳</div><div><b>小Q 助手</b><small title={`项目 ${projectId}`}>项目 {projectLabel} · 本地 Agent CLI</small></div><span className="agent-connection">{loading ? '连接中' : error ? '连接异常' : polling ? '回复中' : '就绪'}</span></div>
        <div className="chat-feed" ref={feedRef} role="log" aria-live="polite" aria-label="Agent 对话记录">
          {conversation.length === 0 && !loading && <div className="agent-empty"><span className="agent-empty-mark">✦</span><div><h3>从当前项目开始创作</h3><p>小Q 可以读取当前项目、分镜和素材。涉及生成、费用或项目修改时，会先向你确认。</p></div><div className="agent-starters" aria-label="推荐问题">{STARTER_PROMPTS.map(([label, prompt]) => <button key={label} type="button" onClick={() => chooseStarter(prompt)}><b>{label}</b><span>{prompt}</span></button>)}</div></div>}
          {conversation.map(message => <div className={`chat-message ${message.role === 'user' ? 'user' : 'agent'}`} key={message.id}><div className="chat-avatar">{message.role === 'user' ? '你' : '小Q'}</div><div><p>{message.text}</p></div></div>)}
          {polling && <p className="agent-progress" role="status">Agent 正在处理… {runId && <button type="button" disabled={busy} onClick={() => void cancelRun()}>停止</button>}</p>}
          {activities.length > 0 && <details className="agent-activity"><summary>任务状态 · {activities.length} 项</summary><ul>{activities.map(item => <li key={item.id}>{item.text}</li>)}</ul></details>}
           {pendingAction && <div className="agent-confirm" role="alertdialog" aria-label="确认高风险动作"><div><b>发送前请确认</b><p>「{pendingAction}」可能调用工具、消耗额度或修改项目。发送后由本地 Agent 处理，不等于已执行成功。</p></div><div className="agent-confirm-actions"><button type="button" onClick={() => setPendingAction(null)}>返回修改</button><button className="primary" type="button" disabled={busy} onClick={() => void dispatch(pendingAction)}>确认发送</button></div></div>}
        </div>
        {failure && <div className="agent-chat-error" role="alert">{failure}<button type="button" onClick={() => void retryConnection()}>{error ? '恢复对话' : '刷新状态'}</button></div>}
        <form className="composer" onSubmit={send}><input ref={composerInputRef} aria-label="发送给 Agent 的消息" value={input} onChange={event => setInput(event.target.value)} placeholder="描述你要完成的工作…" maxLength={8000} disabled={loading || busy || polling} /><button className="primary" type="submit" disabled={loading || busy || polling || !input.trim()}>发送 ↑</button></form>
      </div>
    </div>
  </div>;
}
