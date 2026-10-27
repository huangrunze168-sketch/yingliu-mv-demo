import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  HalfFloatType,
  MathUtils,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  Points,
  ReinhardToneMapping,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';

/* ============================================================================
   对标站「A new era」首屏的 **Agent 引力透镜** —— 逐字搬自对标生产代码
   ============================================================================
   来源：对标站 首页 生产构建里的组件（压缩名）。它渲染的是
        <canvas class="pointer-events-none absolute inset-0 size-full rounded-[inherit]
                      transition-opacity duration-600 ...">

   ⚠ 这块是整张图里最容易被误判的地方，也是前几轮「越改越差」的真正原因：
     我把它当成「CSS 画的光环 / 自己调 canvas 粒子」，于是怎么调都不像。
     真实实现是 **三维粒子场景 + 引力透镜后处理**：

     ① 三维粒子（WebGL，一趟）
        · 把 `GLYPH_TEXT`（'小QTV'，无空格；对标原文是 'Agent'）用 `600 240px <页面字体>` 画进
          1000×300 的 2D canvas，逐 2px 采样 alpha>160 的像素 → 字形点集 pts（原点移到字形中心、y 翻转）；
        · 总共 `COUNT*5` 个点（COUNT = 宽<640 ? 4500 : 8000）：
            前 45%  = 字形点（贴在 pts 上，z 方向铺开 2000..10000）
            其余    = 星野点（球坐标 r=800..11800，每 40 个挑一个乘 0.25 拉近）
            最后 1/5 再叠一层更远的远景星（r=10000..20000）
        · 每点带 vec4 star = (大小, 能量, 相位, 长宽比)，颜色 HSL（hue 0.55±0.1 为主，
          8% 暖色 0.06±0.08、1% 品红 0.83±0.1）；
        · 相机 PerspectiveCamera(58, 1, 30, 30000)：入场 0.8→4.4s 由 r=6000 推到 r=600，
          之后以 sin() 叠加持续漂移，并叠加指针视差（damp 4）。
     ② 后处理（二趟）：**点质量引力透镜 + 切向抹散**
        · uniform `box` = 输入台的矩形（中心 + 半宽高），`radius` = 它的 border-radius，
          **每帧从 getBoundingClientRect() 现算**，所以 shader 里那圈光精确贴住输入台轮廓；
        · `edge` = 到该圆角矩形的有符号距离；`influence` 只在 edge∈[45,115]px 内生效；
        · 点质量透镜方程 `source = impact - einstein² / impact` → `bent` 折线采样；
        · `for (i=-16..16) tangent * i * 7.0` 的 **33 抽切向采样**（高斯权重 exp(-(i/9)²)）
          就是参考图里那圈「沿轮廓流动的细丝」——最远抹到 112px，
          与我对标图上量到的 ~115px 完全一致；
        · 再用 `fwidth` 画一根 1px 亮环（`ring = edge - 0.65`）→ 输入台那圈亮边；
        · `flare` 的 `orbit = atan(dir.y, dir.x) + time*0.56` 让它绕圈转 → 那圈会「流动」；
        · `clear` / `quiet` 把输入台内部与文字区压黑 → 台内仍是纯黑。
     ③ 两趟渲染：粒子写进 HalfFloat RT（材料 toneMapped:false，保住 HDR 不给压掉），
        再用全屏三角/quad 过透镜，`toneMapping = Reinhard`，最后 sRGB 输出。

   下面所有常量、PRNG、公式、GLSL 都是原样搬运，只在命名与类型上做了还原。
   ============================================================================ */

/* ★ 星野「拼字」用的文本（对标原文是 'Agent'，按产品要求改成小QTV——**无空格**，与全站文案一致）。
   ⚠ 该文本与 index.html 的 font preload 是**一对**，改一个必须改另一个：
     · `小`(U+5C0F)              → MiSans 第 0 片 `MiSansVF.16240990c6f7f7dd.0.woff2`
     · `Q` / `T` / `V`           → MiSans 第 50 片 `MiSansVF.3ee7f36171786397.50.woff2`
   两片都必须在首屏 JS 采样之前就绪，否则字符落回系统字体 → `measureText` 宽度变化
   → `glyphScale` 变化 → 整片星野变形（就是上一轮修掉的「冷/热加载两个样」）。
   实测 @`600 240px MiSans VF`：'Agent' 733.21、'小Q TV' 841.99、'小QTV' 763.51，均 < 采样画布宽 1000。
   （'小QTV' 去掉空格后反而更贴近对标 'Agent' 的宽度，星野图案比例更接近参照。） */
