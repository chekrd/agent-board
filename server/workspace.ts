import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { liveConversations, listConversations, type Conversation } from './conversations.ts';
import { repos, roots, sessions, type Repo } from './db.ts';
import { SCRATCH_DIR } from './config.ts';
import { detectBase, listWorktrees, type Worktree } from './git.ts';
import { findRepos } from './scan.ts';

export interface WorktreeView extends Worktree {
  conversations: Conversation[];
}

export interface RepoView extends Repo {
  name: string;
  base: string;
  defaultWorktreeRoot: string;
  worktrees: WorktreeView[];
  error?: string;
}

let cache: RepoView[] = [];
const listeners = new Set<() => void>();

export const onChange = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

let pending = false;
export function notify() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    for (const fn of listeners) fn();
  });
}

async function scanRoots() {
  const known = new Set(cache.flatMap((r) => r.worktrees.map((w) => w.path)));
  for (const root of roots.all()) {
    for (const path of await findRepos(root, known)) repos.addFound(path);
  }
}

const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;

let started = 0;
let applied = 0;

// Refreshes overlap; one that began before a delete must not put the deleted worktree back.
export async function refreshWorkspace({ scan = false } = {}) {
  const generation = ++started;
  if (scan) await scanRoots();
  const live = await liveConversations();
  const next = await Promise.all(repos.all().map(async (repo): Promise<RepoView> => {
    const view = {
      ...repo,
      name: basename(repo.path),
      defaultWorktreeRoot: repo.worktreeRoot ?? join(dirname(repo.path), 'worktrees'),
    };
    try {
      const worktrees = await Promise.all((await listWorktrees(repo.path)).filter((w) => !w.path.startsWith(`${SCRATCH_DIR}/`)).map(async (w) => ({
        ...w,
        conversations: await listConversations(w.path, live),
      })));
      worktrees.sort((a, b) => Number(b.isMain) - Number(a.isMain) || byName(a.branch ?? a.path, b.branch ?? b.path));
      return { ...view, base: repo.baseBranch ?? await detectBase(repo.path), worktrees };
    } catch (err) {
      return { ...view, base: repo.baseBranch ?? 'master', worktrees: [], error: String(err) };
    }
  }));
  next.sort((a, b) => byName(a.name, b.name) || byName(a.path, b.path));
  if (generation < applied) return;
  applied = generation;
  cache = next;
  notify();
}

export const workspace = () => cache;

export const repoView = (id: number | null) => (id === null ? undefined : cache.find((r) => r.id === id));

// A folder holding two or more of the repositories; one task can work across them, from a task folder
// <folder>/worktrees/<task> with a worktree <task folder>/<repo folder> in each repository it changes.
export interface FolderView {
  path: string;
  name: string;
  repos: number[];
}

export function folders(): FolderView[] {
  const by = Map.groupBy(cache.filter((r) => !r.error), (r) => dirname(r.path));
  return [...by].filter(([, rs]) => rs.length > 1).map(([path, rs]) => ({ path, name: basename(path), repos: rs.map((r) => r.id) }));
}

export function taskFolderOf(path: string) {
  const parent = dirname(path);
  if (basename(parent) !== 'worktrees') return undefined;
  const folder = folders().find((f) => f.path === dirname(parent));
  return folder && { path, name: basename(path), folder, repos: cache.filter((r) => folder.repos.includes(r.id)) };
}

export const taskWorktrees = (taskFolder: string) =>
  cache.flatMap((repo) => repo.worktrees.filter((w) => !w.isMain && dirname(w.path) === taskFolder).map((worktree) => ({ repo, worktree })));

// Where a task works, for the prompts of the models that read about it.
export function placeOf(s: { repoId: number | null; worktree: string }) {
  if (s.repoId !== null) return `the git worktree ${s.worktree} (repository ${repoView(s.repoId)?.name ?? 'unknown'}, base branch ${repoView(s.repoId)?.base ?? 'unknown'})`;
  const opened = taskWorktrees(s.worktree).map(({ repo, worktree }) => `${repo.name} at ${worktree.path} (base branch ${repo.base})`);
  return `the task folder ${s.worktree}, which holds a git worktree for each repository the task changes (${opened.join('; ') || 'none yet'}), beside the main checkouts in ${dirname(dirname(s.worktree))}`;
}

export const taskRepoNames = (taskFolder: string) => taskWorktrees(taskFolder).map(({ repo }) => repo.name).join(', ') || 'no repository yet';

export const snapshot = () => ({ home: homedir(), roots: roots.all(), repos: cache, folders: folders(), sessions: sessions.all() });
