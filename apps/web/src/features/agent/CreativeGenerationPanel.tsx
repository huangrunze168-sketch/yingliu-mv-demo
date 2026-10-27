import { useEffect, useState } from 'react';
import { agentClient, type AgentMessage, type GenerationBackendInfo, type ImageGenerationOptions } from './agentClient';
import type { CreativePlan } from './CreativePlanCard';

type Progress = { phase: 'running' | 'completed' | 'partial' | 'failed' | 'unknown'; done: number; total: number; kind?: 'image' | 'video'; failures?: Array<{ shotId: string; reason: string }> };
type Asset = { shotId: string; artifactId: string; url: string; kind?: 'image' | 'video'; reused?: boolean };

function FirstFrameTile({ asset, title, selected, busy, canRework, onSelect, onRework }: {
  asset: Asset; title: string; selected: boolean; busy: boolean; canRework: boolean;
  onSelect: () => void; onRework: () => void;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [asset.url]);
  return <figure>{broken ? <p role="alert">首帧已登记，但预览文件不可用，不能选作视频输入。</p>
    : <img src={asset.url} alt={`${title} 首帧预览`} loading="lazy" onError={() => setBroken(true)} />}
    <figcaption>{title} · {asset.reused ? '复用已有产物' : '真实产物'}</figcaption>
    <button type="button" disabled={busy || selected || broken} onClick={onSelect}>{selected ? '已选为视频首帧' : '选为视频首帧'}</button>
    <button type="button" disabled={busy || !canRework} onClick={onRework}>重做此镜首帧</button>
  </figure>;
}

function progressFrom(message: AgentMessage): Progress | null {
  if (message.role !== 'progress') return null;
  try {
    const value = JSON.parse(message.text) as Progress;
    if (!['running', 'completed', 'partial', 'failed', 'unknown'].includes(value.phase) || !Number.isInteger(value.done) || !Number.isInteger(value.total)) return null;
    return value;
  } catch { return null; }
}
function assetFrom(message: AgentMessage): Asset | null {
  if (message.role !== 'asset') return null;
  try {
    const value = JSON.parse(message.text) as Asset;
    if (!/^shot-(?:0[1-9]|1[0-2])$/.test(value.shotId) || !/^sha256:[a-f0-9]{64}$/.test(value.artifactId)
      || value.kind === 'video' || !value.url.startsWith('/api/v1/agent/projects/') || !value.url.includes('/images/')) return null;
    return value;
  } catch { return null; }
}
const cents = (value: string): number => Math.round(Number(value) * 100);

type Props = {
  plan: CreativePlan; planId: string; messages: AgentMessage[]; busy: boolean; running: boolean;
  onGenerate: (planId: string, options: ImageGenerationOptions) => Promise<boolean>;
  onSelectFrame: (planId: string, shotId: string, artifactId: string) => Promise<boolean>;
};