const GLYPH_TEXT = '小QTV';

const STAR_VERTEX_SHADER = `
				attribute vec3 color;
				attribute vec4 star;
				uniform float arrival, pixelRatio, time;
				varying vec3 tint;
				varying float energy, angle, aspect, spriteSize, foreground;
				void main() {
					vec4 view = modelViewMatrix * vec4(position, 1.0);
					gl_Position = projectionMatrix * view;
					float distance = max(1.0, -view.z);
					float diameter = clamp(star.x * 1400.0 / distance, 0.45, 3.8);
					foreground = arrival * smoothstep(1.2, 2.0, diameter) * (1.0 - smoothstep(1800.0, 3200.0, distance));
					spriteSize = diameter * 7.0 + 5.0;
					gl_PointSize = spriteSize * pixelRatio;
					energy = star.y * smoothstep(100.0, 400.0, distance);
					energy *= 1.0 + arrival * step(0.88, fract(star.z * 7.13)) * step(1.0, star.y)
						* (sin(time * (0.7 + star.w) + star.z) * 0.25 + sin(time * 2.3 + star.z * 4.0) * 0.12);
					tint = color;
					angle = star.z;
					aspect = star.w;
				}
			`;

const STAR_FRAGMENT_SHADER = `
				varying vec3 tint;
				varying float energy, angle, aspect, spriteSize, foreground;
				void main() {
					vec2 pixel = (gl_PointCoord - 0.5) * spriteSize;
					float pinpoint = exp(-dot(pixel, pixel) * 0.5);
					vec2 p = gl_PointCoord * 2.0 - 1.0;
					p = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p;
					p *= vec2(inversesqrt(aspect), sqrt(aspect));
					float core = exp(-dot(p, p) * 65.0);
					vec2 shoulder = p - vec2(0.055, 0.025);
					float light = core + exp(-dot(shoulder, shoulder) * 35.0) * 0.22
						+ exp(-dot(p, p) * 20.0) * 0.08 + exp(-dot(p, p) * 6.0) * 0.004;
					gl_FragColor = vec4((tint * light + vec3(1.0) * pinpoint * foreground * 3.0) * energy, 1.0);
				}
			`;

const LENS_VERTEX_SHADER = `
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`;

/* ⚠ 这段是效果的核心，除注释外**一字未改**。注意三个硬依赖：
     · `varying`/`texture2D`/`gl_FragColor` 是 GLSL1 写法（three 的 ShaderMaterial 默认就是）；
     · `fwidth()` 需要导数 —— three r163 起渲染器只支持 WebGL2，导数是核心特性，
       所以**不需要**再写 `extensions.derivatives`（该字段已被 three 移除，写了会 TS 报错）；
     · 两个 three 的 `#include` 必须保留，否则 Reinhard 色调映射与 sRGB 编码都不会发生，
       画面会整体发灰/过曝。 */
