import { useEffect, useMemo, useRef, useState } from 'react';
import { CoverThumb } from '../workbench/CoverThumb';
import { VelornProductionWorkbench } from './VelornProductionWorkbench';
import '../../marketing.css';
import './create.css';

type AssetKey = 'song' | 'lyrics' | 'portrait' | 'reference' | 'voice';
type AssetState = {
  song: File | null;
  lyrics: File | null;
  portrait: File[];
  reference: File | null;
  voice: File | null;
};
type DemoJob = {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  stage?: string;
  progress: number;
  result_url?: string;
  duration?: number;
  file_size?: number;
  error?: string;
  client_request_id?: string;
  submission_state?: 'not_started' | 'preparing' | 'submitting' | 'submitted' | 'rejected' | 'unknown' | 'completed';
};
type AgentShot = {
  id: string;
  time: string;
  title: string;
  lyrics_window?: string;
  lyrics_sync?: {
    start: string;
    end: string;
    text: string;
    section: string;
    cut_on: string;
  };
  director_method?: {
    composition: string;
    camera: string;
    lighting_color: string;
    blocking: string;
    rhythm: string;
  };
  corpus_refs?: string[];
  reference_match?: {
    source_time: string;
    visual_blueprint: string;
    subject_layout: string;
    action_timing: string;
    camera_motion: string;
    transition: string;
  };
  prompt: string;
  negative_prompt?: string;
};
type AgentAnalysis = {
  project_summary: string;
  creative_brief: string;
  analysis_cards: Array<{ title: string; value: string; copy: string }>;
  timeline: Array<{ time: string; label: string }>;
  material_observations: string[];
  material_manifest?: {
    song: boolean;
    lyrics: boolean;
    portrait_count: number;
    reference_video: boolean;
    reference_audio: boolean;
  };
  director_application: string;
  reference_breakdown?: {
    summary: string;
    shot_scale_pattern: string;
    composition: string;
    lighting_color: string;
    blocking_performance: string;
    editing_rhythm: string;
    reference_shots: Array<{
      source_time: string;
      visual_blueprint: string;
      subject_layout: string;
      action_timing: string;
      shot_size_camera: string;
      lighting_color: string;
      transition: string;
      target_mapping: string;
    }>;
    rhetorical_enhancement: string[];
  };
  corpus_retrieval?: {
    version: string;
    director: string;
    coverage: string[];
    items: Array<{ id: string; category: string; title: string; text: string; score: number }>;
    stats: { director_entries: number; general_entries: number; returned: number };
  };
  shots: AgentShot[];
  provider: string;
  model: string;
  usage?: { total_tokens?: number };
};
type ProjectRecord = {
  id: string;
  name: string;
  ratio: string;
  model: ModelName;
  resolution: string;
  director: string;
  requirements: string;
  status: string;
  progress: number;
  shots: number;
  assets: number;
  active_step?: number;
  agent_analysis?: AgentAnalysis | null;
  job_id?: string;
  result_url?: string;
  created_at: number;
  updated_at: number;
};

function generationApiModel(model: ModelName, resolution: string) {
  if (model === 'Seedance 2.5 · 海外版') return `sd2.5海外版-${resolution}`;
  if (model === 'Seedance 2.0 · 海外版') return `sd2.0海外版-${resolution}`;
  return resolution === '2k' ? 'minimax-h3-2k' : 'minimax-h3-768p';
}

function agentDisplayText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(agentDisplayText).filter(Boolean).join('；');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.observation) {
      const prefix = agentDisplayText(record.type || record.file);
      const observation = agentDisplayText(record.observation);
      return prefix ? `${prefix}：${observation}` : observation;
    }
    const labels: Record<string, string> = { composition: '构图', camera: '摄影', lighting_color: '光色', blocking: '调度', rhythm: '节奏', avoid: '避免' };
    return Object.entries(record).map(([key, item]) => {
      const text = agentDisplayText(item);
      return text ? `${labels[key] || key}：${text}` : '';
    }).filter(Boolean).join('；');
  }
  return String(value);
}

function normalizeAgentPayload(payload: AgentAnalysis): AgentAnalysis {
  return {
    ...payload,
    project_summary: agentDisplayText(payload.project_summary),
    creative_brief: agentDisplayText(payload.creative_brief),
    director_application: agentDisplayText(payload.director_application),
    material_observations: Array.isArray(payload.material_observations)
      ? payload.material_observations.map(agentDisplayText).filter(Boolean)
      : [],
    analysis_cards: Array.isArray(payload.analysis_cards) ? payload.analysis_cards.map(card => ({
      title: agentDisplayText(card?.title),
      value: agentDisplayText(card?.value),
      copy: agentDisplayText(card?.copy),
    })) : [],
    timeline: Array.isArray(payload.timeline) ? payload.timeline.map(item => ({
      time: agentDisplayText(item?.time),
      label: agentDisplayText(item?.label),
    })) : [],
    shots: Array.isArray(payload.shots) ? payload.shots.map(shot => ({
      ...shot,
      id: agentDisplayText(shot?.id),
      time: agentDisplayText(shot?.time),
      title: agentDisplayText(shot?.title),
      lyrics_window: agentDisplayText(shot?.lyrics_window),
      prompt: agentDisplayText(shot?.prompt),
      negative_prompt: agentDisplayText(shot?.negative_prompt),
      corpus_refs: Array.isArray(shot?.corpus_refs) ? shot.corpus_refs.map(agentDisplayText) : [],
    })) : [],
  };
}

const assetConfig: Array<{ key: AssetKey; title: string; copy: string; accept: string; required: boolean; tag: string }> = [
  { key: 'song', title: '原始音频', copy: '可选；上传后作为整支 MV 的时间基准', accept: 'audio/*', required: false, tag: 'MP3 · WAV · FLAC' },
  { key: 'lyrics', title: '歌词文件', copy: '可选；上传后用于逐句对齐、口型与切点', accept: '.txt,.lrc,text/plain', required: false, tag: 'TXT · LRC' },
  { key: 'portrait', title: '人物参考图', copy: '可选；支持多张，用于补充正脸、侧脸、全身和服装', accept: 'image/*', required: false, tag: '最多 8 张' },
  { key: 'reference', title: '对标视频', copy: '可选；作为具体画面、动作、运镜和切镜的复刻骨架', accept: 'video/*,.mp4,.mov,.webm,.mkv', required: false, tag: 'MP4 · MOV · WEBM' },
  { key: 'voice', title: '参考音频', copy: '可选；任意 FFmpeg 可读音频都会自动标准化为 WAV', accept: 'audio/*', required: false, tag: '自动转 WAV' },
];

const stepCopy = [
  ['01', '项目与物料', '提交需求、歌曲、歌词、参考图与可选参考片'],
  ['02', 'Agent 分析与生成确认', '检查逐镜全能提示词，并确认生成模型与输出规格'],
  ['03', '成片合成与交付', '生成成片、在线播放审片，并保留下载'],
];

const agentAnalysisStages = [
  ['读取项目上下文', '汇总制作需求、输出规格和导演选择'],
  ['分析歌曲与歌词', '识别段落、情绪曲线、歌词时间窗和剪辑点'],
  ['理解参考物料', '提取人物特征、场景信息与参考片镜头语言'],
  ['应用导演方法', '将导演的构图、光线、调度和节奏写入方案'],
  ['生成分镜提示词', '输出逐镜画面、运镜、镜头衔接与负面约束'],
] as const;

