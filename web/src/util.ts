import type { RepoView, Session } from './types.ts';

export function locate(repos: RepoView[], session: Session) {
  const repo = repos.find((r) => r.id === session.repoId);
  const worktree = repo?.worktrees.find((w) => w.path === session.worktree);
  const folder = session.worktree.split('/').at(-1) ?? session.worktree;
  return { repo, worktree, branch: worktree?.branch ?? folder };
}

export const sessionLabel = (session: Session, branch: string) => session.title || branch;

export function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
