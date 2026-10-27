import { useEffect, useMemo, useState, type ReactNode } from 'react';

type WorkbenchProps = {
  activeStep: number;
  agentBusy: boolean;
  assets: Array<{ name: string; ready: boolean; optional: boolean }>;
  children: ReactNode;
  director: string;
  directors: ReadonlyArray<ReadonlyArray<string>>;
  model: string;
  onBack: () => void;
  onDirectorChange: (director: string) => void;
  onStepChange: (step: number) => void;
  projectName: string;
  ratio: string;
  resolution: string;
  requirements: string;
  shots: ReadonlyArray<readonly string[]>;
  steps: ReadonlyArray<readonly string[]>;
};

type LibraryView = 'assets' | 'scenes' | 'flow';
type InspectorView = 'properties' | 'prompt' | 'agent';

const promptChecks = [
  ['歌词时间窗', '每镜起止时间与歌词句对齐'],
  ['人物一致性', '全部参考图同级组成身份与多角度特征约束'],
  ['场景、动作、景别', '环境、表演和镜头尺度完整'],
  ['摄影和运镜', '焦段、机位、光线与运动明确'],
  ['导演方法', 'ZY 导演方案写入每镜约束'],
  ['负面提示词', '字幕、水印、畸变和身份漂移已排除'],
  ['镜头衔接', '开场状态、结尾动作与前后镜关系均有说明'],
] as const;

