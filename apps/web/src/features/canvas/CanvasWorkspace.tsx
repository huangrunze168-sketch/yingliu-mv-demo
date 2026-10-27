import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  ArrowRight, ChevronDown, ClipboardCopy, Download, FileJson, FolderOpen, History, ImagePlus, ListVideo, Maximize2,
  Minimize2, Paperclip, PanelsTopLeft, Plus, Send, Share2, SlidersHorizontal,
  WandSparkles, X, Zap,
} from 'lucide-react';
import { canvasHref, navigate } from '../../app/router';
import { ports, useAppData } from '../../app/useAppData';
import type { AgentConversation, AgentMessage, AgentReference, Asset, CanvasSummary, ModelSummary } from '../../ports';
import { skillApi, type SkillSummary } from '../skills/skillApi';
import { canvasAgentHandoffKey, parseCanvasAgentHandoff, type CanvasAgentHandoff } from '../agent/canvasAgentHandoff';
import { Canvas } from './Canvas';
import { CanvasHeroAgentPanel } from '../agent/CanvasHeroAgentPanel';

type Utility = 'models' | 'assets' | 'timeline' | 'export' | 'agent';
const utilityLabels: Record<Utility, string> = {
  models: '模型 / API', assets: '素材', timeline: '时间线', export: '导出', agent: '新对话',
};
type AgentPanelSize = { width: number; height: number };
const DEFAULT_AGENT_SIZE: AgentPanelSize = { width: 380, height: 660 };
function clampAgentSize(size: AgentPanelSize): AgentPanelSize {
  return {
    width: Math.round(Math.max(320, Math.min(Math.min(720, window.innerWidth - 28), size.width))),
    height: Math.round(Math.max(420, Math.min(window.innerHeight - 80, size.height))),
  };
}
function readAgentSize(projectId: string): AgentPanelSize {
  try {
    const value = JSON.parse(window.localStorage.getItem(`qiyin.agent-panel-size.${projectId}`) ?? 'null') as Partial<AgentPanelSize> | null;
    return clampAgentSize({ width: Number(value?.width) || DEFAULT_AGENT_SIZE.width, height: Number(value?.height) || DEFAULT_AGENT_SIZE.height });
  } catch { return clampAgentSize(DEFAULT_AGENT_SIZE); }
}
function conversationSkill(messages: AgentMessage[]) {
  const skill = messages.slice().reverse().find(message => message.role === 'user' && message.skillRef)?.skillRef;
  return skill ? { id: skill.id, version: skill.version, name: skill.name || skill.id } : null;
}
type AgentStarter = {
  icon: typeof WandSparkles;
  label: string;
  kind: 'skill' | 'original' | 'adapt' | 'storyboard';
  prompt: string;
};
const agentStarters: AgentStarter[] = [
  { icon: WandSparkles, kind: 'skill', label: '选择 Skill 开始创作', prompt: '' },
  {
    icon: PanelsTopLeft,
    kind: 'original',
    label: '构思原创剧本方向',
    prompt: '请基于我的创作想法构思原创剧本方向。先给出 3 个差异明确的方向，每个包含一句话梗概、核心人物、主要冲突、类型气质和适合的视觉方向；我选定后再展开三幕结构和分镜。',
  },
  {
    icon: Paperclip,
    kind: 'adapt',
    label: '为现有故事提出改编建议',
    prompt: '请读取当前画布中引用的故事、分镜和素材，提出可执行的改编建议。请分别说明保留内容、需要压缩或重排的内容、人物与冲突的改写方向，并给出一版改编后的结构大纲；不要直接覆盖原内容。',
  },
  {
    icon: ImagePlus,
    kind: 'storyboard',
    label: '整理分镜脚本草案',
    prompt: '请把当前画布中的故事整理成一版可编辑的分镜脚本草案。按镜头编号输出时长、景别、画面动作、人物表演、镜头运动、声音和生成提示，并标记需要我确认的设定；先整理方案，不要声称已经生成素材。',
  },
];

