import type {
  BackendAudioRequest,
  BackendImageShortcutRequest,
  BackendImageRequest,
  BackendMedia,
  BackendVideoEditRequest,
  BackendVideoGenerationRequest,
  BackendVideoRequest,
  GenerationBackend,
} from '@qiyin/generation-backend';
import { UnsupportedCapabilityError, describeParameterNotes } from '@qiyin/generation-backend';
import type { CanvasAdapter } from './adapter.js';
import { normalizeModelParams, type NormalizeParamsResult } from './param-normalize.js';

/* ============================================================
   期音科技 · 小QTV 生成后端
   ------------------------------------------------------------
   把「画布节点」这套执行模型收进一个实现里：一次生成 =

     图：node create(image) → node --run → download
     视频：upload(首帧) → node create(video, --left) → node --run → download

   上层（生成服务）看不到节点、画布、`--left` 这些词——它只问
   「给我一张图 / 一段视频」，以及「花了多少」。

   最后那一点是本后端**如实报缺**的地方：小QTV 的 CLI 没有计费接口，
   所以我们返回 `cost: null`（不提供），而不是 0（花了 0 元）。
   把「不知道」写成 0，正是账目不可信的起点。
   ============================================================ */

/** 资源名里的时间戳：同一秒内多次调用也要能区分。 */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function createCanvasBackend(adapter: CanvasAdapter): GenerationBackend {
  /**
   * 模型 schema 的缓存（按模型**显示名**）。
   *
   * 为什么要它：参数必须按模型 schema 收敛一次，否则 CLI 会因为
   * "键不认识 / 取值不在枚举里"直接拒绝整条 `node create`（实测，见 param-normalize.ts）。
   * 失败的查询也缓存成 null，免得每个镜头都去重试一次。
   */
  const schemaCache = new Map<string, Awaited<ReturnType<CanvasAdapter['modelSchema']>> | null>();

  const schemaFor = async (model: string) => {
    if (schemaCache.has(model)) return schemaCache.get(model) ?? undefined;
    try {
      const found = await adapter.modelSchema(model);
      schemaCache.set(model, found);
      return found;
    } catch {
      /* 拿不到 schema（名字拼错 / CLI 版本不同 / 网络）→ 记 null，参数原样放行 */
      schemaCache.set(model, null);
      return undefined;
    }
  };

  /** 参数收敛：丢掉该模型不认识的键、把取值规范到 schema 的写法 */
  const settingsFor = async (
    model: string,
    settings: Record<string, string | number | boolean> | undefined,
  ): Promise<NormalizeParamsResult> => {
    if (settings === undefined || Object.keys(settings).length === 0) {
      return { accepted: {}, droppedKeys: [], adjusted: [] };
    }
    const schema = await schemaFor(model);
    return normalizeModelParams(settings, schema?.schema);
  };

  /** 收敛结果 → 给用户看的那几句话（丢键 / 改值各一句） */
  const notesOf = (result: NormalizeParamsResult): string[] =>
    describeParameterNotes({ dropped: result.droppedKeys, adjusted: result.adjusted });

  /**
   * 下载产物。
   *
   * **固定带 `--without-ai-watermark`**，依据是实测（2026-09）：
   *
   *   而它**会 404**；后果是"生成成功、下载失败"——一次已经花掉的钱白花，
   *   而且用户看到的是一句跟生成无关的 API 报错。
   *
   *   CLI 的帮助写着「偏好不添加 AI 水印（与画布「去水印」一致；
   *   会员且账号有效时图片/视频可走原链）」——本机账号是年费会员，
   *   实测带开关后同一张图立刻下载成功。
   *
   * 顺带说清产品口径：产物要进用户的项目、再进成片，AI 水印不是我们要加的东西。
   */
  const downloadTo = (node: string, outputDir: string) =>
    adapter.download({ node, to: outputDir, withoutAiWatermark: true });

  return {
    id: 'canvas',
    label: 'LibTV 画布（外部服务）',
    /*
      小QTV 的模型 schema 里确实有 `videoEdit2video`（片段重拍）与
      tool_spec 里读出来的，不是猜的。所以 videoEdit 如实声明为 true。
    */
    /*
      图片高清放大（界面上的「高清」）在 小QTV 这边**关着**，依据是实测：
          （故事板 / 多机位 / 三视图 / 光影校正都在，放大不在）；
        · 根命令也没有 image upscale 之类的子命令。
      也就是说 小QTV 的「高清」是**平台侧的任务流**，CLI 没暴露入口。
      如实声明为 false——界面据此让用户改用图像生成服务（它真有 `image_upscale`），
      而不是让用户点下去拿到一句 CLI 报的"未知命令"。
    */
    capabilities: {
      image: true, videoFromImage: true, videoEdit: true,
      imageShortcut: true, imageUpscale: false,
      /*
        小QTV 画布上确实有 `text2audio` 这类音频节点，但 **CLI 没有暴露入口**
        界面据此不给"用它生成配音"的入口，而不是让用户点下去拿一句未知命令。
      */
      audioSpeech: false, audioMusic: false,
    },

    async generateAudio(request: BackendAudioRequest): Promise<BackendMedia> {
      throw new UnsupportedCapabilityError(this.label, request.kind === 'music' ? 'audioMusic' : 'audioSpeech');
    },

    async generateImage(request: BackendImageRequest): Promise<BackendMedia> {
      const node = `${request.label}-image-${stamp()}`;
      /* 参数收敛在**建节点之前**做：收敛结果既要进 -s，也要变成给用户看的那两句话 */
      const normalized = await settingsFor(request.model, request.settings);
      /*
        参考图走"上传成资源节点 + 连到左侧入边"，与图生视频同一条路子。

        为什么不是直接给个文件路径：小QTV 的 `--left` 连的是**节点**，
        不是文件。所以参考图必须先上传成画布上的资源节点。
      */
      /*
        多参考槽位（VID-010）：小QTV 这边**一次只连一个参考节点**
        （`--left` 只接受一个节点名），所以只送第 1 张，并把这件事写进 notes。
        悄悄只用第一张，用户会以为后面几张也参与了。
      */
      const referenceFiles = request.referenceImageFiles ?? (request.referenceImageFile === undefined ? [] : [request.referenceImageFile]);
      const referenceNotes = referenceFiles.length > 1
        ? [`小QTV 一次只连一个参考节点，只用了第 1 张参考图（共给了 ${referenceFiles.length} 张）`]
        : [];
      let referenceNode: string | null = null;
      if (referenceFiles[0] !== undefined) {
        referenceNode = `${request.label}-reference-${stamp()}`;
        await adapter.upload({ name: referenceNode, file: referenceFiles[0], type: 'image' });
      }
      await adapter.nodeCreate({
        name: node,
        type: 'image',
        prompt: request.prompt,
        sets: {
          /*
            参数透传放在最前面：**显式的产品级字段优先**。

            `settings` 是画布参数面板下来的那一包（键已经是后端字段名）。
            它里面理论上也可能出现 ratio/quality，但产品在这里给的默认值
            是有理由的（例如图生视频的 ratio 缺省用 adaptive 跟随首帧），
            不能让一个同名参数把它顶掉——所以展开顺序是"透传在前、显式在后"。
          */
          /*
            先按模型 schema 收敛：CLI 会因为"键不认识 / 取值不在枚举"**整条拒绝**，
            不是忽略（实测，见 param-normalize.ts 文件头）。所以这一步不是优化，是必需。
          */
          ...normalized.accepted,
          model: request.model,
          ...(request.ratio === undefined ? {} : { ratio: request.ratio }),
          ...(request.quality === undefined ? {} : { quality: request.quality }),
        },
        ...(referenceNode === null ? {} : { left: [referenceNode] }),
      });
      const run = await adapter.nodeRun(node);
      const { savedPaths } = await downloadTo(node, request.outputDir);
      if (savedPaths.length === 0) {
        throw new Error(`小QTV 报生成成功，但节点 ${node} 没有落盘任何文件`);
      }
      return {
        files: savedPaths,
        source_url: run.data?.url?.[0] ?? null,
        task_ref: node,
        cost: null,
        notes: [...notesOf(normalized), ...referenceNotes],
      };
    },

    async generateVideo(request: BackendVideoGenerationRequest): Promise<BackendMedia> {
      const marker = stamp(); const videoNode = `${request.label}-video-${marker}`; const normalized = await settingsFor(request.model, request.settings); const referenceNodes: string[] = [];
      for (const [index, reference] of request.references.entries()) { const type = reference.mediaType.startsWith('video/') ? 'video' : reference.mediaType.startsWith('audio/') ? 'audio' : 'image'; const name = `${request.label}-${type}-${index + 1}-${marker}`; await adapter.upload({ name, file: reference.path, type }); referenceNodes.push(name); }
      await adapter.nodeCreate({ name: videoNode, type: 'video', prompt: request.prompt, sets: { ...normalized.accepted, model: request.model, modeType: request.modeType, duration: Math.max(1, Math.round(request.durationSeconds)), ...(request.resolution ? { resolution: request.resolution } : {}), ratio: request.ratio ?? (request.references.some(item => item.mediaType.startsWith('image/')) ? 'adaptive' : '16:9') }, ...(referenceNodes.length ? { left: referenceNodes } : {}) });
      const run = await adapter.nodeRun(videoNode); const { savedPaths } = await downloadTo(videoNode, request.outputDir); if (!savedPaths.length) throw new Error(`LibTV 报生成成功，但节点 ${videoNode} 没有落盘任何文件`);
      return { files: savedPaths, source_url: run.data?.url?.[0] ?? null, task_ref: videoNode, cost: null, notes: notesOf(normalized) };
    },

    async generateVideoFromImage(request: BackendVideoRequest): Promise<BackendMedia> {
      const marker = stamp();
      const imageNode = `${request.label}-firstframe-${marker}`;
      const videoNode = `${request.label}-video-${marker}`;
      const normalized = await settingsFor(request.model, request.settings);

      /**
       * 图生视频必须先有参考图节点：`node --left` 连的是**节点**，不是文件路径。
       * 这一步不消耗生成额度，但会占用账户存储。
       */
      await adapter.upload({ name: imageNode, file: request.imageFile, type: 'image' });
      await adapter.nodeCreate({
        name: videoNode,
        type: 'video',
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        sets: {
          ...normalized.accepted,
          model: request.model,
          modeType: 'singleImage2video',
          duration: Math.max(1, Math.round(request.durationSeconds)),
          ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
          /**
           * 省略时用 `adaptive`（跟随首帧画幅），**不用**模型默认的 16:9——
           * 竖屏首帧因此不会被悄悄生成成横屏。
           */
          ratio: request.ratio ?? 'adaptive',
        },
        left: [imageNode],
      });
      const run = await adapter.nodeRun(videoNode);
      const { savedPaths } = await downloadTo(videoNode, request.outputDir);
      if (savedPaths.length === 0) {
        throw new Error(`小QTV 报生成成功，但节点 ${videoNode} 没有落盘任何文件`);
      }
      return {
        files: savedPaths,
        source_url: run.data?.url?.[0] ?? null,
        task_ref: videoNode,
        cost: null,
        /* 参数被规范/丢掉的话要带回去——用户设的和实际用的不一样，必须让他看见 */
        notes: notesOf(normalized),
      };
    },

    /**
     * 视频重拍（`videoEdit2video`）：以已有片段为输入，按提示词局部重生成。
     *
     * 参数集是**照 tool_spec 抄的**，不是照图生视频改的：
     * `config.settings.videoEdit2video = [ratio_auto, resolution, duration_auto, enableSound]`。
     * 也就是说这个模式下画幅与时长**都跟随输入片段**，不接受我们指定。
     */
    async editVideo(request: BackendVideoEditRequest): Promise<BackendMedia> {
      const marker = stamp();
      const sourceNode = `${request.label}-srcvideo-${marker}`;
      const editNode = `${request.label}-retake-${marker}`;

      /* 与图生视频同一条规矩：`--left` 连的是**节点**，不是文件路径 */
      await adapter.upload({ name: sourceNode, file: request.videoFile, type: 'video' });
      await adapter.nodeCreate({
        name: editNode,
        type: 'video',
        prompt: request.prompt,
        sets: {
          model: request.model,
          modeType: 'videoEdit2video',
          ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
          /*
            刻意**不传** ratio 与 duration。

            依据是 tool_spec 里那个 `videoEdit2video` 的设置列表——
            它挂的是 `ratio_auto` / `duration_auto`，而不是 `ratio` / `duration`。
            传了的话，CLI 会**校验并整条拒绝**（实测，见 param-normalize.ts 文件头），
            也就是这次重拍根本发不出去——参数名写错会当场炸，不是悄悄忽略。
          */
        },
        left: [sourceNode],
      });
      const run = await adapter.nodeRun(editNode);
      const { savedPaths } = await downloadTo(editNode, request.outputDir);
      if (savedPaths.length === 0) {
        throw new Error(`小QTV 报重拍成功，但节点 ${editNode} 没有落盘任何文件`);
      }
      return {
        files: savedPaths,
        source_url: run.data?.url?.[0] ?? null,
        task_ref: editNode,
        cost: null,
        /* 重拍这条路的参数是照 tool_spec 写死的，没有"用户设了但没生效"的情况 */
        notes: [],
      };
    },

    /**
     *
     * 三步：把源图**上传成节点** → 在节点上执行该场景 → 下载结果。
     * 顺序不能变：`-n` 要的是节点，不是文件路径（与图生视频那条 `--left` 同一条规矩）。
     *
     * **这一段未经真实付费调用验证**：它会真实消耗额度，自动化不该替用户做这个决定。
     * 依据是 CLI 自己的帮助（`image shortcut list` / `<scene|label> -n <node>`），
     * 所以流程是对的；但"结果节点叫什么、download 该用哪个引用"这一步只有真跑一次
     * 才能确认。代码里做了两个兜底（nodeKey 优先、退回节点名），失败时错误会原样带出来。
     */
    async applyImageShortcut(request: BackendImageShortcutRequest): Promise<BackendMedia> {
      const marker = stamp();
      const sourceNode = `${request.label}-shortcut-src-${marker}`;

      const uploaded = await adapter.upload({ name: sourceNode, file: request.imageFile, type: 'image' });
      /* 优先用 nodeKey：节点名在画布上要唯一，而我们已经给它带了时间戳；
         nodeKey 是后端的主键，用它更不容易指错 */
      const sourceRef = uploaded.nodeKey || uploaded.data?.name || sourceNode;

      const run = await adapter.runImageShortcut({ scene: request.scene, node: sourceRef });
      /*
        结果可能落在**新节点**上，也可能就地更新源节点。
        两种都兜住：先看返回里给了哪个引用，再退回源节点。
      */
      const resultRef = run.data?.name ?? run.nodeKey ?? sourceRef;

      const { savedPaths } = await downloadTo(resultRef, request.outputDir);
      if (savedPaths.length === 0) {
        throw new Error(`小QTV 报「${request.scene}」执行成功，但节点 ${resultRef} 没有落盘任何文件`);
      }
      return {
        files: savedPaths,
        source_url: run.data?.url?.[0] ?? null,
        task_ref: resultRef,
        cost: null,
        /* 场景化能力（多机位/三视图…）没有参数透传，参数由 scene 决定 */
        notes: [],
      };
    },

    /**
     * 图片高清放大：小QTV 这边走不通（见上面 capabilities 的说明）。
     *
     * 抛 `UnsupportedCapabilityError` 而不是"用图片能力凑一个"：
     * 那 16 个场景里没有任何一个是放大，凑出来的东西跟"高清"不是一回事。
     */
    async upscaleImage(): Promise<BackendMedia> {
      throw new UnsupportedCapabilityError('Canvas', 'imageUpscale');
    },
  };
}