const directors = [
  ['张艺谋', '色彩秩序 · 仪式感 · 东方构图'],
  ['贾樟柯', '社会现场 · 固定观察 · 时代肌理'],
  ['毕赣', '梦境长镜头 · 时间折叠 · 潮湿空间'],
  ['娄烨', '手持贴近 · 都市欲望 · 混合光源'],
  ['王家卫', '情绪光影 · 碎片叙事 · 慢快门'],
  ['侯孝贤', '长时观察 · 多层空间 · 日常余韵'],
  ['杨德昌', '城市建筑 · 关系距离 · 冷静构图'],
  ['岩井俊二', '季节柔光 · 青春记忆 · 轻盈留白'],
  ['黑泽明', '天气压力 · 深度调度 · 动作轴线'],
  ['小津安二郎', '低机位 · 家庭空间 · 静态余白'],
  ['是枝裕和', '生活流 · 自然表演 · 温柔凝视'],
  ['奉俊昊', '空间调度 · 类型反转 · 群像节奏'],
  ['朴赞郁', '精确构图 · 雕塑光线 · 物件叙事'],
  ['安德烈·塔可夫斯基', '元素空间 · 精神凝视 · 缓慢沉浸'],
  ['大卫·芬奇', '低照度 · 程序秩序 · 精确信息层级'],
  ['丹尼斯·维伦纽瓦', '宏大尺度 · 克制运镜 · 氛围压迫'],
];

const modelProfiles = {
  'Seedance 2.5 · 海外版': {
    provider: 'ModelsNexus · Seedance Overseas',
    apiModel: 'sd2.5海外版-{resolution}',
    resolutions: [
      ['480p', '480p · 官方固定模型 · 5–30 秒'],
      ['720p', '720p · 官方固定模型 · 5–30 秒'],
    ],
  },
  'Seedance 2.0 · 海外版': {
    provider: 'ModelsNexus · Seedance Overseas',
    apiModel: 'sd2.0海外版-{resolution}',
    resolutions: [
      ['480p', '480p · 官方固定模型 · 5–15 秒'],
      ['720p', '720p · 官方固定模型 · 5–15 秒'],
    ],
  },
  'MiniMax H3': {
    provider: 'ModelsNexus · MiniMax H3',
    apiModel: 'minimax-h3-{resolution}',
    resolutions: [
      ['768p', '768p · minimax-h3-768p · 4–15 秒'],
      ['2k', '2K · minimax-h3-2k · 4–15 秒'],
    ],
  },
} as const;

type ModelName = keyof typeof modelProfiles;

