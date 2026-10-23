import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loginEnv } from './env.ts';

const run = promisify(execFile);

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const { stdout } = await run('git', args, {
    cwd,
    env: { ...loginEnv, ...env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 256 << 20,
  });
  return stdout;
}

const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

export async function repoRoot(path: string) {
  const common = (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  return resolve(common, '..');
}

export async function detectBase(repo: string) {
  for (const candidate of ['master', 'main']) {
    if (await ok(git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]))) return candidate;
  }
  const head = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  return head.trim() || 'HEAD';
}

export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  return out.split('\n\n').filter(Boolean).flatMap((block, i) => {
    const fields = new Map(block.split('\n').map((l) => {
      const sp = l.indexOf(' ');
      return sp < 0 ? [l, ''] : [l.slice(0, sp), l.slice(sp + 1)];
    }));
    if (fields.has('bare') || fields.has('prunable')) return [];
    return [{
      path: fields.get('worktree')!,
      branch: fields.get('branch')?.replace('refs/heads/', '') ?? null,
      head: fields.get('HEAD') ?? '',
      isMain: i === 0,
    }];
  });
}

export async function addWorktree(repo: string, path: string, branch: string, base: string) {
  const exists = await ok(git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]));
  await git(repo, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base]);
}

export async function removeWorktree(repo: string, path: string, opts: { force: boolean; deleteBranch: boolean }) {
  const branch = (await listWorktrees(repo)).find((w) => w.path === path)?.branch;
  await git(repo, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), path]);
  if (opts.deleteBranch && branch) await git(repo, ['branch', '-D', branch]);
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface FullDiff {
  base: string;
  mergeBase: string;
  patch: string;
  stat: DiffStat;
}

// Everything on disk (committed, staged, unstaged, untracked minus ignored) against
// the merge-base, staged into a throwaway index so the real one is never touched.
export async function fullDiff(worktree: string, base: string, statOnly = false): Promise<FullDiff> {
  const mergeBase = (await git(worktree, ['merge-base', base, 'HEAD'])).trim();
  const dir = await mkdtemp(join(tmpdir(), 'agent-ide-index-'));
  const index = join(dir, 'index');
  try {
    let realIndex = (await git(worktree, ['rev-parse', '--git-path', 'index'])).trim();
    if (!isAbsolute(realIndex)) realIndex = join(worktree, realIndex);
    await copyFile(realIndex, index).catch(() => {});
    const env = { GIT_INDEX_FILE: index };
    await git(worktree, ['add', '-A'], env);
    const diffArgs = ['diff', '--cached', '--find-renames', '--no-color', '--no-ext-diff', mergeBase];
    const [numstat, patch] = await Promise.all([
      git(worktree, [...diffArgs, '--numstat'], env),
      statOnly ? '' : git(worktree, diffArgs, env),
    ]);
    const stat = { files: 0, insertions: 0, deletions: 0 };
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [add, del] = line.split('\t');
      stat.files++;
      stat.insertions += Number(add) || 0;
      stat.deletions += Number(del) || 0;
    }
    return { base, mergeBase, patch, stat };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const remotes = new Map<string, Promise<string>>();

export async function pullRequestUrl(worktree: string, id: number) {
  if (!remotes.has(worktree)) remotes.set(worktree, git(worktree, ['remote', 'get-url', 'origin']).then((s) => s.trim(), () => ''));
  const remote = (await remotes.get(worktree)!)
    .replace(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+)$/, 'https://dev.azure.com/$1/$2/_git/$3')
    .replace(/^git@([^:]+):(.+)$/, 'https://$1/$2')
    .replace(/^(https?:\/\/)[^@/]+@/, '$1')
    .replace(/\.git$/, '');
  if (remote.includes('/_git/')) return `${remote}/pullrequest/${id}`;
  if (remote.includes('github.com')) return `${remote}/pull/${id}`;
  return null;
}

const cloneInto = (src: string, dest: string) => run('/bin/cp', ['-cR', src, `${dest}/`]);

// A detached worktree whose files are APFS clones of `worktree`, uncommitted and ignored files included.
export async function addScratchCopy(worktree: string, dest: string) {
  await git(worktree, ['worktree', 'add', '--detach', '--no-checkout', dest, 'HEAD']);
  const entries = (await readdir(worktree)).filter((e) => e !== '.git');
  await Promise.all(entries.map((e) => cloneInto(join(worktree, e), dest)));
  await git(dest, ['reset', '--quiet']);
}

export async function removeScratchCopy(dir: string) {
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then((s) => s.trim(), () => null);
  await rm(dir, { recursive: true, force: true });
  if (common) await git(dirname(common), ['worktree', 'prune']).catch(() => {});
}
