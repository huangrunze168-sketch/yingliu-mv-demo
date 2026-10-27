import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';
import { ports } from '../../app/useAppData';
import { canvasHref, navigate, newCanvasHref } from '../../app/router';
import { requiresAgentConfirmation } from '../../domain/agentActions';
import { HeroAgentThread } from '../agent/HeroAgentThread';
import { useHeroAgentChat } from '../agent/useHeroAgentChat';
import { openAgentCanvas } from '../agent/agentNavigation';
import { agentClient } from '../agent/agentClient';
import { canvasAgentHandoffKey, createCanvasAgentHandoff } from '../agent/canvasAgentHandoff';
import { usePrefersReducedMotion } from '../../app/usePrefersReducedMotion';
import { LazyAgentLensCanvas } from '../marketing/LazyAgentLensCanvas';
import { AGENT_MODES, LUCIDE_PLUS_PATHS, LUCIDE_SPARKLE_PATH } from '../marketing/agentConsole';
import type { AgentReference, Asset, WorkspaceSummary } from '../../ports';
import '../../marketing.css';
import './agent-attachments.css';

gsap.registerPlugin(useGSAP, ScrollTrigger);

type SortMode = 'updated' | 'name' | 'progress';
/** 状态筛选：ProjectStatus 是 active/archived 生命周期，这里按 progress 判定完成度。 */
type StatusFilter = 'all' | 'active' | 'done';

import { CountUp } from './CountUp';
import { CoverThumb } from './CoverThumb';
import { ProjectRail } from './ProjectRail';

const statusFilters: Array<[StatusFilter, string]> = [
  ['all', '全部'],
  ['active', '进行中'],
  ['done', '已完成'],
];

