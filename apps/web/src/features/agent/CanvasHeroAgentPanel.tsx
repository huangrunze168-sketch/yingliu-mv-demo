import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowRight, ImagePlus, Paperclip, PanelsTopLeft, Plus, WandSparkles } from 'lucide-react';
import { requiresAgentConfirmation } from '../../domain/agentActions';
import { navigate } from '../../app/router';
import { ports, useAppData } from '../../app/useAppData';
import type { AgentReference, ModelSummary } from '../../ports';
import { skillApi, type SkillSummary } from '../skills/skillApi';
import { openAgentCanvas } from './agentNavigation';
import { HeroAgentThread } from './HeroAgentThread';
import { useHeroAgentChat } from './useHeroAgentChat';
import './canvas-hero-agent.css';

const starterPrompts = [
  { icon: WandSparkles, label: '选择 Skill 开始创作', prompt: '' },
  { icon: PanelsTopLeft, label: '构思原创剧本方向', prompt: '请基于我的创作想法构思原创剧本方向。先给出 3 个差异明确的方向，每个包含一句话梗概、核心人物、主要冲突、类型气质和适合的视觉方向；我选定后再展开三幕结构和分镜。' },
  { icon: Paperclip, label: '为现有故事提出改编建议', prompt: '请读取当前画布中已有的故事、分镜和素材，提出可执行的改编建议。分别说明保留、压缩、重排和改写内容，并给出一版改编后的结构大纲；不要直接覆盖原内容。' },
  { icon: ImagePlus, label: '整理分镜脚本草案', prompt: '请把当前画布中的故事整理成一版可编辑的分镜脚本草案。按镜头编号输出时长、景别、画面动作、人物表演、镜头运动、声音和生成提示，并标记需要我确认的设定；先整理方案，不要声称已经生成素材。' },
];

