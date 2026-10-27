import type { Session } from './types.ts';
import { attentionOf, type Attention } from './util.ts';

const attentionRank: Record<Attention, number> = { decide: 0, focus: 1, idle: 2, working: 3, exited: 4 };

const group = (s: Session) => attentionRank[attentionOf(s)];

export function compare(a: Session, b: Session) {
  const g = group(a) - group(b);
  if (g) return g;
  return (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.createdAt - b.createdAt;
}

// The Wall shows tasks, not subtasks, however deep: a subtask shows on its root task's tile and on its task's page, and
// the task stands where its most urgent subtask would. A subtask whose task is gone or archived shows on its own.
export function orderTiles(sessions: Session[]) {
  const active = sessions.filter((s) => !s.archived);
  const byId = new Map(active.map((s) => [s.id, s]));
  const ids = new Set(sessions.map((s) => s.id));
  const rootOf = (s: Session): Session => {
    const seen = new Set<Session>();
    while (s.parent && byId.has(s.parent.id) && !seen.has(s)) {
      seen.add(s);
      s = byId.get(s.parent.id)!;
    }
    return s;
  };
  const tasks = new Set(active.sort(compare).map(rootOf));
  return {
    active: [...tasks],
    archived: sessions.filter((s) => s.archived && !(s.parent && ids.has(s.parent.id))).sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

export const orderKey = (sessions: Session[]) => {
  const { active, archived } = orderTiles(sessions);
  return [...active, ...archived].map((s) => `${s.id}:${group(s)}`).join();
};