export function CreativeGenerationPanel({ plan, planId, messages, busy, running, onGenerate, onSelectFrame }: Props) {
  const [backends, setBackends] = useState<GenerationBackendInfo[]>([]);
  const [backend, setBackend] = useState('');
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState('');
  const [perShot, setPerShot] = useState('');
  const [rights, setRights] = useState(false);
  const [confirmCosts, setConfirmCosts] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void agentClient.generationBackends().then(items => { if (active) setBackends(items); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '无法读取生成后端'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const progressMessages = messages.map(progressFrom).filter((item): item is Progress => item !== null && item.kind !== 'video');
  const current = progressMessages[progressMessages.length - 1] ?? null;
  const assets = messages.map(assetFrom).filter((item): item is Asset => item !== null);
  const latestAssets = new Map<string, Asset>();
  for (const item of assets) latestAssets.set(item.shotId, item);
  const selectedFrames = new Map<string, string>();
  for (const message of messages) if (message.role === 'selection') {
    try {
      const selection = JSON.parse(message.text) as { shotId: string; artifactId: string };
      if (/^shot-(?:0[1-9]|1[0-2])$/.test(selection.shotId) && /^sha256:[a-f0-9]{64}$/.test(selection.artifactId)) selectedFrames.set(selection.shotId, selection.artifactId);
    } catch { /* 旧版会话中的非法选帧记录不得影响界面状态。 */ }
  }
  const runningNow = running || busy;
  const cap = cents(budget);
  const estimate = cents(perShot);
  const valid = (backend === 'canvas' || backend === 'imagegen') && backends.some(item => item.id === backend && item.installed)
    && !!model.trim() && Number.isInteger(cap) && cap > 0 && cap <= 1_000_000
    && Number.isInteger(estimate) && estimate > 0 && estimate <= 1_000_000 && rights && confirmCosts;
  const submit = async (shotId?: string) => {
    if (!valid || runningNow) return;
    setError('');
    const options: ImageGenerationOptions = {
      backend: backend as ImageGenerationOptions['backend'], model: model.trim(),
      budget_cap_cents: cap, estimated_cost_cents_per_shot: estimate,
      rights_confirmed: rights, confirm_costs: true,
      ...(shotId ? { shot_id: shotId } : {}),
    };
    if (estimate * (shotId ? 1 : plan.shots.length) > cap) { setError('本次预估费用超过输入的项目预算上限。'); return; }
    if (await onGenerate(planId, options)) setConfirmCosts(false);
  };
  return <section className="hero-generation" aria-label="真实生成任务">
    <header><strong>制作任务 · 首帧</strong><span>{current?.phase === 'running' && running ? `实际执行 ${current.done}/${current.total}` : current?.phase === 'completed' ? '首帧任务已完成，预览需核验' : current?.phase === 'partial' ? '部分成功' : current?.phase === 'failed' ? '本次失败' : '未启动'}</span></header>
    {current?.phase === 'running' && !running && <p role="status">服务已中断，本次生成状态尚未核实。请检查项目记录与产物，不要直接重复付费。</p>}
    {current?.phase === 'unknown' && <p role="status">生成结果未确认。请先核对项目中的真实产物和费用。</p>}
    {current?.failures?.length ? <p role="status">失败镜头：{current.failures.map(item => `${item.shotId}（${item.reason}）`).join('、')}</p> : null}
    {assets.length > 0 && <div className="hero-generation-assets">{plan.shots.map(shot => {
      const asset = latestAssets.get(shot.id);
      return asset ? <FirstFrameTile key={`${shot.id}:${asset.artifactId}`} asset={asset} title={shot.title}
        selected={selectedFrames.get(shot.id) === asset.artifactId} busy={runningNow} canRework={valid}
        onSelect={() => void onSelectFrame(planId, shot.id, asset.artifactId)} onRework={() => void submit(shot.id)} /> : null;
    })}</div>}
    <div className="hero-generation-config">
      <label>生成后端<select aria-label="真实生成后端" value={backend} disabled={loading || runningNow} onChange={event => { setBackend(event.target.value); setModel(''); }}><option value="">请选择</option>{backends.map(item => <option key={item.id} value={item.id} disabled={!item.installed}>{item.label}{item.installed ? '（已安装，登录待核实）' : '（未安装）'}</option>)}</select></label>
      <label>模型名称<input aria-label="真实生成模型" value={model} disabled={runningNow} maxLength={120} placeholder={backend === 'canvas' ? '例如 Z-image Turbo' : '填写服务商的实际模型版本'} onChange={event => setModel(event.target.value)} /></label>
      <label>项目预算上限（元）<input aria-label="项目预算上限" type="number" min="0.01" step="0.01" value={budget} disabled={runningNow} onChange={event => setBudget(event.target.value)} /></label>
      <label>每镜预估费用（元）<input aria-label="每镜预估费用" type="number" min="0.01" step="0.01" value={perShot} disabled={runningNow} onChange={event => setPerShot(event.target.value)} /></label>
      <label className="hero-generation-check"><input type="checkbox" checked={rights} disabled={runningNow} onChange={event => setRights(event.target.checked)} />我确认对提供的素材拥有必要的使用权</label>
      <label className="hero-generation-check"><input type="checkbox" checked={confirmCosts} disabled={runningNow} onChange={event => setConfirmCosts(event.target.checked)} />我已核对服务商报价，确认本次可能产生真实费用</label>
    </div>
    <p className="hero-creative-hint">预算用于项目预留和领域闸门；服务商实际扣费可能以积分计，不能把预估金额当作供应商计费保证。视频生成须另行选定首帧并确认预算，不会在此自动启动。</p>
    {error && <p role="alert">{error}</p>}
    <button className="hero-generation-start" type="button" disabled={loading || runningNow || !valid || estimate * plan.shots.length > cap} onClick={() => void submit()}>确认并生成 {plan.shots.length} 镜首帧</button>
  </section>;
}
