import { decisionKey, turnDecision } from '../../server/decision.ts';
import type { QuestionOption, RepoView, Session } from './types.ts';

export function locate(repos: RepoView[], session: Session) {
  const repo = repos.find((r) => r.id === session.repoId);
  const worktree = repo?.worktrees.find((w) => w.path === session.worktree);
  const folder = session.worktree.split('/').at(-1) ?? session.worktree;
  return { repo, worktree, branch: worktree?.branch ?? folder };
}

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
  return { key, problem: d.problem, brief: d.brief, context: d.context ?? '', options: d.options };
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