export function VelornProductionWorkbench({ activeStep, agentBusy, assets, children, director, directors, model, onBack, onDirectorChange, onStepChange, projectName, ratio, requirements, resolution, shots, steps }: WorkbenchProps) {
  const [libraryView, setLibraryView] = useState<LibraryView>('assets');
  const [inspectorView, setInspectorView] = useState<InspectorView>('properties');
  const [agentPrompt, setAgentPrompt] = useState('检查当前阶段，并给出下一步可执行计划');
  const [agentNotice, setAgentNotice] = useState('');
  const [approvedChecks, setApprovedChecks] = useState(() => promptChecks.map(() => true));
  const readyAssets = assets.filter(item => item.ready).length;
  const referenceReady = assets.some(item => item.name === '参考视频' && item.ready);
  const activeDirector = directors.find(([name]) => name === director);
  const approvedCount = approvedChecks.filter(Boolean).length;
  const sequenceDuration = shots.length ? shots[shots.length - 1]?.[1]?.split(/[–-]/).pop()?.trim() || '--:--' : '--:--';
  const deliveryStep = steps.length - 1;

  useEffect(() => {
    if (activeStep === 1) setInspectorView(agentBusy ? 'agent' : 'prompt');
    if (activeStep === 0) setInspectorView('properties');
  }, [activeStep, agentBusy]);

  const agentTasks = useMemo(() => {
    const copies = [
      `${readyAssets}/${assets.length} 项用户物料已连接到 Agent 上下文`,
      `Agent 分析全部物料，输出 ${shots.length} 份分镜全能提示词并确认生成规格`,
      '用户主动开始生成，完成后在线播放审片或下载成片',
    ];
    return steps.map(([, title], index) => [title, copies[index]]);
  }, [assets.length, director, readyAssets, shots.length, steps]);

  const openWorkspace = (workspace: 'generate' | 'editor' | 'agent') => {
    if (workspace === 'editor') onStepChange(deliveryStep);
    if (workspace === 'agent') setInspectorView('agent');
  };

  const togglePromptCheck = (index: number) => {
    setApprovedChecks(current => current.map((value, itemIndex) => itemIndex === index ? !value : value));
  };

  return (
    <div className="vl-workbench">
      <header className="vl-titlebar">
        <button className="vl-logo" type="button" onClick={onBack}><span>映</span><b>映流 MV</b></button>
        <nav className="vl-workspaces" aria-label="Velorn 工作区">
          <button className={activeStep < deliveryStep ? 'is-active' : ''} type="button" onClick={() => openWorkspace('generate')}>制作</button>
          <button className={activeStep === deliveryStep ? 'is-active' : ''} type="button" onClick={() => openWorkspace('editor')}>剪辑与交付</button>
          <button className={inspectorView === 'agent' ? 'is-active' : ''} type="button" onClick={() => openWorkspace('agent')}>Agent</button>
        </nav>
        <div className="vl-project-title"><span>{projectName || '未命名项目'}</span><i>已自动保存</i></div>
        <div className="vl-title-actions"><span>{ratio}</span><span>{resolution}</span><span>{model}</span><a href="https://github.com/VelornLabs/velorn" target="_blank" rel="noreferrer">Velorn 工作台移植</a><button type="button" onClick={onBack}>返回项目库</button></div>
      </header>

      <nav className="vl-icon-rail" aria-label="项目工具">
        <button className={libraryView === 'assets' ? 'is-active' : ''} type="button" onClick={() => setLibraryView('assets')}><span>◫</span><small>素材</small></button>
        <button className={libraryView === 'scenes' ? 'is-active' : ''} type="button" onClick={() => setLibraryView('scenes')}><span>▱</span><small>场景</small></button>
        <button className={libraryView === 'flow' ? 'is-active' : ''} type="button" onClick={() => setLibraryView('flow')}><span>⌁</span><small>流程</small></button>
        <button className={inspectorView === 'agent' ? 'is-active' : ''} type="button" onClick={() => setInspectorView('agent')}><span>✦</span><small>Agent</small></button>
        <div className="vl-icon-rail-spacer" />
        <button type="button" onClick={onBack}><span>⌂</span><small>项目</small></button>
      </nav>

      <aside className="vl-library">
        {libraryView === 'assets' && <>
          <div className="vl-panel-heading"><div><small>PROJECT MEDIA</small><h2>项目素材</h2></div><span>{readyAssets}/{assets.length}</span></div>
          <label className="vl-library-search"><span>⌕</span><input readOnly value="" placeholder="搜索素材…" /></label>
          <div className="vl-bin-title"><b>用户上传</b><small>{assets.length} 项</small></div>
          <div className="vl-asset-list">{assets.map((asset, index) => <article className={asset.ready ? 'is-ready' : ''} key={asset.name}><div className={`vl-asset-thumb vl-asset-${index + 1}`}>{asset.ready ? '✓' : asset.optional ? '可选' : '+'}</div><div><b>{asset.name}</b><small>{asset.ready ? '已连接到项目' : asset.optional ? '未上传 · 可跳过' : '等待上传'}</small></div></article>)}</div>
          <div className="vl-bin-title"><b>项目输出</b><small>自动归档</small></div>
          <div className="vl-output-folders"><button type="button"><span>▣</span>AI 分析</button><button type="button"><span>▣</span>分镜提示词</button><button type="button"><span>▣</span>候选视频</button><button type="button"><span>▣</span>交付文件</button></div>
        </>}

        {libraryView === 'scenes' && <>
          <div className="vl-panel-heading"><div><small>SCENE / SHOT TREE</small><h2>场景与镜头</h2></div><span>{shots.length}</span></div>
          <div className="vl-scene-tree"><section><header><span>⌄</span><b>SC01 · {projectName || '待分析项目'}</b><small>{sequenceDuration}</small></header>{shots.map(([id, time, title], index) => <button type="button" key={id} onClick={() => onStepChange(activeStep === 0 ? 1 : activeStep)}><i className={`mv-shot-${(index % 6) + 1}`} /><span><b>{id} · {title}</b><small>{time} · {activeStep === 0 ? '等待 Agent 分析' : activeStep === 1 ? '提示词与生成规格待确认' : '已进入成片流程'}</small></span></button>)}</section></div>
        </>}

        {libraryView === 'flow' && <>
          <div className="vl-panel-heading"><div><small>GUIDED WORKFLOW</small><h2>制作流程</h2></div><span>{activeStep + 1}/{steps.length}</span></div>
          <div className="vl-flow-list">{steps.map(([number, title, copy], index) => <button className={index === activeStep ? 'is-active' : index < activeStep ? 'is-complete' : ''} type="button" key={number} disabled={index > activeStep} onClick={() => onStepChange(index)}><span>{index < activeStep ? '✓' : number}</span><div><b>{title}</b><small>{copy}</small></div></button>)}</div>
        </>}
        <footer className="vl-library-footer"><span>VELORN WEB WORKBENCH</span><small>GPL-3.0 · DEMO</small></footer>
      </aside>

      <main className="vl-stage">
        <div className="vl-guided-steps">{steps.map(([number, title], index) => <button className={index === activeStep ? 'is-active' : index < activeStep ? 'is-complete' : ''} type="button" key={number} disabled={index > activeStep} onClick={() => onStepChange(index)}><span>{index < activeStep ? '✓' : number}</span><b>{title}</b></button>)}</div>
        <div className="vl-stage-scroll">{children}</div>
      </main>

      <aside className="vl-inspector">
        <nav className="vl-inspector-tabs"><button className={inspectorView === 'properties' ? 'is-active' : ''} type="button" onClick={() => setInspectorView('properties')}>检查器</button><button className={inspectorView === 'prompt' ? 'is-active' : ''} type="button" onClick={() => setInspectorView('prompt')}>提示词审核</button><button className={inspectorView === 'agent' ? 'is-active' : ''} type="button" onClick={() => setInspectorView('agent')}>Agent</button></nav>

        {inspectorView === 'properties' && <div className="vl-properties-panel">
          <div className="vl-inspector-heading"><div><small>PROJECT INSPECTOR</small><h2>项目属性</h2></div><i>只读上下文</i></div>
          <dl className="vl-property-list"><div><dt>当前阶段</dt><dd>{steps[activeStep]?.[1]}</dd></div><div><dt>画幅</dt><dd>{ratio}</dd></div><div><dt>输出清晰度</dt><dd>{resolution}</dd></div><div><dt>生成模型</dt><dd>{model}</dd></div><div><dt>素材就绪</dt><dd>{readyAssets}/{assets.length}</dd></div></dl>
          <label className="vl-director-select"><span>ZY 导演方法</span><select value={director} onChange={event => onDirectorChange(event.target.value)}>{directors.map(([name]) => <option key={name}>{name}</option>)}</select></label>
          <article className="vl-director-card"><header><span>ZY</span><div><small>SELECTED DIRECTOR</small><b>{director}</b></div></header><p>{activeDirector?.[1]}</p><button type="button" onClick={() => onStepChange(0)}>回到项目设置修改导演 →</button></article>
          <section className="vl-brief-card"><small>CREATIVE BRIEF</small><p>{requirements || '尚未填写制作需求。'}</p></section>
        </div>}

        {inspectorView === 'prompt' && <div className="vl-prompt-review">
          <div className="vl-inspector-heading"><div><small>PROMPT REVIEW GATE</small><h2>第二步 · 分镜提示词确认</h2></div><i className={approvedCount === promptChecks.length ? 'is-passed' : ''}>{approvedCount}/{promptChecks.length}</i></div>
          <p className="vl-review-intro">这里审核提示词本身，并确认模型与输出规格。完成后直接进入成片合成与交付。</p>
          <div className="vl-review-list">{promptChecks.map(([title, copy], index) => <button className={approvedChecks[index] ? 'is-approved' : ''} type="button" key={title} onClick={() => togglePromptCheck(index)}><span>{approvedChecks[index] ? '✓' : '!'}</span><div><b>{title}</b><small>{copy}</small></div><em>{approvedChecks[index] ? '已覆盖' : '待补充'}</em></button>)}</div>
          <section className="vl-review-summary"><div><span>镜头提示词</span><b>{shots.length} 份</b></div><div><span>导演方法</span><b>{director}</b></div><div><span>审核门禁</span><b>{approvedCount === promptChecks.length ? '可以送审' : '尚未通过'}</b></div></section>
          <button className="vl-review-action" type="button" disabled={approvedCount !== promptChecks.length || shots.length === 0} onClick={() => onStepChange(deliveryStep)}>确认提示词与生成方案，进入成片交付 <span>→</span></button>
        </div>}

        {inspectorView === 'agent' && <div className="vl-agent-panel">
          <div className="vl-agent-title"><div><span>✦</span><div><small>PRODUCTION AGENT</small><h2>需求与物料 Agent</h2></div></div><i>分析模式</i></div>
          <div className="vl-agent-mode"><button className="is-active" type="button">只规划</button><button type="button">执行前确认</button><button type="button" disabled>自动执行</button></div>
          <section className="vl-agent-context"><header><b>Agent 当前上下文</b><span>统一读取</span></header><div><b>{projectName || '未命名项目'}</b><small>制作需求与输出规格</small></div><div><b>{readyAssets}/{assets.length} 类物料</b><small>歌曲、歌词、参考图组与可选参考片</small></div><div><b>{director}</b><small>ZY 导演方法将写入全能提示词</small></div><div><b>{referenceReady ? '参考片已连接' : '参考片可选'}</b><small>未上传时由 Agent 自主规划镜头语言</small></div></section>
          <section className="vl-agent-plan"><header><b>执行计划</b><span>READ → PLAN → APPROVE</span></header>{agentTasks.map(([title, copy], index) => <article className={index < activeStep ? 'is-done' : index === activeStep ? 'is-active' : ''} key={title}><span>{index < activeStep ? '✓' : index + 1}</span><div><b>{title}</b><small>{copy}</small></div></article>)}</section>
          <section className="vl-agent-tools"><header><b>可用工具</b><span>云生成锁定</span></header><div><i className="is-ready" /><b>DeepSeek</b><small>分析与规划</small><em>已接入</em></div><div><i className="is-ready" /><b>ModelsNexus</b><small>模型路由</small><em>已接入</em></div><div><i /><b>MiniMax / 生图</b><small>人工批准后调用</small><em>锁定</em></div><div><i className="is-local" /><b>FFmpeg</b><small>演示成片</small><em>可运行</em></div></section>
          <div className="vl-agent-message"><span>Agent 当前工作</span><p>{agentNotice || ['等待完整读取制作需求、导演选择与用户上传物料。', '分析需求、歌曲、歌词和参考物料，并直接输出带导演方法的逐镜全能提示词。', '提示词通过后进行模型路由；生成结果进入候选审核与返工。', '确认镜头序列、音轨和输出规格后生成演示成片。'][activeStep]}</p></div>
          <label className="vl-agent-command"><span>给 Agent 补充指令</span><textarea value={agentPrompt} onChange={event => setAgentPrompt(event.target.value)} rows={3} /><button type="button" onClick={() => setAgentNotice(`补充指令已记录：${agentPrompt}。返回第一步重新分析后生效。`)}>记录补充要求 <span>↗</span></button><small>DeepSeek 只在第一步提交分析时调用；视频与生图接口仍需人工批准</small></label>
        </div>}
      </aside>

    </div>
  );
}
