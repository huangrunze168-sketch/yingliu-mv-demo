import { useEffect, useRef, useState } from 'react';
import { readSession } from '../auth/session';
import { AgentApiError, agentClient, type AgentEvents, type AgentMessage, type ImageGenerationOptions, type VideoGenerationOptions } from './agentClient';
import type { AgentReference } from '../../ports';
import { missingPlanningReply } from './agentDisplay';

const describeError = (reason: unknown) => reason instanceof Error ? reason.message : 'Agent 服务暂不可用，请稍后重试。';

/** 首屏和画布使用同一服务端项目会话，不生成演示回复。 */
export function useHeroAgentChat(preferredProjectId?: string) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsReview, setNeedsReview] = useState(false);
  const [runState, setRunState] = useState<AgentEvents['run_state']>();
  const sending = useRef(false);
  const pendingSend = useRef<{ sessionId: string; text: string; id: string; skillRef?: { id: string; version: string }; references?: AgentReference[] } | null>(null);
  const pendingGeneration = useRef<{ key: string; id: string } | null>(null);
  const generation = useRef(0);

  async function loadSession(pid: string, sid: string, version = generation.current) {
    const snapshot = await agentClient.get(pid, sid);
    if (version !== generation.current) return;
    setProjectId(pid);
    setSessionId(sid);
    setError('');
    setMessages(snapshot.messages);
    const restoredMessages = [...snapshot.messages];
    setRevision(snapshot.session_revision);
    setCursor(snapshot.session_revision);
    let after = snapshot.session_revision;
    while (version === generation.current) {
      const update = await agentClient.events(pid, sid, after);
      if (version !== generation.current) return;
      if (update.events.length) {
        const ids = new Set(restoredMessages.map(message => message.id));
        restoredMessages.push(...update.events.filter(message => !ids.has(message.id)));
        setMessages([...restoredMessages]);
      }
      setRevision(update.session_revision);
      setCursor(update.next_cursor);
      setRunId(update.run_id ?? null);
      setNeedsReview(update.needs_review === true);
      setRunState(update.run_state);
      if (update.next_cursor >= update.session_revision) {
        setRunning(!update.done);
        if (update.done && missingPlanningReply(restoredMessages)) {
          setError('上轮规划没有收到核实后的答复，服务可能中断。结果和服务商计费状态未知；请先核对服务商记录，再决定是否重试。');
        }
        break;
      }
      if (update.next_cursor <= after) throw new Error('消息同步中断，请恢复对话。');
      after = update.next_cursor;
    }
  }

  useEffect(() => {
    if (!readSession()) return;
    const version = ++generation.current;
    void (async () => {
      try {
        const pid = preferredProjectId ?? await agentClient.homeProject();
        if (version !== generation.current || !pid) return;
        const sessions = await agentClient.list(pid);
        if (sessions.length) await loadSession(pid, sessions[0].id, version);
        else if (version === generation.current) setProjectId(null);
      } catch (reason) { if (version === generation.current) setError(describeError(reason)); }
    })();
    return () => { generation.current++; };
  }, [preferredProjectId]);

  useEffect(() => {
    if (!running || !projectId || !sessionId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let after = cursor;
    let failures = 0;
    async function poll() {
      try {
        const update = await agentClient.events(projectId!, sessionId!, after);
        if (stopped) return;
        if (update.next_cursor < after || (update.next_cursor === after && update.session_revision > after)) throw new Error('消息同步中断，请恢复对话。');
        failures = 0;
        setError('');
        after = update.next_cursor;
        setCursor(after);
        setRevision(update.session_revision);
        setRunId(update.run_id ?? null);
        setNeedsReview(update.needs_review === true);
        setRunState(update.run_state);
        if (update.events.length) setMessages(current => {
          const ids = new Set(current.map(message => message.id));
          return [...current, ...update.events.filter(message => !ids.has(message.id))];
        });
        if (after < update.session_revision) timer = setTimeout(poll, 0);
        else if (!update.done) timer = setTimeout(poll, 900);
        else { setRunning(false); setRunId(null); }
      } catch (reason) {
        if (stopped) return;
        failures++;
        if (failures < 4) timer = setTimeout(poll, 500 * 2 ** (failures - 1));
        else { setError(describeError(reason)); setRunning(false); }
      }
    }
    timer = setTimeout(poll, 100);
    return () => { stopped = true; clearTimeout(timer); };
  }, [projectId, sessionId, running, cursor]);

  async function send(text: string, skillRef?: { id: string; version: string }, references?: AgentReference[], model?: string): Promise<boolean> {
    if (!readSession() || sending.current || running || needsReview || !text.trim()) return false;
    sending.current = true;
    generation.current++;
    setBusy(true);
    setError('');
    let activeProjectId = projectId;
    try {
      if (!activeProjectId) {
        activeProjectId = await agentClient.homeProject(true);
        if (!activeProjectId) throw new Error('无法创建 Agent 项目。');
        setProjectId(activeProjectId);
      }
      const pid = activeProjectId;
      let sid = sessionId;
      let expected = revision;
      if (!sid) {
        const created = await agentClient.create(pid);
        sid = created.id;
        expected = created.session_revision;
        setSessionId(sid);
      }
      const previous = pendingSend.current;
      const sameSkill = previous?.skillRef?.id === skillRef?.id && previous?.skillRef?.version === skillRef?.version;
      const sameReferences = JSON.stringify(previous?.references ?? []) === JSON.stringify(references ?? []);
      const id = previous?.sessionId === sid && previous.text === text && sameSkill && sameReferences ? previous.id : crypto.randomUUID();
      pendingSend.current = { sessionId: sid, text, id, ...(skillRef ? { skillRef } : {}), ...(references?.length ? { references } : {}) };
      const result = await agentClient.send(pid, sid, id, text, expected, 'creative', skillRef, references, model);
      if (result.duplicate) {
        await loadSession(pid, sid);
      } else {
        setMessages(current => current.some(message => message.id === id) ? current : [...current, { id, role: 'user', text, ...(skillRef ? { skillRef } : {}) }]);
        setRevision(result.session_revision);
        setCursor(result.session_revision);
        setRunId(result.run_id);
        setRunState('starting');
        setRunning(true);
      }
      pendingSend.current = null;
      return true;
    } catch (reason) {
      setError(describeError(reason));
      if (pendingSend.current && activeProjectId) {
        try {
          const pending = pendingSend.current;
          const snapshot = await agentClient.get(activeProjectId, pending.sessionId);
          if (snapshot.messages.some(message => message.id === pending.id)) {
            pendingSend.current = null;
            await loadSession(activeProjectId, pending.sessionId);
            return true;
          }
          setMessages(snapshot.messages);
          setRevision(snapshot.session_revision);
          setCursor(snapshot.session_revision);
          if (reason instanceof AgentApiError && (reason.code === 'PREVIOUS_RUN_NEEDS_REVIEW' || reason.code === 'PREVIOUS_RUN_UNVERIFIED')) {
            // 其他标签页或重启后的状态可能晚于本页；读取服务端事实并显示明确确认入口，不重发请求。
            await loadSession(activeProjectId, pending.sessionId);
          }
        } catch { /* 服务未恢复时保留草稿和 message_id。 */ }
      }
      return false;
    } finally { sending.current = false; setBusy(false); }
  }

  async function savePlan(planId: string, plan: unknown): Promise<boolean> {
    if (!projectId || !sessionId || busy || running) return false;
    setBusy(true);
    setError('');
    try {
      const result = await agentClient.savePlan(projectId, sessionId, planId, plan, revision);
      setMessages(current => [...current, result.plan]);
      setRevision(result.session_revision);
      setCursor(result.session_revision);
      return true;
    } catch (reason) { setError(describeError(reason)); return false; }
    finally { setBusy(false); }
  }

  async function approvePlan(planId: string): Promise<boolean> {
    if (!projectId || !sessionId || busy || running) return false;
    setBusy(true);
    setError('');
    try {
      await agentClient.approvePlan(projectId, sessionId, planId, revision);
      await loadSession(projectId, sessionId);
      return true;
    } catch (reason) { setError(describeError(reason)); return false; }
    finally { setBusy(false); }
  }

  async function selectFrame(planId: string, shotId: string, artifactId: string): Promise<boolean> {
    if (!projectId || !sessionId || busy || running) return false;
    setBusy(true); setError('');
    try {
      await agentClient.selectFrame(projectId, sessionId, planId, shotId, artifactId, revision);
      await loadSession(projectId, sessionId);
      return true;
    } catch (reason) { setError(describeError(reason)); return false; }
    finally { setBusy(false); }
  }

  async function generateImages(planId: string, options: ImageGenerationOptions): Promise<boolean> {
    if (!projectId || !sessionId || busy || running) return false;
    const pid = projectId;
    const sid = sessionId;
    const key = `${sid}:${planId}:${JSON.stringify(options)}`;
    const id = pendingGeneration.current?.key === key ? pendingGeneration.current.id : crypto.randomUUID();
    pendingGeneration.current = { key, id };
    setBusy(true);
    setError('');
    try {
      await agentClient.generateImages(pid, sid, planId, id, revision, options);
      pendingGeneration.current = null;
      await loadSession(pid, sid);
      return true;
    } catch (reason) {
      // 响应丢失时先读取会话：若同一 request_id 已登记，不能重新发起付费任务。
      try {
        const snapshot = await agentClient.get(pid, sid);
        if (snapshot.messages.some(message => message.role === 'progress' && message.itemId === id)) {
          pendingGeneration.current = null;
          await loadSession(pid, sid);
          return true;
        }
        setMessages(snapshot.messages);
        setRevision(snapshot.session_revision);
        setCursor(snapshot.session_revision);
      } catch { /* 服务断线时保留本次请求编号，供重试幂等。 */ }
      setError(describeError(reason));
      return false;
    } finally { setBusy(false); }
  }

  async function generateVideos(planId: string, options: VideoGenerationOptions): Promise<boolean> {
    if (!projectId || !sessionId || busy || running) return false;
    const pid = projectId;
    const sid = sessionId;
    const key = `video:${sid}:${planId}:${JSON.stringify(options)}`;
    const id = pendingGeneration.current?.key === key ? pendingGeneration.current.id : crypto.randomUUID();
    pendingGeneration.current = { key, id };
    setBusy(true); setError('');
    try {
      await agentClient.generateVideos(pid, sid, planId, id, revision, options);
      pendingGeneration.current = null;
      await loadSession(pid, sid);
      return true;
    } catch (reason) {
      try {
        const snapshot = await agentClient.get(pid, sid);
        if (snapshot.messages.some(message => message.role === 'progress' && message.itemId === id)) {
          pendingGeneration.current = null;
          await loadSession(pid, sid);
          return true;
        }
        setMessages(snapshot.messages);
        setRevision(snapshot.session_revision);
        setCursor(snapshot.session_revision);
      } catch { /* 未知付费状态时保留同一请求编号，不能直接重新扣费。 */ }
      setError(describeError(reason));
      return false;
    } finally { setBusy(false); }
  }

  async function newSession() {
    if (!readSession() || busy) return;
    setBusy(true);
    setError('');
    try {
      // 一段新创作绑定一张新项目画布，不覆盖旧会话已经确认的镜头事实。
      const pid = await agentClient.createCanvasProject();
      const created = await agentClient.create(pid);
      generation.current++;
      setProjectId(pid);
      setSessionId(created.id);
      setMessages([]);
      setRevision(created.session_revision);
      setCursor(created.session_revision);
      setRunId(null);
      setRunning(false);
      setNeedsReview(false);
      setRunState(undefined);
      pendingSend.current = null;
      pendingGeneration.current = null;
    } catch (reason) { setError(describeError(reason)); }
    finally { setBusy(false); }
  }

  async function acknowledgeUnknown(): Promise<void> {
    if (!projectId || !sessionId || !needsReview || busy) return;
    const lastUser = [...messages].reverse().find(message => message.role === 'user');
    if (!lastUser) return;
    setBusy(true);
    try {
      await agentClient.acknowledgeUnknown(projectId, sessionId, lastUser.id);
      await loadSession(projectId, sessionId);
    } catch (reason) { setError(describeError(reason)); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!projectId || !sessionId || !runId) return;
    try { await agentClient.cancel(projectId, sessionId, runId); setRunId(null); }
    catch (reason) { setError(describeError(reason)); }
  }

  async function reconnect() {
    setError('');
    try {
      const pid = projectId ?? await agentClient.homeProject();
      if (!pid) return;
      const sid = sessionId ?? (await agentClient.list(pid))[0]?.id;
      if (sid) await loadSession(pid, sid);
    } catch (reason) { setError(describeError(reason)); }
  }

  return { projectId, sessionId, messages, busy, running, runId, runState, error, needsReview, acknowledgeUnknown, send, savePlan, approvePlan, selectFrame, generateImages, generateVideos, newSession, cancel, reconnect };
}