function prettySize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function updatedLabel(timestamp: number) {
  const seconds = Math.max(0, Math.round(Date.now() / 1000) - timestamp);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function createClientRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `yingliu-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function CreateFlowDemo() {
  const submissionLockRef = useRef(false);
  const submissionRequestIdRef = useRef<string | null>(null);
  // 公网首页先展示真实项目库；只有新建或打开项目后才进入制作工作流。
  const [pageView, setPageView] = useState<'projects' | 'workflow'>('projects');
  const [projectSearch, setProjectSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState<'all' | 'active' | 'done'>('all');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectSync, setProjectSync] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading');
  const [activeStep, setActiveStep] = useState(0);
  const [projectName, setProjectName] = useState('雨夜来信');
  const [requirements, setRequirements] = useState('对标视频作为具体画面骨架，尽量保持布局、动作、景别、运镜和切镜节奏；用我的人物与项目内容替换，再通过导演库和电影语料完成电影感修辞。');
  const [ratio, setRatio] = useState('16:9');
  const [model, setModel] = useState<ModelName>('Seedance 2.5 · 海外版');
  const [resolution, setResolution] = useState('720p');
  const [director, setDirector] = useState('王家卫');
  const [assets, setAssets] = useState<AssetState>({ song: null, lyrics: null, portrait: [], reference: null, voice: null });
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [runStage, setRunStage] = useState('等待提交生成任务');
  const [job, setJob] = useState<DemoJob | null>(null);
  const [notice, setNotice] = useState('');
  const [agentAnalyzing, setAgentAnalyzing] = useState(false);
  const [agentAnalysisComplete, setAgentAnalysisComplete] = useState(false);
  const [agentAnalysis, setAgentAnalysis] = useState<AgentAnalysis | null>(null);
  const [agentAnalysisError, setAgentAnalysisError] = useState('');

  const assetReady = (key: AssetKey) => key === 'portrait' ? assets.portrait.length > 0 : Boolean(assets[key]);

  const requiredReady = useMemo(
    () => assetConfig.filter(item => item.required).every(item => item.key === 'portrait' ? assets.portrait.length > 0 : Boolean(assets[item.key])),
    [assets],
  );
  const referenceIsVideo = Boolean(assets.reference);

  const visibleProjects = useMemo(() => {
    const keyword = projectSearch.trim().toLocaleLowerCase('zh-CN');
    return projects.filter(project => {
      const matchesSearch = !keyword || `${project.name} ${project.director} ${project.status}`.toLocaleLowerCase('zh-CN').includes(keyword);
      const matchesStatus = projectFilter === 'all' || (projectFilter === 'done' ? project.progress === 100 : project.progress < 100);
      return matchesSearch && matchesStatus;
    });
  }, [projectFilter, projectSearch, projects]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch('/yingliu-demo-api/projects', { cache: 'no-store' });
        const payload = await response.json() as { projects?: ProjectRecord[]; error?: string };
        if (!response.ok) throw new Error(payload.error || '项目库读取失败');
        if (!cancelled) {
          setProjects(Array.isArray(payload.projects) ? payload.projects : []);
          setProjectSync('saved');
        }
      } catch {
        if (!cancelled) setProjectSync('error');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    setProjectSync('saving');
    const timer = window.setTimeout(async () => {
      const assetCount = Number(Boolean(assets.song)) + Number(Boolean(assets.lyrics)) + assets.portrait.length + Number(Boolean(assets.reference)) + Number(Boolean(assets.voice));
      const status = job?.status === 'completed' ? '已完成' : job ? '正在生成' : agentAnalysisComplete ? '分镜提示词已生成' : '草稿';
      const progress = job?.status === 'completed' ? 100 : job ? Math.max(70, runProgress) : agentAnalysisComplete ? 66 : Math.max(8, activeStep * 30);
      try {
        const response = await fetch(`/yingliu-demo-api/projects/${activeProjectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: projectName || '未命名 MV', ratio, model, resolution, director, requirements,
            status, progress, shots: agentAnalysis?.shots?.length || 0, assets: assetCount,
            active_step: activeStep, agent_analysis: agentAnalysis, job_id: job?.id, result_url: job?.result_url,
          }),
        });
        const saved = await response.json() as ProjectRecord & { error?: string };
        if (!response.ok) throw new Error(saved.error || '项目保存失败');
        setProjects(current => [saved, ...current.filter(item => item.id !== saved.id)]);
        setProjectSync('saved');
      } catch {
        setProjectSync('error');
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [activeProjectId, activeStep, agentAnalysis, agentAnalysisComplete, assets, director, job?.id, job?.result_url, job?.status, model, projectName, ratio, requirements, resolution, runProgress, running]);

  useEffect(() => {
    if (!job || job.status === 'completed' || job.status === 'failed') return;
    const poll = async () => {
      try {
        const response = await fetch(`/yingliu-demo-api/jobs/${job.id}`, { cache: 'no-store' });
        const payload = await response.json() as DemoJob & { error?: string };
        if (!response.ok) throw new Error(payload.error || '任务状态读取失败');
        setJob(payload);
        if (payload.client_request_id) submissionRequestIdRef.current ||= payload.client_request_id;
        setRunStage(payload.stage || '服务端正在生成视频');
        setRunProgress(current => Math.max(current, Math.min(100, 10 + Math.round((payload.progress || 0) * 0.9))));
        if (payload.status === 'completed') {
          submissionRequestIdRef.current = null;
          setRunning(false);
          setRunProgress(100);
          setRunStage('成片已就绪');
          setNotice('真实 MP4 已生成，可以直接播放或下载。服务器将在 24 小时后自动清理任务素材。');
        }
        if (payload.status === 'failed') {
          // 4xx 明确拒绝才允许创建新请求；5xx/网络错误可能已经在上游创建任务，必须保留幂等键。
          if (payload.submission_state === 'rejected') submissionRequestIdRef.current = null;
          setRunning(false);
          setRunStage('生成失败');
          setNotice(payload.submission_state === 'unknown'
            ? `${payload.error || '上游创建结果未知'}；系统已锁定本次请求，禁止重复提交，请凭请求 ID 交由 ModelsNexus 查询。`
            : payload.error || '生成失败，请检查参数或更换素材后重试。');
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '暂时无法读取生成进度');
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

  const selectFile = (key: Exclude<AssetKey, 'portrait'>, file: File | undefined) => {
    if (!file) return;
    setAssets(current => ({ ...current, [key]: file }));
    setAgentAnalysis(null);
    setAgentAnalysisComplete(false);
    setAgentAnalysisError('');
    setNotice('');
  };

  const selectPortraits = (files: FileList | null) => {
    const selectedFiles = files ? Array.from(files) : [];
    if (!selectedFiles.length) return;
    setAssets(current => {
      const merged = [...current.portrait, ...selectedFiles].filter((file, index, all) => all.findIndex(candidate => candidate.name === file.name && candidate.size === file.size) === index).slice(0, 8);
      return { ...current, portrait: merged };
    });
    setAgentAnalysis(null);
    setAgentAnalysisComplete(false);
    setAgentAnalysisError('');
    setNotice(selectedFiles.length > 8 ? '人物参考图最多保留 8 张，已自动截取前 8 张。' : '人物参考图已加入项目，全部图片将同级参与 Agent 分析。');
  };

  const portraitPreviews = useMemo(() => assets.portrait.map((file, index) => ({ file, index, url: URL.createObjectURL(file) })), [assets.portrait]);

  useEffect(() => () => {
    portraitPreviews.forEach(preview => URL.revokeObjectURL(preview.url));
  }, [portraitPreviews]);

  const removePortrait = (index: number) => {
    setAssets(current => ({ ...current, portrait: current.portrait.filter((_, itemIndex) => itemIndex !== index) }));
    setAgentAnalysis(null);
    setAgentAnalysisComplete(false);
    setNotice('已删除该人物参考图，其余参考图保持同级。');
  };

  const changeModel = (nextModel: ModelName) => {
    setModel(nextModel);
    const allowed = modelProfiles[nextModel].resolutions.map(([value]) => value as string);
    if (!allowed.includes(resolution)) setResolution(allowed[0]);
  };

  const changeDirector = (nextDirector: string) => {
    setDirector(nextDirector);
    if (agentAnalysis || agentAnalysisComplete) {
      setAgentAnalysis(null);
      setAgentAnalysisComplete(false);
      setAgentAnalysisError('');
      setActiveStep(0);
      setNotice('导演方法已更换。旧分镜已失效，请重新提交素材分析。');
    }
  };

  const loadProject = (project: ProjectRecord) => {
    setActiveProjectId(project.id);
    setProjectName(project.name);
    setRatio(project.ratio);
    const nextModel = project.model as ModelName;
    setModel(nextModel);
    const allowedResolutions = modelProfiles[nextModel].resolutions.map(([value]) => value as string);
    setResolution(allowedResolutions.includes(project.resolution) ? project.resolution : allowedResolutions[0]);
    setDirector(project.director);
    setRequirements(project.requirements);
    setActiveStep(project.active_step ?? 0);
    setAgentAnalysis(project.agent_analysis ?? null);
    setAgentAnalysisComplete(Boolean(project.agent_analysis));
    setAgentAnalysisError('');
    setAgentAnalyzing(false);
    setAssets({ song: null, lyrics: null, portrait: [], reference: null, voice: null });
    setJob(project.job_id
      ? { id: project.job_id, status: project.result_url ? 'completed' : 'queued', progress: project.result_url ? 100 : Math.max(5, project.progress || 5), result_url: project.result_url }
      : null);
    setPageView('workflow');
    setNotice(`已从服务器打开项目「${project.name}」。项目配置与 Agent 分镜已恢复。`);
  };

  const createProject = async () => {
    const draft = {
      name: '未命名 MV', ratio: '16:9', model: 'Seedance 2.5 · 海外版' as ModelName,
      resolution: '720p', director: '王家卫', requirements: '描述你想要的故事、画面风格、人物表演与镜头节奏。',
      status: '草稿', progress: 8, shots: 0, assets: 0, active_step: 0,
    };
    setProjectSync('saving');
    try {
      const response = await fetch('/yingliu-demo-api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      });
      const project = await response.json() as ProjectRecord & { error?: string };
      if (!response.ok) throw new Error(project.error || '新建项目失败');
      setProjects(current => [project, ...current.filter(item => item.id !== project.id)]);
      setActiveProjectId(project.id);
      setProjectSync('saved');
    } catch (error) {
      setProjectSync('error');
      setNotice(error instanceof Error ? error.message : '新建项目失败');
      return;
    }
    setProjectName(draft.name);
    setRatio('16:9');
    setModel('Seedance 2.5 · 海外版');
    setResolution('720p');
    setDirector('王家卫');
    setRequirements(draft.requirements);
    setAssets({ song: null, lyrics: null, portrait: [], reference: null, voice: null });
    setJob(null);
    setRunProgress(0);
    setUploadProgress(0);
    setRunStage('等待提交生成任务');
    setAgentAnalyzing(false);
    setAgentAnalysisComplete(false);
    setAgentAnalysis(null);
    setAgentAnalysisError('');
    setActiveStep(0);
    setPageView('workflow');
    setNotice('新项目已写入服务器。后续修改会自动同步保存。');
  };

  const deleteProject = async (project: ProjectRecord) => {
    if (!window.confirm(`确认删除项目「${project.name}」？该项目记录将从服务器移除。`)) return;
    try {
      const response = await fetch(`/yingliu-demo-api/projects/${project.id}`, { method: 'DELETE' });
      const payload = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !payload.deleted) throw new Error(payload.error || '删除项目失败');
      setProjects(current => current.filter(item => item.id !== project.id));
      if (activeProjectId === project.id) setActiveProjectId(null);
      setNotice(`项目「${project.name}」已从服务器删除。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除项目失败');
    }
  };

  const runAgentAnalysis = async () => {
    setActiveStep(1);
    setAgentAnalyzing(true);
    setAgentAnalysisComplete(false);
    setAgentAnalysis(null);
    setAgentAnalysisError('');
    setNotice('正在提交项目需求和已选择物料，DeepSeek Agent 将只分析本次真实提供的内容。');
    const body = new FormData();
    body.append('title', projectName || '未命名 MV');
    body.append('requirements', requirements);
    body.append('ratio', ratio);
    body.append('model', generationApiModel(model, resolution));
    body.append('resolution', resolution);
    body.append('director', director);
    if (assets.song) body.append('song', assets.song);
    if (assets.lyrics) body.append('lyrics', assets.lyrics);
    if (assets.portrait[0]) body.append('portrait', assets.portrait[0]);
    assets.portrait.slice(1, 8).forEach((file, index) => body.append(`portrait_${index + 2}`, file));
    if (assets.reference) body.append('reference', assets.reference);
    if (assets.voice) body.append('voice', assets.voice);
    try {
      const response = await fetch('/yingliu-demo-api/analyze', { method: 'POST', body });
      const payload = await response.json() as AgentAnalysis & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Agent 分析失败');
      if (!Array.isArray(payload.analysis_cards) || !Array.isArray(payload.shots) || payload.shots.length === 0) {
        throw new Error('Agent 返回的分镜结构不完整，请重试');
      }
      const normalizedPayload = normalizeAgentPayload(payload);
      if (activeProjectId) {
        setProjectSync('saving');
        try {
          const assetCount = Number(Boolean(assets.song)) + Number(Boolean(assets.lyrics)) + assets.portrait.length + Number(Boolean(assets.reference)) + Number(Boolean(assets.voice));
          const saveResponse = await fetch(`/yingliu-demo-api/projects/${activeProjectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: projectName || '未命名 MV', ratio, model, resolution, director, requirements,
              status: '分镜提示词已生成', progress: 66, shots: normalizedPayload.shots.length,
              assets: assetCount, active_step: 1, agent_analysis: normalizedPayload,
            }),
          });
          const saved = await saveResponse.json() as ProjectRecord & { error?: string };
          if (!saveResponse.ok) throw new Error(saved.error || '分析结果保存失败');
          setProjects(current => [saved, ...current.filter(item => item.id !== saved.id)]);
          setProjectSync('saved');
        } catch {
          setProjectSync('error');
        }
      }
      setAgentAnalysis(normalizedPayload);
      setAgentAnalysisComplete(true);
      setNotice(`DeepSeek Agent 真实分析完成，已生成 ${normalizedPayload.shots.length} 份分镜全能提示词。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent 分析失败';
      setAgentAnalysisError(message);
      setNotice(message);
    } finally {
      setAgentAnalyzing(false);
    }
  };

  const nextStep = async () => {
    if (activeStep === 0) {
      await runAgentAnalysis();
      return;
    }
    if (activeStep === 1 && !agentAnalysisComplete) return;
    if (activeStep === 1 && !agentAnalysis?.corpus_retrieval?.items?.length) {
      setNotice('当前是语料检索上线前生成的旧分镜，请返回第一步重新执行 Agent 分析。');
      return;
    }
    if (activeStep === 1 && referenceIsVideo && !analysisHasReferenceVideo) {
      setNotice('当前分镜没有逐段复刻对标视频的画面骨架，请返回第一步重新执行 Agent 分析。');
      return;
    }
    setNotice('');
    setActiveStep(step => Math.min(stepCopy.length - 1, step + 1));
  };

  const startDemoRun = async () => {
    if (submissionLockRef.current) return;
    if (!agentAnalysisComplete || !agentAnalysis) {
      setActiveStep(1);
      setNotice('请先让 Agent 根据当前需求和已上传物料生成分镜方案。');
      return;
    }
    submissionLockRef.current = true;
    setRunProgress(1);
    setUploadProgress(0);
    setRunStage('准备上传项目素材');
    setRunning(true);
    setJob(null);
    setNotice('正在上传素材并创建真实生成任务，请勿关闭页面。');
    try {
      const body = new FormData();
      body.append('title', projectName || '未命名 MV');
      body.append('requirements', requirements);
      body.append('ratio', ratio);
      body.append('model', generationApiModel(model, resolution));
      body.append('resolution', resolution);
      body.append('director', director);
      if (assets.song) body.append('song', assets.song);
      if (assets.lyrics) body.append('lyrics', assets.lyrics);
      if (assets.portrait[0]) body.append('portrait', assets.portrait[0]);
      assets.portrait.slice(1, 8).forEach((file, index) => body.append(`portrait_${index + 2}`, file));
      if (assets.reference) body.append('reference', assets.reference);
      if (assets.voice) body.append('voice', assets.voice);
      if (agentAnalysis) body.append('generation_plan', JSON.stringify(agentAnalysis));
      submissionRequestIdRef.current ||= createClientRequestId();
      body.append('client_request_id', submissionRequestIdRef.current);
      const payload = await new Promise<DemoJob & { error?: string }>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', '/yingliu-demo-api/jobs');
        request.timeout = 10 * 60 * 1000;
        request.upload.onprogress = event => {
          if (!event.lengthComputable) return;
          const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
          setUploadProgress(percent);
          setRunProgress(Math.max(1, Math.round(percent * 0.1)));
          setRunStage(`正在上传项目素材 · ${percent}%`);
        };
        request.upload.onload = () => {
          setUploadProgress(100);
          setRunProgress(10);
          setRunStage('素材上传完成，正在创建生成任务');
        };
        request.onerror = () => reject(new Error('素材上传失败，请检查网络后重试'));
        request.onabort = () => reject(new Error('素材上传已取消'));
        request.ontimeout = () => reject(new Error('素材上传超时，请检查网络后重试'));
        request.onload = () => {
          try {
            const responsePayload = JSON.parse(request.responseText || '{}') as DemoJob & { error?: string };
            if (request.status < 200 || request.status >= 300) throw new Error(responsePayload.error || '创建生成任务失败');
            resolve(responsePayload);
          } catch (error) {
            reject(error instanceof Error ? error : new Error('创建生成任务失败'));
          }
        };
        request.send(body);
      });
      setJob(payload);
      setRunProgress(Math.max(10, 10 + Math.round((payload.progress || 0) * 0.9)));
      setRunStage('任务已进入服务端生成队列');
      setNotice('任务已进入服务器生成队列，页面会自动更新进度。');
    } catch (error) {
      setRunning(false);
      setRunStage('生成任务创建失败');
      setNotice(error instanceof Error ? error.message : '创建生成任务失败');
    } finally {
      submissionLockRef.current = false;
    }
  };

  const durationLabel = job?.duration ? `${Math.floor(job.duration / 60).toString().padStart(2, '0')}:${Math.floor(job.duration % 60).toString().padStart(2, '0')}` : '待生成';
  const displayedShots: AgentShot[] = Array.isArray(agentAnalysis?.shots) ? agentAnalysis.shots : [];
  const displayedCards = Array.isArray(agentAnalysis?.analysis_cards) ? agentAnalysis.analysis_cards : [];
  const corpusItems = Array.isArray(agentAnalysis?.corpus_retrieval?.items) ? agentAnalysis.corpus_retrieval.items : [];
  const timelineItems = Array.isArray(agentAnalysis?.timeline) ? agentAnalysis.timeline : [];
  const referenceShots = Array.isArray(agentAnalysis?.reference_breakdown?.reference_shots) ? agentAnalysis.reference_breakdown.reference_shots : [];
  const rhetoricalEnhancements = Array.isArray(agentAnalysis?.reference_breakdown?.rhetorical_enhancement)
    ? agentAnalysis.reference_breakdown.rhetorical_enhancement
    : agentAnalysis?.reference_breakdown?.rhetorical_enhancement
      ? [String(agentAnalysis.reference_breakdown.rhetorical_enhancement)]
      : [];
  const corpusById = useMemo(() => new Map(corpusItems.map(item => [item.id, item])), [corpusItems]);
  const corpusReady = corpusItems.length > 0;
  const analysisHasReferenceVideo = Boolean(agentAnalysis?.material_manifest?.reference_video || referenceShots.length);
  const referenceBlueprintReady = !referenceIsVideo || analysisHasReferenceVideo;

  if (pageView === 'projects') {
    return (
      <div className="create-page yingliu-demo mv-workspace-page">
        <aside className="mv-workspace-rail">
          <button className="mv-workspace-brand" type="button"><span>映</span><b>映流 MV</b></button>
          <button className="mv-new-project" type="button" onClick={createProject}><span>＋</span>新建项目</button>
          <nav aria-label="工作台导航">
            <p>工作区</p>
            <button className="is-active" type="button"><span>▱</span>项目</button>
            <button type="button"><span>◫</span>素材</button>
            <button type="button"><span>✦</span>ZY 导演库 <em>16</em></button>
            <p>创作工具</p>
            <button type="button"><span>◐</span>图像生成</button>
            <button type="button"><span>▶</span>视频生成</button>
            <button type="button"><span>♫</span>音色与音乐</button>
          </nav>
          <div className="mv-workspace-rail-foot"><span>{projectSync === 'saving' ? '正在同步' : projectSync === 'error' ? '同步失败' : '服务器已同步'}</span><small>项目数据保存在服务器 · 不会自动调用模型</small></div>
        </aside>

        <main className="mv-workspace-main">
          <header className="mv-workspace-topbar"><div><p className="overline">YINGLIU WORKSPACE</p><h1>我的项目</h1></div><span className="mv-workspace-account">演示工作区</span></header>
          <section className="mv-workspace-hero">
            <div><span>✦</span><p className="overline">AI CREATIVE AGENT</p><h2>从一个项目开始，完成整支 MV。</h2><p>项目配置、导演方法、Agent 分镜与成片进度会实时保存到服务器。选择已有项目继续，或创建一个新项目。</p></div>
            <button type="button" onClick={createProject}>创建新项目 <span>→</span></button>
          </section>

          <section className="mv-projects-section" aria-labelledby="projects-title">
            <div className="mv-projects-head"><div><p className="overline">PROJECTS</p><h2 id="projects-title">创作项目</h2></div><div className="mv-project-count"><b>{projects.length}</b><span>个服务器项目</span></div></div>
            <div className="mv-project-toolbar">
              <div className="mv-project-filters" role="group" aria-label="项目状态">
                {([['all', '全部'], ['active', '进行中'], ['done', '已完成']] as const).map(([value, label]) => <button className={projectFilter === value ? 'is-active' : ''} type="button" key={value} onClick={() => setProjectFilter(value)}>{label}</button>)}
              </div>
              <label className="mv-project-search"><span>⌕</span><input type="search" value={projectSearch} onChange={event => setProjectSearch(event.target.value)} placeholder="搜索项目或导演…" /></label>
            </div>
            <div className="mv-project-grid">
              <button className="mv-create-project-card" type="button" onClick={createProject}><span>＋</span><b>新建项目</b><small>上传歌曲、歌词和人物素材</small></button>
              {visibleProjects.map((project, index) => (
                <article className="mv-project-card" key={project.id}>
                  <button className={`mv-project-cover mv-cover-tone-${index + 1}`} type="button" onClick={() => loadProject(project)} aria-label={`打开项目 ${project.name}`}>
                    <CoverThumb seed={project.id} shots={project.shots} progress={project.progress} tone={index} />
                    <span className="mv-project-cover-veil" />
                    <span className="mv-project-state">{project.status}</span>
                    <span className="mv-project-ratio">{project.ratio}</span>
                    <strong>{project.name}</strong>
                  </button>
                  <div className="mv-project-card-body">
                    <div className="mv-project-card-title"><div><h3>{project.name}</h3><p>{project.director}导演方法 · {project.model}</p></div><span>{project.progress}%</span></div>
                    <div className="mv-project-progress"><i style={{ width: `${project.progress}%` }} /></div>
                    <div className="mv-project-meta"><span>{project.shots} 个镜头</span><span>{project.assets} 个素材</span><span>更新于 {updatedLabel(project.updated_at)}</span></div>
                    <div className="mv-project-card-actions">
                      <button className="mv-project-open" type="button" onClick={() => loadProject(project)}>打开项目 →</button>
                      <button className="mv-project-delete" type="button" onClick={() => void deleteProject(project)}>删除</button>
                    </div>
                  </div>
                </article>
              ))}
              {visibleProjects.length === 0 && <div className="mv-project-empty">没有匹配的项目，请更换搜索词或状态筛选。</div>}
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="create-page yingliu-demo mv-ported-page">
      <VelornProductionWorkbench
        activeStep={activeStep}
        agentBusy={agentAnalyzing}
        assets={assetConfig.map(item => ({ name: item.key === 'portrait' && assets.portrait.length ? `${item.title} · ${assets.portrait.length} 张` : item.title, ready: assetReady(item.key), optional: !item.required }))}
        corpusCount={corpusItems.length}
        corpusReady={corpusReady}
        referenceBlueprintReady={referenceBlueprintReady}
        director={director}
        directors={directors}
        model={model}
        resolution={resolution}
        onBack={() => setPageView('projects')}
        onDirectorChange={changeDirector}
        onStepChange={setActiveStep}
        projectName={projectName}
        ratio={ratio}
        requirements={requirements}
        shots={displayedShots.map(shot => [shot.id, shot.time, shot.title, shot.prompt])}
        steps={stepCopy}
      >
          <div className="mv-studio-stage-head">
            <div><p className="overline">STAGE {stepCopy[activeStep][0]} · MV PRODUCTION</p><h1>{stepCopy[activeStep][1]}</h1><p>{stepCopy[activeStep][2]}</p></div>
            <div className="mv-studio-stage-progress"><span>{activeStep + 1} / {stepCopy.length}</span><i><b style={{ width: `${((activeStep + 1) / stepCopy.length) * 100}%` }} /></i></div>
          </div>

        {activeStep === 0 && (
          <>
          <div className="mv-upload-layout">
            <section className="create-panel mv-project-panel">
              <div className="mv-section-heading"><p className="overline">PROJECT INPUT</p><h2>创建你的 MV 项目</h2><p>带 * 的素材为演示流程必填项。</p></div>
              <div className="mv-field-grid">
                <label className="create-field"><span>项目名称</span><input value={projectName} onChange={event => setProjectName(event.target.value)} /></label>
                <label className="create-field"><span>画幅</span><select value={ratio} onChange={event => setRatio(event.target.value)}><option>16:9</option><option>9:16</option><option>1:1</option></select></label>
                <label className="create-field"><span>生成模型</span><select value={model} onChange={event => changeModel(event.target.value as ModelName)}><optgroup label="ModelsNexus · Seedance 海外版"><option value="Seedance 2.5 · 海外版">Seedance 2.5 · 海外版</option><option value="Seedance 2.0 · 海外版">Seedance 2.0 · 海外版</option></optgroup><optgroup label="ModelsNexus · MiniMax"><option value="MiniMax H3">MiniMax H3 · 768p/2K</option></optgroup></select><small>{modelProfiles[model].provider} · API model: {generationApiModel(model, resolution)}</small></label>
                <label className="create-field"><span>输出清晰度</span><select value={resolution} onChange={event => setResolution(event.target.value)}>{modelProfiles[model].resolutions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>API resolution: {resolution}</small></label>
                <label className="create-field"><span>导演方法</span><select value={director} onChange={event => changeDirector(event.target.value)}>{directors.map(([name]) => <option key={name}>{name}</option>)}</select><small>选择后，Agent 会读取对应的结构化导演方法库</small></label>
              </div>
              <section className="mv-director-quick">
                <div><p className="overline">ZY DIRECTOR LIBRARY · 16</p><h3>选择导演方法</h3><span>当前：{director}</span></div>
                <div className="mv-director-quick-grid">
                  {directors.map(([name]) => <button className={director === name ? 'is-selected' : ''} type="button" key={name} onClick={() => changeDirector(name)}>{name}</button>)}
                </div>
              </section>
              <label className="create-field"><span>制作需求</span><textarea value={requirements} onChange={event => setRequirements(event.target.value)} rows={4} /></label>
              <div className="mv-upload-grid">
                {assetConfig.map(item => {
                  const isPortrait = item.key === 'portrait';
                  const file = isPortrait ? null : assets[item.key] as File | null;
                  const ready = assetReady(item.key);
                  const portraitSize = assets.portrait.reduce((total, image) => total + image.size, 0);
                  if (isPortrait) return (
                    <div className={`mv-portrait-upload ${ready ? 'is-ready' : ''}`} key={item.key}>
                      <label className={`mv-upload-card ${ready ? 'is-ready' : ''}`}>
                        <input type="file" accept={item.accept} multiple onChange={event => { selectPortraits(event.target.files); event.currentTarget.value = ''; }} />
                        <span className="mv-upload-icon">{ready ? '＋' : '＋'}</span>
                        <span className="mv-upload-copy"><b>{item.title} *</b><small>{ready ? `已选择 ${assets.portrait.length} 张 · ${prettySize(portraitSize)}；全部参考图同级` : item.copy}</small></span>
                        <em>{ready ? '继续添加' : item.tag}</em>
                      </label>
                      {ready && <div className="mv-portrait-gallery">
                        {portraitPreviews.map(preview => <article className="mv-portrait-item" key={`${preview.file.name}-${preview.file.size}-${preview.index}`}>
                          <img src={preview.url} alt={`人物参考图 ${preview.index + 1}`} />
                          <div><b>参考图 {preview.index + 1}</b><small title={preview.file.name}>{preview.file.name}</small></div>
                          <button type="button" aria-label={`删除 ${preview.file.name}`} onClick={() => removePortrait(preview.index)}>×</button>
                        </article>)}
                      </div>}
                    </div>
                  );
                  return (
                    <label className={`mv-upload-card ${ready ? 'is-ready' : ''}`} key={item.key}>
                      <input type="file" accept={item.accept} onChange={event => selectFile(item.key as Exclude<AssetKey, 'portrait'>, event.target.files?.[0])} />
                      <span className="mv-upload-icon">{ready ? '✓' : '＋'}</span>
                      <span className="mv-upload-copy"><b>{item.title}{item.required ? ' *' : ''}</b><small>{file ? `${file.name} · ${prettySize(file.size)}` : item.copy}</small></span>
                      <em>{file ? '更换' : item.tag}</em>
                    </label>
                  );
                })}
              </div>
            </section>
            <aside className="create-side">
              <div className="create-analysis mv-summary-card">
                <p className="overline">UPLOAD STATUS</p><h2>Agent 按现有物料分析</h2>
                <ul className="summary-list">
                  {assetConfig.map(item => <li key={item.key}><span>{item.title}</span><b className={assetReady(item.key) ? 'status-ready' : ''}>{assetReady(item.key) ? item.key === 'portrait' ? `${assets.portrait.length} 张` : '已选择' : item.required ? '必填' : '可选'}</b></li>)}
                </ul>
                <div className="mv-privacy-note"><b>隐私说明</b><p>点击生成后，素材会上传到本服务器完成渲染，仅用于本次任务，并在 24 小时后自动清理。公开 Demo 最长生成前 60 秒。</p></div>
              </div>
            </aside>
          </div>
          </>
        )}

        {activeStep === 1 && (
          !agentAnalysisComplete ? (
          <section className="mv-agent-running" aria-live="polite">
            <header><div><span>✦</span><div><p className="overline">DEEPSEEK PRODUCTION AGENT</p><h2>{agentAnalyzing ? 'Agent 正在真实分析项目' : 'Agent 调用未完成'}</h2></div></div><strong>{agentAnalyzing ? 'API 处理中' : '需要重试'}</strong></header>
            <div className={`mv-agent-running-bar ${agentAnalyzing ? 'is-indeterminate' : 'is-error'}`}><span /></div>
            <p>{agentAnalyzing ? `素材已提交后端。DeepSeek 正在读取真实歌词、音频时长、${assets.portrait.length} 张同级参考图${referenceIsVideo ? '及对标视频逐段抽帧' : ''}${assets.voice ? '及自动标准化的参考音频' : ''}，并应用 ${director} 导演方法。` : agentAnalysisError}</p>
            <div className="mv-agent-running-steps">{agentAnalysisStages.map(([title, copy], index) => <article className={agentAnalyzing ? index === 0 ? 'is-done' : 'is-active' : index === 0 ? 'is-done' : ''} key={title}><span>{index === 0 ? '✓' : `0${index + 1}`}</span><div><b>{title}</b><small>{copy}</small></div><em>{index === 0 ? '已提交' : agentAnalyzing ? 'DeepSeek 处理中' : '未完成'}</em></article>)}</div>
            <footer>{agentAnalyzing ? <><span className="mv-agent-pulse" /> 正在等待 DeepSeek 返回结构化分析和逐镜提示词</> : <button className="button button-primary" type="button" onClick={() => void runAgentAnalysis()}>重新调用 Agent</button>}</footer>
          </section>
          ) : (
          <div className="mv-analysis-stage">
            <div className="mv-stage-title"><div><p className="overline">AGENT CONTEXT ANALYSIS</p><h2>Agent 已理解需求并分析本次已提供物料</h2><p>所有物料均可选：Agent 只读取真实上传的内容，缺失部分由需求、导演库和电影语料补全，不会假装已经读取。</p></div><span>项目上下文已结构化</span></div>
            <section className="mv-agent-logic"><span>01 读取需求</span><i>→</i><span>02 分析物料</span><i>→</i><span>03 建立约束</span><i>→</i><span>04 形成创作简报</span><i>→</i><span>05 交给导演方案</span></section>
            <div className="mv-analysis-grid">
              {displayedCards.map(({ title, value, copy }, index) => <article key={title}><span>0{index + 1}</span><h3>{title}</h3><b>{value}</b><p>{copy}</p></article>)}
            </div>
            <section className="mv-timeline-card"><div><p className="overline">AUDIO TIMELINE · REAL AGENT RESULT</p><h3>{projectName || '未命名项目'} · {agentAnalysis?.project_summary}</h3></div><div className="mv-waveform">{Array.from({ length: 54 }, (_, index) => <i key={index} style={{ height: `${20 + ((index * 17) % 64)}%` }} />)}</div><div className="mv-timeline-labels">{timelineItems.map(item => <span key={`${item.time}-${item.label}`}>{item.time} {item.label}</span>)}</div></section>
          </div>
          )
        )}

        {activeStep === 1 && agentAnalysisComplete && (
          <div className="storyboard-shell">
            <div className="storyboard-toolbar"><div><p className="overline">AGENT MASTER PROMPTS · {director}</p><h2>Agent 全能提示词输出</h2><small>{agentAnalysis?.creative_brief}</small></div><span className="mv-gate-pass">{displayedShots.length} 份真实提示词待确认</span></div>
            <section className="mv-master-prompt-source"><div><small>AGENT INPUT</small><b>用户需求 + 歌曲/歌词 + 人物参考图组 + 可选参考片 + 电影语料检索结果</b></div><span>→</span><div><small>AGENT OUTPUT</small><b>统一角色设定 + 逐镜画面 + 摄影运镜 + 镜头衔接 + 负面约束</b></div></section>
            {referenceIsVideo && !analysisHasReferenceVideo ? <section className="mv-reference-missing-warning"><div><b>本次 Agent 结果没有读取到对标视频</b><p>不能把这批分镜当作“完美复刻”结果继续生成。请返回第一步重新选择真实视频文件，再执行 Agent 分析；参考音频请放到独立的“参考音频”卡片。</p></div><button type="button" onClick={() => { setActiveStep(0); setNotice('请在“对标视频”卡片重新选择视频文件，然后再次运行 Agent。'); }}>返回重新上传</button></section> : null}
            {corpusReady ? <>
              <section className="mv-director-proof"><div><small>FILM CORPUS RETRIEVAL</small><h3>{director} · 电影语料已检索并参与推理</h3></div><p>{agentAnalysis?.director_application}</p><span>{corpusItems.length} 条命中 · {agentAnalysis?.corpus_retrieval?.coverage.length || 0} 类覆盖</span></section>
              <section className="mv-corpus-results"><header><div><small>RETRIEVAL EVIDENCE</small><h3>本次电影语料检索命中</h3></div><span>{agentAnalysis?.corpus_retrieval?.version}</span></header><div>{corpusItems.map(item => <article key={item.id}><div><b>{item.title}</b><em>{item.category}</em></div><p>{item.text}</p></article>)}</div></section>
              {referenceShots.length && analysisHasReferenceVideo && agentAnalysis?.reference_breakdown ? <section className="mv-reference-breakdown"><header><div><small>BENCHMARK VIDEO BLUEPRINT</small><h3>对标视频画面骨架</h3></div><span>具体画面优先 · 导演语料修辞</span></header><p>{agentAnalysis.reference_breakdown.summary}</p><dl><div><dt>景别规律</dt><dd>{agentAnalysis.reference_breakdown.shot_scale_pattern}</dd></div><div><dt>构图空间</dt><dd>{agentAnalysis.reference_breakdown.composition}</dd></div><div><dt>光线色彩</dt><dd>{agentAnalysis.reference_breakdown.lighting_color}</dd></div><div><dt>人物调度</dt><dd>{agentAnalysis.reference_breakdown.blocking_performance}</dd></div><div><dt>剪辑节奏</dt><dd>{agentAnalysis.reference_breakdown.editing_rhythm}</dd></div></dl><div className="mv-reference-shot-list">{referenceShots.map((item, index) => <article key={`${item.source_time}-${index}`}><header><b>{item.source_time}</b><span>画面 {index + 1}</span></header><p>{item.visual_blueprint}</p><small><b>主体布局：</b>{item.subject_layout}</small><small><b>动作节拍：</b>{item.action_timing}</small><small><b>镜头：</b>{item.shot_size_camera}</small><small><b>切换：</b>{item.transition}</small><small><b>项目映射：</b>{item.target_mapping}</small></article>)}</div><div className="mv-reference-methods"><div><b>导演库与电影语料修辞</b>{rhetoricalEnhancements.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}</div></div></section> : null}
            </> : <section className="mv-corpus-missing"><div><b>这批分镜没有电影语料检索记录</b><p>它是在语料库上线前生成的历史结果，不能作为已检索结果继续送审。</p></div><button type="button" onClick={() => { setActiveStep(0); setNotice('请重新选择本地素材并执行 Agent 分析，新分镜会显示真实语料命中。'); }}>返回第一步重新分析</button></section>}
            <div className="mv-prompt-gate-banner"><div><span>✓</span><p><b>八项提示词门禁</b><small>歌词时间窗 · 人物一致性 · 对标画面骨架 · 场景动作景别 · 摄影运镜 · 导演与语料修辞 · 负面提示词 · 镜头衔接</small></p></div><em>本步骤只出提示词，不生成图片</em></div>
            <div className="storyboard-grid mv-shot-grid">
              {displayedShots.map((shot, index) => <article className="shot-card" key={shot.id}><div className={`shot-media mv-shot-${(index % 6) + 1}`}><span>{shot.id}</span><b>{shot.time}</b></div><div className="shot-card-copy"><div className="shot-card-title"><span>{String(index + 1).padStart(2, '0')}</span><i>DeepSeek 真实输出</i></div><h3>{shot.title}</h3>{shot.lyrics_sync ? <section className="mv-lyrics-sync"><header><b>{shot.lyrics_sync.start}–{shot.lyrics_sync.end}</b><span>{shot.lyrics_sync.section}</span></header><p>{shot.lyrics_sync.text}</p><small>切点：{shot.lyrics_sync.cut_on}</small></section> : shot.lyrics_window && <small className="mv-shot-lyrics">歌词时间窗：{shot.lyrics_window}</small>}<p>{shot.prompt}</p>{shot.reference_match && analysisHasReferenceVideo ? <section className="mv-reference-match"><header><b>对标画面复刻约束</b><span>{shot.reference_match.source_time}</span></header><p>{shot.reference_match.visual_blueprint}</p><small><b>主体布局：</b>{shot.reference_match.subject_layout}</small><small><b>动作节拍：</b>{shot.reference_match.action_timing}</small><small><b>摄影运镜：</b>{shot.reference_match.camera_motion}</small><small><b>切镜衔接：</b>{shot.reference_match.transition}</small></section> : null}{shot.director_method && <section className="mv-shot-method"><header><b>导演方法实际执行</b><span>5 / 5</span></header><dl><div><dt>构图</dt><dd>{shot.director_method.composition}</dd></div><div><dt>摄影</dt><dd>{shot.director_method.camera}</dd></div><div><dt>光色</dt><dd>{shot.director_method.lighting_color}</dd></div><div><dt>调度</dt><dd>{shot.director_method.blocking}</dd></div><div><dt>节奏</dt><dd>{shot.director_method.rhythm}</dd></div></dl></section>}{shot.corpus_refs?.length ? <section className="mv-corpus-evidence"><header><b>电影语料引用</b><span>{shot.corpus_refs.length} 条</span></header><div>{shot.corpus_refs.map(reference => { const item = corpusById.get(reference); return <span title={item?.text} key={reference}>{item?.title || reference}</span>; })}</div></section> : null}{shot.negative_prompt && <p className="mv-negative-prompt"><b>负面提示词：</b>{shot.negative_prompt}</p>}<div className="mv-shot-tags"><span>{ratio}</span><span>{resolution}</span><span>{model}</span><span>歌词时间轴已锁定</span><span>电影语料已引用</span><span>{analysisHasReferenceVideo ? '对标画面骨架已锁定' : '本次未读取对标视频'}</span><span>镜头衔接已写入</span><span>负面词已写入</span></div></div></article>)}
            </div>
            <section className="mv-generation-decision">
              <div className="storyboard-toolbar"><div><p className="overline">GENERATION DECISION</p><h2>确认本次生成方案</h2><small>提示词确认后直接决定生成模型和交付规格，不再进入单独的“生成中心”步骤。</small></div><span className="mv-cloud-lock">需用户确认后执行</span></div>
              <div className="mv-generation-settings">
                <label><span>视频生成模型</span><select value={model} onChange={event => changeModel(event.target.value as ModelName)}>{Object.entries(modelProfiles).map(([name, profile]) => <option value={name} key={name}>{name} · {profile.provider}</option>)}</select></label>
                <label><span>输出清晰度</span><select value={resolution} onChange={event => setResolution(event.target.value)}>{modelProfiles[model].resolutions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                <article><span>动态任务数</span><b>{displayedShots.length} 个镜头</b><small>由本次音频时长、歌词结构和真实 Agent 分析决定</small></article>
              </div>
              <div className="mv-generation-decision-note"><span>✓</span><div><b>生成前确认</b><p>下一步进入成片交付页，由你主动点击“生成可播放预览”。进入下一步不会自动调用付费视频或生图接口。</p></div></div>
            </section>
          </div>
        )}

        {activeStep === 2 && (
          <div className="mv-delivery-layout">
            <section className="mv-result-card">
              {job?.status === 'completed' && job.result_url ? (
                <div className="mv-video-result">
                  <header className="mv-player-head">
                    <div><span className="mv-live-dot" />在线播放审片</div>
                    <small>成片已就绪</small>
                  </header>
                  <video controls playsInline preload="metadata" src={job.result_url} aria-label={`${projectName || '映流MV'} 成片播放器`} />
                  <footer className="mv-player-foot">
                    <div><b>{projectName || '映流MV'}</b><small>{ratio} · {resolution} · {durationLabel}</small></div>
                    <a className="button button-secondary mv-download" href={job.result_url} download={`${projectName || '映流MV'}.mp4`}>下载 MP4</a>
                  </footer>
                </div>
              ) : (
                <div className="mv-result-screen"><div className="mv-result-glow" /><span className="mv-play">{running ? `${runProgress}%` : '▶'}</span><div><b>{running ? runStage : '等待生成成片'}</b><small>{projectName || '雨夜来信'} · {ratio} · {resolution}</small><small>{running ? '请保持页面打开，进度会自动更新' : '生成完成后可在此直接播放、拖动进度、全屏审片'}</small></div></div>
              )}
              <div className={`mv-progress-panel ${running ? 'is-running' : job?.status === 'completed' ? 'is-complete' : ''}`}>
                <div className="mv-progress-head"><div><p className="overline">VIDEO GENERATION PROGRESS</p><h3>{runStage}</h3></div><strong>{runProgress}%</strong></div>
                <div className="mv-progress-bar"><span style={{ width: `${runProgress}%` }} /></div>
                <div className="mv-phase-progress"><article className={uploadProgress >= 100 ? 'is-done' : running && !job ? 'is-active' : ''}><header><b>01 素材上传</b><em>{uploadProgress}%</em></header><i><span style={{ width: `${uploadProgress}%` }} /></i></article><article className={job?.status === 'completed' ? 'is-done' : running && Boolean(job) ? 'is-active' : ''}><header><b>02 视频生成</b><em>{job?.status === 'completed' ? 100 : job?.progress || 0}%</em></header><i><span style={{ width: `${job?.status === 'completed' ? 100 : job?.progress || 0}%` }} /></i></article></div>
                <div className="mv-pipeline-status">{['素材校验', '需求分析', '对标拆解', 'ZY 分镜', '视频生成', 'AI 质检', '成片交付'].map((label, index) => { const done = runProgress >= (index + 1) * (100 / 7); return <span className={done ? 'is-done' : ''} key={label}>{done ? '✓' : index + 1} {label}</span>; })}</div>
              </div>
            </section>
            <aside className="create-side"><div className="create-analysis"><p className="overline">PLAYBACK & DELIVERY</p><h2>播放与交付</h2><ul className="summary-list"><li><span>项目</span><b>{projectName}</b></li><li><span>视频规格</span><b>{ratio} · {resolution}</b></li><li><span>生成模型</span><b>{model}</b></li><li><span>导演方法</span><b>{director}</b></li><li><span>总时长</span><b>{durationLabel}</b></li><li><span>在线播放</span><b className={job?.status === 'completed' ? 'status-ready' : ''}>{job?.status === 'completed' ? '可观看' : '等待成片'}</b></li><li><span>音轨</span><b className={job?.status === 'completed' ? 'status-ready' : ''}>{job?.status === 'completed' ? '已封装' : '待处理'}</b></li></ul><button className="button button-primary export-button" type="button" onClick={() => void startDemoRun()} disabled={running}>{running ? job ? `视频生成中 ${job.progress || 0}%` : `素材上传中 ${uploadProgress}%` : job?.status === 'completed' ? '重新生成播放预览' : '生成可播放预览'}</button>{running && <div className="mv-button-progress"><span style={{ width: `${runProgress}%` }} /></div>}</div></aside>
          </div>
        )}

        {notice && <div className="shot-notice mv-notice" role="status">{notice}</div>}
        <div className="create-actions">
          <button className="button button-secondary" type="button" onClick={() => setActiveStep(step => Math.max(0, step - 1))} disabled={activeStep === 0}>上一步</button>
          {activeStep < stepCopy.length - 1 && <button className="button button-primary" type="button" onClick={() => void nextStep()} disabled={agentAnalyzing || (activeStep === 1 && (!agentAnalysisComplete || !corpusReady || !referenceBlueprintReady))}>{agentAnalyzing ? 'DeepSeek Agent 真实分析中…' : `下一步：${stepCopy[activeStep + 1][1]}`} {!agentAnalyzing && <span>→</span>}</button>}
          <p className="create-actions-note">可运行 Demo · 真实上传并生成 MP4，不调用付费视频模型，最长处理前 60 秒。</p>
        </div>
      </VelornProductionWorkbench>
    </div>
  );
}