/** 首屏消息所绑定的画布继续使用同一服务端会话，而非另起一个本地模拟对话。 */
export function CanvasHeroAgentPanel({ projectId }: { projectId: string }) {
  const agent = useHeroAgentChat(projectId);
  const data = useAppData(projectId);
  const [draft, setDraft] = useState('');
  const [draftReferences, setDraftReferences] = useState<AgentReference[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<{ id: string; version: string; name: string } | null>(null);
  const [textModels, setTextModels] = useState<ModelSummary[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelBusy, setModelBusy] = useState(false);
  const [skillChoices, setSkillChoices] = useState<SkillSummary[]>([]);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillPickerBusy, setSkillPickerBusy] = useState(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState('');
  const mentionQuery = draft.match(/(?:^|\s)@([^\s@]*)$/)?.[1]?.toLocaleLowerCase('zh-CN');
  const agentSuggestions: AgentReference[] = mentionQuery === undefined ? [] : [
    ...data.assets.map(asset => ({ id: asset.id, kind: 'asset' as const, label: asset.name })),
    ...data.shots.map(shot => ({ id: shot.id, kind: 'shot' as const, label: shot.title })),
  ].filter(reference => !draftReferences.some(item => item.kind === reference.kind && item.id === reference.id) && (!mentionQuery || reference.label.toLocaleLowerCase('zh-CN').includes(mentionQuery))).slice(0, 8);
  useEffect(() => {
    const skill = [...agent.messages].reverse().find(message => message.role === 'user' && message.skillRef)?.skillRef;
    setSelectedSkill(skill ? { id: skill.id, version: skill.version, name: skill.name ?? skill.id } : null);
  }, [agent.messages]);
  useEffect(() => {
    let active = true;
    setModelBusy(true);
    void ports.models.search('text').then(models => { if (active) setTextModels(models); }).catch(() => { if (active) setTextModels([]); }).finally(() => { if (active) setModelBusy(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!agent.projectId || agent.projectId === projectId) return;
    void openAgentCanvas().then(ok => { if (!ok) setNavigationError('新对话已创建，但暂未找到对应画布。'); }).catch(() => setNavigationError('新对话已创建，但画布暂时无法打开。'));
  }, [agent.projectId, projectId]);
  const submit = (text: string) => {
    if (!text.trim() || agent.busy || agent.running || agent.needsReview) return;
    if (requiresAgentConfirmation(text) && confirmation === null) { setConfirmation(text); return; }
    void agent.send(text, selectedSkill ? { id: selectedSkill.id, version: selectedSkill.version } : undefined, draftReferences, selectedModel || undefined).then(sent => { if (sent) { setDraft(''); setDraftReferences([]); setConfirmation(null); } });
  };
  const onSubmit = (event: FormEvent) => { event.preventDefault(); submit(draft); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault(); submit(draft);
  };
  const startNewConversation = async () => {
    setDraft(''); setDraftReferences([]); setSelectedSkill(null); setSelectedModel(''); setSkillPickerOpen(false); setComposerMenuOpen(false); setConfirmation(null);
    await agent.newSession();
  };
  const openSkillPicker = async () => {
    if (skillPickerOpen) { setSkillPickerOpen(false); return; }
    setSkillPickerBusy(true);
    try {
      const installed: SkillSummary[] = [];
      let cursor: string | null = null;
      do {
        const result = await skillApi.list({ tab: 'skill', limit: 50, cursor });
        installed.push(...result.items.filter(item => item.installed));
        cursor = result.nextCursor;
      } while (cursor && installed.length < 500);
      setSkillChoices(installed); setSkillPickerOpen(true);
    } catch { /* 选择器失败时不阻塞普通对话 */ }
    finally { setSkillPickerBusy(false); }
  };
  const activateStarter = (starter: (typeof starterPrompts)[number]) => {
    if (starter.label === '选择 Skill 开始创作') { void openSkillPicker(); return; }
    setDraft(starter.prompt);
    if (starter.label !== '构思原创剧本方向') {
      const refs: AgentReference[] = [...data.assets.map(asset => ({ id: asset.id, kind: 'asset' as const, label: asset.name })), ...data.shots.map(shot => ({ id: shot.id, kind: 'shot' as const, label: shot.title }))];
      setDraftReferences(refs.slice(0, 20));
    } else setDraftReferences([]);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.qtv-canvas-agent-conversation textarea')?.focus());
  };
  const addReference = (reference: AgentReference) => {
    setDraftReferences(current => current.some(item => item.id === reference.id && item.kind === reference.kind) ? current : [...current, reference].slice(0, 20));
    setDraft(current => current.replace(/(?:^|\s)@[^\s@]*$/, current.trimStart() === current ? '' : ' ').trimStart());
  };
  return <div className="libtv-agent-box qtv-canvas-agent-conversation">
    <HeroAgentThread {...agent} confirmation={confirmation} onConfirm={() => confirmation && submit(confirmation)} onDismiss={() => setConfirmation(null)} onNew={() => void startNewConversation()} onCancel={() => void agent.cancel()} onReconnect={() => void agent.reconnect()} />
    {navigationError ? <p role="alert">{navigationError}</p> : null}
    {!agent.messages.length && !agent.busy && !agent.running ? <><p className="qtv-canvas-agent-intro">在这张画布里继续与小Q讨论方案。生成任务仍需逐项确认。</p><div className="libtv-agent-starters qtv-canvas-agent-starters">{starterPrompts.map(starter => { const Icon = starter.icon; return <button type="button" key={starter.label} onClick={() => activateStarter(starter)}><Icon size={14} aria-hidden="true" /><span>{starter.label}</span><ArrowRight size={14} aria-hidden="true" /></button>; })}</div></> : null}
    <form className="libtv-agent-composer" onSubmit={onSubmit}>
      {skillPickerOpen ? <div className="libtv-agent-skill-picker" role="dialog" aria-label="选择已安装 Skill"><strong>选择已安装 Skill</strong>{skillPickerBusy ? <p>正在读取 Skill…</p> : skillChoices.length ? skillChoices.map(skill => <button type="button" key={skill.id} onClick={() => { setSelectedSkill({ id: skill.id, version: skill.version, name: skill.name }); setSkillPickerOpen(false); }}>{skill.name}<small>v{skill.version}</small></button>) : <p>尚未安装 Skill。<button type="button" onClick={() => navigate('/skill')}>前往 Skill 库</button></p>}</div> : null}
      {selectedSkill ? <div className="libtv-agent-reference-chips" aria-label="当前启用的 Skill"><span>Skill：{selectedSkill.name} · v{selectedSkill.version}<button type="button" aria-label={`移除 Skill ${selectedSkill.name}`} onClick={() => setSelectedSkill(null)}>×</button></span></div> : null}
      {draftReferences.length ? <div className="libtv-agent-reference-chips" aria-label="本次工作流引用的画布内容">{draftReferences.map(reference => <span key={`${reference.kind}-${reference.id}`}>@{reference.label}<button type="button" aria-label={`移除引用 ${reference.label}`} onClick={() => setDraftReferences(current => current.filter(item => item.id !== reference.id || item.kind !== reference.kind))}>×</button></span>)}</div> : null}
      {composerMenuOpen ? <div className="libtv-agent-source-menu" role="menu" aria-label="添加创作上下文"><button type="button" role="menuitem" onClick={() => { setComposerMenuOpen(false); setDraft(current => `${current}${current && !current.endsWith(' ') ? ' ' : ''}@`); }}>@ 引用当前画布的节点或素材</button><button type="button" role="menuitem" onClick={() => { setComposerMenuOpen(false); void openSkillPicker(); }}>选择已安装 Skill</button></div> : null}
      {agentSuggestions.length ? <div className="libtv-agent-mentions" role="listbox" aria-label="可引用的项目内容">{agentSuggestions.map(reference => <button type="button" role="option" aria-selected="false" key={`${reference.kind}-${reference.id}`} onClick={() => addReference(reference)}><b>@{reference.label}</b><small>{reference.kind === 'asset' ? '素材' : '分镜'}</small></button>)}</div> : null}
      <textarea aria-label="在画布中继续与小Q对话" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} placeholder="继续讨论镜头、方案或素材…" />
      <div><button type="button" className="libtv-composer-plus" aria-label="添加创作上下文" aria-expanded={composerMenuOpen} title="添加项目引用或 Skill" onClick={() => { setComposerMenuOpen(open => !open); setSkillPickerOpen(false); }}><Plus size={16} /></button><select className="libtv-agent-model-select" aria-label="创意模型" value={selectedModel} disabled={modelBusy || agent.busy || agent.running} onChange={event => setSelectedModel(event.target.value)}><option value="">自动（服务端配置）</option>{textModels.map(model => <option value={model.modelKey} key={model.modelKey}>{model.modelName}</option>)}</select><span>{agent.running ? '小Q正在规划…' : draftReferences.length ? `已引用 ${draftReferences.length} 项` : selectedSkill ? `Skill：${selectedSkill.name}` : '当前画布的 Agent 会话'}</span><button className="libtv-agent-send" type="submit" aria-label="发送画布对话" disabled={(!draft.trim() && !draftReferences.length) || agent.busy || agent.running || agent.needsReview || !!confirmation}>↑</button></div>
    </form>
  </div>;
}