export function ProjectListPage() {
  const [projects, setProjects] = useState<WorkspaceSummary[]>([]);
  const [archived, setArchived] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortMode>('updated');
  const [settingsProject, setSettingsProject] = useState<WorkspaceSummary | null>(null);
  const [settingsName, setSettingsName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [renamingId, setRenamingId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** Agent 对话：对标站 的中间是会话而非单行输入，空态才显示「A new era」。 */
  const [agentPrompt, setAgentPrompt] = useState(() => window.sessionStorage.getItem('qiyin.hero.workbench.draft') ?? '');
  const [agentModel, setAgentModel] = useState('auto-medium');
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachments, setAttachments] = useState<AgentReference[]>([]);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assetPickerBusy, setAssetPickerBusy] = useState(false);
  const [assetOptions, setAssetOptions] = useState<Asset[]>([]);
  const [assetSelection, setAssetSelection] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const agentTargetRef = useRef<Promise<{ projectId: string; workspaceId: string }> | null>(null);
  const heroAgent = useHeroAgentChat();
  const [canvasNavigationError, setCanvasNavigationError] = useState('');
  const enterCanvas = async () => {
    try { if (!await openAgentCanvas(heroAgent.projectId)) setCanvasNavigationError('消息已提交，但暂未找到对应画布；对话保留在此处。'); }
    catch { setCanvasNavigationError('消息已提交，但画布暂时无法打开；对话保留在此处。'); }
  };
  const hasAgentDialogue = heroAgent.messages.some(message => message.role === 'user' || message.role === 'agent' || message.role === 'plan');
  useEffect(() => {
    if (agentPrompt) window.sessionStorage.setItem('qiyin.hero.workbench.draft', agentPrompt);
    else window.sessionStorage.removeItem('qiyin.hero.workbench.draft');
  }, [agentPrompt]);

  /** 首屏入场（对标 hero 组件：`b=z(()=>l(d)||xt.current)` / `data-animate=!xt.current`）。
      data-animate 从首帧就为 true（transition 先挂好），data-ready 等透镜动画到位（f>=1.5）才翻。 */
  const reducedMotion = usePrefersReducedMotion();
  const [arrived, setArrived] = useState(false);
  const introReady = arrived || reducedMotion;
  const handleLensArrival = useCallback(() => setArrived(true), []);

  /** 引力透镜 canvas：输入台元素 + 首屏是否在视口内（离开就停渲染，见 AgentLensCanvas）。 */
  const consoleRef = useRef<HTMLFormElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const [heroActive, setHeroActive] = useState(true);
  useEffect(() => {
    const node = heroRef.current;
    if (!node) return;
    const io = new IntersectionObserver(([entry]) => setHeroActive(entry.isIntersecting));
    io.observe(node);
    return () => io.disconnect();
  }, []);

  const refresh = async () => {
    const [activeItems, archivedItems] = await Promise.all([ports.workspaces.list(), ports.workspaces.listArchived()]);
    setProjects(activeItems);
    setArchived(archivedItems);
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);
  const visibleProjects = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const filtered = projects.filter(project => `${project.name} ${project.description}`.toLowerCase().includes(keyword));
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
      if (sort === 'progress') return b.progress - a.progress;
      return b.revision - a.revision;
    });
  }, [projects, search, sort]);

  const filteredProjects = useMemo(() => (
    statusFilter === 'all'
      ? visibleProjects
      : visibleProjects.filter(project => statusFilter === 'done' ? project.progress >= 100 : project.progress < 100)
  ), [visibleProjects, statusFilter]);

  const runProjectAction = async (id: string, action: () => Promise<unknown>, message: string) => {
    setBusyId(id);
    try {
      await action();
      await refresh();
      setNotice(message);
    } finally {
      setBusyId('');
    }
  };

  const openSettings = (project: WorkspaceSummary) => {
    setSettingsProject(project);
    setSettingsName(project.name);
  };

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!settingsProject || !settingsName.trim()) return;
    await runProjectAction(settingsProject.id, async () => {
      await ports.workspaces.rename(settingsProject.id, settingsName.trim());
    }, '工作区设置已保存。');
    setSettingsProject(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleteConfirmName.trim() !== pendingDelete.name) return;
    await runProjectAction(pendingDelete.id, () => ports.workspaces.purge(pendingDelete.id, pendingDelete.name), '工作区已彻底删除。');
    setPendingDelete(null);
    setDeleteConfirmName('');
  };

  const confirmRename = async () => {
    if (!renamingId) return;
    const title = renameValue.trim();
    if (!title) {
      setRenamingId('');
      return;
    }
    await runProjectAction(renamingId, () => ports.workspaces.rename(renamingId, title), '工作区已重命名。');
    setRenamingId('');
  };

  const toggleSelected = (id: string) => {
    setSelectedIds(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]));
  };

  const archiveSelected = async () => {
    if (selectedIds.length === 0) return;
    const count = selectedIds.length;
    setBusyId('bulk');
    try {
      await Promise.all(selectedIds.map(id => ports.workspaces.trash(id)));
      await refresh();
      setNotice('已归档 ' + count + ' 个项目。');
      setSelectedIds([]);
      setSelectMode(false);
    } finally {
      setBusyId('');
    }
  };

  /** Card Spotlight：指针位置写入 --mx/--my，供卡片辉光径向渐变定位。 */
  const handleSpotlight = (event: ReactPointerEvent<HTMLElement>) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('.tool-card, .project-cover, .feature-tile, .rail-promo');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    card.style.setProperty('--my', `${event.clientY - rect.top}px`);
  };

  /** 项目首页的 Agent 消息成功提交后进入同一项目画布。 */
  const submitAgentPrompt = () => {
    const text = agentPrompt.trim();
    if (!text || heroAgent.busy || heroAgent.running || confirmation) return;
    if (requiresAgentConfirmation(text)) { setConfirmation(text); return; }
    if (attachments.length) {
      void handoffWithAttachments(text).then(() => { setAgentPrompt(''); setAttachments([]); }).catch(reason => setCanvasNavigationError(reason instanceof Error ? reason.message : '附件交接失败'));
    } else {
      void heroAgent.send(text).then(sent => { if (sent) { setAgentPrompt(''); void enterCanvas(); } });
    }
  };

  const confirmAgentPrompt = () => {
    if (!confirmation) return;
    if (attachments.length) {
      void handoffWithAttachments(confirmation).then(() => { setAgentPrompt(''); setAttachments([]); setConfirmation(null); }).catch(reason => setCanvasNavigationError(reason instanceof Error ? reason.message : '附件交接失败'));
    } else {
      void heroAgent.send(confirmation).then(sent => {
        if (sent) { setAgentPrompt(''); setConfirmation(null); void enterCanvas(); }
      });
    }
  };

  const sendAgentPrompt = (event: FormEvent) => {
    event.preventDefault();
    submitAgentPrompt();
  };

  /** Enter 直发（Shift+Enter 换行）；放过 IME 组合中的 Enter，否则中文选字会直接发出。
      说明见 LandingPage.tsx 的同名注释 —— 之前这里也只有点 ✦ 钮才能出对话。 */
  const handlePromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submitAgentPrompt();
  };

  async function ensureAgentTarget() {
    if (!agentTargetRef.current) {
      agentTargetRef.current = (async () => {
        const projectId = await agentClient.homeProject(true);
        if (!projectId) throw new Error('无法创建 Agent 创作画布。');
        const canvas = await ports.canvases.get(projectId);
        if (!canvas?.workspaceId) throw new Error('无法定位 Agent 创作画布。');
        return { projectId, workspaceId: canvas.workspaceId };
      })().catch(reason => { agentTargetRef.current = null; throw reason; });
    }
    return agentTargetRef.current;
  }

  async function uploadAgentFiles(files: FileList | null) {
    const selected = Array.from(files ?? []).slice(0, Math.max(0, 20 - attachments.length));
    if (!selected.length) return;
    setAttachmentMenuOpen(false); setAttachmentBusy(true); setCanvasNavigationError('');
    try {
      const { projectId } = await ensureAgentTarget();
      const uploaded: AgentReference[] = [];
      for (const file of selected) {
        setNotice(`正在上传 ${file.name}…`);
        const asset = await ports.media.upload(projectId, file);
        uploaded.push({ id: asset.id, kind: 'asset', label: asset.name });
      }
      setAttachments(current => [...current, ...uploaded.filter(item => !current.some(existing => existing.id === item.id))].slice(0, 20));
      setNotice(`已添加 ${uploaded.length} 个附件`);
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : '附件上传失败'); }
    finally { setAttachmentBusy(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  }

  async function openAgentAssetPicker() {
    setAttachmentMenuOpen(false); setAssetPickerOpen(true); setAssetPickerBusy(true);
    setAssetSelection(attachments.filter(reference => reference.kind === 'asset').map(reference => reference.id));
    try { const { projectId } = await ensureAgentTarget(); setAssetOptions(await ports.media.listAssets(projectId)); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : '读取素材库失败'); setAssetPickerOpen(false); }
    finally { setAssetPickerBusy(false); }
  }

  function confirmAgentAssets() {
    const selected = assetOptions.filter(asset => assetSelection.includes(asset.id)).map(asset => ({ id: asset.id, kind: 'asset' as const, label: asset.name }));
    setAttachments(current => [...current.filter(reference => reference.kind !== 'asset' || !assetOptions.some(asset => asset.id === reference.id)), ...selected].slice(0, 20));
    setAssetPickerOpen(false);
    if (selected.length) setNotice(`已从素材库添加 ${selected.length} 个附件`);
  }

  async function handoffWithAttachments(text: string) {
    const { projectId } = await ensureAgentTarget();
    const workspace = (await ports.workspaces.list()).find(item => item.primaryProjectId === projectId);
    if (!workspace) throw new Error('无法定位 Agent 工作区。');
    sessionStorage.setItem(canvasAgentHandoffKey(projectId), JSON.stringify(createCanvasAgentHandoff(text, undefined, attachments)));
    window.localStorage.setItem('qiyin.hero.agent.project', projectId);
    navigate(canvasHref(workspace.id, projectId));
  }

  /** GSAP 动效层：只驱动「少量、独立」的层（gsap-performance）。
      ⚠ 首屏星野已换成对标那张预渲染照片、光带改成纯 CSS 的 conic-gradient + feTurbulence，
        所以这里不再有 .starfield* 的视差/漂移 tween，也不再给光带建 canvas
        （对标压根没做这两件事，程序化撒点 + 漩涡环是自造的，越调越不像）。 */
  const pageRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      mm.add({ live: '(prefers-reduced-motion: no-preference)' }, ctx => {
        if (!ctx.conditions?.live) return;
        const targets = pageRef.current?.querySelectorAll<HTMLElement>('.feature-tile, .project-card') ?? [];
        Array.from(targets).forEach((el, index) => {
          gsap.from(el, {
            autoAlpha: 0,
            y: 26,
            duration: 0.8,
            ease: 'power2.out',
            delay: (index % 3) * 0.06,
            scrollTrigger: { trigger: el, start: 'top 88%', once: true },
          });
        });
      });

      return () => mm.revert();
    },
    { scope: pageRef },
  );

  return (
    <div className="app-shell workbench-scope project-list-page" ref={pageRef}>
      {/* 与落地页同一套：星野是预渲染照片、光带是 conic-gradient + feTurbulence，
          滤镜定义必须挂在根上（祖先带 transform/filter 会改 url(#…) 的解析基准）。 */}
      <svg className="agent-streak-defs" aria-hidden="true">
        <filter id="agent-streak-texture" x="-10%" y="-30%" width="120%" height="160%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.045 0.5" numOctaves="2" seed="8" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="2" xChannelSelector="R" yChannelSelector="G" result="distorted" />
          <feColorMatrix in="noise" type="saturate" values="0" result="grain" />
          <feComposite in="distorted" in2="grain" operator="arithmetic" k1="1.5" k2="0.35" k3="0" k4="0" />
        </filter>
      </svg>
      <ProjectRail active="projects" />
      <div className="project-list-body">
      <main className="project-list-main" onPointerMove={handleSpotlight}>
        <section
          className={'agent-hero' + (hasAgentDialogue ? ' has-thread' : '')}
          ref={heroRef}
        >
          <img
            className="agent-hero-backdrop"
            src="/covers/agent-starfield-backdrop.webp"
            alt=""
            fetchPriority="high"
          />
          <LazyAgentLensCanvas
            promptRef={consoleRef}
            active={heroActive}
            engaged={hasAgentDialogue}
            onArrival={handleLensArrival}
          />
          {/* data-ready / data-animate / inert 三件套在 copy 容器上（对标 `te` = div.hero-copy） */}
          <div
            className="agent-hero-copy"
            data-ready={introReady}
            data-animate={!reducedMotion}
            inert={!introReady}
          >
            <div className="agent-hero-heading">
              <h1 className="agent-hero-title hero-enter">{hasAgentDialogue ? '小QTV Agent' : '全新的创作时代'}</h1>
              {!hasAgentDialogue && (
                <p className="agent-hero-sub hero-enter" style={{ '--intro-delay': '150ms' } as CSSProperties}>介绍全新小QTV Agent —— 生成式媒体的下一种创作方式。</p>
              )}
            </div>
            <HeroAgentThread {...heroAgent} confirmation={confirmation} onConfirm={confirmAgentPrompt}
              onDismiss={() => setConfirmation(null)} onNew={() => void heroAgent.newSession()}
              onCancel={() => void heroAgent.cancel()} onReconnect={() => void heroAgent.reconnect()}
              onOpenCanvas={() => void enterCanvas()} />
             {canvasNavigationError ? <p role="alert" className="hero-agent-error">{canvasNavigationError}</p> : null}
            <div
              className="agent-prompt hero-enter"
              style={{
                '--intro-delay': '225ms',
                animationPlayState: !introReady || !heroActive ? 'paused' : 'running',
              } as CSSProperties}
            >
              <div className="agent-streaks" aria-hidden="true" />
              <form
                className="agent-console"
                ref={consoleRef}
                onSubmit={sendAgentPrompt}
              >
                <textarea
                  className="agent-console-input"
                  value={agentPrompt}
                  onChange={event => setAgentPrompt(event.target.value)}
                  onKeyDown={handlePromptKeyDown}
                  disabled={heroAgent.busy || heroAgent.running || !!confirmation}
                  placeholder="告诉我你想完成什么…"
                  rows={1}
                  aria-label="创作描述"
                />
                {/* 底栏结构/图标与落地页同源：左 `gap-1` 簇（Lucide plus）+ 右 `ml-auto gap-1` 簇
                    （Model settings 触发钮 + Lucide sparkle 发送钮）。权威依据见 LandingPage.tsx。 */}
                {attachments.length > 0 && <div className="agent-attachment-chips" aria-label="已添加附件">{attachments.map(reference => <span key={reference.id}>{reference.label}<button type="button" aria-label={`移除附件 ${reference.label}`} onClick={() => setAttachments(current => current.filter(item => item.id !== reference.id))}>×</button></span>)}</div>}
                <div className="agent-console-bar">
                  <div className="agent-console-left">
                    <button className={`agent-plus${attachmentMenuOpen ? ' active' : ''}`} type="button" aria-label="添加参考素材" aria-haspopup="menu" aria-expanded={attachmentMenuOpen} disabled={attachmentBusy || attachments.length >= 20} onClick={() => setAttachmentMenuOpen(open => !open)}>
                      <svg
                        className="agent-plus-icon"
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        {LUCIDE_PLUS_PATHS.map(d => <path key={d} d={d} />)}
                      </svg>
                    </button>
                    {attachmentMenuOpen && <div className="agent-attachment-menu" role="menu"><button type="button" role="menuitem" onClick={() => fileInputRef.current?.click()}>本地上传</button><button type="button" role="menuitem" onClick={() => void openAgentAssetPicker()}>素材库添加</button></div>}
                    <input ref={fileInputRef} className="agent-file-input" type="file" multiple accept="image/*,video/*,audio/*,.pdf,.txt,.md,.markdown,.doc,.docx,application/pdf,text/plain,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={event => void uploadAgentFiles(event.currentTarget.files)} />
                  </div>
                  <div className="agent-console-right">
                    <span className="agent-mode">
                      <span className="agent-mode-text" aria-hidden="true">
                        <span className="agent-mode-model">Auto</span>
                        <span className="agent-mode-effort">{AGENT_MODES[agentModel] ?? 'Medium'}</span>
                        <svg
                          className="agent-mode-chev"
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                      <select value={agentModel} onChange={event => setAgentModel(event.target.value)} aria-label="生成质量">
                        <option value="auto-low">Auto Low</option>
                        <option value="auto-medium">Auto Medium</option>
                        <option value="auto-high">Auto High</option>
                      </select>
                    </span>
                    <button className="agent-send" type="submit" aria-label="开始创作" disabled={agentPrompt.trim().length === 0 || heroAgent.busy || heroAgent.running || !!confirmation}>
                      <svg
                        className="agent-send-icon"
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d={LUCIDE_SPARKLE_PATH} />
                      </svg>
                    </button>
                  </div>
                </div>
              </form>
              {assetPickerOpen && <div className="agent-asset-backdrop" role="presentation" onClick={() => setAssetPickerOpen(false)}><section className="agent-asset-picker" role="dialog" aria-modal="true" aria-label="从素材库添加" onClick={event => event.stopPropagation()}><header><b>从素材库添加</b><button type="button" aria-label="关闭素材库" onClick={() => setAssetPickerOpen(false)}>×</button></header>{assetPickerBusy ? <p>正在读取素材库…</p> : assetOptions.length ? <div className="agent-asset-list">{assetOptions.map(asset => <button type="button" key={asset.id} className={assetSelection.includes(asset.id) ? 'selected' : ''} aria-pressed={assetSelection.includes(asset.id)} onClick={() => setAssetSelection(current => current.includes(asset.id) ? current.filter(id => id !== asset.id) : [...current, asset.id])}><span>{asset.kind === 'video' ? '▶' : asset.kind === 'audio' ? '♫' : '✦'}</span><b>{asset.name}</b><small>{asset.meta}</small></button>)}</div> : <p>素材库暂时为空，请先使用本地上传。</p>}<footer><span>已选择 {assetSelection.length} 项</span><button type="button" disabled={assetPickerBusy || !assetSelection.length} onClick={confirmAgentAssets}>添加素材</button></footer></section></div>}
            </div>
          </div>
        </section>

        <section className="workspace-launchpad" aria-labelledby="launchpad-title">
          <div className="launchpad-copy">
            <p className="overline">WORKSPACE</p>
            <h2 id="launchpad-title">今天想从哪里开始？</h2>
            <p>选择一个入口，或者直接告诉 Agent 你的想法。</p>
          </div>
          <div className="launchpad-actions">
            <button className="launchpad-primary" type="button" onClick={() => navigate(newCanvasHref())}><span>＋</span><b>新建项目</b><small>创建后直接进入空白画布</small></button>
            <a className="launchpad-secondary" href="/create?tool=image"><span>◐</span><b>快速生成</b><small>一句话生成第一版镜头</small></a>
            <a className="launchpad-secondary" href="#recent-projects"><span>↗</span><b>继续创作</b><small>打开最近使用的项目</small></a>
          </div>
        </section>

        <section className="module-strip workspace-modules" aria-labelledby="module-strip-title">
          <div className="module-strip-head"><div><p className="overline">创作工具</p><h2 id="module-strip-title">专用工具</h2><p>每个工具都连接到同一条创作链路，结果可回到项目继续编辑。</p></div><span className="module-count">4 个模块</span></div>
          <div className="tool-card-row">
            <a className="tool-card" href="/create?tool=image" aria-label="打开图像生成"><span className="tool-icon" aria-hidden="true">◐</span><b>图像生成</b><small>生成首帧与视觉方向</small><span className="tool-card-cta">开始 →</span></a>
            <a className="tool-card" href="/create?tool=video" aria-label="打开视频生成"><span className="tool-icon" aria-hidden="true">▶</span><b>视频生成</b><small>把镜头变成可预览片段</small><span className="tool-card-cta">进入 →</span></a>
            <a className="tool-card" href="/create?tool=upscale" aria-label="打开高清放大"><span className="tool-icon" aria-hidden="true">⤢</span><b>高清放大</b><small>提升清晰度后再导出</small><span className="tool-card-cta">提升 →</span></a>
            <a className="tool-card" href="/create?tool=retake" aria-label="打开局部重做"><span className="tool-icon" aria-hidden="true">✂</span><b>局部重做</b><small>只修改不满意的一镜</small><span className="tool-card-cta">修正 →</span></a>
          </div>
        </section>

        <section className="project-list-head" id="recent-projects">
          <div>
            <p className="overline">项目工作台</p>
            <h2>你的创作项目</h2>
            <p>从参考片到成片，项目、分镜、素材、生成与局部重做保持同一条链路。</p>
          </div>
          <div className="project-list-metrics">
            <span><b><CountUp value={projects.length} /></b>进行中</span>
            <span><b><CountUp value={archived.length} /></b>回收站</span>
            <span><b><CountUp value={projects.reduce((sum, item) => sum + item.shots, 0)} /></b>个镜头</span>
          </div>
        </section>

        <div className="chip-row" role="group" aria-label="按状态筛选项目">
          {statusFilters.map(([value, label]) => (
            <button key={value} type="button" className={statusFilter === value ? 'chip active' : 'chip'} aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}>{label}</button>
          ))}
          <button type="button" className={selectMode ? 'chip active' : 'chip'} aria-pressed={selectMode} onClick={() => { setSelectMode(current => !current); setSelectedIds([]); }}>批量管理</button>
          {selectMode && (
            <>
              <button type="button" className="chip" disabled={selectedIds.length === filteredProjects.length} onClick={() => setSelectedIds(filteredProjects.map(project => project.id))}>全选</button>
              <button type="button" className="chip chip-danger" disabled={selectedIds.length === 0 || busyId === 'bulk'} onClick={() => void archiveSelected()}>归档所选（{selectedIds.length}）</button>
            </>
          )}
        </div>

        <section className="project-toolbar" aria-label="项目筛选">
          <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索项目名称或描述…" />
          <label><span>排序</span><select value={sort} onChange={event => setSort(event.target.value as SortMode)}><option value="updated">最近更新</option><option value="name">项目名称</option><option value="progress">完成进度</option></select></label>
        </section>

        {notice && <div className="project-notice" role="status">{notice}</div>}

        <section className="project-grid" aria-label="进行中的项目">
          {loading && <div className="project-loading">正在读取项目…</div>}
          {!loading && filteredProjects.map((project, index) => (
            <article className="project-card" key={project.id}>
              <button type="button" className={'project-cover cover-tone-' + (index % 4) + (selectMode && selectedIds.includes(project.id) ? ' selected' : '')} onClick={() => (selectMode ? toggleSelected(project.id) : project.primaryProjectId && navigate(canvasHref(project.id, project.primaryProjectId)))} aria-label={'打开项目 ' + project.name}>
                {selectMode && <span className={selectedIds.includes(project.id) ? 'cover-check on' : 'cover-check'} aria-hidden="true">✓</span>}
                <CoverThumb seed={project.id} shots={project.shots} progress={project.progress} tone={index % 4} />
                <img
                  className="cover-thumb-img"
                  src={`/covers/cover-${index % 4}.webp`}
                  alt=""
                  loading="lazy"
                  onError={event => { event.currentTarget.style.display = 'none'; }}
                />
                <span className="cover-veil" aria-hidden="true" />
                <span className="cover-badge">{project.progress}%</span>
                <span className="cover-play" aria-hidden="true">▶</span>
                <b>{project.name}</b>
              </button>
              <div className="project-card-top">
                <div>
                  <p className="overline">{project.state}</p>
                  {renamingId === project.id ? (
                    <form className="inline-rename" onSubmit={event => { event.preventDefault(); void confirmRename(); }}>
                      <input autoFocus value={renameValue} onChange={event => setRenameValue(event.target.value)} aria-label="项目名称" />
                      <button type="submit" disabled={busyId === project.id || !renameValue.trim()}>确定</button>
                      <button type="button" onClick={() => setRenamingId('')}>取消</button>
                    </form>
                  ) : (
                    <p>{project.description}</p>
                  )}
                </div>
              </div>
              <div className="project-progress"><i style={{ width: `${project.progress}%` }} /></div>
              <div className="project-card-meta">
                <span>{project.shots} 个镜头</span>
                <span>{project.assets} 个素材</span>
                <span>预算 {(project.maxBudgetCents / 100).toFixed(2)} 元</span>
                <span>{project.rightsConfirmed ? '权利已确认' : '权利待确认'}</span>
                <span>更新于 {project.updatedAt}</span>
              </div>
              <div className="project-card-actions">
                <button className="project-open" type="button" onClick={() => project.primaryProjectId && navigate(canvasHref(project.id, project.primaryProjectId))}>打开工作台 <span>↗</span></button>
                <button type="button" onClick={() => openSettings(project)}>工作区设置</button>
                <button type="button" onClick={() => { setRenamingId(project.id); setRenameValue(project.name); }}>重命名</button>
                <button type="button" disabled={busyId === project.id} onClick={() => void runProjectAction(project.id, () => ports.workspaces.trash(project.id), '工作区已移入回收站。')}>归档</button>
              </div>
            </article>
          ))}
          {!loading && visibleProjects.length === 0 && <div className="project-empty">没有匹配的项目。</div>}
        </section>

        {archived.length > 0 && (
          <section className="project-archive">
            <div className="project-section-title"><h2>回收站</h2><p>项目可恢复；彻底删除需要逐字输入项目名。</p></div>
            <div className="archive-list">
              {archived.map(project => (
                <div className="archive-row" key={project.id}>
                  <button type="button" onClick={() => project.primaryProjectId && navigate(canvasHref(project.id, project.primaryProjectId))}><div><b>{project.name}</b><small>{project.description}</small></div><span>{project.updatedAt}</span><span className="badge">查看</span></button>
                  <div className="archive-actions">
                    <button type="button" disabled={busyId === project.id} onClick={() => void runProjectAction(project.id, () => ports.workspaces.restore(project.id), '工作区已恢复。')}>恢复</button>
                    <button className="danger" type="button" onClick={() => { setPendingDelete(project); setDeleteConfirmName(''); }}>彻底删除</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
      </div>

      {settingsProject && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSettingsProject(null)}>
          <form className="modal project-settings-modal" onSubmit={saveSettings} onClick={event => event.stopPropagation()}>
            <button className="modal-close" type="button" aria-label="关闭" onClick={() => setSettingsProject(null)}>×</button>
            <p className="overline">WORKSPACE SETTINGS</p><h2>工作区设置</h2>
            <label><span>工作区名称</span><input value={settingsName} onChange={event => setSettingsName(event.target.value)} /></label>
            <div className="settings-facts"><span>{settingsProject.canvasCount} 张画布</span><span>工作区 ID：{settingsProject.id}</span></div>
            <button className="primary full" type="submit">保存工作区设置</button>
          </form>
        </div>
      )}

      {pendingDelete && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPendingDelete(null)}>
          <div className="modal project-delete-modal" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}>
            <p className="overline">PERMANENT DELETE</p><h2>彻底删除项目</h2>
            <p>这会永久删除项目及其本地数据，无法恢复。请输入项目名 <b>{pendingDelete.name}</b> 确认。</p>
            <input value={deleteConfirmName} onChange={event => setDeleteConfirmName(event.target.value)} placeholder={pendingDelete.name} />
            <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setPendingDelete(null)}>取消</button><button className="button danger" type="button" disabled={deleteConfirmName.trim() !== pendingDelete.name} onClick={() => void confirmDelete()}>彻底删除</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
