/* ============================================================
  期音科技 · 导演台摆位 → 生成提示词
  ------------------------------------------------------------
    · src/features/canvas/application/blueprintPrompt.ts  —— 摆位怎么描述
    · src/features/canvas/application/promptTemplates.ts  —— `directorStudio.layout` 的默认文案
    · src/features/canvas/application/panelPromptBuilders.ts —— applyTemplate

  我们只搬 `directorStudio.layout` 这一条的默认值，所以把正文内联成常量——
  与上一轮搬 cameraPromptLibrary 时同一种处理：搬的是**这一件事的行为**，不是那套设置系统。

  为什么这一层必须存在（而不是"反正有截图了"）：
  截图只能告诉模型"大概是这个样子"，说不出"左起第二个人比第一个人离镜头远 1.5 米"
  这种**相对关系**。出图最容易崩的恰恰是这件事——人物粘连、位置互换、多出一个人。
  照搬比自创靠谱。

       ——它的蓝图截图里每个主体画成**彩色标记**。我们的截图是真实的 3D 代理
       不存在的标记，所以删掉这一句，其余照旧。
    ② 引用截图那句用我们自己的说法（「第 1 张参考图是导演台截图…」），
       而我们的参考图是走 `node --left` 连上去的节点——没有证据表明
       那条路上 `@图1` 会被解析成"第 1 张参考图"。写一个我们自己能保证的句子，
       比抄一个可能什么都不指的记号好。
  ============================================================ */

/**
 * 生成服务看到的"一个主体"。
 *
 * 字段是**契约 `spatial-plan@1` 的 `subjects[]` 的形状**（只声明这一层用得到的），
 * 而不是 import 契约类型：这一层的输入来自 `spatial_plans.plan_json` 解析出来的
 * 普通对象，写死结构反而让"库里那份 JSON 少一个键"这种事在编译期看不出来。
 * 认不出来的条目由调用方过滤，这里只处理能认的。
 */
export interface StagingSubject {
  subject_ref: string;
  /**
   * 主体在主体库里的名字（例如「小Q」）。

   * 可选：空间方案里没有它，生成服务查过主体档案之后才补上。
   * 有名字就用名字——提示词里前面写着「参考 小Q 的五官特点」、
   * 后面却把同一个人叫「角色 1」，模型收到的是两条互相独立的信息，
   * 而"这是同一个人"恰恰是跨镜一致性最要紧的那件事。
   */
  display_name?: string;
  proxy: 'mannequin' | 'box';
  position: readonly [number, number, number];
  rotation_deg?: readonly [number, number, number];
  pose?: string;
  body_preset?: string | null;
  pose_preset?: string | null;
  scale?: number;
}

/**
 *
 * 而 `{{modeInstructions}}` / `{{placements}}` 这些片段是英文）。
 * 自己把它"统一成中文"会改动模型看到的字，那是没有依据的改动。
 */
export const DIRECTOR_STAGING_TEMPLATE_ZH =
  '{{modeInstructions}}, 将导演台布局视为不可见的制作指导，而不是要画进画面的内容。'
  + '保持每个主体身份稳定且彼此独立。当元素引用上传图时，使用提示词中给出的编号参考图作为主体身份和外观参考。'
  + '尊重对象名称、颜色、动作、关系和坐标等场面调度约束。保持场景光线和风格一致。'
  + '不要复制、合并或新增未命名主体。不要绘制导演台控件、标记、标签、网格线或任何 UI 覆盖层。'
  + '不要文字、水印或注释。'
  + '{{referenceImages}}, {{placements}}, {{sceneReferences}}, {{basePrompt}}';

/**
 *
 * 那个"重拼"看着多余，其实是关键：占位符为空时会在正文里留下一串连续逗号
 * （`… 不要文字。,, , 中景，平视`），模型看到的是一段有噪声的提示词。
 * 不这么做的话，"这一镜没有站位"的提示词会明显比有站位的难看。
 */
export function applyStagingTemplate(template: string, values: Record<string, string>): string {
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? '');
  return rendered
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
}

/** 一位小数；`-0.0` 写成 `0.0`（提示词里出现负零是噪声） */
const round1 = (value: number): string => (Object.is(value, -0) ? '0.0' : value.toFixed(1));

