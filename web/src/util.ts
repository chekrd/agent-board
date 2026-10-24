import type { QuestionOption, RepoView, Session } from './types.ts';

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

export interface DecisionView {
  key: string;
  problem: string;
  brief: string;
  details: string | null;
  options: QuestionOption[];
}

export function decisionOf(s: Session): DecisionView | null {
  const q = s.question;
  const summary = s.summary;
  if (q) {
    const d = summary?.question === q.toolUseId ? summary.decision : null;
    return { key: `q:${q.toolUseId}`, problem: d?.problem || q.title, brief: d?.brief ?? '', details: q.details, options: q.options };
  }
  const d = summary?.question === null && s.status === 'idle' ? summary.decision : null;
  return d ? { key: `s:${summary!.basis}`, problem: d.problem, brief: d.brief, details: null, options: d.options.map((label) => ({ label })) } : null;
}

export type Attention = 'decide' | 'focus' | 'working' | 'idle' | 'exited';

export const attentionOf = (s: Session): Attention =>
  decisionOf(s) ? 'decide' : s.status === 'waiting' ? 'focus' : s.status;
