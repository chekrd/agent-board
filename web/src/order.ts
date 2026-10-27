import type { Session } from './types.ts';
import { attentionOf, type Attention } from './util.ts';

const attentionRank: Record<Attention, number> = { decide: 0, focus: 1, idle: 2, working: 3, exited: 4 };

const group = (s: Session) => attentionRank[attentionOf(s)];

export function compare(a: Session, b: Session) {
  const g = group(a) - group(b);
  if (g) return g;
  return (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.createdAt - b.createdAt;
}

// A task's subtasks follow it, and the family stands where its most urgent member would.
function withSubtasks(sorted: Session[]) {
  const ids = new Set(sorted.map((s) => s.id));
  const headOf = (s: Session) => (s.parent && ids.has(s.parent.id) ? s.parent.id : s.id);
  const families = new Map<string, Session[]>();
  for (const s of sorted) families.set(headOf(s), [...(families.get(headOf(s)) ?? []), s]);
  return [...families].flatMap(([head, members]) => [...members.filter((s) => s.id === head), ...members.filter((s) => s.id !== head)]);
}

export function orderTiles(sessions: Session[]) {
  return {
    active: withSubtasks(sessions.filter((s) => !s.archived).sort(compare)),
    archived: sessions.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

export const orderKey = (sessions: Session[]) => {
  const { active, archived } = orderTiles(sessions);
  return [...active, ...archived].map((s) => `${s.id}:${group(s)}`).join();
};
