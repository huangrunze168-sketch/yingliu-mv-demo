import type { SkillDetail, SkillMediaType } from '@qiyin/contracts';

const updatedAt = '2026-03-18T00:00:00.000Z';
type NativeSkill = {
  id: string;
  name: string;
  description: string;
  category: string;
  mediaType?: SkillMediaType;
  uses: number;
  scenario: string;
  inputs: string;
  output: string;
  workflow: [string, string, string, string];
};

const native: NativeSkill[] = [
  { id:'eastern-epic-drama', name:'东方巨构美学短剧', description:'把一句东方幻想设定展开为巨构场景、人物关系与完整短剧分镜。', category:'短剧漫剧', uses:5800, scenario:'仙侠、历史幻想、东方史诗短剧', inputs:'世界观、主角、核心冲突、目标时长', output:'三幕结构、角色设定、逐镜头视觉与声音方案', workflow:['提取世界规则与核心矛盾','建立尺度参照和东方建筑视觉母题','按三幕结构拆解关键转折','输出带时长、景别和声音的可执行分镜'] },
  { id:'xianxia-atmosphere-film', name:'仙侠氛围美学短片', description:'从意境词生成统一人物、服装、仙境空间和诗意镜头节奏。', category:'专业影视', uses:3200, scenario:'仙侠角色片、古风品牌片、氛围短片', inputs:'人物或参考图、意境词、时长、画幅', output:'视觉圣经、角色锁定表、镜头提示词与转场设计', workflow:['锁定人物身份、服装和法器连续性','建立色彩、天气、材质与光线圣经','设计远中近景递进的诗意镜头','检查动作、视线和空间连续性'] },
  { id:'dreamcore-visual-film', name:'梦核视觉短片', description:'把记忆碎片转化为梦核空间、重复意象和可控的不安叙事。', category:'专业影视', uses:1700, scenario:'梦核、怪核、超现实概念短片', inputs:'记忆片段、情绪、禁用元素、目标时长', output:'意象表、空间规则、分镜与声音氛围表', workflow:['提炼记忆锚点与主要情绪','定义熟悉但异常的空间规则','用重复、缺失和尺度错位组织镜头','以环境音和留白控制不安强度'] },
  { id:'indie-cinematic-aesthetic', name:'独立电影怪诞美学', description:'用粗粝真实、冷幽默与作者视角构建克制的独立电影短片。', category:'专业影视', uses:1900, scenario:'作者短片、怪诞广告、低成本剧情片', inputs:'主题、人物困境、场景条件、时长', output:'导演阐述、表演原则、摄影规则和分镜脚本', workflow:['将主题转化为具体人物困境','选择生活化场景与不完美质感','设计克制表演和反高潮节拍','输出手持、自然光和环境声拍摄方案'] },
  { id:'symmetry-color-film', name:'对称色彩电影美学', description:'用中轴构图、章节化叙事和精确色盘生成秩序感短片。', category:'专业影视', uses:3100, scenario:'对称构图短片、复古广告、角色群像', inputs:'主题、角色数量、主色、时长', output:'色彩脚本、构图规则、章节卡和逐镜分镜', workflow:['建立有限色盘与道具编码','用中轴和横移构建空间秩序','按章节卡组织信息与笑点','检查每镜构图、服装与色彩连续性'] },
  { id:'brutalist-monument-film', name:'粗野主义纪念碑影像', description:'生成混凝土巨构、纪念碑尺度与冷峻人文叙事。', category:'专业影视', uses:980, scenario:'建筑概念片、工业品牌片、反乌托邦短片', inputs:'建筑主题、人物尺度、天气、画幅', output:'建筑母题、尺度设计、镜头运动与声音方案', workflow:['确定几何母题与材料老化程度','用人物或车辆建立尺度参照','设计阴天硬质光和低饱和色盘','输出缓慢运动与工业环境声镜头表'] },
  { id:'classical-wuxia-director', name:'古典武侠全流程导演', description:'把武侠灵感转为客栈、竹林、山门等经典空间中的动作叙事。', category:'专业影视', uses:15200, scenario:'古典武侠、门派恩怨、兵器动作短片', inputs:'人物关系、兵器、场景、动作强度', output:'动作节拍表、空间轴线图、逐镜分镜和音效点', workflow:['明确人物目的、门派关系与兵器特性','绘制场景轴线和攻防路线','按试探、升级、反转设计动作节拍','输出可保持人物和兵器连续性的分镜'] },
  { id:'cinematic-fight-vfx', name:'影视打斗特效导演', description:'把角色与招式描述转成空间清楚、冲击有层次的打斗特效镜头。', category:'专业影视', uses:2900, scenario:'超能力战斗、武器对决、游戏感动作片', inputs:'角色参考、能力规则、场景、时长', output:'动作编排、特效层级、镜头表和负面约束', workflow:['锁定角色外观和能力边界','先规划真实动作再叠加特效','用全景交代空间并以近景强化冲击','检查碰撞因果、方向与特效遮挡'] },
  { id:'casting-director-pro', name:'智能选角 Casting', description:'根据剧本角色需求生成可比较的选角画像、试镜片段与决策矩阵。', category:'专业影视', mediaType:'image', uses:6500, scenario:'短剧、广告、电影角色选角', inputs:'角色小传、剧情、年龄范围、表演关键词', output:'候选画像、试镜题、评价维度和定妆提示词', workflow:['从剧情提炼角色的表演任务','区分必要条件与可拓展特质','生成多样化候选画像和试镜情境','用统一评分矩阵给出选择理由'] },
  { id:'pop-mv-director', name:'国际流行 MV 导演', description:'从歌曲情绪和副歌钩子生成舞台、表演、造型与剪辑节奏。', category:'音乐MV', uses:3300, scenario:'流行歌曲 MV、艺人视觉预告、舞蹈短片', inputs:'歌曲或歌词、艺人参考、时长、预算级别', output:'视觉概念、造型表、时间轴分镜和剪辑节拍', workflow:['拆解歌曲段落与情绪曲线','提炼一个可重复的视觉钩子','为主歌、副歌和桥段设计差异化场景','按音乐重拍输出镜头时长和剪辑点'] },
  { id:'electronic-neon-mv', name:'电子霓虹节奏 MV', description:'围绕 BPM、霓虹光场和运动图形设计高能电子音乐影像。', category:'音乐MV', uses:2100, scenario:'电子音乐、DJ 视觉、赛博舞蹈短片', inputs:'BPM、曲式、表演主体、色彩偏好', output:'节拍标记、光效规则、镜头运动和转场表', workflow:['标记强拍、drop 和结构变化','建立两组互补霓虹色和曝光规则','让运镜速度与能量曲线同步','用匹配剪辑和图形转场连接段落'] },
  { id:'chinese-style-mv', name:'国风音乐叙事 MV', description:'把歌词意象转为东方场景、人物动作与含蓄叙事线。', category:'音乐MV', uses:2400, scenario:'古风、民乐、国潮音乐影像', inputs:'歌词、曲风、人物关系、核心意象', output:'意象映射、场景方案、逐段分镜和服化道表', workflow:['提取歌词中的时间、地点和物象','建立主意象与人物关系的映射','用留白和动作替代直白歌词复述','按曲式控制场景变化和情绪高潮'] },
  { id:'lyric-visualizer', name:'歌词可视化短片', description:'将歌词和节奏转成字体、图形、素材与镜头运动的可视化方案。', category:'音乐MV', uses:1800, scenario:'歌词视频、音乐宣发、动态海报', inputs:'歌词、音频节奏、字体偏好、画幅', output:'逐句时间轴、字体规则、动效与背景视觉提示', workflow:['校对歌词并切分到时间轴','为关键词分配字号、位置和运动','选择不干扰阅读的背景视觉','检查安全区、对比度和节奏同步'] },
  { id:'beauty-ugc-review', name:'真人感美妆 UGC 测评', description:'把产品卖点变成可见证据、自然口播和可信的使用前后对比。', category:'商业广告', uses:2500, scenario:'护肤、彩妆、个护产品种草', inputs:'产品图、核心卖点、目标人群、平台', output:'口播脚本、证据镜头、前后对比与合规提示', workflow:['把营销卖点改写为可验证体验','设计开场痛点和真实使用情境','为每个观点配置手部或特写证据','避免绝对化承诺并保留自然口语'] },
  { id:'crossborder-ugc-ad', name:'北美出海 UGC 广告', description:'为跨境商品策划 30 秒内本地化信息流带货视频。', category:'商业广告', uses:1500, scenario:'TikTok、Reels、跨境电商信息流', inputs:'商品、市场、用户痛点、语言、时长', output:'本地化钩子、口播、B-roll 和 CTA 多版本', workflow:['按目标市场重写使用情境和表达','前三秒用具体问题建立钩子','用演示镜头逐一兑现卖点','输出三种 CTA 并标记本地化风险'] },
  { id:'performance-accessory-ad', name:'高机能配饰酷炫广告', description:'为眼镜、手表和数码配饰生成高节奏、高质感产品广告。', category:'商业广告', uses:720, scenario:'配饰新品、数码产品、潮流品牌广告', inputs:'产品多角度图、材料、功能点、目标时长', output:'产品锁定表、光效方案、英雄镜头和节拍分镜', workflow:['锁定产品结构、logo 和材质不可变项','以微距光扫展示材料与工艺','把功能点转为动作和环境反馈','按节拍组织快速切换与英雄定格'] },
  { id:'automotive-impact-tvc', name:'高冲击汽车 TVC', description:'从车型图和卖点生成速度、力量与精密质感兼具的汽车广告。', category:'商业广告', uses:3000, scenario:'汽车发布、性能宣传、概念车型短片', inputs:'车型参考、核心卖点、道路环境、时长', output:'车辆锁定表、场景路线、镜头清单和声音设计', workflow:['锁定车型比例、车漆、轮毂和灯组','将性能卖点转成道路行为与环境反馈','交替使用低机位追车、细节和大景','以引擎、胎噪和音乐重拍强化冲击'] },
  { id:'macro-food-commercial', name:'微距美食广告', description:'用材质、热气、流体与声音特写打造高食欲商业影像。', category:'商业广告', uses:2700, scenario:'食品饮料、餐饮新品、烘焙广告', inputs:'产品、关键口感、制作过程、品牌色', output:'食欲点清单、微距镜头、灯光和拟音方案', workflow:['提炼脆、滑、爆汁等可见口感','选择切开、倾倒、拉丝等动作证据','设计逆光、微距和高速摄影节点','用拟音与节奏建立味觉联想'] },
  { id:'luxury-jewelry-film', name:'珠宝奢品光影广告', description:'围绕宝石切面、金属反射和品牌仪式感生成奢品广告。', category:'商业广告', uses:1600, scenario:'珠宝、腕表、香水与高端礼赠', inputs:'产品图、材质、品牌气质、目标画幅', output:'材质锁定、布光图、镜头运动和文案落版', workflow:['锁定切面、镶嵌与品牌标识','设计可控高光和暗部层次','用缓慢微距运动建立稀缺感','控制文案数量并设计最终落版'] },
  { id:'product-three-shot-drama', name:'三镜头带货短剧', description:'把一张商品图转成约 15 秒、人物动机清晰的三分镜带货剧情。', category:'短剧漫剧', uses:2100, scenario:'商品种草、反转广告、信息流短剧', inputs:'商品图、目标人群、痛点、卖点', output:'三镜剧情、台词、商品证据镜头和 CTA', workflow:['选择一个高频真实使用痛点','用问题、尝试、结果构成三镜结构','让商品功能通过动作而非旁白证明','在结尾给出自然且明确的行动提示'] },
  { id:'premium-female-drama', name:'精品女频短剧导演', description:'按情绪价值、关系张力与付费卡点规划精品女频短剧。', category:'短剧漫剧', uses:18600, scenario:'都市情感、逆袭、甜宠与家庭关系短剧', inputs:'人物关系、核心梗、集数、单集时长', output:'人物弧光、分集梗概、场景分镜和卡点', workflow:['明确女主目标和关系权力差','为每集设置冲突升级与情绪回报','用细节动作承载人物潜台词','在信息差最大处设计结尾卡点'] },
  { id:'absurd-comedy-maker', name:'无厘头喜剧制造机', description:'将任意主题转成逻辑自洽又不断升级的荒诞喜剧短片。', category:'短剧漫剧', uses:4500, scenario:'玩梗短片、照片改编、反套路广告', inputs:'主题、角色、必须保留的梗、时长', output:'喜剧前提、升级节拍、台词和反转分镜', workflow:['建立一个角色认真相信的荒诞前提','用重复加变化连续升级后果','保持角色表演认真而非主动搞笑','用前文道具或台词完成回收反转'] },
  { id:'suspense-microdrama', name:'悬疑微短剧编排', description:'在有限时长内组织线索、误导、揭示与结尾钩子。', category:'短剧漫剧', uses:3600, scenario:'悬疑、惊悚、密室与反转微短剧', inputs:'谜面、真相、角色、集数与时长', output:'线索矩阵、分集节拍、视角策略和镜头脚本', workflow:['先写清唯一真相和角色动机','区分公平线索、误导和气氛信息','控制每集揭示量并维持因果链','在结尾用新证据改变观众判断'] },
  { id:'romance-dialogue-drama', name:'高张力情感对手戏', description:'为双人关系场景生成有潜台词、节奏和情绪转折的对手戏。', category:'短剧漫剧', uses:2800, scenario:'恋爱、婚姻、职场与家庭冲突场景', inputs:'人物关系、场景目标、秘密、时长', output:'潜台词表、台词、表演动作和机位设计', workflow:['分别写出双方表面目标与真实需求','让台词围绕回避和试探推进','以道具、停顿和视线承载潜台词','在关系权力变化处调整景别和机位'] },
  { id:'manga-panel-director', name:'漫剧分镜导演', description:'把文本剧情转换为适配竖屏阅读和动态化的漫画分镜。', category:'短剧漫剧', mediaType:'image', uses:3400, scenario:'动态漫、条漫、竖屏漫剧', inputs:'剧情文本、角色设定、画风、单集长度', output:'格子分镜、气泡文案、角色表情和动态化建议', workflow:['按信息单元切分剧情而非平均分格','锁定角色外观和标志性表情','用格子尺寸表达节奏和重要性','为景深、摇移和局部动画预留空间'] },
  { id:'concept-character-lab', name:'概念角色设计实验室', description:'从一句角色想法生成原创角色板、表情动作和展示短片。', category:'动漫游戏', mediaType:'image', uses:1300, scenario:'动画、游戏、潮玩与虚拟角色设计', inputs:'角色关键词、世界观、功能、风格边界', output:'角色简报、正侧背、表情动作、材质与展示镜头', workflow:['从职业和世界观推导功能需求','建立轮廓、比例和识别色','设计服装道具的功能性细节','输出角色板并规划十五秒展示镜头'] },
  { id:'anime-trailer-director', name:'动画番剧预告片', description:'将故事梗概压缩为角色亮相、世界观展示与高潮悬念预告。', category:'动漫游戏', uses:2500, scenario:'动画 PV、番剧先导片、IP 宣传', inputs:'故事梗概、角色、卖点、预告时长', output:'预告结构、镜头分配、字幕卡和音乐节拍', workflow:['选取最能代表作品的角色与冲突','按疑问、升级、高潮组织信息','控制剧透并保留核心悬念','让字幕卡和音乐断点共同强化记忆点'] },
  { id:'game-cg-cinematic', name:'游戏 CG 叙事片', description:'围绕游戏世界观、英雄技能和战斗目标设计电影化 CG。', category:'动漫游戏', uses:2200, scenario:'游戏宣传 CG、角色上线、赛季预告', inputs:'世界观、角色、技能、战斗目标、时长', output:'战斗逻辑、技能展示表、分镜和视效层级', workflow:['确定阵营目标与战场空间规则','让技能展示服务角色选择和剧情','用远景维持战场方位与规模','为大招设置铺垫、释放和结果反馈'] },
  { id:'virtual-idol-stage', name:'虚拟偶像舞台导演', description:'设计角色一致、舞台可执行、镜头与歌曲同步的虚拟演出。', category:'动漫游戏', uses:1400, scenario:'虚拟偶像 MV、直播舞台、角色演唱', inputs:'角色设定、歌曲、舞台主题、舞蹈强度', output:'造型锁定、舞台灯光、机位表和表演节拍', workflow:['锁定角色模型、服装和标志动作','按歌曲段落变化舞台层次和灯光','设计全身舞蹈、近景表演和观众视角','检查肢体、麦克风与舞台空间连续性'] },
  { id:'ai-model-talkshow', name:'AI 模特脱口秀', description:'自动规划模特形象、场景、段子与完整竖屏脱口秀短片。', category:'自媒体创作', uses:1700, scenario:'品牌人格、虚拟主播、热点轻评论', inputs:'话题、人设、目标受众、时长、禁区', output:'人设卡、段子结构、口播、表演和镜头脚本', workflow:['建立稳定人设、语气和观点边界','用观察、误导、包袱构成段落','为每个笑点设计停顿和表情动作','用中近景为主并插入少量反应镜头'] },
  { id:'knowledge-explainer-video', name:'知识讲解短视频', description:'把复杂知识转成钩子、类比、视觉证据和清晰结论。', category:'自媒体创作', uses:4100, scenario:'科普、职场、教育与产品原理解说', inputs:'主题、受众基础、时长、资料', output:'事实清单、口播、视觉辅助和逐镜时间轴', workflow:['先核对事实并确定一个学习目标','用反常识问题建立开场钩子','以类比、示意和例子逐层解释','用一句可复述结论和行动建议收束'] },
  { id:'cinematic-vlog-planner', name:'电影感 Vlog 规划', description:'把日常行程组织成有主题、有变化、有声音细节的电影感 Vlog。', category:'自媒体创作', uses:3700, scenario:'旅行、城市、生活方式与幕后 Vlog', inputs:'行程、地点、主题、设备、时长', output:'拍摄清单、叙事线、转场和旁白建议', workflow:['从行程中选择一个明确主题','按出发、发现、变化、回望组织素材','补足环境声、细节和人物反应镜头','设计现场可完成的匹配转场'] },
  { id:'product-unboxing-story', name:'产品开箱故事化', description:'将普通开箱变成期待、发现、验证和结论完整的内容叙事。', category:'自媒体创作', uses:2300, scenario:'数码、美妆、潮玩与家居产品开箱', inputs:'产品、受众、关注点、使用场景', output:'开箱节拍、口播、验证镜头和优缺点结论', workflow:['从受众最关心的问题建立期待','按包装、细节、上手、实测推进','用同类对比或实际任务验证体验','明确适合人群并保留真实缺点'] },
  { id:'vertical-news-recap', name:'热点资讯快剪', description:'将多条可信来源压缩为中立、紧凑、带来源标识的竖屏资讯。', category:'自媒体创作', uses:2600, scenario:'行业新闻、赛事战报、热点时间线', inputs:'来源链接、受众、时长、观点边界', output:'事实时间线、口播、来源标注和画面建议', workflow:['区分已证实事实、引用观点和未知项','按时间或因果重排信息','每个关键结论保留来源标识','用背景、影响和待观察项结束'] },
];

