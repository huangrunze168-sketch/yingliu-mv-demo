import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SkillDetail, SkillListResult, SkillSource, SkillSummary } from '@qiyin/contracts';
import { SKILL_CATALOG } from './skill-catalog.js';
import { NATIVE_SKILL_CATALOG } from './native-skill-catalog.js';
import { parseSkillDirectory, SkillValidationError } from './skill-parser.js';

type InstalledRecord = SkillDetail & { installDir: string };
type SkillIndex = { schema: 'xqtv.skills@1'; favorites: string[]; installed: InstalledRecord[] };
const EMPTY: SkillIndex = { schema: 'xqtv.skills@1', favorites: [], installed: [] };
const SEARCH_ALIASES: Array<[RegExp, string[]]> = [
  [/视频生成|文生视频|图生视频/, ['video generation', 'text-to-video', 'image-to-video', 'seedance', 'veo']],
  [/分镜|故事板|预演/, ['storyboard', 'previs', 'shot list']],
  [/视频|影片|影视/, ['video', 'film', 'cinematic']],
  [/图像生成|图片生成/, ['image generation', 'flux', 'gpt image', 'nano banana']],
  [/图片|图像|摄影/, ['image', 'photo', 'photography']],
  [/配音|语音|旁白/, ['voice', 'speech', 'tts', 'dubbing']],
  [/音乐|音频|音效/, ['music', 'audio', 'sound']],
  [/广告|营销|带货/, ['advertising', 'marketing', 'ad creative', 'ugc']],
  [/社媒|自媒体|短视频/, ['social media', 'content', 'youtube', 'instagram', 'xiaohongshu']],
  [/海报|封面|缩略图/, ['poster', 'cover design', 'thumbnail']],
  [/角色|人物/, ['character', 'portrait', 'casting']],
  [/字幕|转录/, ['caption', 'subtitle', 'transcript', 'speech-to-text']],
  [/提示词/, ['prompt', 'prompting']],
];

function expandedSearchTerms(keyword: string): string[] {
  if (!keyword) return [];
  const aliases = SEARCH_ALIASES.find(([pattern]) => pattern.test(keyword))?.[1] ?? [];
  return [keyword, ...aliases];
}

export class SkillStore {
  readonly root: string;
  private readonly indexFile: string;
  constructor(workspaceRoot: string) {
    this.root = resolve(workspaceRoot, '..', 'skills');
    this.indexFile = join(this.root, 'index.json');
  }

  private readIndex(): SkillIndex {
    if (!existsSync(this.indexFile)) return { ...EMPTY, favorites: [], installed: [] };
    try {
      const value = JSON.parse(readFileSync(this.indexFile, 'utf8')) as Partial<SkillIndex>;
      if (value.schema !== EMPTY.schema || !Array.isArray(value.favorites) || !Array.isArray(value.installed)) throw new Error();
      return { schema: EMPTY.schema, favorites: value.favorites.filter((id): id is string => typeof id === 'string'), installed: value.installed as InstalledRecord[] };
    } catch {
      throw new SkillValidationError('SKILL_INDEX_CORRUPT', `Skill 索引损坏，请检查 ${this.indexFile}`);
    }
  }

