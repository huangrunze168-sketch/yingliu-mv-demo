import { useEffect, useState } from 'react';
import { ports } from '../../app/useAppData';
import { navigate } from '../../app/router';
import type { AccountEntitlements } from '../../ports';
import { canUseFreeRetake, evaluateFreeExport, freePlan } from '../../domain/entitlements';
import '../../marketing.css';
import './create.css';

const steps: Array<[string, string, string]> = [
  ['01', '上传参考片', '输入一句话也能开始，系统先读懂参考。'],
  ['02', '定风格与主体', '用预设、文字或参考素材组合你的视觉方向。'],
  ['03', '生成并调整分镜', '先看低清结果，再锁定满意镜头。'],
  ['04', '精修与导出', '只重做局部，选择画幅与分辨率后导出。'],
];
const pipelineLabels = ['分析参考', '生成分镜', '生成镜头', '合成视频'];
const analysis: Array<[string, string, number]> = [
  ['镜头节奏', '平均 2.4s / 镜', 68],
  ['景别结构', '中近景为主', 52],
  ['构图倾向', '中心 + 留白', 74],
  ['情绪曲线', '低起 · 中段抬升', 41],
];
const shotNames = ['开场钩子', '概念拆解', '案例说明', '结尾行动'];
type ShotAction = { index: number; kind: 'retake' | 'restore' };
type ExportState = 'idle' | 'confirm' | 'exporting' | 'done';

