import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeGitHubLocation } from '../apps/local-api/src/skills/github-importer.js';
import { parseSkillMarkdown, SkillValidationError } from '../apps/local-api/src/skills/skill-parser.js';
import { SkillStore } from '../apps/local-api/src/skills/skill-store.js';
import { SKILL_CATALOG } from '../apps/local-api/src/skills/skill-catalog.js';
import { VERIFIED_GITHUB_SKILLS } from '../apps/local-api/src/skills/github-skill-catalog.generated.js';
import { GITHUB_SKILL_DESCRIPTIONS_ZH } from '../apps/local-api/src/skills/github-skill-localizations.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function makeRoot() { const root = mkdtempSync(join(tmpdir(), 'xqtv-skill-test-')); roots.push(root); return root; }
function makeSkill(root: string, name = 'film-director') {
  const dir = join(root, 'source', name); mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 把创意整理成可执行的电影分镜\nversion: 1.2.0\nauthor: 测试导演\ncategory: 专业影视\nmedia-type: video\nusage-scenario: 短片与广告\ninputs: 一句话创意\noutput: 分镜方案\n---\n\n# 工作流\n\n先澄清时长，再规划镜头。\n`, 'utf8');
  writeFileSync(join(dir, 'references', 'camera.md'), '镜头参考', 'utf8');
  return dir;
}

describe('Skill 解析与存储', () => {
  it('内置目录达到对标数量，并覆盖主要视频创作分类与可执行工作流', () => {
    const root = makeRoot(); const workspaceRoot = join(root, 'workspaces'); mkdirSync(workspaceRoot);
    const store = new SkillStore(workspaceRoot);
    const all = store.list({ tab: 'skill', category: '推荐', limit: 50 });
    expect(all.total).toBeGreaterThanOrEqual(120);
    expect(all.items.slice(0, 20).every(item => item.featured)).toBe(true);
    for (const category of ['专业影视', '商业广告', '短剧漫剧', '动漫游戏', '音乐MV', '自媒体创作']) {
      expect(store.list({ tab: 'skill', category, limit: 50 }).items.length, category).toBeGreaterThanOrEqual(4);
    }
    const native = store.getInstalled('eastern-epic-drama', '1.0.0');
    expect(native?.instructions).toContain('三幕结构');
    expect(native?.output).toContain('逐镜头');
    expect(store.list({ tab: 'mine', limit: 50 }).items).toHaveLength(0);
    expect(store.list({ tab: 'skill', keyword: '视频生成', limit: 50 }).items.map(item => item.id)).toContain('ai-video-generation');
    expect(store.list({ tab: 'skill', keyword: '分镜', limit: 50 }).items.some(item => item.id.includes('storyboard'))).toBe(true);
  });

  it('精选 GitHub 目录只保留 LibTV 相关创作能力，且来源可追溯、标识不重复', () => {
    const repositories = new Set([
      'https://github.com/inference-sh/skills',
      'https://github.com/agentara/skills',
      'https://github.com/cajias/agentic-video-skills',
      'https://github.com/gainubi/storyboard-video-skill',
      'https://github.com/sickn33/agentic-awesome-skills',
    ]);
    expect(VERIFIED_GITHUB_SKILLS).toHaveLength(88);
    expect(Object.keys(GITHUB_SKILL_DESCRIPTIONS_ZH)).toHaveLength(88);
    expect(SKILL_CATALOG).toHaveLength(130);
    expect(SKILL_CATALOG.every(item => /[\u3400-\u9fff]/.test(item.description))).toBe(true);
    expect(new Set(SKILL_CATALOG.map(item => item.id)).size).toBe(SKILL_CATALOG.length);
    expect(SKILL_CATALOG.map(item => item.id)).not.toEqual(expect.arrayContaining(['frontend-design', 'seo-audit', '3d-web-experience']));
    for (const item of VERIFIED_GITHUB_SKILLS) {
      expect(item.source.kind).toBe('catalog');
      expect(repositories.has(item.source.repository)).toBe(true);
      expect(item.source.ref).toMatch(/^[a-f0-9]{40}$/);
      expect(item.source.subdir === undefined || !item.source.subdir.includes('..')).toBe(true);
      expect(item.description.length).toBeGreaterThan(10);
      expect(GITHUB_SKILL_DESCRIPTIONS_ZH[item.id]).toMatch(/[\u3400-\u9fff]/);
      expect(GITHUB_SKILL_DESCRIPTIONS_ZH[item.id]).not.toMatch(/\b(?:Triggers|Use for|Capabilities|Models|Tools):/i);
      expect(['专业影视', '商业广告', '动漫游戏', '音乐MV', '自媒体创作', '通用技能']).toContain(item.category);
    }
  });

  it('解析标准 frontmatter 并拒绝缺少说明的伪 Skill', () => {
    const parsed = parseSkillMarkdown('---\nname: video-maker\ndescription: 视频制作\n---\n\n先写脚本。');
    expect(parsed).toMatchObject({ id: 'video-maker', name: 'video-maker', description: '视频制作', version: '1.0.0' });
    expect(parseSkillMarkdown('---\nname: folded-skill\ndescription: >-\n  第一行说明\n  第二行说明\n---\n\n执行正文。').description).toBe('第一行说明 第二行说明');
    expect(() => parseSkillMarkdown('---\nname: bad\n---\n正文')).toThrowError(SkillValidationError);
  });

  it('安装、收藏、筛选、重启读取与删除均持久化', () => {
    const root = makeRoot(); const workspaceRoot = join(root, 'workspaces'); mkdirSync(workspaceRoot);
    const store = new SkillStore(workspaceRoot);
    const detail = store.installFromDirectory({ directory: makeSkill(root), source: { kind: 'github', repository: 'https://github.com/example/skills', commit: 'abcdef1234567' } });
    expect(detail).toMatchObject({ id: 'film-director', installed: true, version: '1.2.0', hasScripts: false });
    expect(detail.files).toContain('references/camera.md');
    expect(store.setFavorite(detail.id, true).favorite).toBe(true);
    expect(store.list({ tab: 'favorite' }).items.map(item => item.id)).toContain(detail.id);
    const reloaded = new SkillStore(workspaceRoot);
    expect(reloaded.getInstalled(detail.id, '1.2.0')?.instructions).toContain('先澄清时长');
    expect(reloaded.remove(detail.id)).toBe(true);
    expect(reloaded.getInstalled(detail.id, '1.2.0')).toBeNull();
  });

  it('同名不同来源不能静默覆盖', () => {
    const root = makeRoot(); const workspaceRoot = join(root, 'workspaces'); mkdirSync(workspaceRoot);
    const store = new SkillStore(workspaceRoot); const directory = makeSkill(root);
    store.installFromDirectory({ directory, source: { kind: 'github', repository: 'https://github.com/a/repo' } });
    expect(() => store.installFromDirectory({ directory, source: { kind: 'github', repository: 'https://github.com/b/repo' } })).toThrow(/来源仓库不同/);
  });
});

describe('GitHub 地址规范化', () => {
  it('接受公开仓库与 tree 地址，拒绝外部主机和路径穿越', () => {
    expect(normalizeGitHubLocation('https://github.com/anthropics/skills/tree/main/skills/slides')).toEqual({ repository: 'https://github.com/anthropics/skills', ref: 'main', subdir: 'skills/slides' });
    expect(() => normalizeGitHubLocation('https://evil.example/a/b')).toThrow(/github\.com/i);
    expect(() => normalizeGitHubLocation('https://github.com/a/b', 'main', '../secret')).toThrow(/子目录/);
  });
});
