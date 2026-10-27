import { FormEvent, useEffect, useRef, useState } from 'react';
import { ports, useAppData } from './useAppData';
import { uiStore, useUiStore } from '../state/uiStore';
import type { Asset, CanvasSummary, GenerationJob, ReferenceSource, Shot } from '../ports';
import { rhythmShares, summarizeRhythm } from '../domain/sourceAnalysis';
import { AgentChat } from '../features/agent/AgentChat';
import { Canvas } from '../features/canvas/Canvas';
import { CanvasWorkspace } from '../features/canvas/CanvasWorkspace';
import { TimelineEditor } from '../features/timeline/TimelineEditor';
import { NotFoundPage } from '../features/marketing/NotFoundPage';
import { canvasHref, navigate } from './router';

const sections = [['overview','总览','⌂'],['source','参考片','◌'],['shots','分镜','▦'],['canvas','画布','◇'],['assets','素材库','▧'],['generate','生成工作台','✦'],['director','导演台','◉'],['timeline','剪辑与成片','▤'],['agent','Agent 工作台','✳']];
const statusText = { draft: '草稿', ready: '待审核', approved: '已通过' };
function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: string }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
function Sidebar() { const ui = useUiStore(); return <aside className="workbench-rail"><a className="rail-brand" href="/" aria-label="返回小QTV首页" title="返回首页">Q</a><nav className="rail-nav" aria-label="工作台工具">{sections.map(([id, label, icon]) => <button key={id} className={ui.selectedSection === id ? 'rail-item active' : 'rail-item'} title={label} aria-label={label} onClick={() => uiStore.set({ selectedSection: id })}><span aria-hidden="true">{icon}</span></button>)}</nav><button className="rail-help" aria-label="打开工具说明" title="工具说明" onClick={() => uiStore.set({ rightPanel: true })}>?</button></aside>; }
function Topbar({ workspaceId, workspaceName, projectId, projectName, canvases, onCreated }: { workspaceId?: string; workspaceName: string; projectId: string; projectName: string; canvases: CanvasSummary[]; onCreated: (canvas: CanvasSummary) => void }) {
  const ui = useUiStore();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const openCreate = () => { setName(`未命名画布 ${canvases.length + 1}`); setCreating(true); };
  const createCanvas = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId || !name.trim() || busy) return;
    setBusy(true);
    try {
      const canvas = await ports.canvases.create({ workspaceId, name: name.trim(), description: '', rightsConfirmed: false, maxBudgetCents: 0 });
      onCreated(canvas);
      setCreating(false);
      navigate(canvasHref(workspaceId, canvas.id));
    } finally { setBusy(false); }
  };
  return <><header className="workbench-topbar"><div className="workbench-breadcrumb"><a href="/workbench">{workspaceName}</a><span>/</span>{workspaceId ? <select aria-label="切换画布" value={projectId} onChange={event => navigate(canvasHref(workspaceId, event.target.value))}>{canvases.map(canvas => <option key={canvas.id} value={canvas.id}>{canvas.name}</option>)}</select> : <b>{projectName}</b>}<span>/</span><span>{sections.find(section => section[0] === ui.selectedSection)?.[1]}</span></div><div className="workbench-actions">{workspaceId ? <button className="chrome-button" type="button" onClick={openCreate}>＋ 新建画布</button> : null}<a className="chrome-link" href="/create">创作流程</a><button className="chrome-button" aria-label="打开命令面板" onClick={() => uiStore.set({ commandPaletteOpen: true })}>Ctrl K</button><button className="chrome-button chrome-avatar" aria-label="打开工具说明" onClick={() => uiStore.set({ rightPanel: true })}>Q</button></div></header>{creating ? <div className="modal-backdrop" role="presentation" onClick={() => setCreating(false)}><form className="modal project-create-modal" role="dialog" aria-modal="true" aria-labelledby="new-canvas-title" onSubmit={createCanvas} onClick={event => event.stopPropagation()}><button className="modal-close" type="button" aria-label="关闭" onClick={() => setCreating(false)}>×</button><p className="overline">NEW CANVAS</p><h2 id="new-canvas-title">新建画布</h2><label><span>画布名称</span><input autoFocus value={name} onFocus={event => event.currentTarget.select()} onChange={event => setName(event.target.value)} /></label><div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setCreating(false)}>取消</button><button className="button button-primary" type="submit" disabled={!name.trim() || busy}>{busy ? '创建中…' : '创建画布'}</button></div></form></div> : null}</>;
}
function ToolDrawer({ projectName }: { projectName: string }) { const ui = useUiStore(); if (!ui.rightPanel || ui.selectedSection === 'overview' || ui.selectedSection === 'canvas' || ui.selectedSection === 'agent') return null; const item = sections.find(section => section[0] === ui.selectedSection); return <aside className="workbench-drawer" aria-label={`${item?.[1] ?? '工具'}面板`}><div className="drawer-head"><h2>{item?.[1] ?? '工具'}</h2><button className="drawer-close" aria-label="关闭面板" onClick={() => uiStore.set({ rightPanel: false })}>×</button></div><div className="drawer-body"><p>{projectName} 的{item?.[1] ?? '工具'}。</p><div className="drawer-card"><b>当前视图</b><span>选择画布中的对象后，这里会显示相关操作。</span></div><div className="drawer-card"><b>快速提示</b><span>使用底部控制条管理画布、网格与缩放。</span></div></div></aside>; }
function WorkbenchBottomBar() { const ui = useUiStore(); const [grid, setGrid] = useState(true); const [edges, setEdges] = useState(true); const [miniMap, setMiniMap] = useState(true); const [zoom, setZoom] = useState(100); if (ui.selectedSection === 'canvas') return null; return <div className="workbench-bottom-bar" aria-label="画布控制条"><button className="bottom-control" onClick={() => uiStore.set({ selectedSection: 'assets', rightPanel: true })}>资产管理</button><button className="bottom-control" onClick={() => uiStore.set({ selectedSection: 'canvas' })}>整理画布</button><button className={miniMap ? 'bottom-control active' : 'bottom-control'} onClick={() => setMiniMap(value => !value)} aria-pressed={miniMap}>小地图</button><button className={edges ? 'bottom-control active' : 'bottom-control'} onClick={() => setEdges(value => !value)} aria-pressed={edges}>连线</button><button className={grid ? 'bottom-control active' : 'bottom-control'} onClick={() => setGrid(value => !value)} aria-pressed={grid}>网格吸附</button><div className="zoom-control"><button aria-label="缩小" onClick={() => setZoom(value => Math.max(12, value - 10))}>−</button><span className="zoom-value">{zoom}%</span><button aria-label="放大" onClick={() => setZoom(value => Math.min(200, value + 10))}>＋</button></div></div>; }
function Overview({ projectId, project, shots, jobs, assets }: { projectId: string; project?: ReturnType<typeof useAppData>['project']; shots: Shot[]; jobs: GenerationJob[]; assets: Asset[] }) { const [creating, setCreating] = useState(false); const [title, setTitle] = useState(''); const create = async () => { if (!title.trim()) return; await ports.generation.create(projectId, title, '图像生成'); setTitle(''); setCreating(false); }; const runningJobs = jobs.filter(job => job.status === 'running' || job.status === 'queued').length; return <div className="page"><section className="creative-hero"><div className="hero-copy"><div className="hero-kicker"><span className="pulse-dot" /> 项目进行中</div><p className="eyebrow">项目总览 · 最近同步于 {project?.updatedAt}</p><h1>{project?.name}</h1><p className="subheading">{project?.description}</p><div className="hero-actions"><button className="primary" onClick={() => setCreating(true)}>＋ 发起生成</button><button className="ghost-button" onClick={() => uiStore.set({ selectedSection: 'canvas' })}>进入画布 <span>↗</span></button></div></div></section><div className="stat-grid"><Stat label="项目进度" value={`${project?.progress ?? 0}%`} detail="按当前项目数据" tone="blue" /><Stat label="分镜" value={`${project?.shots ?? shots.length}`} detail="项目内镜头" tone="purple" /><Stat label="素材" value={`${project?.assets ?? assets.length}`} detail="项目内素材" tone="orange" /><Stat label="运行中任务" value={String(runningJobs)} detail="当前队列" tone="green" /></div><div className="content-grid"><section className="panel wide"><div className="panel-head"><div><h2>项目进度</h2><p>从参考片到成片的工作流</p></div><button className="text-button" onClick={() => uiStore.set({ selectedSection: 'shots' })}>查看分镜 →</button></div><div className="progress-track"><div style={{ width: `${project?.progress ?? 0}%` }} /></div><div className="milestones"><Milestone label="参考片分析" done /><Milestone label="分镜设计" done /><Milestone label="素材准备" active /><Milestone label="生成与审核" /><Milestone label="剪辑交付" /></div></section><section className="panel"><div className="panel-head"><div><h2>生成队列</h2><p>实时任务状态</p></div><Badge tone="green">{jobs.length} 个任务</Badge></div>{jobs.slice(0, 3).map(job => <JobRow key={job.id} job={job} />)}<button className="full-button" onClick={() => uiStore.set({ selectedSection: 'generate' })}>打开生成工作台</button></section></div>{creating && <div className="modal-backdrop"><div className="modal"><button className="modal-close" onClick={() => setCreating(false)}>×</button><p className="eyebrow">新建任务</p><h2>发起一次生成</h2><input autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && void create()} placeholder="例如：03 · 楼梯间 · 候选首帧" /><button className="primary full" onClick={() => void create()}>加入队列</button></div></div>}</div>; }
function Stat({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) { return <div className="stat-card"><div className={`stat-icon ${tone}`}>◒</div><div><span>{label}</span><strong>{value}</strong><small className={tone === 'green' ? 'positive' : ''}>{detail}</small></div></div>; }
function Milestone({ label, done, active }: { label: string; done?: boolean; active?: boolean }) { return <div className={`milestone ${done ? 'done' : ''} ${active ? 'active' : ''}`}><span>{done ? '✓' : active ? '•' : '○'}</span><small>{label}</small></div>; }
function JobRow({ job, onRetry }: { job: GenerationJob; onRetry?: (job: GenerationJob) => void }) {
  const running = job.status === 'running' || job.status === 'queued';
  const failed = job.status === 'failed';
  return (
    <div className="job-row">
      <div className={`job-thumb ${running ? 'loading' : 'done-thumb'}`}>{running ? '✦' : failed ? '!' : '✓'}</div>
      <div className="job-info">
        <b>{job.title}</b>
        <small>{job.type} · {job.createdAt}</small>
        {running && <div className="mini-progress"><span style={{ width: `${job.progress}%` }} /></div>}
        {failed && <small className="job-failure">任务失败，可从断点重新提交</small>}
      </div>
      <Badge tone={running ? 'blue' : failed ? 'muted' : 'green'}>{running ? `${job.progress}%` : failed ? '失败' : '完成'}</Badge>
      {failed && onRetry && <button className="text-button job-retry" type="button" onClick={() => onRetry(job)}>重试</button>}
    </div>
  );
}
function Workspace({ projectId, data }: { projectId: string; data: ReturnType<typeof useAppData> }) {
  const section = useUiStore().selectedSection;
  if (section === 'overview') return <Overview projectId={projectId} {...data} />;
  if (section === 'source') return <Sources projectId={projectId} sources={data.sources} refresh={data.refreshSources} />;
  if (section === 'shots') return <Shots shots={data.shots} />;
  if (section === 'assets') return <Assets assets={data.assets} />;
  if (section === 'generate') return <Generation projectId={projectId} jobs={data.jobs} refresh={data.refreshJobs} />;
  if (section === 'director') return <Director shots={data.shots} assets={data.assets} />;
  if (section === 'timeline') return <TimelineEditor projectId={projectId} shots={data.shots} jobs={data.jobs} assets={data.assets} />;
  if (section === 'agent') return <Agent projectId={projectId} />;
  if (section === 'canvas') return <div className="page canvas-page"><Canvas projectId={projectId} /></div>;
  return <Placeholder section={sections.find(s => s[0] === section)?.[1] ?? '工作台'} />;
}
function ModuleToolbar({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) { return <div className="module-toolbar"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{children && <div className="module-actions">{children}</div>}</div>; }
function Sources({ projectId, sources, refresh }: { projectId: string; sources: ReferenceSource[]; refresh: () => Promise<void> }) { const [name, setName] = useState(''); const [genre, setGenre] = useState('知识类口播'); const [busy, setBusy] = useState(false); const submit = async (event: FormEvent) => { event.preventDefault(); if (!name.trim() || busy) return; setBusy(true); await ports.source.create(projectId, name.trim(), genre); await refresh(); setName(''); setBusy(false); }; return <div className="page source-page"><ModuleToolbar eyebrow="参考片" title="建立你的制作参考"><form className="source-import-form" onSubmit={submit}><label><span>名称</span><input value={name} onChange={event => setName(event.target.value)} placeholder="例如：知识口播 · 开场节奏" required /></label><label><span>创作类型</span><select value={genre} onChange={event => setGenre(event.target.value)}><option>知识类口播</option><option>产品广告</option><option>情绪化剧情片</option><option>系列内容</option></select></label><button className="primary" type="submit" disabled={busy}>{busy ? '分析中…' : '导入参考片'}</button></form></ModuleToolbar>{sources.length === 0 ? <div className="empty-state source-empty"><div className="empty-icon">◌</div><h2>还没有参考片</h2><p>导入一条你拥有使用权的视频或音频，先从镜头语言开始建立制作方案。</p></div> : <div className="source-list">{sources.map(source => <SourceCard key={source.id} source={source} />)}</div>}</div>; }
function SourceCard({ source }: { source: ReferenceSource }) { const summary = summarizeRhythm(source.rhythm); const shares = rhythmShares(source.rhythm); return <article className="source-card panel"><div className="source-card-head"><div className="source-thumb" style={{ '--source-accent': source.accent } as React.CSSProperties} aria-hidden="true"><span>{source.kind === 'video' ? '▶' : '♫'}</span></div><div className="source-meta"><h2>{source.name}</h2><p>{source.meta} · {source.genre}</p></div><Badge tone={source.status === 'analyzed' ? 'green' : 'blue'}>{source.status === 'analyzed' ? '已分析' : '分析中'}</Badge></div><div className="source-analysis-grid"><section className="source-rhythm"><div className="source-section-head"><div><h3>镜头节奏</h3><p>{summary.label}</p></div><span className="source-score">紧凑度 {summary.paceScore}</span></div><div className={`rhythm-bar ${shares.length === 0 ? 'is-empty' : ''}`} aria-label={`镜头节奏：${summary.label}`}>{shares.map((share, index) => <span key={`${source.id}-rhythm-${index}`} style={{ width: `${share}%` }} />)}</div></section><section className="source-findings"><div className="source-section-head"><h3>风格分析结论</h3><span>三项观察</span></div><div className="finding-list">{source.findings.slice(0, 3).map(finding => <div className="finding-row" key={finding.key}><div><b>{finding.label}</b><span>{finding.value}</span></div><div className="finding-scale" aria-label={`${finding.label}：刻度 ${finding.score}`}><i style={{ width: `${Math.min(100, Math.max(0, finding.score))}%` }} /></div><small>{finding.score}</small></div>)}</div></section></div></article>; }
function Shots({ shots }: { shots: Shot[] }) { return <div className="page"><ModuleToolbar eyebrow="分镜设计" title="镜头列表"><button className="primary" type="button" onClick={() => uiStore.set({ rightPanel: true })}>＋ 新建镜头</button></ModuleToolbar><div className="shot-list">{shots.map((s, i) => <div className="shot-row" key={s.id}><div className="shot-number">{String(i + 1).padStart(2,'0')}</div><div className={`shot-preview shot-preview-${i % 3}`}><span>▶</span></div><div className="shot-copy"><b>{s.title}</b><small>{s.scene} · {s.duration}</small><p>{s.prompt}</p></div><Badge tone={s.status === 'approved' ? 'green' : s.status === 'ready' ? 'blue' : 'muted'}>{statusText[s.status]}</Badge></div>)}</div></div>; }
function Assets({ assets }: { assets: Asset[] }) { return <div className="page"><ModuleToolbar eyebrow="素材库" title="项目素材"><button className="primary" type="button" onClick={() => uiStore.set({ rightPanel: true })}>＋ 上传素材</button></ModuleToolbar><div className="asset-grid">{assets.map(a => <div className="asset-card" key={a.id}><div className={`asset-cover asset-cover-${a.kind}`}><span>{a.kind === 'video' ? '▶' : a.kind === 'audio' ? '♫' : '✦'}</span></div><b>{a.name}</b><small>{a.meta}</small></div>)}</div></div>; }
function Director({ shots, assets }: { shots: Shot[]; assets: Asset[] }) {
  const approved = shots.filter(shot => shot.status === 'approved').length;
  const referenceAssets = assets.filter(asset => asset.kind === 'image').slice(0, 3);
  return (
    <div className="page director-page">
      <ModuleToolbar eyebrow="导演台" title="镜头语言与主体一致性">
        <button className="primary" type="button" onClick={() => uiStore.set({ rightPanel: true })}>查看导演建议</button>
      </ModuleToolbar>
      <div className="director-grid">
        <section className="panel director-rhythm">
          <div className="panel-head"><div><h2>节奏诊断</h2><p>根据当前分镜读取镜头结构</p></div><Badge tone="blue">{shots.length} 镜</Badge></div>
          <div className="director-bars">{shots.map((shot, index) => <div className="director-bar-row" key={shot.id}><span>0{index + 1}</span><i style={{ width: `${Math.max(34, Math.min(100, Number(shot.duration.split(':')[1] ?? 4) * 18))}%` }} /><small>{shot.duration}</small></div>)}</div>
          <div className="director-summary"><span>已确认镜头 <b>{approved}</b></span><span>待导演复核 <b>{Math.max(0, shots.length - approved)}</b></span></div>
        </section>
        <section className="panel subject-board">
          <div className="panel-head"><div><h2>主体一致性</h2><p>参考图与角色档案</p></div><Badge tone="green">稳定</Badge></div>
          <div className="subject-grid">{referenceAssets.map(asset => <div className="subject-card" key={asset.id}><div className={`asset-cover asset-cover-${asset.kind}`}>✦</div><b>{asset.name}</b><small>{asset.meta}</small></div>)}{referenceAssets.length === 0 && <div className="subject-empty">暂无主体参考图</div>}</div>
        </section>
        <section className="panel director-suggestions">
          <div className="panel-head"><div><h2>导演建议</h2><p>先看建议，再决定是否执行</p></div><Badge tone="muted">待确认</Badge></div>
          <div className="suggestion-list"><article><b>提高开场镜节奏</b><p>把第一镜缩短 0.4 秒，保留结尾留白。</p><button type="button" onClick={() => uiStore.set({ selectedSection: 'shots' })}>查看镜头 →</button></article><article><b>统一主体参考</b><p>把主角参考图应用到后续三个镜头。</p><button type="button" onClick={() => uiStore.set({ selectedSection: 'assets' })}>打开素材库 →</button></article></div>
        </section>
      </div>
    </div>
  );
}

function Generation({ projectId, jobs, refresh }: { projectId: string; jobs: GenerationJob[]; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [pendingRetry, setPendingRetry] = useState<GenerationJob | null>(null);
  const start = async () => {
    setBusy(true);
    try {
      await ports.generation.create(projectId, '新建候选首帧', '图像生成');
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const confirmRetry = async () => {
    if (!pendingRetry) return;
    const job = pendingRetry;
    setPendingRetry(null);
    setBusy(true);
    try {
      await ports.generation.create(projectId, `${job.title} · 断点续作`, job.type);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const running = jobs.filter(job => job.status === 'running' || job.status === 'queued').length;
  const failed = jobs.filter(job => job.status === 'failed').length;

  return (
    <div className="page">
      <ModuleToolbar eyebrow="生成工作台" title="生成任务">
        <button className="primary" type="button" onClick={() => void start()} disabled={busy}>{busy ? '创建中…' : '＋ 新建任务'}</button>
      </ModuleToolbar>
      <div className="generation-layout">
        <div className="panel">
          <div className="panel-head">
            <div><h2>全部任务</h2><p>服务端队列每 3 秒自动轮询，失败任务可从断点重试</p></div>
            <div className="queue-badges">
              <Badge tone="blue">{running ? `${running} 个进行中` : '暂无进行中任务'}</Badge>
              <Badge tone="muted">{failed ? `${failed} 个失败` : '无失败任务'}</Badge>
            </div>
          </div>
          {jobs.map(job => <JobRow key={job.id} job={job} onRetry={item => setPendingRetry(item)} />)}
        </div>
        <div className="panel cost-card">
          <p className="eyebrow">队列概览</p>
          <strong>{jobs.length}</strong>
          <p>当前项目任务总数</p>
          <div className="progress-track"><div style={{ width: `${jobs.length ? Math.round((jobs.filter(job => job.status === 'succeeded').length / jobs.length) * 100) : 0}%` }} /></div>
          <button className="text-button" onClick={() => uiStore.set({ rightPanel: true })}>查看任务说明 →</button>
        </div>
      </div>

      {pendingRetry && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPendingRetry(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}>
            <p className="eyebrow">RESUME FROM CHECKPOINT</p>
            <h2>从断点重新提交？</h2>
            <p>「{pendingRetry.title}」将创建一条新的续作任务；失败的历史记录会保留，便于审计与排查。</p>
            <div className="modal-actions">
              <button className="button button-secondary" type="button" onClick={() => setPendingRetry(null)}>取消</button>
              <button className="button button-primary" type="button" onClick={() => void confirmRetry()}>确认断点续作</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function Agent({ projectId }: { projectId: string }) {
  return <AgentChat key={projectId} projectId={projectId} />;
}
function Placeholder({ section }: { section: string }) { const copy = section === '导演台' ? { title: '导演台还没开工', body: '这里会承载镜头节奏、角色连续性与生成决策。下一步先在参考片和分镜中确认制作方向。' } : section === '剪辑与成片' ? { title: '剪辑与成片还没开工', body: '这里会承载镜头排序、局部修复结果与最终导出。下一步先完成分镜和生成任务。' } : { title: '这个模块还没开工', body: `${section} 的界面会在后续版本中加入，当前可以先使用其他工作台工具。` }; return <div className="page"><ModuleToolbar eyebrow="工作区" title={section} /><div className="empty-state"><div className="empty-icon">◇</div><h2>{copy.title}</h2><p>{copy.body}</p></div></div>; }
function CommandPalette() { const ui = useUiStore(); if (!ui.commandPaletteOpen) return null; return <div className="modal-backdrop" onClick={() => uiStore.set({ commandPaletteOpen: false })}><div className="modal command-modal" onClick={e => e.stopPropagation()}><input autoFocus placeholder="搜索页面、镜头或命令…" onKeyDown={e => { if (e.key === 'Escape') uiStore.set({ commandPaletteOpen: false }); }} /><div className="command-list">{sections.slice(0,6).map(s => <button key={s[0]} onClick={() => { uiStore.set({ selectedSection: s[0], commandPaletteOpen: false }); }}>{s[2]}　{s[1]}<span>⌘ ↵</span></button>)}</div></div></div>; }
/**
 * 工作台面（/workbench/:projectId）。
 *
 * 必须抽成独立组件：原来的两态硬编码把 useState/useEffect 写在提前 return 之后，
 * 违反 Hooks 规则 —— 路径一旦切换触发重渲染，React 会直接报
 * "Rendered more hooks than during the previous render"。
 * 路由化之后路径一定会变，所以这个坑必须在这里填掉。
 *
 * 项目切换改为写路由（replace，不留历史），useAppData 依赖 [projectId] 会自动重取。
 */
export function CanvasRoute({ workspaceId, projectId, newProject }: { workspaceId: string | null; projectId: string | null; newProject: boolean }) {
  const started = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!newProject) {
      if (projectId) uiStore.set({ activeProjectId: projectId, selectedSection: 'canvas', rightPanel: false });
      return;
    }
    if (started.current) return;
    started.current = true;
    void ports.workspaces.create('未命名工作区').then(({ workspace, project }) => {
      uiStore.set({ activeProjectId: project.id, selectedSection: 'canvas', rightPanel: false });
      navigate(canvasHref(workspace.id, project.id), { replace: true });
    }).catch(reason => setError(reason instanceof Error ? reason.message : '创建工作区失败'));
  }, [newProject, projectId]);
  if (newProject) return <div className="page"><div className="empty-state"><div className="empty-icon">＋</div><h2>{error || '正在创建空白画布…'}</h2><p>工作区与画布将使用各自独立的标识。</p></div></div>;
  if (!workspaceId || !projectId) return <NotFoundPage />;
  return <CanvasWorkspace workspaceId={workspaceId} projectId={projectId} />;
}

export function WorkbenchApp({ workspaceId, projectId }: { workspaceId?: string; projectId: string }) {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('section') === 'agent') uiStore.set({ selectedSection: 'agent', rightPanel: false });
  }, [projectId]);
  const [canvases, setCanvases] = useState<Awaited<ReturnType<typeof ports.canvases.list>>>([]);
  const [workspaceName, setWorkspaceName] = useState('当前工作区');
  const data = useAppData(projectId);
  useEffect(() => { void ports.canvases.list(workspaceId).then(setCanvases); if (workspaceId) void ports.workspaces.get(workspaceId).then(space => setWorkspaceName(space?.name ?? '当前工作区')); }, [workspaceId]);
  const project = data.project;
  const projectName = project?.name ?? canvases.find(canvas => canvas.id === projectId)?.name ?? '当前画布';
  const title = workspaceId ? `${workspaceName} / ${projectName}` : projectName;
  return <div className="app-shell workbench-scope"><Sidebar /><main className="workbench-main"><Topbar workspaceId={workspaceId} workspaceName={workspaceName} projectId={projectId} projectName={projectName} canvases={canvases} onCreated={canvas => setCanvases(current => [...current, canvas])} /><div className="workbench-stage"><Workspace projectId={projectId} data={data} /></div><WorkbenchBottomBar /></main><ToolDrawer projectName={title} /><CommandPalette /></div>;
}
