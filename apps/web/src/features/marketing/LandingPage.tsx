import { FormEvent, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';
import { navigate } from '../../app/router';
import { usePrefersReducedMotion } from '../../app/usePrefersReducedMotion';
import { LazyAgentLensCanvas } from './LazyAgentLensCanvas';
import { AGENT_MODES, LUCIDE_PLUS_PATHS, LUCIDE_SPARKLE_PATH } from './agentConsole';
import { ProjectRail } from '../workbench/ProjectRail';
import { readSession } from '../auth/session';
import { requiresAgentConfirmation } from '../../domain/agentActions';
import { HeroAgentThread } from '../agent/HeroAgentThread';
import { useHeroAgentChat } from '../agent/useHeroAgentChat';
import { openAgentCanvas } from '../agent/agentNavigation';
import '../../marketing.css';

gsap.registerPlugin(useGSAP, ScrollTrigger);

/* ============================================================
   落地页 · 对标站 架构 1:1 复刻（对标站）
   导航摊开 + NEW 公告 pill + 两色调逐字大标题 + 双 CTA
   （白 pill / 玻璃 pill）+ 实景产品视觉（暗房桌面 + 显示器
   里真 UI）+ 封面跑马灯 + 模型展示章 + 逐字统计 + 定价
   （月/年切换 + 算力滑杆）+ Ask AI 深链 + 工具列页脚。
   交互动效：逐字符 stagger 入场、IO 触发 reveal、跑马灯、
   tab 切换、滑杆、hover 抬升。内容为小QTV。
   ============================================================ */

const capabilities = [
  ['参考片分析', '提取镜头节奏、景别结构、构图与情绪曲线，把参考变成可理解的制作地图。'],
  ['分镜与主体', '风格、角色与主体先在分镜里对齐；一句话创意也能直接开始。'],
  ['局部精修', '锁定满意镜头，只重做不满意的；画幅与分辨率由你选择。'],
];

const steps = [
  ['01', '上传参考', '上传参考片或音乐，也可以只给一句话。'],
  ['02', '定风格', '预设、文字或参考素材组合你的视觉方向。'],
  ['03', '逐镜确认', '先看低清结果，锁定满意镜头。'],
  ['04', '精修导出', '只重做局部，选择画幅与分辨率后导出。'],
];

const plans: Array<{ key: string; name: string; monthly: number; yearly?: number; blurb: string; units: string; feats: string[] }> = [
  { key: 'free', name: '免费', monthly: 0, blurb: '走完整个创作闭环。', units: '5 次生成 / 月', feats: ['四步全流程', '逐镜确认', '带小QTV水印'] },
  { key: 'pro', name: '专业', monthly: 99, yearly: 59, blurb: '日更节奏的创作者。', units: '200 次生成 / 月', feats: ['去除水印', '局部重做不限次', '高清导出', '优先队列'] },
];

const unitSteps = [500, 1000, 2000, 5000];
const askPrompt = encodeURIComponent('我想了解小QTV——一个从参考片出发、四步生成属于自己视频的创作工作站。它的方法学、功能与使用流程是什么？');

function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setInView(true); io.disconnect(); }
    }, { threshold: 0.15 });
    io.observe(node);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={`reveal ${inView ? 'in' : ''} ${className}`}>{children}</div>;
}

function SplitChars({ text, className = '' }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setInView(true); io.disconnect(); }
    }, { threshold: 0.2 });
    io.observe(node);
    return () => io.disconnect();
  }, []);
  return (
    <span ref={ref} className={`split-chars ${inView ? 'in' : ''} ${className}`} aria-label={text}>
      {Array.from(text).map((ch, i) => (
        <span key={i} aria-hidden="true" style={{ '--i': i } as CSSProperties}>{ch === ' ' ? '\u00A0' : ch}</span>
      ))}
    </span>
  );
}

