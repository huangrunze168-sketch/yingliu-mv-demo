import { useEffect, useState } from 'react';
import type { AgentMessage } from './agentClient';

export type CreativePlan = {
  kind: 'plan';
  title: string;
  direction: string;
  aspectRatio: '9:16' | '16:9' | '1:1';
  shots: Array<{ id: string; title: string; visual: string; narration: string; durationSeconds: number }>;
};

export function parsePlanMessage(message: AgentMessage): CreativePlan | null {
  if (message.role !== 'plan') return null;
  try {
    const value = JSON.parse(message.text) as CreativePlan;
    if (value.kind !== 'plan' || !Array.isArray(value.shots) || !value.shots.length || typeof value.title !== 'string') return null;
    return value;
  } catch { return null; }
}

type Props = { plan: CreativePlan; planId: string; approved: boolean; busy: boolean; onSave: (planId: string, plan: CreativePlan) => Promise<boolean>; onApprove: (planId: string) => Promise<boolean> };

export function CreativePlanCard({ plan: initial, planId, approved, busy, onSave, onApprove }: Props) {
  const [plan, setPlan] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [favorite, setFavorite] = useState(() => { try { return window.localStorage.getItem(`qiyin.agent.favorite.${planId}`) === '1'; } catch { return false; } });
  useEffect(() => { try { window.localStorage.setItem(`qiyin.agent.favorite.${planId}`, favorite ? '1' : '0'); } catch { /* 隐私模式下收藏仅保留在当前状态 */ } }, [favorite, planId]);
  const changed = JSON.stringify(plan) !== JSON.stringify(initial);
  const ready = !!plan.title.trim() && !!plan.direction.trim()
    && plan.shots.every(shot => shot.title.trim() && shot.visual.trim() && Number.isInteger(shot.durationSeconds) && shot.durationSeconds > 0 && shot.durationSeconds <= 60);
  const updateShot = (index: number, patch: Partial<CreativePlan['shots'][number]>) => {
    setPlan(current => ({ ...current, shots: current.shots.map((shot, at) => at === index ? { ...shot, ...patch } : shot) }));
  };
  const save = async () => {
    setSaving(true);
    setNotice('');
    try { if (!await onSave(planId, plan)) setNotice('保存失败，请检查下方提示后重试。'); }
    finally { setSaving(false); }
  };
  const approve = async () => {
    setSaving(true);
    setNotice('');
    try { if (!await onApprove(planId)) setNotice('确认失败，请检查下方提示后重试。'); }
    finally { setSaving(false); }
  };
  const copy = async () => {
    const text = [plan.title, plan.direction, ...plan.shots.map((shot, index) => `镜头 ${index + 1}：${shot.title}\n画面：${shot.visual}\n旁白：${shot.narration}\n时长：${shot.durationSeconds} 秒`)].join('\n\n');
    try { await navigator.clipboard.writeText(text); setNotice('方案已复制'); } catch { setNotice('复制失败，请手动选择方案内容'); }
  };
  return <section className="hero-creative-plan" aria-label="可编辑创作方案">
    <header><span>创作方案 · {approved ? '已确认' : '待确认'}</span><div className="hero-creative-card-actions"><small>{plan.shots.length} 镜 · {plan.shots.reduce((seconds, shot) => seconds + (shot.durationSeconds || 0), 0)} 秒</small><button type="button" aria-label="复制创作方案" title="复制创作方案" onClick={() => void copy()}>⧉</button><button type="button" aria-label={favorite ? '取消收藏创作方案' : '收藏创作方案'} title={favorite ? '取消收藏' : '收藏'} onClick={() => setFavorite(value => !value)}>{favorite ? '★' : '☆'}</button></div></header>
    <label>片名<input aria-label="方案片名" value={plan.title} disabled={approved || busy || saving} maxLength={100} onChange={event => setPlan(current => ({ ...current, title: event.target.value }))} /></label>
    <label>创作方向<textarea aria-label="创作方向" value={plan.direction} disabled={approved || busy || saving} maxLength={600} onChange={event => setPlan(current => ({ ...current, direction: event.target.value }))} /></label>
    <label>画幅<select aria-label="方案画幅" value={plan.aspectRatio} disabled={approved || busy || saving} onChange={event => setPlan(current => ({ ...current, aspectRatio: event.target.value as CreativePlan['aspectRatio'] }))}><option value="9:16">9:16 竖屏</option><option value="16:9">16:9 横屏</option><option value="1:1">1:1 方形</option></select></label>
    <div className="hero-creative-shots">{plan.shots.map((shot, index) => <fieldset key={shot.id} disabled={approved || busy || saving}>
      <legend>镜头 {index + 1}</legend>
      <label>镜头标题<input aria-label={`镜头 ${index + 1} 标题`} value={shot.title} maxLength={80} onChange={event => updateShot(index, { title: event.target.value })} /></label>
      <label>画面描述<textarea aria-label={`镜头 ${index + 1} 画面`} value={shot.visual} maxLength={800} onChange={event => updateShot(index, { visual: event.target.value })} /></label>
      <label>旁白<input aria-label={`镜头 ${index + 1} 旁白`} value={shot.narration} maxLength={400} onChange={event => updateShot(index, { narration: event.target.value })} /></label>
      <label>时长（秒）<input aria-label={`镜头 ${index + 1} 时长`} type="number" min={1} max={60} value={shot.durationSeconds} onChange={event => updateShot(index, { durationSeconds: Number(event.target.value) })} /></label>
    </fieldset>)}</div>
    {!approved && <div className="hero-creative-actions">
      {changed && <button type="button" disabled={busy || saving || !ready} onClick={() => void save()}>保存修改</button>}
      <button type="button" disabled={busy || saving || !ready || changed} onClick={() => void approve()}>确认方案</button>
    </div>}
    {changed && !approved && <p className="hero-creative-hint">请先保存修改，再确认方案；确认不会自动触发付费生成。</p>}
    {approved && <p className="hero-creative-hint" role="status">方案已确认并绑定项目分镜。尚未启动生成、未产生预览或费用；如需制作首帧，请在下方选择真实后端并确认预算。</p>}
    {notice && <p className="hero-creative-hint" role="alert">{notice}</p>}
  </section>;
}