function buildInstructions(skill: NativeSkill): string {
  return `# ${skill.name}\n\n## 任务边界\n${skill.description}\n\n## 输入要求\n${skill.inputs}。缺少会显著改变结果的信息时，先提出不超过 3 个问题；其余内容给出明确假设。\n\n## 工作流\n${skill.workflow.map((step, index) => `${index + 1}. ${step}。`).join('\n')}\n5. 在输出前检查人物、产品、场景、光线、轴线、时长和画幅的连续性。\n\n## 输出规范\n${skill.output}。默认以结构化创作方案输出，镜头必须包含时长、景别、画面动作、镜头运动、声音和生成提示；不得声称未实际生成的素材已经完成。`;
}

export const NATIVE_SKILL_CATALOG: SkillDetail[] = native.map((skill, index) => ({
  id: skill.id,
  name: skill.name,
  description: skill.description,
  version: '1.0.0',
  category: skill.category,
  author: '小QTV 创作实验室',
  mediaType: skill.mediaType ?? 'video',
  installed: true,
  favorite: false,
  featured: index < 20,
  uses: skill.uses,
  coverUrl: `/skills/native/${skill.id}.svg`,
  source: { kind: 'catalog', repository: `https://xiaoqtv.local/skills/${skill.id}` },
  updatedAt,
  instructions: buildInstructions(skill),
  usageScenario: skill.scenario,
  inputs: skill.inputs,
  output: skill.output,
  files: ['SKILL.md'],
  hasScripts: false,
}));