export function LandingPage() {
  const [yearly, setYearly] = useState(false);
  const [units, setUnits] = useState(1000);
  /** Agent 对话：对标站 首页——中间是会话流，空态才显示「A new era」。 */
  const [agentPrompt, setAgentPrompt] = useState(() => window.sessionStorage.getItem('qiyin.hero.draft') ?? '');
  const [agentModel, setAgentModel] = useState('auto-medium');
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const heroAgent = useHeroAgentChat();
  const [canvasNavigationError, setCanvasNavigationError] = useState('');
  const enterCanvas = async () => {
    try { if (!await openAgentCanvas()) setCanvasNavigationError('消息已提交，但暂未找到对应画布；对话保留在此处。'); }
    catch { setCanvasNavigationError('消息已提交，但画布暂时无法打开；对话保留在此处。'); }
  };
  const hasAgentDialogue = heroAgent.messages.some(message => message.role === 'user' || message.role === 'agent' || message.role === 'plan');
  useEffect(() => {
    if (agentPrompt) window.sessionStorage.setItem('qiyin.hero.draft', agentPrompt);
    else window.sessionStorage.removeItem('qiyin.hero.draft');
  }, [agentPrompt]);

  /** 首屏入场（对标 hero 组件里的 `b=z(()=>l(d)||xt.current)` / `data-animate=!xt.current`）。
      ⚠ 三条都是照抄对标，别自己发挥：
        · `data-animate = !prefersReducedMotion` —— **从首帧就为 true**。这样 transition
          已经挂在元素上，等 data-ready 稍后翻上来时过渡必然播（之前把两者挤在同一次
          DOM 更新里翻，反而是在赌浏览器把「新增 transition」和「改终值」当同一帧处理）。
        · `data-ready = arrived || prefersReducedMotion` —— 正常用户要等**透镜动画走到
          f>=1.5**（≈1.5s）才淡入；reduced-motion 用户直接落在终态、不做开场。
        · 未 ready 时 `.agent-hero-copy` 带 `inert`（对标 `te.inert=!b`），
          避免在不可见的输入台上抢焦点。 */
  const reducedMotion = usePrefersReducedMotion();
  const [arrived, setArrived] = useState(false);
  const introReady = arrived || reducedMotion;
  /** 透镜开销到位 → 放开 hero 文案。identity 稳定，AgentLensCanvas 内部也只走 ref。 */
  const handleLensArrival = useCallback(() => setArrived(true), []);

  /** 引力透镜 canvas 的两个入参：输入台元素（透镜 box/圆角取自它）+ 首屏是否在视口内。
     对标也是用 IntersectionObserver 控制 active，离开视口就 setAnimationLoop(null)，不空转。 */
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

  /** 首屏提交成功后进入同一项目画布；服务端未接受消息时保留输入。 */
  const submitAgentPrompt = () => {
    const text = agentPrompt.trim();
    if (!text || heroAgent.busy || heroAgent.running || confirmation) return;
    if (!readSession()) {
      window.sessionStorage.setItem('qiyin.hero.draft', text);
      navigate('/signup?next=%2F');
      return;
    }
    if (requiresAgentConfirmation(text)) { setConfirmation(text); return; }
    void heroAgent.send(text).then(sent => {
      if (sent) { setAgentPrompt(''); window.sessionStorage.removeItem('qiyin.hero.draft'); void enterCanvas(); }
    });
  };

  const confirmAgentPrompt = () => {
    if (!confirmation) return;
    void heroAgent.send(confirmation).then(sent => {
      if (sent) { setAgentPrompt(''); setConfirmation(null); window.sessionStorage.removeItem('qiyin.hero.draft'); void enterCanvas(); }
    });
  };

  const sendAgentPrompt = (event: FormEvent) => {
    event.preventDefault();
    submitAgentPrompt();
  };

  /** ★ Enter 直发：对标站 的 prompt editor 就是 Enter 提交、Shift+Enter 换行。
      之前只在 submit 钮上挂了提交，textarea 里按 Enter 只会插一个换行 ——
      用户必须**去点**那个 ✦ 钮对话才会出现（这就是「点击才弹出 agent 对话框」的来源）。
      ⚠ 必须放过 IME 组合中的 Enter（`isComposing` / `keyCode 229`）：
        中文选字确认也是按 Enter，不拦的话一句话还没打完就直接发出去了。 */
  const handlePromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submitAgentPrompt();
  };

  /** Card Spotlight：指针位置写入 --mx/--my，供卡片辉光径向渐变定位。 */
  const handleSpotlight = (event: ReactPointerEvent<HTMLElement>) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('.tool-card, .project-cover, .feature-tile, .rail-promo');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    card.style.setProperty('--my', `${event.clientY - rect.top}px`);
  };

  /** GSAP 动效层：只驱动「少量、独立」的层（gsap-performance）。
      ⚠ 首屏星野**已换成对标那张预渲染照片**（agent-starfield-backdrop.webp），
        光环也改成纯 CSS 的 conic-gradient + feTurbulence（.agent-streaks）。
        所以这里不再有 .starfield* 的视差/漂移 tween，也不再给光带建 canvas ——
        对标压根没做这两件事；之前那套「程序化撒点 + 漩涡环」是自造的，越调越不像。
        光带的自转/闪烁是纯 CSS animation（见 components.css），不需要 JS 驱动。 */
  const pageRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      mm.add({ live: '(prefers-reduced-motion: no-preference)' }, ctx => {
        if (!ctx.conditions?.live) return;
        const targets = pageRef.current?.querySelectorAll<HTMLElement>('.feature-tile') ?? [];
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
    <div className="kpage project-list-page workbench-scope hero-home" ref={pageRef}>
      {/* 对标「A new era」页：整屏只有 星空 + 标题 + 输入台 + 缠绕光带。
          ⚠ 三件事必须与对标一致，否则怎么调都不像（已全部从对标生产代码核实）：
            ① 星野是**一张预渲染照片**（webp，1256×736 真实星空），不是程序化撒点；
            ② 光带是 conic-gradient 描边环经 SVG feTurbulence 位移撕裂，不是粒子漩涡；
            ③ 输入台固定 792px + 四周均匀 border-white/15 + box-shadow:none，
               台外辉光来自 .agent-streaks 的 drop-shadow。 */}
      {/* 滤镜定义必须挂在根上：任何祖先带 transform / filter 都会改变 url(#…) 的解析基准。
          零尺寸 svg，纯定义，不参与布局。 */}
      <svg className="agent-streak-defs" aria-hidden="true">
        <filter id="agent-streak-texture" x="-10%" y="-30%" width="120%" height="160%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.045 0.5" numOctaves="2" seed="8" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="2" xChannelSelector="R" yChannelSelector="G" result="distorted" />
          <feColorMatrix in="noise" type="saturate" values="0" result="grain" />
          <feComposite in="distorted" in2="grain" operator="arithmetic" k1="1.5" k2="0.35" k3="0" k4="0" />
        </filter>
      </svg>
      {/* ★ 左栏：对标站 的 **`/` 也有这一栏** —— 它是 app shell 的一部分，不是工作台专属。
          所以 hero 根本不是「全出血」，而是「视口 − 256px 侧栏」那一列里的普通居中；
          主列的宽度就是视口减 256（1412 → 1156）。
          ⚠ 曾经这里没有 rail，hero 被反撑成 100vw 然后再给内容加 140px 横移来「凑」中心 ——
            现在 rail 是真实布局的一部分，横移量 = rail/2 自然成立，且随视口自适应。 */}
      <ProjectRail active="home" />
      <div className="project-list-body">
          <section
            className={'agent-hero' + (hasAgentDialogue ? ' has-thread' : '')}
            ref={heroRef}
            aria-label="介绍小QTV Agent"
          >
            {/* 对标星野：`<img class="absolute inset-0 size-full object-cover">` —— 真实星空照片 */}
            <img
              className="agent-hero-backdrop"
              src="/covers/agent-starfield-backdrop.webp"
              alt=""
              fetchPriority="high"
            />
            {/* 三维粒子 + 引力透镜（照搬对标 chunk 里的 Qr 组件），铺满 hero、压在文案之下。
                `onArrival` 是 hero 文案入场的触发源（对标 `!P&&f>=1.5&&onArrival()`）。 */}
            <LazyAgentLensCanvas
              promptRef={consoleRef}
              active={heroActive}
              engaged={hasAgentDialogue}
              onArrival={handleLensArrival}
            />
            {/* ⚠ `data-ready` / `data-animate` / `inert` 三件套挂在 **copy 容器**上，不是 section 上
                —— 对标是 `n(te,'data-ready',b)`、`n(te,'data-animate',!xt.current)`、`te.inert=!b`，
                其中 te 就是 `div.hero-copy`。CSS 的 `.hero-copy[data-ready=true] .hero-enter{…}`
                也正是从这个容器往下选。 */}
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
                onCancel={() => void heroAgent.cancel()} onReconnect={() => void heroAgent.reconnect()} />
               {canvasNavigationError ? <p role="alert" className="hero-agent-error">{canvasNavigationError}</p> : null}
              {/* 对标把输入台包在 `role="group"` 的定位容器里，.agent-streaks 是它的 `-inset-1` 子层。
                  顺序是 streaks 在前、form 在后（streaks 靠绝对定位脱层，不靠 z-index）。
                  ⚠ 这一层承载两个**只在这一层**才有的东西（都照抄对标 `ne` 元素）：
                    · `--intro-delay: 225ms` —— 入场阶梯是 标题 75ms（默认）/ 副题 150ms / 输入台 225ms；
                    · `animation-play-state` —— 对标 `ne` 上算的是
                      `!ready||!visible ? 'paused' : 'running'`，而 `.agent-streaks` 与其 `::before`
                      都写了 `animation-play-state: inherit`，所以光带的自转/闪烁会被这一层统一开关。
                      不写这行的话，光带在文案还没入场时就已经在转了。 */}
              <div
                className="agent-prompt hero-enter"
                role="group"
                aria-label="Agent 提示词"
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
                  {/* 底栏 = 对标 `flex w-full items-end justify-between gap-2` 的两个簇：
                        左 `<div data-slot="prompt-box-bottom-left"  class="flex min-w-0 flex-wrap items-center gap-1">`
                        右 `<div data-slot="prompt-box-bottom-right" class="ml-auto flex shrink-0 items-center justify-end gap-1">` */}
                  <div className="agent-console-bar">
                    <div className="agent-console-left">
                      {/* ＋ = 对标 `[data-slot=prompt-box-attach]` 的 **Lucide `plus`** 图标
                             <path d="M5 12h14"/><path d="M12 5v14"/>  stroke-width="2"
                          不是我们以前用伪元素画的十字（那根是 1.5px 细线，粗细不对）。 */}
                      <button className="agent-plus" type="button" aria-label="添加参考素材" onClick={() => navigate('/signup')}>
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
                    </div>
                    <div className="agent-console-right">
                      {/* 对标（生产 chunk 触发钮模板 `Pr`）是**两个 span + gap-1(4px)**，
                          不是 `<b>Auto</b>` 拼字符串：第一段 `Auto` 无粗体（按钮是 font-normal）、
                          用前景色；第二段是 effort 的 label，用 `text-muted-foreground`。
                          第三段是 Lucide `chevron-down`（路径 m6 9 6 6 6-6）、`size-3.5` = 14px、
                          色同为 text-muted-foreground —— 不是文本字符 `∨`。 */}
                      <span className="agent-mode">
                        {/* 对标触发钮里只有一个孩子：`<span class="flex min-w-0 items-center gap-1 text-sm">`
                            —— Auto / Medium / chevron **三者都在这个 span 里**，chevron 不是按钮的直接孩子。 */}
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
                      {/* 发送钮 = 对标 `[data-slot=prompt-box-generate]` 的 **Lucide `sparkle`**（路径见
                          ./agentConsole.ts）；`stroke-width="1.5"`、`size-4`(16px)、黑色填充。
                          白圆 + 黑色四角星的观感就是它，不需要自己画 clip-path。
                          对标在输入为空时给按钮 `disabled` ⇒ `opacity-50`，所以这里也绑 disabled。 */}
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
              </div>
            </div>
          </section>

          <a className="feature-tile" href="/signup">
            <img className="feature-tile-img" src="/covers/cover-2.webp" alt="" loading="lazy" />
            <span className="feature-tile-veil" aria-hidden="true" />
            <span className="feature-tile-title">小QTV<i className="feature-tile-mark" aria-hidden="true">＋</i>Agent</span>
          </a>

        {/* 模型展示：大图 + 字幕章 */}
        <section id="work" className="kmodel">
          <Reveal>
            <h2 className="kmodel-title"><SplitChars text="最有表现力的视频创作模型。" /></h2>
            <p className="kmodel-sub">小QTV 2 —— 从参考方法学到成片，一个模型闭环。</p>
          </Reveal>
          <Reveal className="kmodel-figure">
            <figure>
              <img src="/covers/cover-1.webp" alt="小QTV 2 生成示例：产品 · 青调" loading="lazy" />
              <figcaption className="kmodel-cap"><span>小QTV 2</span><b>产品 · 青调</b></figcaption>
            </figure>
          </Reveal>
        </section>

        {/* 能力三卡 */}
        <section id="capability" className="kcaps">
          <Reveal><h2 className="ksection-title"><SplitChars text="三条能力，一个闭环。" /></h2></Reveal>
          <div className="kcap-grid">
            {capabilities.map(([title, copy], i) => (
              <Reveal key={title} className="kcap-card">
                <span className="kcap-num">0{i + 1}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* 逐字统计 */}
        <section className="kstats">
          <Reveal><p className="kstat"><SplitChars text="30,000+" /><b>支成片</b></p></Reveal>
          <Reveal><p className="kstat"><SplitChars text="191" /><b>种参考风格</b></p></Reveal>
          <Reveal><p className="kstat"><SplitChars text="4" /><b>步闭环</b></p></Reveal>
        </section>

        {/* 四步流程（保留 /#workflow 锚点） */}
        <section id="workflow" className="ksteps">
          <Reveal><h2 className="ksection-title"><SplitChars text="四步，从参考到成片。" /></h2></Reveal>
          <div className="kstep-row">
            {steps.map(([num, title, copy]) => (
              <Reveal key={num} className="kstep">
                <span className="kstep-num">{num}</span>
                <b>{title}</b>
                <p>{copy}</p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ⚠ hero 必须是 .project-list-main 的**兄弟**、铺满整个主列 —— 线上 DOM 正是这个层级：
             <main> 下第一层是 hero section（宽度 = 主列全宽），第二层才是居中窄列
             `mx-auto max-w-[112rem] p-6 md:p-12`（下面几屏）。 */}
        <main className="project-list-main" onPointerMove={handleSpotlight}>
        {/* 定价：月/年切换 + 算力滑杆 */}
        <section id="pricing" className="kpricing">
          <Reveal><h2 className="ksection-title"><SplitChars text="定价。" /></h2></Reveal>
          <div className="ktabs" role="tablist" aria-label="计费周期">
            <button role="tab" aria-selected={!yearly} className={!yearly ? 'on' : ''} onClick={() => setYearly(false)}>月付</button>
            <button role="tab" aria-selected={yearly} className={yearly ? 'on' : ''} onClick={() => setYearly(true)}>年付<em>-40%</em></button>
          </div>
          <div className="ktier-grid">
            {plans.map(plan => (
              <Reveal key={plan.key} className="ktier">
                <h3>{plan.name}</h3>
                <p className="ktier-blurb">{plan.blurb}</p>
                <p className="ktier-price"><b>¥{yearly && plan.yearly ? plan.yearly : plan.monthly}</b><span>/月{yearly && plan.yearly ? ' · 年付' : ''}</span></p>
                <p className="ktier-units">{plan.units}</p>
                <ul>{plan.feats.map(f => <li key={f}>{f}</li>)}</ul>
                <a className={plan.key === 'pro' ? 'kcta-solid' : 'kcta-glass'} href="/signup">{plan.key === 'free' ? '免费开始' : '升级专业'}</a>
              </Reveal>
            ))}
            <Reveal className="ktier ktier-slider">
              <h3>工作室</h3>
              <p className="ktier-blurb">团队与重度产出。</p>
              <p className="ktier-price"><b>¥{yearly ? Math.round(units * 0.18) : Math.round(units * 0.3)}</b><span>/月</span></p>
              <div className="kunit-steps" role="group" aria-label="生成次数">
                {unitSteps.map(u => <button key={u} className={units === u ? 'on' : ''} onClick={() => setUnits(u)}>{u >= 1000 ? `${u / 1000}k` : u}</button>)}
              </div>
              <input type="range" min={500} max={5000} step={500} value={units} onChange={e => setUnits(Number(e.target.value))} aria-label="每月生成次数" />
              <p className="ktier-units">{units.toLocaleString()} 次生成 / 月</p>
              <ul><li>一切专业档功能</li><li>多席位协作</li><li>批量导出</li><li>专属支持</li></ul>
              <a className="kcta-solid" href="/signup">联系开通</a>
            </Reveal>
          </div>
        </section>

        {/* Ask AI 深链 */}
        <section id="faq" className="kask">
          <Reveal><h2 className="ksection-title"><SplitChars text="问 AI 关于小QTV。" /></h2></Reveal>
          <p className="kask-sub">把这句话丢给你常用的 AI，听听它怎么评价这套工作流。</p>
          <div className="kask-links">
            <a href={`https://chatgpt.com/?q=${askPrompt}`} target="_blank" rel="noreferrer">问 ChatGPT</a>
            <a href={`https://claude.ai/new?q=${askPrompt}`} target="_blank" rel="noreferrer">问 Claude</a>
            <a href={`https://www.google.com/search?udm=50&q=${askPrompt}`} target="_blank" rel="noreferrer">问 Gemini</a>
            <a href={`https://www.perplexity.ai/search?q=${askPrompt}`} target="_blank" rel="noreferrer">问 Perplexity</a>
          </div>
        </section>

        {/* 收口 CTA */}
        <section className="kfinal">
          <Reveal>
            <h2><SplitChars text="把参考变成你的下一支片子。" /></h2>
            <a className="kcta-solid" href="/signup">免费开始创作</a>
          </Reveal>
        </section>

        <footer className="kfoot">
          <div className="kfoot-cols">
            <div><h4>产品</h4><a href="#work">作品</a><a href="#capability">能力</a><a href="#workflow">流程</a><a href="#pricing">定价</a></div>
            <div><h4>创作</h4><a href="/signup">免费开始</a><a href="/workbench">工作台</a><a href="/create">四步流程</a></div>
            <div><h4>资源</h4><a href="#faq">常见问题</a><a href="#capability">方法学</a><a href="#pricing">额度说明</a></div>
          </div>
          <div className="kfoot-base"><span className="brand-symbol">Q</span><span>小QTV · 懂镜头语言的创作搭档</span><em>© 2026 小QTV</em></div>
        </footer>
        </main>
      </div>
    </div>
  );
}
