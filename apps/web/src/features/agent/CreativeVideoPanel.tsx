import { useEffect, useState } from 'react';
import { agentClient, type AgentMessage, type GenerationBackendInfo, type VideoGenerationOptions } from './agentClient';
import type { CreativePlan } from './CreativePlanCard';

type VideoProgress = { kind: 'video'; phase: 'running' | 'completed' | 'partial' | 'failed' | 'unknown'; done: number; total: number; failures?: Array<{ shotId: string; reason: string }> };
type Clip = { kind: 'video'; shotId: string; artifactId: string; firstFrameArtifactId?: string; url: string; reused?: boolean };
const money = (value: string) => Math.round(Number(value) * 100);

function ClipPreview({ clip, title }: { clip: Clip; title: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [clip.url]);
  return failed ? <p role="alert">视频已登记，但当前文件无法播放。请检查项目产物与费用。</p>
    : <video controls preload="metadata" src={clip.url} aria-label={`${title} 视频预览`} onError={() => setFailed(true)} />;
}

export function CreativeVideoPanel({ plan, planId, messages, busy, running, onGenerate }: {
  plan: CreativePlan; planId: string; messages: AgentMessage[]; busy: boolean; running: boolean;
  onGenerate: (planId: string, options: VideoGenerationOptions) => Promise<boolean>;
}) {
  const [backends, setBackends] = useState<GenerationBackendInfo[]>([]);
  const [backend, setBackend] = useState('');
  const [model, setModel] = useState('');
  const [projectBudget, setProjectBudget] = useState('');
  const [videoBudget, setVideoBudget] = useState('');
  const [estimate, setEstimate] = useState('');
  const [rights, setRights] = useState(false);
  const [confirmCosts, setConfirmCosts] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void agentClient.generationBackends().then(items => { if (active) setBackends(items); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '无法读取视频后端'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const selected = new Map<string, string>();
  const clips = new Map<string, Clip>();
  const progress: VideoProgress[] = [];
  for (const message of messages) {
    try {
      const item = JSON.parse(message.text) as Record<string, unknown>;
      if (message.role === 'selection' && typeof item.shotId === 'string' && typeof item.artifactId === 'string') selected.set(item.shotId, item.artifactId);
      if (message.role === 'asset' && item.kind === 'video' && typeof item.shotId === 'string' && typeof item.artifactId === 'string' && typeof item.url === 'string'
        && /^shot-(?:0[1-9]|1[0-2])$/.test(item.shotId) && /^sha256:[a-f0-9]{64}$/.test(item.artifactId) && item.url.startsWith('/api/v1/agent/projects/') && item.url.includes('/videos/')) clips.set(item.shotId, item as Clip);
      if (message.role === 'progress' && item.kind === 'video' && typeof item.phase === 'string'
        && ['running', 'completed', 'partial', 'failed', 'unknown'].includes(item.phase)) progress.push(item as VideoProgress);
    } catch { /* 历史工具日志不作为视频结果呈现。 */ }
  }
  const phase = progress[progress.length - 1];
  const selectedCount = plan.shots.filter(shot => selected.has(shot.id)).length;
  const totalCap = money(projectBudget), videoCap = money(videoBudget), perShot = money(estimate);
  const ready = selectedCount === plan.shots.length && (backend === 'canvas' || backend === 'imagegen')
    && backends.some(item => item.id === backend && item.installed) && !!model.trim()
    && [totalCap, videoCap, perShot].every(value => Number.isInteger(value) && value > 0 && value <= 1_000_000)
    && rights && confirmCosts;
  const submit = async (shotId?: string) => {
    if (!ready || running || busy) return;
    const cost = perShot * (shotId ? 1 : plan.shots.length);
    if (cost > videoCap || cost > totalCap) { setError('本次预估费用超过独立视频预算或项目上限。'); return; }
    setError('');
    const options: VideoGenerationOptions = {
      backend: backend as VideoGenerationOptions['backend'], model: model.trim(), budget_cap_cents: totalCap,
      video_budget_cents: videoCap, estimated_cost_cents_per_shot: perShot, rights_confirmed: rights, confirm_costs: true,
      ...(shotId ? { shot_id: shotId } : {}),
    };
    if (await onGenerate(planId, options)) setConfirmCosts(false);
  };
  return <section className="hero-generation hero-video" aria-label="真实视频生成任务">
    <header><strong>制作任务 · 图生视频</strong><span>{phase?.phase === 'running' && running ? `实际执行 ${phase.done}/${phase.total}` : phase?.phase === 'completed' ? '供应商任务已完成，预览需核验' : phase?.phase === 'partial' ? '部分成功' : phase?.phase === 'failed' ? '本次失败' : `${selectedCount}/${plan.shots.length} 镜已选首帧`}</span></header>
    {selectedCount < plan.shots.length && <p role="status">请先为每一镜选定经校验的首帧；未完成前无法批准 G2 或调用付费视频模型。</p>}
    {phase?.phase === 'running' && !running && <p role="status">服务中断，本次视频状态未核实；请先检查项目记录，不要直接重复付费。</p>}
    {phase?.phase === 'unknown' && <p role="status">视频生成状态未知，请先核对服务商任务、项目产物与费用。</p>}
    {phase?.failures?.length ? <p role="status">失败镜头：{phase.failures.map(item => `${item.shotId}（${item.reason}）`).join('、')}</p> : null}
    {clips.size > 0 && <div className="hero-generation-assets">{plan.shots.map(shot => {
      const clip = clips.get(shot.id);
      const frameChanged = selected.has(shot.id) && clip?.firstFrameArtifactId !== selected.get(shot.id);
      return clip ? <figure key={shot.id}><ClipPreview clip={clip} title={shot.title} /><figcaption>{shot.title} · {frameChanged ? '历史片段：当前首帧不同或来源待核实，需重做' : clip.reused ? '复用已核验片段' : '真实项目视频'}</figcaption>
        <button type="button" disabled={busy || running || !ready} onClick={() => void submit(shot.id)}>只重做此镜视频</button>
      </figure> : null;
    })}</div>}
    <div className="hero-generation-config">
      <label>视频后端<select aria-label="真实视频生成后端" value={backend} disabled={loading || busy || running} onChange={event => { setBackend(event.target.value); setModel(''); }}><option value="">请选择</option>{backends.map(item => <option key={item.id} value={item.id} disabled={!item.installed}>{item.label}{item.installed ? '（已安装，登录待核实）' : '（未安装）'}</option>)}</select></label>
      <label>视频模型名称<input aria-label="真实视频模型" value={model} disabled={busy || running} maxLength={120} placeholder="填写已开通的实际图生视频模型" onChange={event => setModel(event.target.value)} /></label>
      <label>项目预算上限（元）<input aria-label="视频项目预算上限" type="number" min="0.01" step="0.01" value={projectBudget} disabled={busy || running} onChange={event => setProjectBudget(event.target.value)} /></label>
      <label>本次 G2 视频预算（元）<input aria-label="独立视频预算" type="number" min="0.01" step="0.01" value={videoBudget} disabled={busy || running} onChange={event => setVideoBudget(event.target.value)} /></label>
      <label>每镜视频预估费用（元）<input aria-label="每镜视频预估费用" type="number" min="0.01" step="0.01" value={estimate} disabled={busy || running} onChange={event => setEstimate(event.target.value)} /></label>
      <label className="hero-generation-check"><input type="checkbox" checked={rights} disabled={busy || running} onChange={event => setRights(event.target.checked)} />我确认首帧及素材拥有必要的使用权</label>
      <label className="hero-generation-check"><input type="checkbox" checked={confirmCosts} disabled={busy || running} onChange={event => setConfirmCosts(event.target.checked)} />我已核对视频服务商报价，单独批准本次可能产生的费用</label>
    </div>
    <p className="hero-creative-hint">视频阶段单独审批 G2，不沿用首帧授权；不同模型的时长与画幅限制请以供应商实际规则为准，预估费用不是供应商计费保证。</p>
    {error && <p role="alert">{error}</p>}
    <button className="hero-generation-start" type="button" disabled={loading || busy || running || !ready || perShot * plan.shots.length > videoCap || perShot * plan.shots.length > totalCap} onClick={() => void submit()}>确认并生成 {plan.shots.length} 镜视频</button>
  </section>;
}
