import { basename, dirname, join } from 'node:path';
import { repos, sessions, type Repo } from './db.ts';
import { detectBase, listWorktrees, type Worktree } from './git.ts';

export interface RepoView extends Repo {
  name: string;
  base: string;
  defaultWorktreeRoot: string;
  worktrees: Worktree[];
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

export async function refreshWorkspace() {
  cache = await Promise.all(repos.all().map(async (repo): Promise<RepoView> => {
    const view = {
      ...repo,
      name: basename(repo.path),
      defaultWorktreeRoot: repo.worktreeRoot ?? join(dirname(repo.path), 'worktrees'),
    };
    try {
      return { ...view, base: repo.baseBranch ?? await detectBase(repo.path), worktrees: await listWorktrees(repo.path) };
    } catch (err) {
      return { ...view, base: repo.baseBranch ?? 'master', worktrees: [], error: String(err) };
    }
  }));
  notify();
}

export const workspace = () => cache;

export const repoView = (id: number) => cache.find((r) => r.id === id);

export const snapshot = () => ({ repos: cache, sessions: sessions.all() });
