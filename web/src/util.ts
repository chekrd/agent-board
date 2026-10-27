import { decisionKey, turnDecision } from '../../server/decision.ts';
import type { QuestionOption, RepoView, Session } from './types.ts';

export function locate(repos: RepoView[], session: Session) {
  const repo = repos.find((r) => r.id === session.repoId);
  const worktree = repo?.worktrees.find((w) => w.path === session.worktree);
  const folder = session.worktree.split('/').at(-1) ?? session.worktree;
  return { repo, worktree, branch: worktree?.branch ?? folder };
}

export const tilde = (path: string, home: string) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

// A worktree is named by its folder under the worktree root, which git-wt makes <name>/<repo>.
export function worktreeName(path: string, repo: RepoView | undefined) {
  if (repo && path === repo.path) return 'None, the main checkout';
  if (repo && !repo.worktrees.some((w) => w.path === path)) return 'None, it was removed';
  const parts = path.split('/');
  if (repo && parts.length > 1 && parts.at(-1) === repo.name) parts.pop();
  return parts.at(-1) || path;
}

// A subtask's tasks, its root task first; a link to a task that is gone ends the chain.
export function ancestorsOf(sessions: readonly Session[], s: Session) {
  const chain: Session[] = [];
  for (let p = s.parent; p; ) {
    const task = sessions.find((o) => o.id === p!.id);
    if (!task || chain.includes(task)) break;
    chain.unshift(task);
    p = task.parent;
  }
  return chain;
}

// Every subtask under a task, depth first, each with how deep it sits (1 for the task's own).
export function descendantsOf(sessions: readonly Session[], id: string, depth = 1): { session: Session; depth: number }[] {
  return sessions.filter((o) => o.parent?.id === id).flatMap((o) => [{ session: o, depth }, ...descendantsOf(sessions, o.id, depth + 1)]);
}

// The subtasks still to settle under a task: neither solved nor dropped, nor under one that is.
export function openSubtasks(sessions: readonly Session[], id: string) {
  const open: Session[] = [];
  const walk = (of: string) => {
    for (const o of sessions) {
      if (o.parent?.id !== of || o.resolution) continue;
      open.push(o);
      walk(o.id);
    }
  };
  walk(id);
  return { open, total: descendantsOf(sessions, id).length };
}

// The finding numbers from the root task down, e.g. 1.2 for finding 2 of the subtask on finding 1.
export const findingPath = (sessions: readonly Session[], s: Session) =>
  [...ancestorsOf(sessions, s).slice(1), s].map((o) => (o.parent ? o.parent.finding + 1 : '?')).join('.');

export const sessionLabel = (session: Session, branch: string) => session.title || branch;

export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export interface DecisionView {
  key: string;
  problem: string;
  brief: string;
  context: string;
  options: QuestionOption[];
}

// The question or end-of-turn choice the session waits on; a menu is not one.
export function decisionOf(s: Session): DecisionView | null {
  const key = decisionKey(s);
  if (key?.startsWith('q:')) {
    const q = s.question!;
    const d = s.summary?.question === q.toolUseId ? s.summary.decision : null;
    return { key, problem: d?.problem || q.title, brief: d?.brief ?? '', context: q.details, options: q.options };
  }
  if (!key?.startsWith('s:')) return null;
  const d = turnDecision(s)!;
  return { key, problem: d.problem, brief: d.brief, context: s.lastMessage || d.context || '', options: d.options };
}

// The advice shown with the decision or menu the session waits on now, never one left from an earlier one.
export function adviceFor(s: Session) {
  return s.advice && s.advice.key === decisionKey(s) ? s.advice : null;
}

export type Attention = 'decide' | 'focus' | 'working' | 'idle' | 'exited';
// As a task shows while a send to it waits out its hold: answered already, so it asks nothing.
export type Shown = Attention | 'sending';

export const shownOf = (s: Session, busy: ReadonlySet<string>): Shown => {
  const attention = attentionOf(s);
  return busy.has(s.id) && attention !== 'working' && attention !== 'exited' ? 'sending' : attention;
};

export const MENU_GRACE_MS = 10_000;

// A menu the board answered stays open until Claude Code has taken the keys, with Claude reported as waiting.
const answeredMenuAt = (s: Session) => (s.menu && s.answered?.key === `m:${s.menu.toolUseId}` ? s.answered.at : null);

// The menu is still open 10 s after the board answered it, so the keys did not take and only the terminal can help.
export function menuStuck(s: Session, now = Date.now()) {
  const at = answeredMenuAt(s);
  return at !== null && s.status !== 'working' && s.status !== 'exited' && now >= at + MENU_GRACE_MS;
}

export function attentionOf(s: Session, now = Date.now()): Attention {
  if (s.status === 'exited') return 'exited';
  if (decisionKey(s)) return 'decide';
  if (answeredMenuAt(s) !== null) return menuStuck(s, now) ? 'focus' : 'working';
  return s.status === 'waiting' ? 'focus' : s.status;
}

// When the session's attention changes with no new snapshot, or null if it cannot.
export function attentionChangesAt(s: Session) {
  const at = answeredMenuAt(s);
  return at === null ? null : at + MENU_GRACE_MS;
}

// Every time the board shows is on the 24-hour clock, whatever the locale's habit: 14:05, with the weekday when asked.
export const clock = (at: number, weekday = false) =>
  new Date(at).toLocaleString([], { ...(weekday && { weekday: 'short' as const }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
