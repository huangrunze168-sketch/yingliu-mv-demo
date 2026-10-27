import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { SkillInstallCandidate } from '@qiyin/contracts';

const SKILL_FILE_LIMIT = 500;
const SKILL_BYTES_LIMIT = 12 * 1024 * 1024;
const SKILL_SINGLE_FILE_LIMIT = 2 * 1024 * 1024;
const SKILL_INSTRUCTION_LIMIT = 65_536;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{1,79}$/;

export class SkillValidationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export type ParsedSkill = {
  id: string;
  name: string;
  description: string;
  version: string;
  category?: string;
  author?: string;
  mediaType?: 'video' | 'image' | 'text' | 'audio' | 'general';
  usageScenario?: string;
  inputs?: string;
  output?: string;
  instructions: string;
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

/** 只解析 Agent Skill frontmatter 需要的标量；复杂 YAML 必须由作者收敛为清晰元数据。 */
export function parseSkillMarkdown(markdown: string, fallbackId?: string): ParsedSkill {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) throw new SkillValidationError('SKILL_FRONTMATTER_REQUIRED', 'SKILL.md 缺少 YAML frontmatter');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new SkillValidationError('SKILL_FRONTMATTER_INVALID', 'SKILL.md frontmatter 未正确结束');
  const front = normalized.slice(4, end).split('\n');
  const values = new Map<string, string>();
  for (let index = 0; index < front.length; index++) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(front[index] ?? '');
    if (!match) continue;
    const key = match[1]!.toLowerCase().replace(/_/g, '-');
    let value = match[2] ?? '';
    if (/^[|>][+-]?$/.test(value)) {
      const folded = value.startsWith('>');
      const chunks: string[] = [];
      while (index + 1 < front.length && /^\s+/.test(front[index + 1] ?? '')) chunks.push((front[++index] ?? '').trim());
      value = chunks.join(folded ? ' ' : '\n');
    }
    values.set(key, unquote(value).trim());
  }
  const rawName = values.get('name') || fallbackId || '';
  const id = rawName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!SKILL_ID.test(id)) throw new SkillValidationError('SKILL_NAME_INVALID', 'Skill name 必须能转换为 2–80 位小写字母、数字或连字符标识');
  const description = values.get('description')?.trim() ?? '';
  if (!description) throw new SkillValidationError('SKILL_DESCRIPTION_REQUIRED', 'Skill frontmatter 缺少 description');
  const body = normalized.slice(end + '\n---\n'.length).trim();
  if (!body) throw new SkillValidationError('SKILL_INSTRUCTIONS_REQUIRED', 'SKILL.md 没有可执行说明');
  if (body.length > SKILL_INSTRUCTION_LIMIT) throw new SkillValidationError('SKILL_INSTRUCTIONS_TOO_LARGE', `Skill 指令超过 ${SKILL_INSTRUCTION_LIMIT} 字符`);
  const media = values.get('media-type') ?? values.get('media');
  const mediaType = media && ['video', 'image', 'text', 'audio', 'general'].includes(media) ? media as ParsedSkill['mediaType'] : undefined;
  return {
    id,
    name: values.get('title') || rawName,
    description: description.slice(0, 1000),
    version: (values.get('version') || '1.0.0').slice(0, 80),
    ...(values.get('category') ? { category: values.get('category')!.slice(0, 80) } : {}),
    ...(values.get('author') ? { author: values.get('author')!.slice(0, 120) } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(values.get('usage-scenario') ? { usageScenario: values.get('usage-scenario')!.slice(0, 2000) } : {}),
    ...(values.get('inputs') ? { inputs: values.get('inputs')!.slice(0, 2000) } : {}),
    ...(values.get('output') ? { output: values.get('output')!.slice(0, 2000) } : {}),
    instructions: body,
  };
}

function safeRelative(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..') throw new SkillValidationError('SKILL_PATH_INVALID', 'Skill 路径越界');
  return rel.replaceAll('\\', '/');
}

function listSkillFiles(root: string): string[] {
  const files: string[] = [];
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      const rel = safeRelative(root, path);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) throw new SkillValidationError('SKILL_SYMLINK_REJECTED', `Skill 包含符号链接：${rel}`);
      if (stats.isDirectory()) { walk(path); continue; }
      if (!stats.isFile()) continue;
      if (stats.size > SKILL_SINGLE_FILE_LIMIT) throw new SkillValidationError('SKILL_FILE_TOO_LARGE', `Skill 文件过大：${rel}`);
      bytes += stats.size;
      files.push(rel);
      if (files.length > SKILL_FILE_LIMIT) throw new SkillValidationError('SKILL_TOO_MANY_FILES', `Skill 文件数超过 ${SKILL_FILE_LIMIT}`);
      if (bytes > SKILL_BYTES_LIMIT) throw new SkillValidationError('SKILL_TOO_LARGE', `Skill 总大小超过 ${SKILL_BYTES_LIMIT} 字节`);
    }
  };
  walk(root);
  return files.sort();
}

export function parseSkillDirectory(dir: string): { parsed: ParsedSkill; files: string[]; hasScripts: boolean } {
  const skillFile = join(dir, 'SKILL.md');
  try { if (!statSync(skillFile).isFile()) throw new Error(); }
  catch { throw new SkillValidationError('SKILL_FILE_REQUIRED', `${dir} 中没有 SKILL.md`); }
  const files = listSkillFiles(dir);
  const parsed = parseSkillMarkdown(readFileSync(skillFile, 'utf8'), basename(dir));
  return { parsed, files, hasScripts: files.some(file => file.startsWith('scripts/')) };
}

export function discoverSkillCandidates(repoRoot: string, license?: string): SkillInstallCandidate[] {
  const candidates: SkillInstallCandidate[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5 || candidates.length >= 50) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) {
      const { parsed, files, hasScripts } = parseSkillDirectory(dir);
      const subdir = relative(repoRoot, dir).replaceAll('\\', '/');
      candidates.push({ candidateId: subdir || '.', subdir, name: parsed.name, description: parsed.description, version: parsed.version, files, hasScripts, ...(license ? { license } : {}) });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(repoRoot, 0);
  return candidates;
}
