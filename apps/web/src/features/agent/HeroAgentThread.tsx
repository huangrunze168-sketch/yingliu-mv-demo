import { useEffect, useRef } from 'react';
import type { AgentEvents, AgentMessage } from './agentClient';
import { dialogue, isRealGenerationRunning, latestFailure, libtvCanvasLink, toolActivities } from './agentDisplay';
import { CreativePlanCard, parsePlanMessage, type CreativePlan } from './CreativePlanCard';
import { CreativeGenerationPanel } from './CreativeGenerationPanel';
import { CreativeVideoPanel } from './CreativeVideoPanel';
import type { ImageGenerationOptions, VideoGenerationOptions } from './agentClient';
import './hero-agent.css';

function AgentMessageText({ text }: { text: string }) {
  const url = libtvCanvasLink(text);
  if (!url) return <p>{text}</p>;
  const index = text.indexOf(url);
  return <p>{text.slice(0, index)}<a className="agent-canvas-link" href={url} target="_blank" rel="noreferrer">打开 LibTV 画布 ↗</a>{text.slice(index + url.length)}</p>;
}

type Props = {
  messages: AgentMessage[];
  busy: boolean;
  running: boolean;
  runId: string | null;
  runState?: AgentEvents['run_state'];
  error: string;
  needsReview: boolean;
  acknowledgeUnknown: () => Promise<void>;
  confirmation: string | null;
  onConfirm: () => void;
  onDismiss: () => void;
  onNew: () => void;
  onCancel: () => void;
  onReconnect: () => void;
  /** Agent 已接受消息后，进入同一项目的画布继续工作。 */
  onOpenCanvas?: () => void;
  savePlan: (planId: string, plan: CreativePlan) => Promise<boolean>;
  approvePlan: (planId: string) => Promise<boolean>;
  generateImages: (planId: string, options: ImageGenerationOptions) => Promise<boolean>;
  selectFrame: (planId: string, shotId: string, artifactId: string) => Promise<boolean>;
  generateVideos: (planId: string, options: VideoGenerationOptions) => Promise<boolean>;
};

export function HeroAgentThread(props: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [props.messages.length, props.error, props.running]);
  const conversation = dialogue(props.messages);
  const activities = toolActivities(props.messages);
  const latestPlanMessage = [...props.messages].reverse().find(message => message.role === 'plan');
  const plan = latestPlanMessage ? parsePlanMessage(latestPlanMessage) : null;
  const approved = !!latestPlanMessage && props.messages.some(message => message.role === 'approval' && message.text === latestPlanMessage.id);
  const planIndex = latestPlanMessage ? props.messages.findIndex(message => message.id === latestPlanMessage.id) : -1;
  const productionMessages = props.messages.slice(planIndex + 1);
  const generationActive = isRealGenerationRunning(productionMessages, props.running, props.runId);
  const failure = props.error || (!props.running ? latestFailure(props.messages) : '');
  const visible = conversation.length > 0 || !!plan || props.busy || props.running || !!failure || props.needsReview;
  return <>
    {visible && <div className="agent-thread" role="log" aria-label="Agent 对话" aria-live="polite">
      <div className="hero-agent-tools">
        <span>{generationActive ? '真实生成正在执行' : props.running ? '小Q 正在回复' : props.busy ? '正在提交' : '小QTV Agent'}</span>
        {props.running && props.runId && <button type="button" onClick={props.onCancel}>停止</button>}
        {conversation.length > 0 && <button type="button" disabled={props.busy} onClick={props.onNew}>＋ 新对话</button>}
      </div>
      {conversation.map(message => <article className={'agent-msg ' + (message.role === 'user' ? 'user' : 'agent')} key={message.id}>
        <span className="agent-msg-avatar" aria-hidden="true">{message.role === 'user' ? '我' : '✦'}</span>
        <div className="agent-msg-body">{message.skillRef && <span className="agent-message-skill">✦ {message.skillRef.name ?? message.skillRef.id} · {message.skillRef.version}</span>}<AgentMessageText text={message.text} /></div>
      </article>)}
      {plan && latestPlanMessage && <CreativePlanCard key={latestPlanMessage.id} plan={plan} planId={latestPlanMessage.id} approved={approved} busy={props.busy || props.running} onSave={props.savePlan} onApprove={props.approvePlan} />}
      {approved && plan && latestPlanMessage && <CreativeGenerationPanel key={`production-${latestPlanMessage.id}`} plan={plan} planId={latestPlanMessage.id} messages={productionMessages} busy={props.busy} running={props.running} onGenerate={props.generateImages} onSelectFrame={props.selectFrame} />}
      {approved && plan && latestPlanMessage && <CreativeVideoPanel key={`video-${latestPlanMessage.id}`} plan={plan} planId={latestPlanMessage.id} messages={productionMessages} busy={props.busy} running={props.running} onGenerate={props.generateVideos} />}
      {props.running && !generationActive && <p className="hero-agent-state" role="status">正在规划创作方案…</p>}
      {!props.running && props.runState === 'canceled' && <p className="hero-agent-state" role="status">本轮规划已取消。服务商可能已产生用量，请到对应账户核查；未生成新的成功方案。</p>}
      {activities.length > 0 && <details className="hero-agent-activity"><summary>任务状态 · {activities.length} 项</summary><ul>{activities.map(item => <li key={item.id}>{item.text}</li>)}</ul></details>}
      {failure && <div className="hero-agent-error" role="alert"><span>{failure}</span><div className="hero-agent-error-actions"><button type="button" onClick={props.onReconnect}>{props.error ? '恢复对话' : '刷新状态'}</button>{props.onOpenCanvas ? <button type="button" onClick={props.onOpenCanvas}>进入画布继续工作</button> : null}</div></div>}
      {props.needsReview && <div className="hero-agent-error" role="alert"><span>上轮结果与费用仍未知；继续创作前，请确认你已知晓可能重复计费的风险。</span><button type="button" disabled={props.busy || props.running} onClick={() => void props.acknowledgeUnknown()}>我已知晓，允许继续</button></div>}
      <div ref={bottom} />
    </div>}
    {props.confirmation && <div className="hero-agent-confirm" role="alertdialog" aria-label="确认高风险动作">
      <p>此请求可能修改项目、调用工具或消耗额度。确认后才会发送给本地 Agent。</p>
      <button type="button" onClick={props.onDismiss}>返回修改</button>
      <button type="button" onClick={props.onConfirm} disabled={props.busy}>确认发送</button>
    </div>}
  </>;
}
