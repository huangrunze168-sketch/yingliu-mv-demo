import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SkillInstallCandidate, SkillSource } from '@qiyin/contracts';
import { discoverSkillCandidates, parseSkillDirectory, SkillValidationError } from './skill-parser.js';

export type GitHubLocation = { repository: string; ref?: string; subdir?: string };

export function normalizeGitHubLocation(urlValue: string, refValue?: string, subdirValue?: string): GitHubLocation {
  let url: URL;
  try { url = new URL(urlValue); } catch { throw new SkillValidationError('GITHUB_URL_INVALID', '请输入有效的 GitHub HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password) {
    throw new SkillValidationError('GITHUB_URL_INVALID', '仅支持不含凭据的 https://github.com 地址');
  }
  const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_.-]+$/.test(parts[1]!)) {
    throw new SkillValidationError('GITHUB_URL_INVALID', 'GitHub 地址必须包含 owner/repository');
  }
  let ref = refValue?.trim() || undefined;
  let subdir = subdirValue?.trim().replace(/^\/+|\/+$/g, '') || undefined;
  if (parts[2] === 'tree' && parts[3]) {
    if (!ref) ref = decodeURIComponent(parts[3]);
    if (!subdir && parts.length > 4) subdir = parts.slice(4).map(decodeURIComponent).join('/');
  }
  if (ref && (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes('..'))) throw new SkillValidationError('GITHUB_REF_INVALID', 'Git ref 不合法');
  if (subdir && (subdir.split('/').some(part => part === '..' || part === '.' || !part) || subdir.includes('\\'))) {
    throw new SkillValidationError('GITHUB_SUBDIR_INVALID', 'Skill 子目录不合法');
  }
  return { repository: `https://github.com/${parts[0]}/${parts[1]}`, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}) };
}

function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') throw new SkillValidationError('GIT_NOT_INSTALLED', '未找到 Git，请先安装 Git 后再导入公开仓库');
  if (result.status !== 0) throw new SkillValidationError('GITHUB_CLONE_FAILED', (result.stderr || result.stdout || 'GitHub 仓库读取失败').trim().slice(0, 1200));
  return result.stdout.trim();
}

function inside(root: string, subdir: string): string {
  const target = resolve(root, subdir || '.');
  const rel = relative(resolve(root), target);
  if (rel.startsWith('..') || rel === '..') throw new SkillValidationError('GITHUB_SUBDIR_INVALID', 'Skill 子目录越界');
  return target;
}

function detectLicense(repoRoot: string): string | undefined {
  const names = readdirSync(repoRoot).filter(item => /^licen[sc]e(?:[.-]|$)/i.test(item));
  if (!names.length) return undefined;
  if (names.length > 1) return 'Multiple licenses; see repository notices';
  const name = names[0]!;
  try {
    const first = readFileSync(join(repoRoot, name), 'utf8').split(/\r?\n/).find(line => line.trim())?.trim();
    return (first || name).slice(0, 120);
  } catch { return name.slice(0, 120); }
}

export class GitHubSkillImporter {
  private checkout<T>(location: GitHubLocation, action: (repoRoot: string, commit: string, license?: string) => T): T {
    const temp = mkdtempSync(join(tmpdir(), 'xqtv-skill-'));
    const repoRoot = join(temp, 'repo');
    try {
      const pinnedCommit = location.ref && /^[a-f0-9]{40}$/i.test(location.ref) ? location.ref.toLowerCase() : undefined;
      const args = ['clone', '--depth', '1', '--filter=blob:none', '--no-tags', '--no-checkout'];
      if (location.ref && !pinnedCommit) args.push('--branch', location.ref);
      args.push(`${location.repository}.git`, repoRoot);
      git(args);
      if (pinnedCommit) git(['fetch', '--depth', '1', 'origin', pinnedCommit], repoRoot);
      if (location.subdir) {
        // 大型 Skill 集合只检出目标目录；根目录许可证文件仍会由 cone 模式保留。
        git(['sparse-checkout', 'init', '--cone'], repoRoot);
        git(['sparse-checkout', 'set', location.subdir], repoRoot);
      }
      git(['checkout', pinnedCommit ?? 'HEAD'], repoRoot);
      const commit = git(['rev-parse', 'HEAD'], repoRoot).toLowerCase();
      return action(repoRoot, commit, detectLicense(repoRoot));
    } finally {
      try { rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch { /* Windows 上 Git/杀毒进程可能短暂占用公开临时文件，不应覆盖已完成的安装结果。 */ }
    }
  }

  inspect(location: GitHubLocation): { location: GitHubLocation; commit: string; candidates: SkillInstallCandidate[] } {
    return this.checkout(location, (repoRoot, commit, license) => {
      const root = location.subdir ? inside(repoRoot, location.subdir) : repoRoot;
      if (!existsSync(root)) throw new SkillValidationError('SKILL_SUBDIR_NOT_FOUND', '仓库中不存在指定 Skill 子目录');
      const candidates = discoverSkillCandidates(root, license).map(candidate => ({
        ...candidate,
        subdir: [location.subdir, candidate.subdir].filter(Boolean).join('/'),
        candidateId: [location.subdir, candidate.candidateId === '.' ? '' : candidate.candidateId].filter(Boolean).join('/') || '.',
      }));
      if (!candidates.length) throw new SkillValidationError('SKILL_FILE_REQUIRED', '仓库中没有发现合法的 SKILL.md');
      return { location, commit, candidates };
    });
  }

  install<T>(location: GitHubLocation, candidateSubdir: string, action: (directory: string, source: SkillSource) => T): T {
    return this.checkout(location, (repoRoot, commit, license) => {
      const directory = inside(repoRoot, candidateSubdir === '.' ? '' : candidateSubdir);
      parseSkillDirectory(directory);
      return action(directory, {
        kind: 'github', repository: location.repository, ...(location.ref ? { ref: location.ref } : {}),
        ...(candidateSubdir && candidateSubdir !== '.' ? { subdir: candidateSubdir } : {}), commit, ...(license ? { license } : {}),
      });
    });
  }
}