const LENS_FRAGMENT_SHADER = `
				uniform sampler2D tDiffuse;
				uniform vec2 resolution, quiet;
				uniform vec4 box;
				uniform float radius, amount, mass, arrival, time;
				varying vec2 vUv;
				void main() {
					vec2 p = vUv * resolution - box.xy;
					vec2 q = abs(p) - box.zw + radius;
					float edge = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
					float horizon = max(box.w, 24.0);
					float impact = horizon + max(edge, 0.0);
					float einstein = horizon + 26.0 * mass;
					// Point-mass lens equation adapted to a rounded rectangle, not a Schwarzschild solution.
					float source = impact - einstein * einstein / impact;
					vec2 direction = normalize(p / max(box.zw, vec2(1.0)) + vec2(0.00001));
					vec2 bent = (box.xy + p * 0.45 + direction * source * 1.8) / resolution;
					float influence = amount * (1.0 - smoothstep(45.0, 115.0, edge));
					vec2 sampleUv = mix(vUv, bent, influence);
					vec2 bounds = min(sampleUv, 1.0 - sampleUv) * resolution;
					vec3 light = texture2D(tDiffuse, clamp(sampleUv, 0.0, 1.0)).rgb
						* smoothstep(0.0, 2.0, min(bounds.x, bounds.y));
					float clear = 1.0 - smoothstep(0.35, 1.0, length((vUv * 2.0 - 1.0 - vec2(0.0, 0.34)) / quiet));
					clear *= mix(1.0, smoothstep(12.0, 48.0, edge), amount);
					light *= pow(1.0 - arrival * clear * 0.98, 2.0);
					light *= mix(1.0, smoothstep(-1.0, 1.0, edge), amount);
					float ring = edge - 0.65;
					float pixel = max(fwidth(edge), 0.001);
					float coverage = clamp((ring + 0.25) / pixel + 0.5, 0.0, 1.0)
						- clamp((ring - 0.25) / pixel + 0.5, 0.0, 1.0);
					if (amount > 0.0 && abs(ring) < 3.0) {
						vec3 compressed = vec3(0.0);
						vec2 tangent = vec2(-direction.y, direction.x);
						for (int i = -16; i <= 16; i++) {
							float weight = exp(-pow(float(i) / 9.0, 2.0));
							for (int j = -1; j <= 1; j++) {
								vec2 ray = bent + (tangent * float(i) * 7.0 + direction * float(j) * 18.0 * mass) / resolution;
								compressed += texture2D(tDiffuse, clamp(ray, 0.0, 1.0)).rgb * weight;
							}
						}
						light += amount * (coverage + exp(-abs(ring) / 0.6) * 0.3) * compressed * 1.8;
					}
					float distance = max(edge, 0.0);
					float orbit = atan(direction.y, direction.x) + time * 0.56;
					float flow = 0.12 + 1.4 * pow(0.5 + 0.32 * sin(orbit * 2.0) + 0.18 * sin(orbit * 5.0), 2.0);
					float flare = max(exp(-distance / 20.0) - exp(-5.0), 0.0) * 0.035 * flow;
					light += amount * smoothstep(-0.5, 0.5, edge)
						* vec3(0.5, 0.72, 1.0) * flare;
					gl_FragColor = vec4(light, 1.0);
					#include <tonemapping_fragment>
					#include <colorspace_fragment>
				}
			`;

export type AgentLensCanvasProps = {
  promptRef?: RefObject<HTMLElement | null>;
  /** 是否在视口内；false 时完全停渲染（省电）。 */
  active?: boolean;
  /** 会话已展开：镜头再推近一点（对标 engaged）。 */
  engaged?: boolean;
  /**
   * 开场动画「抵达」时回调一次 —— 对标 `Qr({ onArrival })`。
   * ⚠ 这是 hero 文案入场的**唯一**触发源，不是可选的装饰：
   *   父级的 `data-ready = arrived || prefersReducedMotion`，
   *   也就是说「A new era」的淡入是在透镜推到位的同一刻才发生的。
   * 对标的三条触发路径都要覆盖：① 进度 `f >= 1.5`；② WebGL 起不来；
   * ③（我们额外多一条）2D 字体取样失败，否则文案会永远不出现。
   */
  onArrival?: () => void;
  className?: string;
};

