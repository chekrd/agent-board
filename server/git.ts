import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
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

const GIT_WT = join(import.meta.dirname, '..', 'scripts', 'git-wt');

async function gitWt(repo: string, args: string[]) {
  const { stdout } = await run(GIT_WT, args, { cwd: repo, env: { ...loginEnv, GIT_OPTIONAL_LOCKS: '0' } }).catch((err) => {
    throw new Error(String(err.stderr || err.message).trim());
  });
  return stdout.trim();
}

export async function addWorktree(repo: string, opts: { branch: string; task: string; base: string; root: string; path?: string }) {
  return gitWt(repo, ['add', opts.branch, '--task', opts.task, '--base', opts.base, '--root', opts.root, ...(opts.path ? ['--path', opts.path] : [])]);
}

// Each branch by name, with whether it is local and whether origin has it: git wt add reuses a local branch, else
// tracks origin's.
export async function listBranches(repo: string) {
  const out = await git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  const found = new Map<string, { name: string; local: boolean; origin: boolean }>();
  for (const ref of out.split('\n').filter(Boolean)) {
    const local = ref.startsWith('refs/heads/');
    const name = local ? ref.slice('refs/heads/'.length) : ref.split('/').slice(3).join('/');
    if (!name || name === 'HEAD') continue;
    const branch = found.get(name) ?? { name, local: false, origin: false };
    if (local) branch.local = true;
    else if (ref.startsWith('refs/remotes/origin/')) branch.origin = true;
    found.set(name, branch);
  }
  return [...found.values()];
}

// A remote-only branch gets a local tracking branch, as `git switch` does by default.
export const switchBranch = (worktree: string, branch: string) => git(worktree, ['switch', '--quiet', branch]);

export const isClean = async (worktree: string, { untracked = true } = {}) =>
  !(await git(worktree, ['status', '--porcelain', ...(untracked ? [] : ['--untracked-files=no'])])).trim();

// Commits only this branch reaches: deleting it would leave them on no branch or remote.
export async function unsharedCommits(worktree: string, branch: string | null) {
  const exclude = branch ? [`--exclude=${branch}`] : [];
  return Number((await git(worktree, ['rev-list', '--count', 'HEAD', '--not', ...exclude, '--branches', '--remotes', '--tags'])).trim()) || 0;
}

export const changedFiles = async (worktree: string) =>
  (await git(worktree, ['status', '--porcelain'])).split('\n').filter(Boolean).length;

export async function removeWorktree(repo: string, path: string, opts: { force: boolean; deleteBranch: boolean }) {
  await gitWt(repo, ['rm', path, ...(opts.force ? ['--force'] : []), ...(opts.deleteBranch ? ['--delete-branch'] : [])]);
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

// git re-reads a file whose stat matches its entry only when the entry is as new as the index,
// so a copy newer than the index would hide a same-size edit made in the second it was written.
async function copyIndex(from: string, to: string) {
  const times = await stat(from).catch(() => null);
  if (times) await copyFile(from, to).then(() => utimes(to, times.atime, times.mtime)).catch(() => {});
}

// The base as origin has it, as a pull request would compare: a local base branch can be behind origin or carry
// commits of its own.
async function remoteBase(worktree: string, base: string) {
  if (base.startsWith('origin/')) return base;
  return (await ok(git(worktree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]))) ? `origin/${base}` : base;
}

// Everything on disk (committed, staged, unstaged, untracked minus ignored) against
// the merge-base with origin's base, staged into a throwaway index so the real one is never touched.
// With `paths`, every unchanged line is context, so those files read in full.
export async function fullDiff(worktree: string, localBase: string, opts: { statOnly?: boolean; paths?: string[] } = {}): Promise<FullDiff> {
  const base = await remoteBase(worktree, localBase);
  const mergeBase = (await git(worktree, ['merge-base', base, 'HEAD'])).trim();
  const dir = await mkdtemp(join(tmpdir(), 'pitwall-index-'));
  const index = join(dir, 'index');
  try {
    let realIndex = (await git(worktree, ['rev-parse', '--git-path', 'index'])).trim();
    if (!isAbsolute(realIndex)) realIndex = join(worktree, realIndex);
    await copyIndex(realIndex, index);
    const env = { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: '1' };
    await git(worktree, ['add', '-A'], env);
    const diff = (format: string[]) => git(worktree, [
      'diff', '--cached', '--find-renames', '--no-color', '--no-ext-diff', ...format, mergeBase, '--', ...(opts.paths ?? []),
    ], env);
    const [numstat, patch] = await Promise.all([
      diff(['--numstat']),
      opts.statOnly ? '' : diff(opts.paths ? ['--unified=1000000'] : []),
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
  return pullRequestUrlOf(await remotes.get(worktree)!, id);
}

export function pullRequestUrlOf(remoteUrl: string, id: number) {
  const remote = remoteUrl
    .replace(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+)$/, 'https://dev.azure.com/$1/$2/_git/$3')
    .replace(/^git@([^:]+):(.+)$/, 'https://$1/$2')
    .replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/, 'https://$1/$2')
    .replace(/^(https?:\/\/)[^@/]+@/, '$1')
    .replace(/\.git$/, '');
  if (remote.includes('/_git/')) return `${remote}/pullrequest/${id}`;
  if (remote.includes('github.com')) return `${remote}/pull/${id}`;
  return null;
}

// clonefile fails across volumes, so a repo outside the data volume gets a plain copy.
const cloneInto = (src: string, dest: string) =>
  run('/bin/cp', ['-cR', src, `${dest}/`]).catch(() => run('/bin/cp', ['-R', src, `${dest}/`]));

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