/** 这一镜的相机（世界坐标）。有它才算得出"画面左/右、离镜头多远"。 */
export interface StagingCamera {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

interface CameraBasis {
  position: readonly [number, number, number];
  /** 相机朝向（单位向量） */
  forward: readonly [number, number, number];
  /** 画面右方（单位向量）= forward × up */
  right: readonly [number, number, number];
}

const subtract = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const dot = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * 相机的朝向与右方。
 *
 * "ground position ... of a subject relative to the viewer camera"），
 * 所以它直接写 `x` 与 `-z` 就够了。
 * 而我们的契约定死是**世界坐标**（`coordinate_system: y_up_right_handed`），
 * "离世界原点多远"——机位一挪，整段描述就是错的，而且错得看不出来。
 *
 * 所以这里按相机做一次投影：`forward` 取机位→目标的方向，
 * `right = forward × up`（y 轴朝上的右手系里，镜头看向 -Z 时 right 正好是 +X，
 * 与"x>0 在画面右"一致）。
 */
function cameraBasis(camera: StagingCamera): CameraBasis | null {
  const forwardRaw = subtract(camera.target, camera.position);
  const length = Math.hypot(forwardRaw[0], forwardRaw[1], forwardRaw[2]);
  /* 机位与目标点重合时没有"朝向"可言：宁可不给方位，也不要凭空编一个 */
  if (!(length > 1e-6)) return null;
  const forward: [number, number, number] = [
    forwardRaw[0] / length, forwardRaw[1] / length, forwardRaw[2] / length,
  ];
  /* (fx, fy, fz) × (0, 1, 0) = (-fz, 0, fx) */
  const right: [number, number, number] = [-forward[2], 0, forward[0]];
  const rightLength = Math.hypot(right[0], right[1], right[2]);
  /* 镜头正对着天或正对着地时 right 退化成零向量：同样不给方位 */
  if (!(rightLength > 1e-6)) return null;
  return {
    position: camera.position,
    forward,
    right: [right[0] / rightLength, right[1] / rightLength, right[2] / rightLength],
  };
}

/**
 * 一个主体在画面里的位置描述。
 *
 * 左右与远近则按相机算。没有可用相机时退回世界坐标，并且
 * **不写 screen-left / screen-right**——没有机位就说不出画面里的左右。
 */
function describePosition(subject: StagingSubject, basis: CameraBasis | null): string {
  const [x, y, z] = subject.position;
  const elevated = y > 0.05 ? `, elevated ${round1(y)}m` : '';
  if (basis === null) {
    return `at world position (x ${round1(x)}m, z ${round1(z)}m${elevated})`;
  }
  const delta = subtract(subject.position, basis.position);
  const screenX = dot(delta, basis.right);
  const depth = dot(delta, basis.forward);
  const side = Math.abs(screenX) < 0.15 ? 'screen-center' : screenX < 0 ? 'screen-left' : 'screen-right';
  /* 站在机位背后的人：不说出来，模型会把"深度为负"当成"在镜头前面" */
  const behind = depth < 0 ? ', behind the camera' : '';
  return `at floor position (x ${round1(screenX)}m ${side}, depth-from-camera ${round1(depth)}m${behind}${elevated})`;
}

/**
 * 旋转与缩放：只在**真的不等于默认值**时才写。
 *
 * 每个主体都写一遍 `rotation (0°, 0°, 0°), scale (1.00, 1.00, 1.00)`
 * 会让提示词里一半的字是废话，反而把真正要紧的位置短语冲淡。
 */
function describeTransform(subject: StagingSubject): string {
  const parts: string[] = [];
  const rotation = subject.rotation_deg;
  if (rotation && rotation.some((value) => Math.abs(value) > 0.6)) {
    parts.push(`rotation xyz (${rotation.map((value) => `${Math.round(value)}°`).join(', ')})`);
  }
  if (typeof subject.scale === 'number' && Math.abs(subject.scale - 1) > 0.01) {
    parts.push(`scale ${subject.scale.toFixed(2)}x`);
  }
  return parts.length > 0 ? `, transform: ${parts.join(', ')}` : '';
}

/** 第几个角色 / 第几个道具——与导演台 3D 视口里的叫法一致（角色 1、道具 1） */
function subjectLabel(subject: StagingSubject, ordinal: number): string {
  const name = subject.display_name;
  if (typeof name === 'string' && name.trim() !== '') return name.trim();
  return subject.proxy === 'mannequin' ? `角色 ${ordinal}` : `道具 ${ordinal}`;
}

/**/
function describePlacements(subjects: readonly StagingSubject[], basis: CameraBasis | null): string {
  if (subjects.length === 0) return '';
  let persons = 0;
  let objects = 0;
  const lines = subjects.map((subject, index) => {
    const isPerson = subject.proxy === 'mannequin';
    if (isPerson) persons += 1;
    else objects += 1;
    const ordinal = isPerson ? persons : objects;
    const kind = isPerson ? 'person' : 'object';
    const body = isPerson && subject.body_preset
      ? `, body preset ${subject.body_preset}`
      : '';
    /*
      姿态两档都要说：`pose_preset` 是细粒度的那一个（叉腰、单膝跪地），
      `pose` 是粗粒度（站着/坐着）。细的没选就用粗的——这正是界面上那两档的关系。
    */
    const pose = isPerson
      ? (subject.pose_preset
        ? `, pose preset ${subject.pose_preset}`
        : subject.pose === 'sitting' ? ', seated' : '')
      : '';
    /*
      清单序号用**总体序号**（1、2、3…），名字里的编号用**同类序号**（角色 1、道具 1）。
      两个都用同类序号的话，输出会变成 "1. person 角色 1 …; 1. object 道具 1"——
      同一段清单里出现两个 1，读起来像两条独立的分组。
    */
    return `${index + 1}. ${kind} "${subjectLabel(subject, ordinal)}"${body}${pose} - `
      + `${describePosition(subject, basis)}${describeTransform(subject)}`;
  });
  return `subjects to place: ${lines.join('; ')}`;
}

export interface DirectorStagingPromptInput {
  /** 七字段派生出来的那一句（景别、机位、光线、替换方案），作为正文主语 */
  basePrompt: string;
  subjects: readonly StagingSubject[];
  /**
   * 这一镜的机位。**没有它就不写画面左/右**——
   * 我们存的是世界坐标，没有相机就没有"画面里哪边"这回事。
   * 只在契约的 `camera` 缺失时才为 null（`enabled=true` 时契约允许只有站位没有机位）。
   */
  camera?: StagingCamera | null;
  /**
   * 这一镜的构图蓝图会不会作为参考图一起发出去。
   *
   * 为真时才写那句"第 1 张参考图是导演台截图"——没发图却说有图，
   * 模型会去找一张不存在的参考。
   */
  hasBlueprintScreenshot: boolean;
}

/**
 * 拼出这一镜最终的图片提示词。
 *
 * **没有站位时原样返回 `basePrompt`**：导演台没摆东西的时候，
 * 套上这层模板只会往提示词里加一段"将导演台布局视为不可见的制作指导"——
 * 而根本没有布局可指导。提示词变长、还可能让模型困惑，
 * 这属于"为了统一而制造噪声"。
 */
export function buildDirectorStagingPrompt(input: DirectorStagingPromptInput): string {
  const basis = input.camera ? cameraBasis(input.camera) : null;
  const placements = describePlacements(input.subjects, basis);
  if (placements.length === 0) return input.basePrompt.trim();

  const modeInstructions = [
    'this is a Director Studio spatial-layout guided image generation driven by a 3D staging floor plan',
    'render a single final photo whose composition respects those relative positions (who is left / right / closer to camera / farther from camera / higher / lower)',
    basis === null
      ? 'camera reference: y is height above the floor; this shot has no camera pose, so positions are given in world coordinates'
      : 'camera reference: x<0 is screen-left, x>0 is screen-right, positive depth-from-camera means farther away from the viewer, y is height above the floor',
    input.hasBlueprintScreenshot
      ? '第 1 张参考图是导演台截图：用它对齐构图、空间布局、取景与透视，但不要把它当成要照抄的画面内容'
      : '',
  ].filter(Boolean).join(', ');

  return applyStagingTemplate(DIRECTOR_STAGING_TEMPLATE_ZH, {
    modeInstructions,
    placements,
    /* 主体身份参考图（`@图1` 那条路）我们还没有——留空，applyTemplate 会把空段去掉 */
    referenceImages: '',
    /* 场景 / 环境参考（全景底图）同理，暂未接成参考图 */
    sceneReferences: '',
    basePrompt: input.basePrompt.trim(),
  });
}