export function CreateFlow() {
  const [activeStep, setActiveStep] = useState(0);
  const [idea, setIdea] = useState('用 15 秒解释：为什么镜头节奏决定口播视频的完播率');
  const [referenceFile, setReferenceFile] = useState('');
  const [style, setStyle] = useState('电影纪实');
  const [keepSubject, setKeepSubject] = useState(true);
  const [lockedShots, setLockedShots] = useState<number[]>([0, 2]);
  const [shotVersions, setShotVersions] = useState<number[]>([1, 1, 1, 1]);
  const [generating, setGenerating] = useState(false);
  const [retaking, setRetaking] = useState<number | null>(null);
  const [pendingShot, setPendingShot] = useState<ShotAction | null>(null);
  const [pendingBatchRetake, setPendingBatchRetake] = useState(false);
  const [shotNotice, setShotNotice] = useState('');
  const [freeRetakesRemaining, setFreeRetakesRemaining] = useState<number>(freePlan.localRetakes);
  const [ratio, setRatio] = useState('9:16');
  const [quality, setQuality] = useState('低清预览');
  const [exportState, setExportState] = useState<ExportState>('idle');
  const [account, setAccount] = useState<AccountEntitlements>();


  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tool = params.get('tool');
    if (tool === 'retake' || tool === 'video') setActiveStep(2);
    if (tool === 'upscale') setActiveStep(3);

    void (async () => {
      try {
        setAccount(await ports.account.get());
      } catch {
        return;
      }

      const payment = params.get('payment');
      const sessionId = params.get('session_id');
      if (payment === 'stripe' && sessionId) {
        try {
          setAccount(await ports.account.confirmStripePayment(sessionId));
          setShotNotice('Stripe 支付已确认，订阅额度已到账，可继续完成导出。');
        } catch (error) {
          setShotNotice(error instanceof Error ? `Stripe 支付确认失败：${error.message}` : 'Stripe 支付确认失败。');
        } finally {
          params.delete('payment');
          params.delete('session_id');
          const query = params.toString();
          window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
        }
      } else if (payment === 'cancelled') {
        setShotNotice('Stripe 支付已取消，没有产生扣款。');
        params.delete('payment');
        const query = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
      }
    })();
  }, []);

  const pipelineState = (index: number): 'done' | 'active' | 'pending' => {
    if (index < activeStep) return 'done';
    if (index === activeStep) return 'active';
    return 'pending';
  };

  const consumeCredit = async (reason: string): Promise<boolean> => {
    if (!account || account.quotaCredits < 1) {
      setShotNotice('生成额度不足，请先完成订阅或额度支付确认。');
      return false;
    }
    try {
      const next = await ports.account.consume(1, reason);
      setAccount(next);
      return true;
    } catch {
      setShotNotice('额度服务不可用，未执行生成动作。');
      return false;
    }
  };

  const confirmBatchRetake = async () => {
    setPendingBatchRetake(false);
    if (!canUseFreeRetake(freeRetakesRemaining)) {
      setShotNotice('免费体验的 1 次局部重做已使用；继续批量重做需要付费或订阅确认。');
      return;
    }
    if (!(await consumeCredit('batch-local-retake'))) return;
    setFreeRetakesRemaining(value => Math.max(0, value - 1));
    regenerateUnlocked();
  };

  const toggleShot = (index: number) => {
    setLockedShots(current => current.includes(index) ? current.filter(item => item !== index) : [...current, index]);
  };

  const regenerateUnlocked = () => {
    setGenerating(true);
    window.setTimeout(() => {
      setShotVersions(current => current.map((version, index) => lockedShots.includes(index) ? version : version + 1));
      setGenerating(false);
      setShotNotice('未锁定镜头已生成新版本，已锁定镜头保持不变。');
    }, 900);
  };

  const confirmShotAction = async () => {
    if (!pendingShot) return;
    if (pendingShot.kind === 'retake' && !canUseFreeRetake(freeRetakesRemaining)) {
      setPendingShot(null);
      setShotNotice('免费体验的 1 次局部重做已使用；继续重做需要付费或订阅确认。');
      return;
    }
    const action = pendingShot;
    if (action.kind === 'retake' && !(await consumeCredit(`local-retake:shot-${action.index + 1}`))) {
      setPendingShot(null);
      return;
    }
    setPendingShot(null);
    if (action.kind === 'restore') {
      setShotVersions(current => current.map((version, index) => index === action.index ? Math.max(1, version - 1) : version));
      setShotNotice(`镜头 ${action.index + 1} 已恢复到上一版，当前预览被替换。`);
      return;
    }
    setRetaking(action.index);
    window.setTimeout(() => {
      setShotVersions(current => current.map((version, index) => index === action.index ? version + 1 : version));
      setRetaking(null);
      setFreeRetakesRemaining(value => Math.max(0, value - 1));
      setShotNotice(`镜头 ${action.index + 1} 已生成新版本；旧版本仍可恢复。`);
    }, 900);
  };

  const startExport = async () => {
    const decision = evaluateFreeExport(15, quality);
    if (decision.requiresPaymentConfirmation && account && account.plan === 'free') {
      try {
        const checkout = await ports.account.startCheckout('studio', 9900, `${window.location.origin}/create`);
        if (checkout.provider === 'stripe') {
          window.location.assign(checkout.url);
          return;
        }
        setAccount(await ports.account.get());
      } catch (error) {
        setShotNotice(error instanceof Error ? `支付渠道不可用：${error.message}` : '支付渠道不可用，导出已取消。');
        setExportState('idle');
        return;
      }
    }
    setExportState('exporting');
    window.setTimeout(() => setExportState('done'), 1100);
  };

  return (
    <div className="create-page">
      <header className="marketing-nav">
        <a className="marketing-brand" href="/" aria-label="小QTV 首页"><span className="brand-symbol">Q</span><span>小QTV</span></a>
        <nav className="marketing-links" aria-label="创建流程导航"><a href="/#method">方法</a><a href="/#workflow">流程</a><a href="/workbench">项目列表</a></nav>
        <a className="nav-cta" href="/">返回首页 <span>↖</span></a>
      </header>

      <main className="create-main section-shell">
        <div className="create-head">
          <p className="overline">STEP {String(activeStep + 1).padStart(2, '0')} / 04 · FROM REFERENCE TO YOURS</p>
          <h1>{['先上传参考，', '把风格与主体，', '逐镜确认，', '精修完成，'][activeStep]}<em>{['让方法看得见。', '变成可控参数。', '只重做不满意的。', '带着项目继续。'][activeStep]}</em></h1>
          <p className="create-lede">小QTV 提取镜头语言与制作方法，不复制参考作品的具体内容。请确保你拥有上传素材的使用权。</p>
          <div className="account-status" aria-live="polite">
            <span>账号方案：{account === undefined ? '免费体验' : account.plan === 'free' ? '免费体验' : account.plan === 'studio' ? 'Studio' : 'Pro'}</span>
            <span>剩余生成额度：{account?.quotaCredits ?? '…'}</span>
            <span>{account?.watermark === false ? '已去除水印' : '导出带小QTV水印'}</span>
          </div>
        </div>

        <ol className="create-rail" aria-label="创作四步">
          {steps.map(([number, title, copy], index) => (
            <li key={number} className={`create-step ${index === activeStep ? 'is-active' : ''} ${index < activeStep ? 'is-complete' : ''}`}>
              <button type="button" onClick={() => setActiveStep(index)}>
                <span className="create-step-number">{index < activeStep ? '✓' : number}</span>
                <b>{title}</b><small>{copy}</small>
              </button>
            </li>
          ))}
        </ol>

        <section className="creation-pipeline" aria-label="生成过程">
          <div className="pipeline-title"><p className="overline">LIVE PIPELINE</p><b>分析参考 → 生成分镜 → 生成镜头 → 合成视频</b></div>
          <div className="pipeline-track">
            {pipelineLabels.map((label, index) => (
              <div className={`pipeline-stage is-${pipelineState(index)}`} key={label}>
                <span>{pipelineState(index) === 'done' ? '✓' : index + 1}</span>
                <b>{label}</b>
                <small>{pipelineState(index) === 'done' ? '已完成' : pipelineState(index) === 'active' ? '当前阶段' : '等待确认'}</small>
              </div>
            ))}
          </div>
        </section>

        {activeStep === 0 && (
          <div className="create-stage">
            <section className="create-panel">
              <label className="create-dropzone">
                <input type="file" accept="video/*,audio/*" onChange={event => setReferenceFile(event.target.files?.[0]?.name ?? '')} />
                <span className="create-dropzone-icon">◌</span>
                <b>{referenceFile || '拖入参考视频或音频'}</b>
                <small>{referenceFile ? '已选择参考素材，可以继续分析。' : '或点击选择文件。高保真原型仅收集输入，不会发起真实上传。'}</small>
                <span className="create-dropzone-tag">MP4 · MOV · MP3 · WAV</span>
              </label>
              <label className="create-field"><span>一句话创意</span><textarea value={idea} maxLength={200} onChange={event => setIdea(event.target.value)} rows={4} /><small>{idea.length} / 200</small></label>
            </section>
            <AnalysisCard />
          </div>
        )}

        {activeStep === 1 && (
          <div className="create-stage">
            <section className="create-panel">
              <p className="overline">STYLE PRESETS</p><h2>选择视觉方向</h2>
              <div className="choice-grid">
                {['电影纪实', '清透知识感', '情绪胶片', '极简产品感'].map(option => (
                  <label className={`choice-card ${style === option ? 'is-selected' : ''}`} key={option}>
                    <input type="radio" name="style" value={option} checked={style === option} onChange={() => setStyle(option)} />
                    <span className="choice-preview" /><b>{option}</b><small>可在工作台继续调整镜头语言</small>
                  </label>
                ))}
              </div>
              <label className="toggle-row"><span><b>保持主体一致</b><small>后续生成尽量维持人物与主体特征</small></span><input type="checkbox" checked={keepSubject} onChange={event => setKeepSubject(event.target.checked)} /><i aria-hidden="true" /></label>
            </section>
            <aside className="create-side">
              <div className="create-analysis"><p className="overline">CURRENT DIRECTION</p><h2>{style}</h2><p className="create-analysis-note">主体一致性：{keepSubject ? '已开启' : '未开启'}</p><div className="subject-placeholder">这里需要：角色 / 主体参考图</div></div>
              <GateCard />
            </aside>
          </div>
        )}

        {activeStep === 2 && (
          <div className="storyboard-shell">
            <div className="storyboard-toolbar">
              <div><p className="overline">LOW-RES PREVIEW</p><h2>逐镜确认与局部重做</h2><small className="free-quota">免费体验剩余局部重做 {freeRetakesRemaining} 次</small></div>
              <button className="button button-secondary" type="button" onClick={() => setPendingBatchRetake(true)} disabled={generating || retaking !== null}>{generating ? '生成中…' : '重新生成未锁定镜头'}</button>
            </div>
            {(generating || retaking !== null) && <div className="generation-status"><span className="ui-loader" /><div><b>{retaking !== null ? `正在重做镜头 ${retaking + 1}` : '正在生成镜头'}</b><small>分析参考 → 生成分镜 → 生成镜头 → 合成视频</small></div></div>}
            {shotNotice && <div className="shot-notice" role="status">{shotNotice}</div>}
            <div className="storyboard-grid">
              {shotNames.map((name, index) => {
                const locked = lockedShots.includes(index);
                return (
                  <article className={`shot-card ${locked ? 'is-locked' : ''} ${retaking === index ? 'is-retaking' : ''}`} key={name}>
                    <div className="shot-media"><span>镜头 {index + 1} · 版本 {shotVersions[index]}</span><b>00:{String(index * 3).padStart(2, '0')}</b></div>
                    <div className="shot-card-copy">
                      <div className="shot-card-title"><span>0{index + 1}</span>{locked && <i>已锁定</i>}</div>
                      <h3>{name}</h3>
                      <p>{index === 0 ? '一句话提出核心问题，快速建立注意力。' : '沿用参考节奏，内容与表达保持原创。'}</p>
                      <div className="shot-actions">
                        <button type="button" onClick={() => toggleShot(index)}>{locked ? '✓ 已锁定' : '锁定这一镜'}</button>
                        {!locked && <button type="button" disabled={!canUseFreeRetake(freeRetakesRemaining)} onClick={() => setPendingShot({ index, kind: 'retake' })}>{canUseFreeRetake(freeRetakesRemaining) ? '局部重做' : '免费重做已用完'}</button>}
                        {shotVersions[index] > 1 && <button type="button" onClick={() => setPendingShot({ index, kind: 'restore' })}>恢复上一版</button>}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {activeStep === 3 && (
          <div className="create-stage">
            <section className="create-panel">
              <p className="overline">FINAL CUT</p><h2>选择导出规格</h2>
              <div className="export-preview">这里需要：最终成片预览</div>
              <div className="export-options">
                <fieldset><legend>画幅</legend>{['9:16', '16:9', '1:1'].map(option => <label key={option}><input type="radio" name="ratio" checked={ratio === option} onChange={() => setRatio(option)} /><span>{option}</span></label>)}</fieldset>
                <fieldset><legend>分辨率</legend>{['低清预览', '高清导出'].map(option => <label key={option}><input type="radio" name="quality" checked={quality === option} onChange={() => setQuality(option)} /><span>{option}</span></label>)}</fieldset>
              </div>
              {exportState === 'exporting' && <div className="generation-status"><span className="ui-loader" /><div><b>正在合成视频</b><small>生成镜头 → 合成视频 → 写入导出文件</small></div></div>}
              {exportState === 'done' && <div className="export-success" role="status"><b>演示导出完成</b><span>{ratio} · {quality} · 带小QTV水印</span></div>}
            </section>
            <aside className="create-side">
              <div className="create-analysis">
                <p className="overline">PROJECT READY</p><h2>知识类口播 · 15 秒</h2>
                <ul className="summary-list"><li><span>视觉方向</span><b>{style}</b></li><li><span>已锁定镜头</span><b>{lockedShots.length} / 4</b></li><li><span>导出规格</span><b>{ratio} · {quality}</b></li><li><span>水印</span><b>小QTV水印</b></li></ul>
                {exportState !== 'done' ? <button className="button button-primary export-button" type="button" onClick={() => setExportState('confirm')} disabled={exportState === 'exporting'}>{exportState === 'exporting' ? '导出中…' : '确认导出规格'}</button> : <button className="button button-primary export-button" type="button" onClick={() => navigate('/workbench/p-demo')}>进入专业工作台 <span>↗</span></button>}
              </div>
              <GateCard />
            </aside>
          </div>
        )}

        <div className="create-actions">
          <button className="button button-secondary" type="button" onClick={() => setActiveStep(step => Math.max(step - 1, 0))} disabled={activeStep === 0}>上一步</button>
          {activeStep < 3 ? <button className="button button-primary" type="button" onClick={() => setActiveStep(step => Math.min(step + 1, 3))}>下一步：{steps[activeStep + 1][1]} <span>→</span></button> : <button className="button button-primary" type="button" onClick={() => navigate('/workbench')}>查看项目列表 <span>↗</span></button>}
          <p className="create-actions-note">每一步都由你确认；涉及付费生成、覆盖结果或导出时，系统会再次确认。</p>
        </div>
      </main>

      {pendingBatchRetake && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPendingBatchRetake(false)}>
          <div className="modal shot-confirm-modal" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}>
            <p className="overline">BATCH LOCAL RETAKE</p>
            <h2>重新生成所有未锁定镜头？</h2>
            <p>这会消耗免费体验中的 1 次局部重做额度，并生成新的镜头版本；已锁定镜头不会被覆盖。</p>
            <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setPendingBatchRetake(false)}>取消</button><button className="button button-primary" type="button" onClick={confirmBatchRetake}>确认批量重做</button></div>
          </div>
        </div>
      )}

      {pendingShot && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPendingShot(null)}>
          <div className="modal shot-confirm-modal" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}>
            <p className="overline">{pendingShot.kind === 'retake' ? 'LOCAL RETAKE' : 'RESTORE PREVIOUS VERSION'}</p>
            <h2>{pendingShot.kind === 'retake' ? `只重做镜头 ${pendingShot.index + 1}？` : `恢复镜头 ${pendingShot.index + 1} 上一版？`}</h2>
            <p>{pendingShot.kind === 'retake' ? '这会消耗生成额度，并生成一个新的镜头版本；其他已锁定镜头不会被覆盖。' : '这会用上一版替换当前预览。当前版本仍会保留在版本历史中。'}</p>
            <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setPendingShot(null)}>取消</button><button className="button button-primary" type="button" onClick={confirmShotAction}>{pendingShot.kind === 'retake' ? '确认局部重做' : '确认恢复'}</button></div>
          </div>
        </div>
      )}

      {exportState === 'confirm' && (
        <div className="modal-backdrop" role="presentation" onClick={() => setExportState('idle')}>
          <div className="modal export-confirm-modal" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}>
            <p className="overline">EXPORT CONFIRMATION</p>
            <h2>确认导出成片</h2>
            <p>本次导出规格为 <b>{ratio} · {quality}</b>。{evaluateFreeExport(15, quality).reason}确认后开始合成视频。</p>
            <div className="modal-actions">
              <button className="button button-secondary" type="button" onClick={() => setExportState('idle')}>返回修改</button>
              <button className="button button-primary" type="button" onClick={() => startExport()}>确认并导出</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AnalysisCard() {
  return <aside className="create-side"><div className="create-analysis"><p className="overline">STYLE ANALYSIS</p><h2>风格分析</h2><p className="create-analysis-note">示例项目已完成分析，可逐项确认。</p><ul>{analysis.map(([label, value, width]) => <li key={label}><div className="create-analysis-row"><span>{label}</span><small>{value}</small></div><div className="create-analysis-bar"><span style={{ width: `${width}%` }} /></div></li>)}</ul></div><GateCard /></aside>;
}

function GateCard() {
  return <div className="create-gate"><b>G0 前置闸门</b><p>未选帧时付费生成请求为 0。进入生成、覆盖或导出前，系统会先停下来征求你的确认。</p></div>;
}
