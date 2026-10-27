import type { SkillSummary } from '@qiyin/contracts';
import { NATIVE_SKILL_CATALOG } from './native-skill-catalog.js';
import { VERIFIED_GITHUB_SKILLS } from './github-skill-catalog.generated.js';
import { GITHUB_SKILL_DESCRIPTIONS_ZH } from './github-skill-localizations.js';

const now = '2026-01-01T00:00:00.000Z';

/**
 * 这里只收录能定位到公开 SKILL.md 的仓库。目录项是“发现入口”，并不冒充已经安装；
 * 用户点击添加后仍要经过 GitHub 检查、frontmatter 校验与本地安装。
 */
const GITHUB_SKILL_CATALOG: SkillSummary[] = [
  {
    id: 'video-generation', name: 'AI 视频生成', description: '规划并实现文本生成视频、镜头提示与生成流程。',
    version: 'latest', category: '专业影视', author: 'DSAA Group', mediaType: 'video', installed: false,
    favorite: false, featured: false, uses: 5400, coverUrl: '/covers/cover-0.webp', updatedAt: now,
    source: { kind: 'catalog', repository: 'https://github.com/dsaagroup/agent-skills', subdir: 'skills/video-generation' },
  },
  {
    id: 'video-gen', name: '多模型视频生成', description: '面向 Seedance、Kling、Gemini 与 MiniMax 的视频生成工作流。',
    version: 'latest', category: '专业影视', author: 'ChatCut', mediaType: 'video', installed: false,
    favorite: false, featured: false, uses: 2900, coverUrl: '/covers/cover-1.webp', updatedAt: now,
    source: { kind: 'catalog', repository: 'https://github.com/ChatCut-Inc/agent-plugin', subdir: 'codex/skills/video-gen' },
  },
  {
    id: 'seek-and-analyze-video', name: '视频检索与分析', description: '搜索、导入并分析长视频内容，提炼镜头和叙事信息。',
    version: 'latest', category: '通用技能', author: 'Agentic Awesome Skills', mediaType: 'video', installed: false,
    favorite: false, featured: false, uses: 1400, coverUrl: '/covers/cover-2.webp', updatedAt: now,
    source: { kind: 'catalog', repository: 'https://github.com/sickn33/agentic-awesome-skills', subdir: 'skills/seek-and-analyze-video' },
  },
  {
    id: 'canvas-design', name: '视觉画布设计', description: '创建高质量视觉作品、海报与静态画面设计。',
    version: 'latest', category: '商业广告', author: 'Anthropic', mediaType: 'image', installed: false,
    favorite: false, featured: false, uses: 6100, coverUrl: '/covers/cover-3.webp', updatedAt: now,
    source: { kind: 'catalog', repository: 'https://github.com/anthropics/skills', subdir: 'skills/canvas-design' },
  },
  {
    id: 'artifacts-builder', name: '交互作品构建', description: '使用 React 与现代前端技术制作复杂的交互式作品。',
    version: 'latest', category: '通用技能', author: 'Anthropic', mediaType: 'general', installed: false,
    favorite: false, featured: false, uses: 2800, coverUrl: '/covers/hero-scene.webp', updatedAt: now,
    source: { kind: 'catalog', repository: 'https://github.com/anthropics/skills', subdir: 'skills/artifacts-builder' },
  },
  {
    id: 'slides', name: '提案与分镜演示', description: '创建、编辑和审阅演示文稿，可用于方案提案与故事板汇报。',
    version: 'latest', category: '商业广告', author: 'Anthropic', mediaType: 'general', installed: false,
    favorite: false, featured: false, uses: 2200, coverUrl: '/covers/cover-1.webp', updatedAt: now,
    source: { kind: 'catalog', repository: 'https://github.com/anthropics/skills', subdir: 'skills/slides' },
  },
  {
    id: 'pdfs', name: '剧本与资料 PDF', description: '读取、整理和生成 PDF 文档，适合剧本、通告单与制作资料。',
    version: 'latest', category: '通用技能', author: 'Anthropic', mediaType: 'text', installed: false,
    favorite: false, featured: false, uses: 1800, coverUrl: '/covers/cover-2.webp', updatedAt: now,
    source: { kind: 'catalog', repository: 'https://github.com/anthropics/skills', subdir: 'skills/pdfs' },
  },
  {
    id: 'docs', name: '创作文档', description: '创建和编辑结构化文档，用于脚本、策划案和拍摄清单。',
    version: 'latest', category: '自媒体创作', author: 'Anthropic', mediaType: 'text', installed: false,
    favorite: false, featured: false, uses: 1600, coverUrl: '/covers/cover-0.webp', updatedAt: now,
    source: { kind: 'catalog', repository: 'https://github.com/anthropics/skills', subdir: 'skills/docs' },
  },
];

/**
 * 首屏 20 项为小QTV 原生创作工作流，可直接交给 Agent；后续保留可从 GitHub 安装的公开 Skill。
 * 原生工作流来自对目标站公共卡片和分类结构的逐项采样，但名称、说明与工作流均为小QTV 自有内容。
 */
const LOCALIZED_GITHUB_SKILLS: SkillSummary[] = VERIFIED_GITHUB_SKILLS.map(item => ({
  ...item,
  description: GITHUB_SKILL_DESCRIPTIONS_ZH[item.id] ?? item.description,
}));

export const SKILL_CATALOG: SkillSummary[] = [...NATIVE_SKILL_CATALOG, ...GITHUB_SKILL_CATALOG, ...LOCALIZED_GITHUB_SKILLS];