export function AgentLensCanvas({ promptRef, active = true, engaged = false, onArrival, className = '' }: AgentLensCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const restartRef = useRef<(() => void) | null>(null);
  /** 首帧渲染成功后才把 canvas 的 opacity 打开（对标 `transition-opacity duration-600`）。
      用一个 effect 内的局部 flag 守卫，避免每帧 setState 触发 React 重渲染。 */
  const [visible, setVisible] = useState(false);

  // 用 ref 把变化型 props 送进渲染循环，避免重建整个 WebGL 上下文
  const activeRef = useRef(active);
  const engagedRef = useRef(engaged);
  const onArrivalRef = useRef(onArrival);
  onArrivalRef.current = onArrival;
  const promptRefLatest = useRef(promptRef);
  promptRefLatest.current = promptRef;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, depth: false, powerPreference: 'low-power' });
    } catch {
      // 对标：`catch{t.onArrival();return}` —— 拿不到 WebGL 就静默降级，
      // 但**必须**把 onArrival 打上去，否则父级 data-ready 永远不翻、文案永远不出现。
      onArrivalRef.current?.();
      return; // 底图星野仍然在
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = ReinhardToneMapping;

    const scene = new Scene();
    scene.background = new Color(0);
    const camera = new PerspectiveCamera(58, 1, 30, 30000);

    /* ⚠ 必须用 HalfFloat —— 对标就是无条件写的
       `new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false })`。
       加色混合的星野会叠出远超 1.0 的亮度，8bit 渲染目标会把它们钳在 1.0，
       经 Reinhard 之后整片天直接糊成一片白（实测：退回 UnsignedByteType 时全屏均值 220/255）。
       不要"贴心地"加 getExtension 检测再回退 8bit —— 那正是画面发白的根因。 */
    const renderTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      depthBuffer: false,
    });

    /* ---------------- ① 字形采样 → 粒子云 ---------------- */
    const glyph = document.createElement('canvas');
    glyph.width = 1000;
    glyph.height = 300;
    const glyphCtx = glyph.getContext('2d');
    if (!glyphCtx) { onArrivalRef.current?.(); renderer.dispose(); return; }
    glyphCtx.font = `600 240px ${getComputedStyle(canvas).fontFamily}`;
    glyphCtx.textAlign = 'center';
    glyphCtx.textBaseline = 'middle';
    glyphCtx.fillText(GLYPH_TEXT, 500, 150);
    const pixels = glyphCtx.getImageData(0, 0, 1000, 300).data;

    const pts: number[] = [];
    for (let y = 0; y < 300; y += 2) {
      for (let x = 0; x < 1000; x += 2) {
        if (pixels[(y * 1000 + x) * 4 + 3] > 160) pts.push(x - 500, 150 - y);
      }
    }
    /* ⚠ 这次采样用的字体决定了**整片星野**的样子，必须确定：
         `getComputedStyle(canvas).fontFamily` 命中 MiSans VF 才稳定；若某一字符所属的
         MiSans 切片还没到，该字符就落回系统字体，`measureText(GLYPH_TEXT).width` 随之变化
         → `glyphScale` 变化 → 星野图案/疏密/亮度整体变形（「冷加载与刷新后不是同一个页面」）。
         根治办法在 index.html：对 GLYPH_TEXT 用到的两个 MiSans 切片加
         `<link rel="preload" as="font">`（第 0 片含 `小`/空格、第 50 片含 Q/T/V），
         与对标预加载 参照字体 完全同一手法。这里保留对标原公式，不做额外兜底。 */
    const glyphScale = 0.9 * Math.min(1, canvas.clientWidth / canvas.clientHeight) / glyphCtx.measureText(GLYPH_TEXT).width;

    // 对标用的线性同余 + Box-Muller（seed = 7391），换 PRNG 会让星野密度分布变样
    let seed = 7391;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-5))) * Math.cos(rnd() * Math.PI * 2);

    const positions: number[] = [];
    const colors: number[] = [];
    const starData: number[] = [];
    const sph = new Vector3();
    const color = new Color();
    const COUNT = canvas.clientWidth < 640 ? 4500 : 8000;
    for (let i = 0; i < COUNT * 5; i++) {
      const far = i >= COUNT;
      const near = i < COUNT * 0.45;
      sph.setFromSphericalCoords(
        far ? 1e4 + rnd() * 1e4 : 800 + Math.cbrt(rnd()) * 1.1e4,
        Math.acos(rnd() * 2 - 1),
        rnd() * Math.PI * 2,
      );
      if (i % 40 === 0 && !far) sph.multiplyScalar(0.25);
      if (near) {
        const k = Math.floor(rnd() * (pts.length / 2)) * 2;
        const t = 2000 + rnd() * 8000;
        sph.set((pts[k] + gauss() * 2) * t * glyphScale, (pts[k + 1] + gauss() * 2) * t * glyphScale, 1100 - t);
      }
      positions.push(sph.x, sph.y, sph.z);
      starData.push(
        far ? 0.15 + rnd() * 0.65 : 0.35 + rnd() ** 2 * 3.3,
        far ? 0.02 + rnd() ** 2 * 0.2 : 0.05 + rnd() ** 3 * 8,
        rnd() * Math.PI * 2,
        0.8 + rnd() * 0.9,
      );
      const r = rnd();
      const hue = r < 0.08 ? 0.06 + rnd() * 0.08 : r > 0.99 ? 0.83 + rnd() * 0.1 : 0.55 + rnd() * 0.1;
      color.setHSL(hue, 0.5 + rnd() * 0.35, 0.64 + rnd() * 0.2, SRGBColorSpace);
      colors.push(color.r, color.g, color.b);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.setAttribute('star', new Float32BufferAttribute(starData, 4));

    const starUniforms = {
      arrival: { value: 0 },
      time: { value: 0 },
      quiet: { value: new Vector2(0.8, 0.7) },
      pixelRatio: { value: renderer.getPixelRatio() },
    };
    const starMaterial = new ShaderMaterial({
      uniforms: starUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      blending: AdditiveBlending,
      vertexShader: STAR_VERTEX_SHADER,
      fragmentShader: STAR_FRAGMENT_SHADER,
    });
    /* ⚠⚠ 必须是 `Points`，不是 `Mesh`！
       对标写的是 `new Tt(geometry, material)`（`import{ Tt as mn }`）——`Tt` 是 three 的 `Points`，
       它按 `gl.POINTS` 绘制，`gl_PointSize` / `gl_PointCoord` 才有意义。
       若偷懒用 `Mesh`：4 万个无索引顶点会被当成 13333 个垃圾三角形灌满整屏
       —— 实测全屏纯白（88% 像素 ≥250），而把 gl_PointSize 钉成 4 也照样白，
       这正是「不是点在画」的铁证。 */
    const starPoints = new Points(geometry, starMaterial);
    starPoints.frustumCulled = false;
    scene.add(starPoints);

    /* ---------------- ② 透镜后处理 ---------------- */
    const lensUniforms = {
      tDiffuse: { value: renderTarget.texture },
      resolution: { value: new Vector2(1, 1) },
      box: { value: new Vector4() },
      radius: { value: 32 },
      amount: { value: 0 },
      mass: { value: 1 },
      time: starUniforms.time,
      arrival: starUniforms.arrival,
      quiet: starUniforms.quiet,
    };
    const lensMaterial = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: lensUniforms,
      vertexShader: LENS_VERTEX_SHADER,
      fragmentShader: LENS_FRAGMENT_SHADER,
    });
    // 对标是一个覆盖全屏的大三角（顶点 -1,3 / -1,-1 / 3,-1，uv 0,2 / 0,0 / 2,0）
    const quadGeometry = new BufferGeometry();
    quadGeometry.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    quadGeometry.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const lensMesh = new Mesh(quadGeometry, lensMaterial);
    lensMesh.frustumCulled = false;

    /* ---------------- ③ 时间线 ---------------- */
    let elapsed = 0;
    let last = 0;
    let engagedMix = 0;
    let revealed = false;
    /** 对标里的 `P`：onArrival 只打一次。 */
    let arrived = false;
    const parallaxTarget = new Vector2();
    const parallax = new Vector2();

    const frame = (now: number) => {
      if (renderer.getContext().isContextLost()) return;
      const raw = last ? (now - last) / 1000 : 0;
      elapsed += raw;
      last = now;
      /* ★ dt 必须钳在 [0, 0.05]：raw 为负（ResizeObserver 用 now=0 手动起帧、而 last 还是
         上一次的真实时间戳）时，damp(x, target, 4, 负dt) 里 `1 - exp(-4·负dt)` 会变成
         巨大的负数，把 engagedMix 打到 -7180 量级 → g 爆到百万级 → 相机飞出星野，
         整片粒子「一下子就没有了」（会话首次展开时必现：hero 高度变化触发 ResizeObserver）。 */
      const dt = MathUtils.clamp(raw, 0, 0.05);
      const f = reduced ? 4.4 : elapsed;
      const p = MathUtils.smootherstep(f, 0.8, 4.4);
      const m = Math.max(0, f - 4.4);
      engagedMix = reduced ? 0 : MathUtils.damp(engagedMix, engagedRef.current ? 1 : 0, 4, dt);
      const h = p * 0.85 + engagedMix * p * 0.12;
      const g = 6000 - p * (5400 + engagedMix * 360);
      if (reduced) parallax.set(0, 0);
      else parallax.lerp(parallaxTarget, 1 - Math.exp(-dt * 4));
      camera.position.set(
        Math.sin(h) * g + Math.sin(m * 0.035) * 12,
        Math.sin(p * Math.PI) * 180 + Math.sin(m * 0.028) * 8,
        -4900 + Math.cos(h) * g,
      );
      camera.lookAt(0, 0, -4900);
      camera.rotateX(Math.sin(m * 0.02) * 0.015 + parallax.y * p * 0.1);
      camera.rotateY(Math.sin(m * 0.017) * 0.025 + parallax.x * p * 0.16);
      camera.rotateZ(Math.sin(p * Math.PI) * -0.1 + Math.sin(m * 0.025) * 0.007);
      starUniforms.arrival.value = MathUtils.smootherstep(f, 1.8, 3.2);
      starUniforms.time.value = m;

      const prompt = promptRefLatest.current?.current ?? null;
      lensUniforms.amount.value = prompt ? MathUtils.smootherstep(f, 2.2, 3.2) : 0;
      lensUniforms.mass.value = 1 + engagedMix * 0.35;
      if (prompt) {
        const canvasRect = canvas.getBoundingClientRect();
        const boxRect = prompt.getBoundingClientRect();
        lensUniforms.box.value.set(
          boxRect.left - canvasRect.left + boxRect.width / 2,
          canvasRect.bottom - boxRect.bottom + boxRect.height / 2,
          boxRect.width / 2,
          boxRect.height / 2,
        );
        lensUniforms.radius.value =
          parseFloat(getComputedStyle(prompt).borderTopLeftRadius) * boxRect.width / (prompt.offsetWidth || 1);
      }
      /* 对标：`!P&&f>=1.5&&(P=!0,t.onArrival())` —— 开场动画走到 1.5s 就把 hero 文案放出来。
         注意 f 在 reduced-motion 下恒为 4.4，所以这里会**立刻**触发（即 reduced-motion 不做开场）。 */
      if (!arrived && f >= 1.5) { arrived = true; onArrivalRef.current?.(); }
      renderer.setRenderTarget(renderTarget);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(lensMesh, quadCamera);
      if (!revealed) { revealed = true; setVisible(true); }
    };

    const restart = () => {
      last = 0;
      if (reduced) elapsed = Math.max(elapsed, 4.4);
      frame(0);
      renderer.setAnimationLoop(!reduced && activeRef.current && !document.hidden ? frame : null);
    };
    restartRef.current = restart;

    const resize = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = canvas;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight, false);
      renderTarget.setSize(canvas.width, canvas.height);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      lensUniforms.quiet.value.set(Math.min(0.9, 880 / clientWidth), 0.7);
      lensUniforms.resolution.value.set(clientWidth, clientHeight);
      /* ★ 与 restart() 同样必须先清 last 再 frame(0)：
         否则 raw = (0 - last)/1000 是大负数 → elapsed 倒扣、dt 为负
         → engagedMix 被 damp 打飞（见 frame 内注释）→ 会话展开时星野整片消失。 */
      last = 0;
      frame(0);
    });
    resize.observe(canvas);
    if (promptRefLatest.current?.current) resize.observe(promptRefLatest.current.current);

    const host = canvas.parentElement;
    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      parallaxTarget.set((event.clientX - rect.left) / rect.width - 0.5, 0.5 - (event.clientY - rect.top) / rect.height);
    };
    const onLeave = () => parallaxTarget.set(0, 0);
    host?.addEventListener('pointermove', onMove);
    host?.addEventListener('pointerleave', onLeave);

    const onLost = (event: Event) => { event.preventDefault(); setVisible(false); restartRef.current = null; renderer.setAnimationLoop(null); };
    const onVisible = () => restartRef.current?.();
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onVisible);
    document.addEventListener('visibilitychange', onVisible);

    restart();

    return () => {
      renderer.setAnimationLoop(null);
      restartRef.current = null;
      resize.disconnect();
      host?.removeEventListener('pointermove', onMove);
      host?.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      geometry.dispose();
      starMaterial.dispose();
      lensMaterial.dispose();
      quadGeometry.dispose();
      renderTarget.dispose();
      renderer.dispose();
    };
  }, []);

  // active 变化要重开/停掉动画循环；engaged 只影响渲染循环里的插值目标，写 ref 即可
  useEffect(() => {
    activeRef.current = active;
    restartRef.current?.();
  }, [active]);

  useEffect(() => {
    engagedRef.current = engaged;
  }, [engaged]);

  return (
    <canvas
      ref={canvasRef}
      className={'agent-lens-canvas ' + className}
      style={{ opacity: visible ? 1 : 0 }}
      aria-hidden="true"
    />
  );
}
