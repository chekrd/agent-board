import type { Session } from './types.ts';
import { attentionOf, type Attention } from './util.ts';

const attentionRank: Record<Attention, number> = { decide: 0, focus: 1, idle: 2, working: 3, exited: 4 };

const group = (s: Session) => attentionRank[attentionOf(s)];

function compare(a: Session, b: Session) {
  const g = group(a) - group(b);
  if (g) return g;
  return (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.createdAt - b.createdAt;
}

export function orderTiles(sessions: Session[]) {
  return {
    active: sessions.filter((s) => !s.archived).sort(compare),
    archived: sessions.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

export const orderKey = (sessions: Session[]) => {
  const { active, archived } = orderTiles(sessions);
  return [...active, ...archived].map((s) => `${s.id}:${group(s)}`).join();
};
