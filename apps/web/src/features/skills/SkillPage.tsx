import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  ArrowUp, Bookmark, Check, ChevronLeft, ChevronRight, Download, ExternalLink, Film, FolderOpen, Github,
  Image as ImageIcon, LoaderCircle, Plus, Search, Sparkles, Trash2, Upload, X,
} from 'lucide-react';
import { canvasHref, navigate } from '../../app/router';
import { ports } from '../../app/useAppData';
import type { AgentReference, Asset } from '../../ports';
import { hasSession } from '../auth/session';
import { agentClient } from '../agent/agentClient';
import { canvasAgentHandoffKey, createCanvasAgentHandoff } from '../agent/canvasAgentHandoff';
import { ProjectRail } from '../workbench/ProjectRail';
import { skillApi, type GitHubInspectResult, type SkillDetail, type SkillInstallCandidate, type SkillSummary, type SkillTab } from './skillApi';
import './skills.css';

const CATEGORIES = ['推荐', '专业影视', '商业广告', '短剧漫剧', '动漫游戏', '音乐MV', '自媒体创作', '通用技能', '发现'];
const tabLabels: Array<{ id: SkillTab; label: string }> = [{ id: 'skill', label: 'Skill' }, { id: 'favorite', label: '收藏' }, { id: 'mine', label: '我的' }];
const mediaLabels = { video: '视频', image: '图片', text: '文本', audio: '音频', general: '通用' } as const;
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '操作失败，请稍后重试。';
const SELECTED_SKILL_KEY = 'qiyin.skill.selected';

function initialQuery() {
  const query = new URLSearchParams(window.location.search);
  const tab = query.get('tab');
  return { tab: tab === 'favorite' || tab === 'mine' ? tab : 'skill' as SkillTab, category: query.get('category') || '推荐', keyword: query.get('keyword') || '' };
}

function persistQuery(tab: SkillTab, category: string, keyword: string) {
  const query = new URLSearchParams();
  if (tab !== 'skill') query.set('tab', tab);
  if (category !== '推荐') query.set('category', category);
  if (keyword.trim()) query.set('keyword', keyword.trim());
  window.history.replaceState(null, '', `/skill${query.size ? `?${query}` : ''}`);
}