  private writeIndex(index: SkillIndex): void {
    mkdirSync(dirname(this.indexFile), { recursive: true });
    const temp = `${this.indexFile}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, JSON.stringify(index, null, 2), 'utf8');
    renameSync(temp, this.indexFile);
  }

  private merged(): SkillSummary[] {
    const index = this.readIndex();
    const favorite = new Set(index.favorites);
    const byId = new Map<string, SkillSummary>();
    for (const item of SKILL_CATALOG) byId.set(item.id, { ...item, favorite: favorite.has(item.id) });
    for (const item of index.installed) {
      const catalog = byId.get(item.id);
      const { installDir: _installDir, instructions: _instructions, files: _files, hasScripts: _hasScripts, ...summary } = item;
      byId.set(item.id, { ...catalog, ...summary, description: catalog?.description ?? summary.description, installed: true, favorite: favorite.has(item.id), source: item.source });
    }
    return [...byId.values()];
  }

  list(query: { tab?: string; category?: string; keyword?: string; cursor?: string; limit?: number }): SkillListResult {
    const keyword = query.keyword?.trim().toLowerCase() ?? '';
    const searchTerms = expandedSearchTerms(keyword);
    let items = this.merged().filter(item => {
      if (query.tab === 'favorite' && !item.favorite) return false;
      if (query.tab === 'mine' && (!item.installed || item.source.kind !== 'github')) return false;
      if (query.category && query.category !== '推荐' && query.category !== '发现' && item.category !== query.category) return false;
      if (!keyword) return true;
      const haystack = `${item.name} ${item.description} ${item.author} ${item.id}`.toLowerCase();
      return searchTerms.some(term => haystack.includes(term));
    });
    items = items.sort((a, b) => Number(b.featured) - Number(a.featured) || b.uses - a.uses || a.name.localeCompare(b.name, 'zh-CN'));
    const start = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0);
    const limit = Math.max(1, Math.min(50, query.limit ?? 20));
    const page = items.slice(start, start + limit);
    return { items: page, total: items.length, nextCursor: start + limit < items.length ? String(start + limit) : null };
  }

  get(id: string): SkillDetail | null {
    const index = this.readIndex();
    const installed = index.installed.find(item => item.id === id);
    if (installed) {
      const { installDir: _installDir, ...detail } = installed;
      const catalog = SKILL_CATALOG.find(item => item.id === id);
      return { ...detail, description: catalog?.description ?? detail.description, favorite: index.favorites.includes(id), installed: true };
    }
    const native = NATIVE_SKILL_CATALOG.find(item => item.id === id);
    if (native) return { ...native, favorite: index.favorites.includes(id) };
    const catalog = SKILL_CATALOG.find(item => item.id === id);
    return catalog ? { ...catalog, favorite: index.favorites.includes(id), files: [], hasScripts: false } : null;
  }

  getInstalled(id: string, version?: string): SkillDetail | null {
    const item = this.get(id);
    if (!item?.installed || !item.instructions || (version && item.version !== version)) return null;
    return item;
  }

  setFavorite(id: string, favorite: boolean): SkillDetail {
    const detail = this.get(id);
    if (!detail) throw new SkillValidationError('SKILL_NOT_FOUND', 'Skill 不存在');
    const index = this.readIndex();
    const set = new Set(index.favorites);
    favorite ? set.add(id) : set.delete(id);
    index.favorites = [...set];
    this.writeIndex(index);
    return { ...detail, favorite };
  }

  installFromDirectory(input: { directory: string; source: SkillSource; coverUrl?: string; featured?: boolean; uses?: number }): SkillDetail {
    const parsedDir = parseSkillDirectory(input.directory);
    const { parsed, files, hasScripts } = parsedDir;
    const index = this.readIndex();
    const existing = index.installed.find(item => item.id === parsed.id);
    if (existing && existing.source.repository !== input.source.repository) {
      throw new SkillValidationError('SKILL_ID_CONFLICT', `已安装同名 Skill“${parsed.name}”，来源仓库不同`);
    }
    const target = join(this.root, 'packages', parsed.id);
    const staging = `${target}.${process.pid}.${Date.now()}.staging`;
    mkdirSync(dirname(target), { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    cpSync(input.directory, staging, { recursive: true, dereference: false });
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    const owner = new URL(input.source.repository).pathname.split('/').filter(Boolean)[0] ?? 'GitHub';
    const previousCatalog = SKILL_CATALOG.find(item => item.id === parsed.id);
    const detail: InstalledRecord = {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      category: parsed.category ?? previousCatalog?.category ?? '通用技能',
      author: parsed.author ?? previousCatalog?.author ?? owner,
      mediaType: parsed.mediaType ?? previousCatalog?.mediaType ?? 'general',
      installed: true,
      favorite: index.favorites.includes(parsed.id),
      featured: input.featured ?? previousCatalog?.featured ?? false,
      uses: input.uses ?? previousCatalog?.uses ?? 0,
      coverUrl: input.coverUrl ?? previousCatalog?.coverUrl,
      source: input.source,
      updatedAt: new Date().toISOString(),
      instructions: parsed.instructions,
      ...(parsed.usageScenario ? { usageScenario: parsed.usageScenario } : {}),
      ...(parsed.inputs ? { inputs: parsed.inputs } : {}),
      ...(parsed.output ? { output: parsed.output } : {}),
      files,
      hasScripts,
      installDir: target,
    };
    index.installed = [...index.installed.filter(item => item.id !== detail.id), detail];
    this.writeIndex(index);
    return detail;
  }

  remove(id: string): boolean {
    const index = this.readIndex();
    const item = index.installed.find(skill => skill.id === id);
    if (!item) return false;
    index.installed = index.installed.filter(skill => skill.id !== id);
    this.writeIndex(index);
    const packageRoot = resolve(this.root, 'packages');
    const target = resolve(item.installDir);
    const rel = relative(packageRoot, target);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) rmSync(target, { recursive: true, force: true });
    return true;
  }
}
