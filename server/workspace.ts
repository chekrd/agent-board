import { basename, dirname, join } from 'node:path';
import { liveConversations, listConversations, type Conversation } from './conversations.ts';
import { repos, roots, sessions, type Repo } from './db.ts';
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

export async function refreshWorkspace({ scan = false } = {}) {
  if (scan) await scanRoots();
  const live = await liveConversations();
  cache = await Promise.all(repos.all().map(async (repo): Promise<RepoView> => {
    const view = {
      ...repo,
      name: basename(repo.path),
      defaultWorktreeRoot: repo.worktreeRoot ?? join(dirname(repo.path), 'worktrees'),
    };
    try {
      const worktrees = await Promise.all((await listWorktrees(repo.path)).map(async (w) => ({
        ...w,
        conversations: await listConversations(w.path, live),
      })));
      return { ...view, base: repo.baseBranch ?? await detectBase(repo.path), worktrees };
    } catch (err) {
      return { ...view, base: repo.baseBranch ?? 'master', worktrees: [], error: String(err) };
    }
  }));
  notify();
}

export const workspace = () => cache;

export const repoView = (id: number) => cache.find((r) => r.id === id);

export const snapshot = () => ({ roots: roots.all(), repos: cache, sessions: sessions.all() });