function usageText(uses: number) {
  if (uses >= 10_000) return `${(uses / 10_000).toFixed(1).replace(/\.0$/, '')}w`;
  if (uses >= 1000) return `${(uses / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(uses);
}

function isGitHubSkill(item: SkillSummary) {
  try { return new URL(item.source.repository).hostname.toLowerCase() === 'github.com'; }
  catch { return false; }
}

function repositoryOwner(item: SkillSummary) {
  try { return new URL(item.source.repository).pathname.split('/').filter(Boolean)[0] || 'GitHub'; }
  catch { return 'GitHub'; }
}

function sourceFileUrl(item: SkillSummary) {
  if (!isGitHubSkill(item)) return item.source.repository;
  const ref = item.source.commit || item.source.ref || 'main';
  const path = item.source.subdir ? `${item.source.subdir}/SKILL.md` : 'SKILL.md';
  return `${item.source.repository}/blob/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function requireSession(action: string): boolean {
  if (hasSession()) return true;
  sessionStorage.setItem('qiyin.skill.pending', action);
  navigate('/signup?next=/skill');
  return false;
}

export function SkillPage() {
  const initial = useMemo(initialQuery, []);
  const [tab, setTab] = useState<SkillTab>(initial.tab);
  const [category, setCategory] = useState(initial.category);
  const [keyword, setKeyword] = useState(initial.keyword);
  const [debouncedKeyword, setDebouncedKeyword] = useState(initial.keyword);
  const [items, setItems] = useState<SkillSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [draft, setDraft] = useState(() => sessionStorage.getItem('qiyin.skill.draft') ?? '');
  const [notice, setNotice] = useState('');
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachments, setAttachments] = useState<AgentReference[]>([]);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assetPickerBusy, setAssetPickerBusy] = useState(false);
  const [assetOptions, setAssetOptions] = useState<Asset[]>([]);
  const [assetSelection, setAssetSelection] = useState<string[]>([]);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSeed, setImportSeed] = useState<SkillSummary | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const agentTargetRef = useRef<Promise<{ projectId: string; workspaceId: string }> | null>(null);

  useEffect(() => { const timer = window.setTimeout(() => setDebouncedKeyword(keyword), 250); return () => window.clearTimeout(timer); }, [keyword]);
  useEffect(() => { persistQuery(tab, category, debouncedKeyword); }, [tab, category, debouncedKeyword]);

  const load = useCallback(async (nextCursor?: string | null, append = false) => {
    append ? setLoadingMore(true) : setLoading(true);
    setError('');
    try {
      const result = await skillApi.list({ tab, category, keyword: debouncedKeyword, cursor: nextCursor, limit: 20 });
      setItems(current => append ? [...current, ...result.items.filter(item => !current.some(existing => existing.id === item.id))] : result.items);
      setCursor(result.nextCursor);
      setTotal(result.total);
    } catch (reason) { setError(errorText(reason)); if (!append) setItems([]); }
    finally { append ? setLoadingMore(false) : setLoading(false); }
  }, [tab, category, debouncedKeyword]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!cursor || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && !loadingMore) void load(cursor, true); }, { rootMargin: '240px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [cursor, loadingMore, load]);

  useEffect(() => {
    const pending = sessionStorage.getItem('qiyin.skill.pending');
    if (pending && hasSession()) { sessionStorage.removeItem('qiyin.skill.pending'); setNotice('已恢复登录前的 Skill 和创作内容，请继续操作。'); }
    const stored = sessionStorage.getItem(SELECTED_SKILL_KEY);
    if (!stored) return;
    try {
      const reference = JSON.parse(stored) as { id?: unknown; version?: unknown };
      if (typeof reference.id !== 'string' || typeof reference.version !== 'string') throw new Error();
      void skillApi.detail(reference.id).then(skill => {
        if (skill.installed && skill.version === reference.version) setSelectedSkill(skill);
        else sessionStorage.removeItem(SELECTED_SKILL_KEY);
      }).catch(() => sessionStorage.removeItem(SELECTED_SKILL_KEY));
    } catch { sessionStorage.removeItem(SELECTED_SKILL_KEY); }
  }, []);

  async function openDetail(item: SkillSummary) {
    setDetailLoading(true); setError('');
    try { setDetail(await skillApi.detail(item.id)); }
    catch (reason) { setError(errorText(reason)); }
    finally { setDetailLoading(false); }
  }

  async function toggleFavorite(item: SkillSummary) {
    if (!requireSession(`favorite:${item.id}`)) return;
    const next = !item.favorite;
    setItems(current => current.map(value => value.id === item.id ? { ...value, favorite: next } : value));
    if (detail?.id === item.id) setDetail({ ...detail, favorite: next });
    setMutatingId(item.id);
    try { await skillApi.favorite(item.id, next); if (tab === 'favorite' && !next) setItems(current => current.filter(value => value.id !== item.id)); }
    catch (reason) { setItems(current => current.map(value => value.id === item.id ? { ...value, favorite: !next } : value)); setError(errorText(reason)); }
    finally { setMutatingId(null); }
  }

  async function installCatalog(item: SkillSummary) {
    if (!requireSession(`install:${item.id}`)) return;
    setMutatingId(item.id); setError('');
    try {
      const inspected = await skillApi.inspectGitHub({ url: item.source.repository, ref: item.source.ref, subdir: item.source.subdir });
      const candidate = inspected.candidates.find(value => value.subdir === item.source.subdir) ?? inspected.candidates[0];
      if (!candidate) throw new Error('仓库中没有发现可安装的 Skill。');
      const installed = await skillApi.installGitHub({ url: item.source.repository, ref: item.source.ref, subdir: item.source.subdir, candidate_subdir: candidate.subdir || '.', cover_url: item.coverUrl });
      setItems(current => current.map(value => value.id === item.id ? { ...value, ...installed } : value));
      setDetail(installed); setSelectedSkill(installed); sessionStorage.setItem(SELECTED_SKILL_KEY, JSON.stringify({ id: installed.id, version: installed.version })); setNotice(`已添加 ${installed.name}，现在可以输入创作要求。`);
    } catch (reason) { setError(errorText(reason)); }
    finally { setMutatingId(null); }
  }

  function chooseSkill(item: SkillSummary) {
    if (!item.installed) { void installCatalog(item); return; }
    setSelectedSkill(item);
    sessionStorage.setItem(SELECTED_SKILL_KEY, JSON.stringify({ id: item.id, version: item.version }));
    setDetail(null); setNotice(`已选择 ${item.name}`);
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.skill-composer textarea')?.focus());
  }

  function clearSelectedSkill() {
    setSelectedSkill(null);
    sessionStorage.removeItem(SELECTED_SKILL_KEY);
  }

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

  async function uploadLocalFiles(files: FileList | null) {
    const selected = Array.from(files ?? []).slice(0, Math.max(0, 20 - attachments.length));
    if (!selected.length || !requireSession('upload')) return;
    setAttachmentMenuOpen(false);
    setAttachmentBusy(true);
    setError('');
    try {
      const { projectId } = await ensureAgentTarget();
      const uploaded: AgentReference[] = [];
      for (const file of selected) {
        setNotice(`正在上传 ${file.name}…`);
        const asset = await ports.media.upload(projectId, file);
        uploaded.push({ id: asset.id, kind: 'asset', label: asset.name });
      }
      setAttachments(current => [...current, ...uploaded.filter(item => !current.some(existing => existing.id === item.id))].slice(0, 20));
      setNotice(`已添加 ${uploaded.length} 个本地附件`);
    } catch (reason) { setError(errorText(reason)); }
    finally { setAttachmentBusy(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  }

  async function openAssetPicker() {
    if (!requireSession('assets')) return;
    setAttachmentMenuOpen(false);
    setAssetPickerOpen(true);
    setAssetPickerBusy(true);
    setAssetSelection(attachments.filter(reference => reference.kind === 'asset').map(reference => reference.id));
    try {
      const { projectId } = await ensureAgentTarget();
      setAssetOptions(await ports.media.listAssets(projectId));
    } catch (reason) { setError(errorText(reason)); setAssetPickerOpen(false); }
    finally { setAssetPickerBusy(false); }
  }

  function confirmAssetSelection() {
    const selected = assetOptions.filter(asset => assetSelection.includes(asset.id)).map(asset => ({ id: asset.id, kind: 'asset' as const, label: asset.name }));
    setAttachments(current => [...current.filter(reference => reference.kind !== 'asset' || !assetOptions.some(asset => asset.id === reference.id)), ...selected].slice(0, 20));
    setAssetPickerOpen(false);
    if (selected.length) setNotice(`已从素材库添加 ${selected.length} 个附件`);
  }

  async function dispatchToAgent(text: string) {
    if (dispatchBusy) return;
    setDispatchBusy(true);
    setError('');
    try {
      const { projectId, workspaceId } = await ensureAgentTarget();
      const handoff = createCanvasAgentHandoff(text, selectedSkill ? { id: selectedSkill.id, version: selectedSkill.version, name: selectedSkill.name } : undefined, attachments);
      sessionStorage.setItem(canvasAgentHandoffKey(projectId), JSON.stringify(handoff));
      setDraft('');
      sessionStorage.removeItem('qiyin.skill.draft');
      navigate(canvasHref(workspaceId, projectId));
    } catch (reason) {
      setError(errorText(reason));
      setDispatchBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim() || (attachments.length ? '请分析我添加的附件，并结合所选 Skill 给出创作方案。' : '');
    if (!text) return;
    if (!requireSession('send')) { sessionStorage.setItem('qiyin.skill.draft', draft); return; }
    if (selectedSkill && !selectedSkill.installed) return;
    // 这里只启动画布内的分析与方案编排；真实生成、付费和覆盖动作仍在画布内单独确认。
    await dispatchToAgent(text);
  }

  async function removeInstalled(item: SkillSummary) {
    if (!window.confirm(`确认从“我的”中移除 ${item.name}？历史对话中的版本记录会保留。`)) return;
    setMutatingId(item.id);
    try { await skillApi.remove(item.id); setItems(current => current.filter(value => value.id !== item.id)); if (selectedSkill?.id === item.id) clearSelectedSkill(); setDetail(null); }
    catch (reason) { setError(errorText(reason)); }
    finally { setMutatingId(null); }
  }

  return <div className="skill-shell app-shell">
    <ProjectRail active="agent" />
    <main className="skill-main">
      <div className="skill-promo"><span>小QTV Skill 开放体验 · 把成熟工作流直接交给 Agent</span><button type="button" onClick={() => setImportOpen(true)}>从 GitHub 导入</button></div>
      <header className="skill-topbar">
        <div className="skill-search"><Search size={15} /><input aria-label="搜索 Skill" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索 Skill" />{keyword && <button aria-label="清空搜索" onClick={() => setKeyword('')}><X size={14} /></button>}</div>
        <button className="skill-github" type="button" aria-label="从 GitHub 导入" onClick={() => { if (requireSession('import')) { setImportSeed(null); setImportOpen(true); } }}><Github size={16} /><span>导入</span></button>
        <span className="skill-balance" title="尚未接入可核实的额度查询">额度未核实</span><span className="skill-avatar">Q</span>
      </header>

      <section className="skill-hero" aria-labelledby="skill-title">
        <p className="skill-overline">小QTV AGENT SKILLS</p>
        <h1 id="skill-title">一个 Skill，一部作品</h1>
        <form className="skill-composer" onSubmit={submit}>
          {selectedSkill && <div className="skill-chip"><Sparkles size={13} /><span>{selectedSkill.name}</span><small>{selectedSkill.version}</small><button type="button" aria-label={`移除 ${selectedSkill.name}`} onClick={clearSelectedSkill}><X size={13} /></button></div>}
          <textarea aria-label="请输入你的创作灵感，或从下方挑选一个 Skill 开始" value={draft} onChange={event => setDraft(event.target.value)} placeholder="请输入你的创作灵感，或从下方挑选一个 Skill 开始" rows={3} maxLength={8000} />
          {attachments.length ? <div className="skill-attachments" aria-label="已添加附件">{attachments.map(reference => <span key={reference.id}><ImageIcon size={13} /><b>{reference.label}</b><button type="button" aria-label={`移除附件 ${reference.label}`} onClick={() => setAttachments(current => current.filter(item => item.id !== reference.id))}><X size={12} /></button></span>)}</div> : null}
          <div className="skill-composer-foot"><div><div className="skill-attach-control"><button type="button" className={`skill-round${attachmentMenuOpen ? ' active' : ''}`} aria-label="添加附件" aria-haspopup="menu" aria-expanded={attachmentMenuOpen} disabled={attachmentBusy || attachments.length >= 20} onClick={() => setAttachmentMenuOpen(open => !open)}>{attachmentBusy ? <LoaderCircle className="spin" size={16} /> : <Plus size={17} />}</button>{attachmentMenuOpen ? <div className="skill-attach-menu" role="menu"><button type="button" role="menuitem" onClick={() => fileInputRef.current?.click()}><Upload size={15} /><span>本地上传</span></button><button type="button" role="menuitem" onClick={() => void openAssetPicker()}><FolderOpen size={15} /><span>素材库添加</span></button></div> : null}<input ref={fileInputRef} className="skill-file-input" type="file" multiple accept="image/*,video/*,audio/*,.pdf,.txt,.md,.markdown,.doc,.docx,application/pdf,text/plain,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={event => void uploadLocalFiles(event.currentTarget.files)} /></div><span>{attachments.length ? `已添加 ${attachments.length} 个附件` : selectedSkill ? `已启用 ${selectedSkill.name}` : '小Q创作助手'}</span></div><button className="skill-send" type="submit" aria-label="发送给小QTV Agent" disabled={(!draft.trim() && !attachments.length) || dispatchBusy || attachmentBusy}>{dispatchBusy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}</button></div>
        </form>
        {notice && <p className="skill-notice" role="status">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={13} /></button></p>}
      </section>

      <section className="skill-library" aria-label="Skill 库">
        <div className="skill-tabs-row"><div className="skill-tabs" role="tablist">{tabLabels.map(value => <button key={value.id} role="tab" aria-selected={tab === value.id} className={tab === value.id ? 'active' : ''} onClick={() => setTab(value.id)}>{value.label}</button>)}</div>{tab === 'mine' && <button className="skill-import-cta" type="button" onClick={() => { if (requireSession('import')) { setImportSeed(null); setImportOpen(true); } }}><Github size={15} /> 从 GitHub 导入</button>}</div>
        <div className="skill-categories" aria-label="Skill 分类">{CATEGORIES.map(value => <button key={value} className={category === value ? 'active' : ''} onClick={() => setCategory(value)}>{value}</button>)}</div>
        <div className="skill-list-head"><strong>{debouncedKeyword ? `搜索“${debouncedKeyword}”` : tab === 'favorite' ? '我的收藏' : tab === 'mine' ? '我安装的 Skill' : category}</strong><span>{loading ? '加载中…' : `${total} 个 Skill${tab === 'skill' ? ' · 原生 + GitHub 精选' : ''}`}</span></div>
        {error && <div className="skill-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div>}
        {loading ? <div className="skill-grid" aria-label="正在加载">{Array.from({ length: 9 }, (_, index) => <div className="skill-card skeleton" key={index} />)}</div> : items.length ? <div className="skill-grid">{items.map(item => <SkillCard key={item.id} item={item} busy={mutatingId === item.id} onOpen={() => void openDetail(item)} onUse={() => chooseSkill(item)} onFavorite={() => void toggleFavorite(item)} onRemove={tab === 'mine' ? () => void removeInstalled(item) : undefined} />)}</div> : <div className="skill-empty"><Sparkles size={28} /><strong>{tab === 'favorite' ? '还没有收藏 Skill' : tab === 'mine' ? '还没有安装自己的 Skill' : '没有找到匹配的 Skill'}</strong><p>{tab === 'mine' ? '你可以从公开 GitHub 仓库导入标准 SKILL.md。' : '换个关键词或分类试试。'}</p>{tab === 'mine' && <button onClick={() => setImportOpen(true)}><Github size={15} /> 从 GitHub 导入</button>}</div>}
        <div ref={sentinel} className="skill-sentinel">{loadingMore && <LoaderCircle className="spin" size={20} />}</div>
      </section>
    </main>

    {(detail || detailLoading) && <SkillDetailModal detail={detail} loading={detailLoading} busy={detail ? mutatingId === detail.id : false} onClose={() => setDetail(null)} onFavorite={detail ? () => void toggleFavorite(detail) : undefined} onUse={detail ? () => chooseSkill(detail) : undefined} onImport={detail ? () => { setImportSeed(detail); setImportOpen(true); } : undefined} />}
    {assetPickerOpen && <AssetPickerDialog assets={assetOptions} selected={assetSelection} busy={assetPickerBusy} onToggle={id => setAssetSelection(current => current.includes(id) ? current.filter(value => value !== id) : current.length < 20 ? [...current, id] : current)} onClose={() => setAssetPickerOpen(false)} onConfirm={confirmAssetSelection} />}
    {importOpen && <GitHubImportDialog seed={importSeed} onClose={() => { setImportOpen(false); setImportSeed(null); }} onInstalled={installed => { setImportOpen(false); setImportSeed(null); setSelectedSkill(installed); sessionStorage.setItem(SELECTED_SKILL_KEY, JSON.stringify({ id: installed.id, version: installed.version })); setItems(current => current.some(item => item.id === installed.id) ? current.map(item => item.id === installed.id ? { ...item, ...installed } : item) : [installed, ...current]); setNotice(`已安装 ${installed.name}`); }} />}
  </div>;
}

function AssetPickerDialog({ assets, selected, busy, onToggle, onClose, onConfirm }: { assets: Asset[]; selected: string[]; busy: boolean; onToggle: (id: string) => void; onClose: () => void; onConfirm: () => void }) {
  return <div className="skill-modal-backdrop" role="presentation"><section className="skill-asset-dialog" role="dialog" aria-modal="true" aria-label="从素材库添加"><header><div><FolderOpen size={21} /><div><h2>从素材库添加</h2><p>选择当前 Agent 创作项目中的素材，随任务一起交给小Q。</p></div></div><button type="button" aria-label="关闭素材库" onClick={onClose}><X size={18} /></button></header>{busy ? <div className="skill-asset-loading"><LoaderCircle className="spin" size={22} /> 正在读取素材库…</div> : assets.length ? <div className="skill-asset-grid">{assets.map(asset => <button type="button" key={asset.id} className={selected.includes(asset.id) ? 'selected' : ''} aria-pressed={selected.includes(asset.id)} onClick={() => onToggle(asset.id)}><span style={{ background: asset.color }}>{asset.kind === 'video' ? '▶' : asset.kind === 'audio' ? '♫' : asset.kind === 'document' ? 'DOC' : '✦'}</span><div><b>{asset.name}</b><small>{asset.meta}</small></div>{selected.includes(asset.id) ? <Check size={16} /> : null}</button>)}</div> : <div className="skill-asset-empty"><FolderOpen size={26} /><b>素材库暂时为空</b><span>请先使用“本地上传”添加素材。</span></div>}<footer><span>已选择 {selected.length} 项</span><div><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={!selected.length || busy} onClick={onConfirm}>添加素材</button></div></footer></section></div>;
}

function skillHue(id: string) {
  let value = 0;
  for (const character of id) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return value % 360;
}

function GitHubArtwork({ item }: { item: SkillSummary }) {
  const style = { '--skill-hue': skillHue(item.id) } as CSSProperties;
  return <div className={`skill-source-art skill-source-${item.mediaType}`} style={style} aria-hidden="true">
    <Github size={21} />
    <strong>{repositoryOwner(item)}</strong>
    <small>OPEN SOURCE SKILL</small>
  </div>;
}

function SkillCard({ item, busy, onOpen, onUse, onFavorite, onRemove }: { item: SkillSummary; busy: boolean; onOpen: () => void; onUse: () => void; onFavorite: () => void; onRemove?: () => void }) {
  const github = isGitHubSkill(item);
  return <article className={`skill-card${github ? ' github-skill' : ''}`} onClick={onOpen}>
    <div className="skill-cover">{github ? <GitHubArtwork item={item} /> : <img src={item.coverUrl || '/covers/cover-0.webp'} alt="" />}<span className="skill-media">{item.mediaType === 'image' ? <ImageIcon size={12} /> : <Film size={12} />}{mediaLabels[item.mediaType]}</span><span className="skill-key">/{item.id}</span></div>
    <div className="skill-card-body"><div className="skill-card-title"><h3>{item.name}</h3><button type="button" aria-label={item.favorite ? `取消收藏 ${item.name}` : `收藏 ${item.name}`} className={item.favorite ? 'favorite active' : 'favorite'} disabled={busy} onClick={event => { event.stopPropagation(); onFavorite(); }}>{busy ? <LoaderCircle className="spin" size={14} /> : <Bookmark size={15} fill={item.favorite ? 'currentColor' : 'none'} />}</button></div><p>{item.description}</p><footer><span>{item.author}</span><span>{github ? <><Github size={11} /> GitHub</> : usageText(item.uses)}</span></footer><div className="skill-card-actions">{onRemove && <button className="remove" aria-label={`移除 ${item.name}`} onClick={event => { event.stopPropagation(); onRemove(); }}><Trash2 size={14} /></button>}<button className="use" type="button" onClick={event => { event.stopPropagation(); onUse(); }}>{item.installed ? '使用' : <><Download size={13} /> 添加</>}</button></div></div>
  </article>;
}

function SkillDetailModal({ detail, loading, busy, onClose, onFavorite, onUse, onImport }: { detail: SkillDetail | null; loading: boolean; busy: boolean; onClose: () => void; onFavorite?: () => void; onUse?: () => void; onImport?: () => void }) {
  const [previewIndex, setPreviewIndex] = useState(0);
  const previews = detail ? [...new Set([detail.coverUrl || '/covers/cover-0.webp', '/covers/hero-scene.webp'])] : [];
  useEffect(() => { setPreviewIndex(0); }, [detail?.id]);
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [onClose]);
  return <div className="skill-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="skill-detail-modal" role="dialog" aria-modal="true" aria-label={detail?.name ?? 'Skill 详情'}><button className="skill-modal-close" aria-label="关闭 Skill 详情" onClick={onClose}><X size={20} /></button>{loading || !detail ? <div className="skill-modal-loading"><LoaderCircle className="spin" size={28} /> 正在读取 Skill…</div> : <><div className="skill-detail-hero"><div className="skill-detail-cover">{isGitHubSkill(detail) ? <GitHubArtwork item={detail} /> : <><img src={previews[previewIndex]} alt={`${detail.name} 预览 ${previewIndex + 1}`} /><button aria-label="上一项" onClick={() => setPreviewIndex(index => (index - 1 + previews.length) % previews.length)}><ChevronLeft size={18} /></button><button aria-label="下一项" onClick={() => setPreviewIndex(index => (index + 1) % previews.length)}><ChevronRight size={18} /></button><span className="skill-preview-time">0:00 / 0:15</span><span>{previewIndex + 1}/{previews.length}</span></>}</div><div className="skill-detail-summary"><span className="skill-detail-path">/{detail.id}</span><h2>{detail.name}</h2><p>{detail.author}</p><div><span>{detail.category}</span><span>{detail.uses > 0 ? `${usageText(detail.uses)} 使用` : detail.source.kind === 'catalog' ? 'GitHub 来源' : '尚无使用记录'}</span><span>v{detail.version}</span></div><button className="skill-add-button" disabled={busy} onClick={detail.installed ? onUse : onImport}>{busy ? <LoaderCircle className="spin" size={16} /> : detail.installed ? <Sparkles size={16} /> : <Download size={16} />}{detail.installed ? '使用此 Skill' : '添加 Skill'}</button></div></div><div className="skill-detail-sections"><section><h3>简介</h3><p>{detail.description}</p></section>{detail.usageScenario && <section><h3>使用场景</h3><p>{detail.usageScenario}</p></section>}{detail.inputs && <section><h3>如何使用</h3><p>{detail.inputs}</p></section>}{detail.output && <section><h3>输出内容</h3><p>{detail.output}</p></section>}<section><h3>来源与安全</h3><p>{detail.source.kind === 'catalog' ? <>{isGitHubSkill(detail) ? <><a href={sourceFileUrl(detail)} target="_blank" rel="noreferrer">查看原始 SKILL.md <ExternalLink size={12} /></a>{detail.source.ref && <small>固定提交 {detail.source.ref.slice(0, 10)}</small>}</> : <>小QTV 内置创作工作流 · 已通过服务端版本校验</>}</> : <><a href={sourceFileUrl(detail)} target="_blank" rel="noreferrer">{detail.source.repository}<ExternalLink size={12} /></a>{detail.source.commit ? ` · ${detail.source.commit.slice(0, 8)}` : ''}{detail.hasScripts ? ' · 包含 scripts（不会自动执行）' : ''}</>}</p></section></div><footer className="skill-detail-footer"><button onClick={onFavorite}>{detail.favorite ? <Check size={15} /> : <Bookmark size={15} />}{detail.favorite ? '已收藏' : '收藏'}</button><button className="primary" onClick={detail.installed ? onUse : onImport}>{detail.installed ? '使用此 Skill' : '从 GitHub 添加'}</button></footer></>}</section></div>;
}

function GitHubImportDialog({ seed, onClose, onInstalled }: { seed: SkillSummary | null; onClose: () => void; onInstalled: (skill: SkillDetail) => void }) {
  const [url, setUrl] = useState(seed?.source.repository ?? '');
  const [ref, setRef] = useState(seed?.source.ref ?? '');
  const [subdir, setSubdir] = useState(seed?.source.subdir ?? '');
  const [inspection, setInspection] = useState<GitHubInspectResult | null>(null);
  const [selected, setSelected] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function inspect(event?: FormEvent) {
    event?.preventDefault(); setBusy(true); setError(''); setInspection(null);
    try { const result = await skillApi.inspectGitHub({ url, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}) }); setInspection(result); setSelected(result.candidates[0]?.subdir || '.'); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  async function install() {
    if (!selected || !trusted) return; setBusy(true); setError('');
    try { onInstalled(await skillApi.installGitHub({ url, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}), candidate_subdir: selected, ...(seed?.coverUrl ? { cover_url: seed.coverUrl } : {}) })); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (seed) void inspect(); }, []);
  return <div className="skill-modal-backdrop" role="presentation"><section className="skill-import-dialog" role="dialog" aria-modal="true" aria-label="从 GitHub 导入 Skill"><header><div><Github size={22} /><div><h2>从 GitHub 导入 Skill</h2><p>读取公开仓库中的标准 SKILL.md，安装为小QTV 自己的 Skill。</p></div></div><button aria-label="关闭导入" onClick={onClose}><X size={19} /></button></header><form onSubmit={inspect}><label>GitHub 仓库地址<input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" required /></label><div className="skill-import-inline"><label>Ref（可选）<input value={ref} onChange={event => setRef(event.target.value)} placeholder="main / tag" /></label><label>Skill 子目录（可选）<input value={subdir} onChange={event => setSubdir(event.target.value)} placeholder="skills/my-skill" /></label></div><button className="inspect" type="submit" disabled={busy || !url.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}检查仓库</button></form>{error && <p className="skill-import-error" role="alert">{error}</p>}{inspection && <div className="skill-candidates"><div className="skill-commit"><Check size={14} /> 已读取 commit {inspection.commit.slice(0, 10)}</div>{inspection.candidates.map(candidate => <Candidate key={candidate.candidateId} candidate={candidate} selected={selected === candidate.subdir} onSelect={() => setSelected(candidate.subdir || '.')} />)}<label className="skill-trust"><input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} /><span>我确认信任该公开仓库的 Skill 说明。小QTV 不会自动执行其中脚本，付费和项目修改仍需单独确认。</span></label><button className="skill-install" disabled={!trusted || !selected || busy} onClick={() => void install()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}安装所选 Skill</button></div>}</section></div>;
}

function Candidate({ candidate, selected, onSelect }: { candidate: SkillInstallCandidate; selected: boolean; onSelect: () => void }) {
  return <button type="button" className={selected ? 'skill-candidate active' : 'skill-candidate'} onClick={onSelect}><span className="candidate-check">{selected && <Check size={14} />}</span><span><strong>{candidate.name}</strong><small>/{candidate.subdir || '.'} · v{candidate.version}</small><p>{candidate.description}</p><em>{candidate.files.length} 个文件{candidate.hasScripts ? ' · 包含 scripts' : ''}{candidate.license ? ` · ${candidate.license}` : ''}</em></span></button>;
}