export function CanvasWorkspace({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [workspaceName, setWorkspaceName] = useState('当前工作区');
  const [saveState, setSaveState] = useState('正在载入…');
  const [credits, setCredits] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [canvasName, setCanvasName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [utility, setUtility] = useState<Utility | null>('agent');
  const [useHeroPanel, setUseHeroPanel] = useState(() => window.localStorage.getItem('qiyin.hero.agent.project') === projectId && !window.sessionStorage.getItem(canvasAgentHandoffKey(projectId)));
  useEffect(() => { setUseHeroPanel(window.localStorage.getItem('qiyin.hero.agent.project') === projectId && !window.sessionStorage.getItem(canvasAgentHandoffKey(projectId))); }, [projectId]);
  const [agentDraft, setAgentDraft] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentHistoryBusy, setAgentHistoryBusy] = useState(false);
  const [agentHistoryOpen, setAgentHistoryOpen] = useState(false);
  const [agentConversations, setAgentConversations] = useState<AgentConversation[]>([]);
  const [agentConversationId, setAgentConversationId] = useState<string | null>(null);
  const activeConversationRef = useRef<string | null>(null);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [skillPickerBusy, setSkillPickerBusy] = useState(false);
  const [skillChoices, setSkillChoices] = useState<SkillSummary[]>([]);
  const [selectedAgentSkill, setSelectedAgentSkill] = useState<{ id: string; version: string; name: string } | null>(null);
  const [agentTextModels, setAgentTextModels] = useState<ModelSummary[]>([]);
  const [selectedAgentModel, setSelectedAgentModel] = useState('');
  const [agentError, setAgentError] = useState('');
  const sendingAgent = useRef(false);
  const [agentThread, setAgentThread] = useState<AgentMessage[]>([]);
  const [agentReferences, setAgentReferences] = useState<AgentReference[]>([]);
  const [canvasNodeReferences, setCanvasNodeReferences] = useState<AgentReference[]>([]);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const agentCancelRequested = useRef(false);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const [agentExpanded, setAgentExpanded] = useState(false);
  const [agentSize, setAgentSize] = useState<AgentPanelSize>(() => readAgentSize(projectId));
  const [nodeMenuRequest, setNodeMenuRequest] = useState(0);
  const updateCanvasNodeReferences = useCallback((nodes: Array<{ id: string; label: string }>) => setCanvasNodeReferences(nodes.map(node => ({ id: node.id, kind: 'node', label: node.label }))), []);
  const data = useAppData(projectId);
  const current = data.project ?? canvases.find(canvas => canvas.id === projectId);
  const selectableCanvases = current && !canvases.some(canvas => canvas.id === current.id) ? [current, ...canvases] : canvases;
  const mentionQuery = agentDraft.match(/(?:^|\s)@([^\s@]*)$/)?.[1]?.toLocaleLowerCase('zh-CN');
  const agentSuggestions: AgentReference[] = mentionQuery === undefined ? [] : [
    ...data.assets.map(asset => ({ id: asset.id, kind: 'asset' as const, label: asset.name })),
    ...data.shots.map(shot => ({ id: shot.id, kind: 'shot' as const, label: shot.title })),
    ...canvasNodeReferences,
  ].filter(reference => !agentReferences.some(selected => selected.kind === reference.kind && selected.id === reference.id) && (!mentionQuery || reference.label.toLocaleLowerCase('zh-CN').includes(mentionQuery))).slice(0, 8);
  useEffect(() => { let active = true; void ports.models.search('text').then(models => { if (active) setAgentTextModels(models); }).catch(() => { if (active) setAgentTextModels([]); }); return () => { active = false; }; }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([ports.canvases.list(workspaceId), ports.workspaces.get(workspaceId), ports.account.get().catch(() => null)]).then(([nextCanvases, workspace, account]) => {
      if (!active) return;
      setCanvases(nextCanvases);
      setWorkspaceName(workspace?.name ?? '当前工作区');
      setCredits(account?.quotaCredits ?? null);
    });
    return () => { active = false; };
  }, [workspaceId]);
  useEffect(() => { setAgentSize(readAgentSize(projectId)); }, [projectId]);
  useEffect(() => {
    const onResize = () => setAgentSize(currentSize => clampAgentSize(currentSize));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const openCreate = () => {
    setCanvasName(`未命名画布 ${canvases.length + 1}`);
    setCreating(true);
  };
  const createCanvas = async (event: FormEvent) => {
    event.preventDefault();
    if (!canvasName.trim() || createBusy) return;
    setCreateBusy(true);
    try {
      const canvas = await ports.canvases.create({ workspaceId, name: canvasName.trim(), description: '', rightsConfirmed: false, maxBudgetCents: 0 });
      setCanvases(items => [...items, canvas]);
      setCreating(false);
      navigate(canvasHref(workspaceId, canvas.id));
    } finally { setCreateBusy(false); }
  };
  const toggleUtility = (next: Utility) => {
    if (next === 'agent') setAgentCollapsed(false);
    setUtility(currentUtility => currentUtility === next ? null : next);
  };
  const copyCanvasLink = async () => {
    const copied = await copyText(window.location.href);
    setSaveState(copied ? '画布链接已复制' : '复制失败，请手动复制地址');
  };
  const projectManifest = () => ({
    schema: 'xiaoqtv.project-manifest.v1',
    exportedAt: new Date().toISOString(),
    workspace: { id: workspaceId, name: workspaceName },
    canvas: current ?? { id: projectId, name: '画布 1' },
    shots: data.shots,
    assets: data.assets,
    sources: data.sources,
    jobs: data.jobs,
  });
  const downloadProjectManifest = () => {
    const blob = new Blob([JSON.stringify(projectManifest(), null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(current?.name ?? 'xiaoqtv-canvas').replace(/[\\/:*?"<>|]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setSaveState('项目清单已导出');
  };
  const copyProjectSummary = async () => {
    const summary = `${current?.name ?? '画布 1'}\n分镜：${data.shots.length}\n素材：${data.assets.length}\n参考：${data.sources.length}\n生成任务：${data.jobs.length}`;
    const copied = await copyText(summary);
    setSaveState(copied ? '项目摘要已复制' : '复制失败，请手动选择内容');
  };
  const activateConversation = (id: string) => {
    activeConversationRef.current = id;
    setAgentConversationId(id);
    try { sessionStorage.setItem(`qiyin.agent.active.${projectId}`, id); } catch { /* 本次页面内仍可继续会话 */ }
  };
  useEffect(() => {
    if (sessionStorage.getItem(canvasAgentHandoffKey(projectId))) return;
    let active = true;
    activeConversationRef.current = null;
    setAgentConversationId(null);
    setAgentThread([]);
    void ports.agent.listConversations(projectId).then(async conversations => {
      if (!active) return;
      setAgentConversations(conversations);
      const preferred = sessionStorage.getItem(`qiyin.agent.active.${projectId}`);
      const id = conversations.find(item => item.id === preferred)?.id ?? conversations[0]?.id;
      if (!id) return;
      const messages = await ports.agent.listMessages(projectId, id);
      if (!active || activeConversationRef.current) return;
      activateConversation(id);
      setAgentThread(messages);
      setSelectedAgentSkill(conversationSkill(messages));
    }).catch(error => { if (active) setAgentError(error instanceof Error ? error.message : '读取对话失败'); });
    return () => { active = false; };
  }, [projectId]);
  const startNewAgentThread = async () => {
    if (agentBusy || agentHistoryBusy) return;
    setAgentHistoryBusy(true);
    try {
      const id = await ports.agent.createConversation(projectId);
      activateConversation(id);
      setAgentConversations(current => [{ id, title: '新对话', updatedAt: Date.now(), messageCount: 0 }, ...current]);
      setAgentThread([]); setAgentDraft(''); setAgentReferences([]); setSelectedAgentSkill(null);
      setAgentError(''); setAgentHistoryOpen(false); setAgentCollapsed(false);
    } catch (error) { setAgentError(error instanceof Error ? error.message : '无法新建对话'); }
    finally { setAgentHistoryBusy(false); }
  };
  const loadAgentHistory = async () => {
    if (agentBusy || agentHistoryBusy) return;
    if (agentHistoryOpen) { setAgentHistoryOpen(false); return; }
    setAgentHistoryBusy(true);
    try { setAgentConversations(await ports.agent.listConversations(projectId)); setAgentHistoryOpen(true); setAgentError(''); }
    catch (error) { setAgentError(error instanceof Error ? error.message : '读取历史对话失败'); }
    finally { setAgentHistoryBusy(false); }
  };
  const openAgentConversation = async (id: string) => {
    if (agentBusy || agentHistoryBusy) return;
    setAgentHistoryBusy(true);
    try { const messages = await ports.agent.listMessages(projectId, id); activateConversation(id); setAgentThread(messages); setAgentHistoryOpen(false); setAgentError(''); setSelectedAgentSkill(conversationSkill(messages)); }
    catch (error) { setAgentError(error instanceof Error ? error.message : '打开历史对话失败'); }
    finally { setAgentHistoryBusy(false); }
  };
  const openSkillPicker = async () => {
    if (skillPickerOpen) { setSkillPickerOpen(false); return; }
    setSkillPickerBusy(true);
    try {
      // LibTV 的入口写的是“选择已安装 Skill”，不是“选择我从 GitHub 导入的 Skill”。
      // 目录接口分页返回，必须把内置目录与 GitHub 导入项合并后再过滤 installed。
      const installed: SkillSummary[] = [];
      let cursor: string | null = null;
      do {
        const result = await skillApi.list({ tab: 'skill', limit: 50, cursor });
        installed.push(...result.items.filter(item => item.installed));
        cursor = result.nextCursor;
      } while (cursor && installed.length < 500);
      setSkillChoices(installed);
      setSkillPickerOpen(true); setComposerMenuOpen(false); setAgentError('');
    }
    catch (error) { setAgentError(error instanceof Error ? error.message : '读取已安装 Skill 失败'); }
    finally { setSkillPickerBusy(false); }
  };
  const selectAgentReference = (reference: AgentReference) => {
    setAgentReferences(currentReferences => [...currentReferences, reference]);
    setAgentDraft(currentDraft => currentDraft.replace(/(?:^|\s)@[^\s@]*$/, currentDraft.trimStart() === currentDraft ? '' : ' ').trimStart());
  };
  const sendAgent = async (handoff?: CanvasAgentHandoff) => {
    const content = handoff?.text ?? (agentDraft.trim() || (agentReferences.length ? '请结合我引用的项目内容给出建议。' : ''));
    if (!content || agentBusy || sendingAgent.current) return;
    sendingAgent.current = true;
    const references = handoff ? (handoff.references ?? []) : agentReferences;
    const skill = handoff?.skill ?? selectedAgentSkill;
    const skillLabel = skill ? `\n已启用 Skill：${skill.name} · v${skill.version}` : '';
    const displayContent = `${content}${references.length ? `\n引用：${references.map(reference => `@${reference.label}`).join('、')}` : ''}${skillLabel}`;
    setAgentBusy(true); setAgentRunId(null); setAgentError(''); agentCancelRequested.current = false;
    let submitted = false;
    const streamingId = `stream-${crypto.randomUUID()}`; let streamed = '';
    try {
      const conversationId = activeConversationRef.current ?? await ports.agent.createConversation(projectId);
      if (!activeConversationRef.current) activateConversation(conversationId);
      if (handoff?.skill) setSelectedAgentSkill(handoff.skill);
      const userMessage: AgentMessage = { id: `local-${crypto.randomUUID()}`, role: 'user', content: displayContent, createdAt: new Date().toISOString(), ...(skill ? { skillRef: { id: skill.id, version: skill.version, name: skill.name } } : {}) };
      setAgentThread(messages => [...messages, userMessage]);
      setAgentDraft(''); setAgentReferences([]); submitted = true;
      const skillRef = skill ? { id: skill.id, version: skill.version } : undefined;
      const reply = await ports.agent.send(projectId, content, { conversationId, references, ...(skillRef ? { skillRef } : {}), ...(selectedAgentModel ? { model: selectedAgentModel } : {}), onStarted: setAgentRunId, onDelta: delta => { if (agentCancelRequested.current) return; streamed = streamed ? `${streamed}\n\n${delta.content}` : delta.content; const streaming: AgentMessage = { id: streamingId, role: 'agent', content: streamed, createdAt: delta.createdAt }; setAgentThread(messages => { const index = messages.findIndex(message => message.id === streamingId); return index < 0 ? [...messages, streaming] : messages.map(message => message.id === streamingId ? streaming : message); }); } });
      if (!agentCancelRequested.current && reply.role === 'agent') setAgentThread(messages => [...messages.filter(message => message.id !== streamingId), reply]);
    } catch (error) {
      if (submitted && !agentCancelRequested.current) setAgentThread(messages => [...messages, { id: `error-${crypto.randomUUID()}`, role: 'agent', content: error instanceof Error ? error.message : '暂时无法响应，请稍后重试。', createdAt: new Date().toISOString() }]);
      else if (!submitted) setAgentError(error instanceof Error ? error.message : '无法创建项目对话，消息未发送');
    } finally { sendingAgent.current = false; setAgentBusy(false); setAgentRunId(null); }
  };
  /** 空状态的三个工作流入口：先把真实任务模板放进输入框，必要时自动带上当前画布上下文，仍由用户确认后发送。 */
  const activateStarter = (starter: AgentStarter) => {
    if (starter.kind === 'skill') { void openSkillPicker(); return; }
    setAgentError('');
    setAgentDraft(starter.prompt);
    if (starter.kind === 'adapt' || starter.kind === 'storyboard') {
      const currentReferences: AgentReference[] = [
        ...data.assets.map(asset => ({ id: asset.id, kind: 'asset' as const, label: asset.name })),
        ...data.shots.map(shot => ({ id: shot.id, kind: 'shot' as const, label: shot.title })),
      ];
      setAgentReferences(previous => [...previous, ...currentReferences.filter(reference => !previous.some(item => item.kind === reference.kind && item.id === reference.id))].slice(0, 20));
    }
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[name="agent-prompt"]')?.focus());
  };
  useEffect(() => {
    const key = canvasAgentHandoffKey(projectId);
    const handoff = parseCanvasAgentHandoff(sessionStorage.getItem(key));
    sessionStorage.removeItem(key);
    if (!handoff) return;
    setUtility('agent');
    setAgentCollapsed(false);
    setAgentExpanded(false);
    void sendAgent(handoff);
  }, [projectId]);

  const cancelAgent = async () => {
    if (!agentRunId) return;
    agentCancelRequested.current = true;
    try { await ports.agent.cancel(projectId, agentRunId, activeConversationRef.current ?? undefined); setAgentThread(messages => [...messages, { id: `cancel-${crypto.randomUUID()}`, role: 'agent', content: '本轮 Agent 已取消。', createdAt: new Date().toISOString() }]); }
    catch (error) { agentCancelRequested.current = false; setAgentThread(messages => [...messages, { id: `cancel-error-${crypto.randomUUID()}`, role: 'agent', content: error instanceof Error ? error.message : '取消失败', createdAt: new Date().toISOString() }]); }
    finally { setAgentBusy(false); setAgentRunId(null); }
  };
  const persistAgentSize = (next: AgentPanelSize) => {
    const clamped = clampAgentSize(next);
    setAgentSize(clamped);
    try { window.localStorage.setItem(`qiyin.agent-panel-size.${projectId}`, JSON.stringify(clamped)); } catch { setSaveState('助手尺寸仅在本次会话生效'); }
  };
  const beginAgentResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (agentCollapsed || agentExpanded) return;
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY, ...agentSize };
    let latest = agentSize;
    const onMove = (moveEvent: PointerEvent) => {
      latest = clampAgentSize({ width: origin.width + origin.x - moveEvent.clientX, height: origin.height + origin.y - moveEvent.clientY });
      setAgentSize(latest);
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.userSelect = '';
      persistAgentSize(latest);
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  };
  const resizeAgentWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 40 : 16;
    const delta = { ArrowLeft: { width: step, height: 0 }, ArrowRight: { width: -step, height: 0 }, ArrowUp: { width: 0, height: step }, ArrowDown: { width: 0, height: -step } }[event.key];
    if (!delta) return;
    event.preventDefault();
    persistAgentSize({ width: agentSize.width + delta.width, height: agentSize.height + delta.height });
  };
  const agentPanelStyle: CSSProperties | undefined = utility === 'agent' && !agentCollapsed && !agentExpanded ? { width: agentSize.width, height: agentSize.height } : undefined;
  const canvasMainStyle = utility === 'agent' && !agentCollapsed && !agentExpanded ? { '--agent-inset': `${agentSize.width + 24}px` } as CSSProperties : undefined;

  return (
    <div className="libtv-canvas-page">
      <header className="libtv-canvas-header">
        <div className="libtv-canvas-identity">
          <button className="libtv-workspace-mark" type="button" aria-label="返回小QTV工作区" data-tooltip="返回小QTV工作区" onClick={() => navigate('/workbench')}><span className="qtv-brand-glyph" aria-hidden="true" /></button>
          <button className="libtv-workspace-name" type="button" onClick={() => navigate('/workbench')}>{workspaceName}</button>
          <label className="libtv-project-select-wrap">
            <select aria-label="切换画布" value={projectId} onChange={event => navigate(canvasHref(workspaceId, event.target.value))}>
              {selectableCanvases.length ? selectableCanvases.map(canvas => <option key={canvas.id} value={canvas.id}>{canvas.name}</option>) : <option value={projectId}>画布 1</option>}
            </select>
            <ChevronDown size={13} aria-hidden="true" />
          </label>
          <button className="libtv-header-icon qtv-add-node-trigger" type="button" aria-label="添加节点" data-tooltip="添加节点 · N" onClick={() => setNodeMenuRequest(value => value + 1)}><WandSparkles size={15} /></button>
          <button className="libtv-header-icon" type="button" aria-label="新建画布" data-tooltip="新建画布" onClick={openCreate}><Plus size={15} /></button>
          <button className={`libtv-header-icon${utility === 'models' ? ' active' : ''}`} type="button" aria-label="模型与 API" data-tooltip="模型 / API" onClick={() => toggleUtility('models')}><SlidersHorizontal size={15} /></button>
          <button className={`libtv-header-icon${utility === 'assets' ? ' active' : ''}`} type="button" aria-label="素材" data-tooltip="素材" onClick={() => toggleUtility('assets')}><PanelsTopLeft size={15} /></button>
          <div className={`libtv-save-state${saveState.includes('正在') ? ' is-saving' : ''}${saveState.includes('失败') ? ' is-error' : ''}`} role="status" aria-live="polite"><i /><span>{saveState}</span></div>
        </div>
        <nav className="libtv-canvas-actions" aria-label="画布与账户工具">
          <button type="button" aria-label="时间线" data-tooltip="时间线" className={utility === 'timeline' ? 'active' : ''} onClick={() => toggleUtility('timeline')}><ListVideo size={15} /></button>
          <button type="button" aria-label="分享画布" data-tooltip="复制画布链接" onClick={() => void copyCanvasLink()}><Share2 size={15} /></button>
          <button type="button" aria-label="导出" data-tooltip="导出" className={utility === 'export' ? 'active' : ''} onClick={() => toggleUtility('export')}><Download size={15} /></button>
          <span className="libtv-credit-pill" aria-label={credits === null ? '额度载入中' : `剩余额度 ${credits}`}><Zap size={13} aria-hidden="true" />{credits === null ? '—' : new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(credits)}</span>
          <button type="button" aria-label="小Q创作助手" data-tooltip="小Q创作助手" className={`libtv-agent-trigger${utility === 'agent' ? ' active' : ''}`} onClick={() => toggleUtility('agent')}><span className="qtv-brand-glyph is-small" aria-hidden="true" /></button>
        </nav>
      </header>

      <main className="libtv-canvas-main" style={canvasMainStyle}>
        <Canvas projectId={projectId} onSaveStateChange={setSaveState} onNodeCatalogChange={updateCanvasNodeReferences} openInsertSignal={nodeMenuRequest} />
        {utility ? <aside className={`libtv-utility-panel is-${utility}${utility === 'agent' && agentCollapsed ? ' is-collapsed' : ''}${utility === 'agent' && agentExpanded ? ' is-expanded' : ''}`} aria-label={utility === 'agent' ? 'Agent' : utilityLabels[utility]} style={agentPanelStyle}>
          {utility === 'agent' && !agentCollapsed && !agentExpanded ? <button type="button" className="libtv-agent-resizer" aria-label={`调整小Q助手窗口大小，当前 ${agentSize.width} × ${agentSize.height}`} title="拖动调整大小；方向键微调；双击恢复默认" onPointerDown={beginAgentResize} onKeyDown={resizeAgentWithKeyboard} onDoubleClick={() => persistAgentSize(DEFAULT_AGENT_SIZE)} /> : null}
          <div className="libtv-utility-head"><div><small>{utility === 'agent' ? '小Q COPILOT' : current?.name ?? '当前画布'}</small><h2>{utilityLabels[utility]}</h2></div>{utility === 'agent' ? <div className="libtv-agent-head-actions">{!useHeroPanel ? <><button type="button" aria-label="新对话" title="新对话" disabled={agentBusy || agentHistoryBusy} onClick={() => void startNewAgentThread()}><Plus size={15} /></button><button type="button" aria-label="读取历史对话" title="历史对话" disabled={agentBusy || agentHistoryBusy} onClick={() => void loadAgentHistory()}><History size={14} /></button>{agentHistoryOpen ? <div className="libtv-agent-history-menu" role="menu" aria-label="历史对话">{agentConversations.length ? agentConversations.map(conversation => <button type="button" role="menuitem" key={conversation.id} aria-current={agentConversationId === conversation.id ? 'page' : undefined} onClick={() => void openAgentConversation(conversation.id)}>{conversation.title || '未命名对话'} · {conversation.messageCount} 条</button>) : <p>暂无历史对话</p>}</div> : null}</> : null}<button type="button" aria-label={agentExpanded ? '恢复助手窗口' : '放大小Q助手'} title={agentExpanded ? '恢复窗口' : '放大窗口'} onClick={() => { setAgentExpanded(value => !value); setAgentCollapsed(false); }}><Maximize2 size={14} /></button><button type="button" aria-label={agentCollapsed ? '展开小Q助手' : '折叠小Q助手'} title={agentCollapsed ? '展开' : '折叠'} onClick={() => setAgentCollapsed(value => !value)}><Minimize2 size={15} /></button><button type="button" aria-label="关闭小Q助手" title="关闭" onClick={() => setUtility(null)}><X size={16} /></button></div> : <button type="button" aria-label={`关闭${utilityLabels[utility]}`} onClick={() => setUtility(null)}><X size={16} /></button>}</div>
          {!agentCollapsed || utility !== 'agent' ? utility === 'agent' && useHeroPanel ? <CanvasHeroAgentPanel key={projectId} projectId={projectId} /> : <UtilityContent utility={utility} projectId={projectId} data={data} agentDraft={agentDraft} agentBusy={agentBusy} agentThread={agentThread} agentReferences={agentReferences} agentSuggestions={agentSuggestions} agentRunId={agentRunId} agentError={agentError} selectedSkill={selectedAgentSkill} selectedModel={selectedAgentModel} textModels={agentTextModels} skillChoices={skillChoices} skillPickerOpen={skillPickerOpen} skillPickerBusy={skillPickerBusy} composerMenuOpen={composerMenuOpen} onModelChange={setSelectedAgentModel} onOpenSkillPicker={() => void openSkillPicker()} onSelectSkill={skill => { setSelectedAgentSkill({ id: skill.id, version: skill.version, name: skill.name }); setSkillPickerOpen(false); }} onClearSkill={() => setSelectedAgentSkill(null)} onToggleComposerMenu={() => setComposerMenuOpen(open => !open)} onAddProjectReference={() => { setAgentDraft(value => `${value}${value && !value.endsWith(' ') ? ' ' : ''}@`); setComposerMenuOpen(false); }} onStarter={activateStarter} onAgentDraftChange={setAgentDraft} onAgentReferenceSelect={selectAgentReference} onAgentReferenceRemove={(reference) => setAgentReferences(currentReferences => currentReferences.filter(item => item !== reference))} onAgentSend={() => void sendAgent()} onAgentCancel={cancelAgent} onExportManifest={downloadProjectManifest} onCopySummary={() => void copyProjectSummary()} /> : null}
        </aside> : null}
      </main>

      {creating ? <div className="modal-backdrop" role="presentation" onClick={() => setCreating(false)}><form className="modal libtv-create-canvas-modal" role="dialog" aria-modal="true" aria-labelledby="libtv-new-canvas-title" onSubmit={createCanvas} onClick={event => event.stopPropagation()}><button className="modal-close" type="button" aria-label="关闭" onClick={() => setCreating(false)}>×</button><p className="overline">NEW CANVAS</p><h2 id="libtv-new-canvas-title">新建画布</h2><label><span>画布名称</span><input name="canvas-name" autoComplete="off" value={canvasName} onChange={event => setCanvasName(event.target.value)} /></label><div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setCreating(false)}>取消</button><button className={`button button-primary${createBusy ? ' is-loading' : ''}`} type="submit" disabled={!canvasName.trim() || createBusy}>{createBusy ? <><i className="ui-mini-loader" aria-hidden="true" />创建中…</> : '创建画布'}</button></div></form></div> : null}
    </div>
  );
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

type AgentUtilityProps = {
  utility: Utility; projectId: string; data: ReturnType<typeof useAppData>;
  agentDraft: string; agentBusy: boolean; agentThread: AgentMessage[]; agentReferences: AgentReference[]; agentSuggestions: AgentReference[]; agentRunId: string | null; agentError: string;
  selectedSkill: { id: string; version: string; name: string } | null; selectedModel: string; textModels: ModelSummary[]; skillChoices: SkillSummary[]; skillPickerOpen: boolean; skillPickerBusy: boolean; composerMenuOpen: boolean;
  onModelChange: (model: string) => void; onOpenSkillPicker: () => void; onSelectSkill: (skill: SkillSummary) => void; onClearSkill: () => void; onToggleComposerMenu: () => void; onAddProjectReference: () => void; onStarter: (starter: AgentStarter) => void;
  onAgentDraftChange: (value: string) => void; onAgentReferenceSelect: (reference: AgentReference) => void; onAgentReferenceRemove: (reference: AgentReference) => void;
  onAgentSend: () => void; onAgentCancel: () => void; onExportManifest: () => void; onCopySummary: () => void;
};
function UtilityContent({ utility, projectId, data, agentDraft, agentBusy, agentThread, agentReferences, agentSuggestions, agentRunId, agentError, selectedSkill, selectedModel, textModels, skillChoices, skillPickerOpen, skillPickerBusy, composerMenuOpen, onModelChange, onOpenSkillPicker, onSelectSkill, onClearSkill, onToggleComposerMenu, onAddProjectReference, onStarter, onAgentDraftChange, onAgentReferenceSelect, onAgentReferenceRemove, onAgentSend, onAgentCancel, onExportManifest, onCopySummary }: AgentUtilityProps) {
  if (utility === 'assets') return <AssetsPanel projectId={projectId} initialAssets={data.assets} />;
  if (utility === 'timeline') return <div className="libtv-utility-list"><div className="libtv-panel-meta"><span>{data.shots.length} 个镜头</span><small>总时长约 {data.shots.reduce((total, shot) => total + (Number.parseFloat(shot.duration) || 0), 0)} 秒</small></div>{data.shots.length ? data.shots.map((shot, index) => <article key={shot.id}><span className="shot-index">{String(index + 1).padStart(2, '0')}</span><div><b>{shot.title}</b><small>{shot.duration} · {shot.status}</small></div></article>) : <UtilityEmpty icon={<ListVideo />} title="时间线为空" detail="创建分镜后即可组织镜头顺序。" />}</div>;
  if (utility === 'models') return <ModelsPanel />;
  if (utility === 'export') return <div className="libtv-export-panel"><div className="libtv-export-summary"><span><b>{data.shots.length}</b><small>分镜</small></span><span><b>{data.assets.length}</b><small>素材</small></span><span><b>{data.jobs.length}</b><small>任务</small></span></div><button type="button" onClick={onExportManifest}><FileJson size={16} /><span><b>导出项目清单</b><small>JSON · 包含分镜、素材与生成任务</small></span><Download size={14} /></button><button type="button" onClick={onCopySummary}><ClipboardCopy size={16} /><span><b>复制项目摘要</b><small>适合发送给协作者或小Q助手</small></span><span aria-hidden="true">→</span></button><p>视频文件请在生成任务完成后，从对应节点或素材面板下载。</p></div>;
  return <div className="libtv-agent-box">{agentThread.length ? <div className="libtv-agent-thread" role="log" aria-live="polite">{agentThread.map(message => <article key={message.id} className={`is-${message.role}`}><span>{message.role === 'agent' ? '小Q' : '你'}</span><p>{message.content}</p></article>)}{agentBusy ? <div className="libtv-agent-thinking" role="status"><i /><i /><i /><span>小Q正在思考…</span></div> : null}</div> : <><div className="libtv-agent-intro"><span className="libtv-agent-orb" aria-hidden="true"><b className="qtv-agent-monogram">Q</b></span><h3>让小Q协助你完成每一次创作</h3></div><div className="libtv-agent-starters">{agentStarters.map(starter => { const Icon = starter.icon; return <button type="button" key={starter.label} onClick={() => onStarter(starter)}><Icon size={14} aria-hidden="true" /><span>{starter.label}</span><ArrowRight size={14} aria-hidden="true" /></button>; })}</div></>}
    {agentError ? <p className="libtv-agent-error" role="alert">{agentError}</p> : null}
    <div className="libtv-agent-composer">
      {skillPickerOpen ? <div className="libtv-agent-skill-picker" role="dialog" aria-label="选择已安装 Skill"><strong>选择已安装 Skill</strong>{skillChoices.length ? skillChoices.map(skill => <button type="button" key={skill.id} onClick={() => onSelectSkill(skill)}>{skill.name}<small>v{skill.version}</small></button>) : <p>尚未安装 Skill。<button type="button" onClick={() => navigate('/skill')}>前往 Skill 库</button></p>}</div> : null}
      {composerMenuOpen ? <div className="libtv-agent-source-menu" role="menu" aria-label="添加创作上下文"><button type="button" role="menuitem" onClick={onAddProjectReference}>@ 引用当前画布的节点或素材</button><button type="button" role="menuitem" onClick={onOpenSkillPicker}>选择已安装 Skill</button></div> : null}
      {agentSuggestions.length ? <div className="libtv-agent-mentions" role="listbox" aria-label="可引用的项目内容">{agentSuggestions.map(reference => <button type="button" role="option" aria-selected="false" key={`${reference.kind}-${reference.id}`} onClick={() => onAgentReferenceSelect(reference)}><b>@{reference.label}</b><small>{reference.kind === 'asset' ? '素材' : reference.kind === 'shot' ? '分镜' : '节点'}</small></button>)}</div> : null}
      {selectedSkill ? <div className="libtv-agent-reference-chips" aria-label="当前已启用 Skill"><span>Skill：{selectedSkill.name} · v{selectedSkill.version}<button type="button" aria-label={`移除 Skill ${selectedSkill.name}`} onClick={onClearSkill}>×</button></span></div> : null}
      {agentReferences.length ? <div className="libtv-agent-reference-chips" aria-label="已引用项目内容">{agentReferences.map(reference => <span key={`${reference.kind}-${reference.id}`}>@{reference.label}<button type="button" aria-label={`移除引用 ${reference.label}`} onClick={() => onAgentReferenceRemove(reference)}>×</button></span>)}</div> : null}
      <textarea name="agent-prompt" autoComplete="off" aria-label="发送给小Q创作助手" value={agentDraft} onChange={event => onAgentDraftChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && agentSuggestions.length === 0) { event.preventDefault(); onAgentSend(); } }} placeholder="开始你的创作，或者 @ 引用分镜或素材…" />
      <div><button type="button" className="libtv-composer-plus" aria-label="添加创作上下文" aria-expanded={composerMenuOpen} title="添加项目引用或 Skill" onClick={onToggleComposerMenu}><Plus size={16} /></button><select className="libtv-agent-model-select" aria-label="创意模型" value={selectedModel} disabled={agentBusy} onChange={event => onModelChange(event.target.value)}><option value="">自动（服务端配置）</option>{textModels.map(model => <option value={model.modelKey} key={model.modelKey}>{model.modelName}</option>)}</select><span>{skillPickerBusy ? '正在读取 Skill…' : agentReferences.length ? `已引用 ${agentReferences.length} 项` : selectedSkill ? `Skill：${selectedSkill.name}` : '小Q创作助手'}</span>{agentBusy ? <button type="button" className="libtv-agent-send is-cancel" aria-label="停止小Q" disabled={!agentRunId} onClick={onAgentCancel}><X size={15} /></button> : <button type="button" className="libtv-agent-send" aria-label="发送给小Q" disabled={!agentDraft.trim() && !agentReferences.length} onClick={onAgentSend}><Send size={15} /></button>}</div>
    </div>
  </div>;
}

function AssetsPanel({ projectId, initialAssets }: { projectId: string; initialAssets: Asset[] }) {
  const [assets, setAssets] = useState(initialAssets);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [assetQuery, setAssetQuery] = useState('');
  const [assetKind, setAssetKind] = useState<'all' | Asset['kind']>('all');
  const [minimumRating, setMinimumRating] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  useEffect(() => { setAssets(initialAssets); }, [initialAssets, projectId]);
  const upload = async (file?: File) => {
    if (!file || progress !== null) return;
    setError(''); setProgress(0); const controller = new AbortController(); uploadAbort.current = controller;
    try {
      const asset = await ports.media.upload(projectId, file, setProgress, controller.signal);
      setAssets(current => [asset, ...current.filter(item => item.id !== asset.id)]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '素材上传失败'); }
    finally { uploadAbort.current = null; setProgress(null); if (inputRef.current) inputRef.current.value = ''; }
  };
  const rateAsset = async (asset: Asset, stars: number) => { try { setError(''); await ports.media.rate(projectId, asset.id, stars); setAssets(current => current.map(item => item.id === asset.id ? (stars ? { ...item, rating: stars } : Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'rating')) as unknown as Asset) : item)); } catch (caught) { setError(caught instanceof Error ? caught.message : '素材评级失败'); } };
  const removeAsset = async (asset: Asset) => { if (!window.confirm(`确定删除素材「${asset.name}」？仍被画布、时间线或生成记录引用时会安全拒绝。`)) return; try { setError(''); await ports.media.remove(projectId, asset.id); setAssets(current => current.filter(item => item.id !== asset.id)); } catch (caught) { setError(caught instanceof Error ? caught.message : '素材删除失败'); } };
  const filteredAssets = assets.filter(asset => (assetKind === 'all' || asset.kind === assetKind) && (asset.rating ?? 0) >= minimumRating && (!assetQuery.trim() || asset.name.toLocaleLowerCase('zh-CN').includes(assetQuery.trim().toLocaleLowerCase('zh-CN'))));
  return <div className="libtv-utility-list libtv-assets-panel" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={event => { event.preventDefault(); void upload(event.dataTransfer.files[0]); }}>
    <input ref={inputRef} type="file" hidden accept="image/png,image/jpeg,image/webp,video/mp4,audio/mpeg,audio/wav" onChange={event => void upload(event.target.files?.[0])} />
    <div className="libtv-asset-filters"><input type="search" value={assetQuery} onChange={event => setAssetQuery(event.target.value)} placeholder="搜索素材名称" aria-label="搜索素材" /><div role="group" aria-label="素材类型筛选">{([['all','全部'],['image','图片'],['video','视频'],['audio','音频']] as const).map(([kind,label]) => <button type="button" key={kind} className={assetKind === kind ? 'active' : ''} aria-pressed={assetKind === kind} onClick={() => setAssetKind(kind)}>{label}</button>)}</div><select aria-label="最低素材评级" value={minimumRating} onChange={event => setMinimumRating(Number(event.target.value))}><option value={0}>全部评级</option>{[1,2,3,4,5].map(stars => <option key={stars} value={stars}>{stars} 星及以上</option>)}</select></div>
    <button type="button" className="libtv-upload-drop" disabled={progress !== null} onClick={() => inputRef.current?.click()}><ImagePlus size={17} /><span><b>{progress === null ? '上传素材' : `正在上传 ${progress}%`}</b><small>也可将图片、MP4 或音频拖到这里</small></span></button>
    {progress !== null ? <button type="button" className="libtv-upload-cancel" onClick={() => uploadAbort.current?.abort()}>取消上传</button> : null}
    {error ? <p className="libtv-upload-error" role="alert">{error}</p> : null}
    <div className="libtv-panel-meta"><span>{assets.length} 项素材</span><small>{assets.filter(asset => asset.kind === 'image').length} 图片 · {assets.filter(asset => asset.kind === 'video').length} 视频 · {assets.filter(asset => asset.kind === 'audio').length} 音频 · {assets.filter(asset => asset.kind === 'document').length} 文档</small></div>
    {filteredAssets.length ? filteredAssets.map(asset => <article key={asset.id} draggable={asset.kind !== 'document'} onDragStart={event => { if (asset.kind === 'document') return; event.dataTransfer.setData('application/x-qtv-asset', JSON.stringify({ id: asset.id, name: asset.name, kind: asset.kind, previewUrl: asset.previewUrl })); event.dataTransfer.effectAllowed = 'copy'; }}><span className="asset-preview" style={{ background: asset.color }}>{asset.previewUrl && asset.kind === 'image' ? <img src={asset.previewUrl} alt="" loading="lazy" /> : null}</span><div><b>{asset.name}</b><small>{asset.kind} · {asset.meta}</small><span className="libtv-asset-rating" aria-label={`${asset.name}评级`}>{[1,2,3,4,5].map(stars => <button type="button" key={stars} className={(asset.rating ?? 0) >= stars ? 'active' : ''} aria-label={`${asset.name} ${stars}星`} aria-pressed={asset.rating === stars} onClick={() => void rateAsset(asset, asset.rating === stars ? 0 : stars)}>★</button>)}</span></div><button type="button" className="libtv-asset-delete" aria-label={`删除 ${asset.name}`} onClick={() => void removeAsset(asset)}><X size={13} /></button>{asset.previewUrl ? <a href={asset.previewUrl} download={asset.name} aria-label={`下载 ${asset.name}`}><Download size={14} /></a> : null}</article>) : <UtilityEmpty icon={<FolderOpen />} title="暂无素材" detail="上传或生成的素材会出现在这里。" />}
  </div>;
}

function ModelsPanel() {
  const [models, setModels] = useState<Array<ModelSummary & { category: '图像' | '视频' }>>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([ports.models.search('image'), ports.models.search('video')]).then(([images, videos]) => {
      if (active) setModels([...images.map(model => ({ ...model, category: '图像' as const })), ...videos.map(model => ({ ...model, category: '视频' as const }))]);
    }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : '无法读取模型目录'); });
    return () => { active = false; };
  }, []);
  if (error) return <UtilityEmpty icon={<SlidersHorizontal />} title="模型目录不可用" detail={error} />;
  if (!models.length) return <UtilityEmpty icon={<SlidersHorizontal />} title="正在读取 LibTV 模型" detail="通过本机已登录的 LibTV CLI 获取真实模型目录。" />;
  return <div className="libtv-utility-list"><div className="libtv-panel-meta"><span>{models.length} 个真实模型</span><small>{models.filter(model => model.category === '图像').length} 图像 · {models.filter(model => model.category === '视频').length} 视频</small></div>{models.map(model => <article key={`${model.category}-${model.modelKey}`}><span className={`model-kind is-${model.category === '图像' ? 'image' : 'video'}`}>{model.category.slice(0, 1)}</span><div><b>{model.modelName}</b><small>{model.description || model.modelKey}{model.estimatedTime ? ` · ${model.estimatedTime}` : ''}</small></div></article>)}</div>;
}

function UtilityEmpty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="libtv-utility-empty"><span>{icon}</span><b>{title}</b><small>{detail}</small></div>;
}
