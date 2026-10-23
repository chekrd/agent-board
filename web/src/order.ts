import type { Session, SessionStatus } from './types.ts';

const statusRank: Record<SessionStatus, number> = { working: 1, permission: 2, idle: 3, exited: 4 };

const group = (s: Session) => (s.question ? 0 : statusRank[s.status]);

function compare(a: Session, b: Session) {
  const g = group(a) - group(b);
  if (g) return g;
  if (a.question && b.question) {
    return (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.question.askedAt - b.question.askedAt;
  }
  return a.createdAt - b.createdAt;
}

export function orderTiles(sessions: Session[]) {
  const claude = sessions.filter((s) => s.kind === 'claude');
  return {
    active: claude.filter((s) => !s.archived).sort(compare),
    archived: claude.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

export const orderKey = (sessions: Session[]) => {
  const { active, archived } = orderTiles(sessions);
  return [...active, ...archived].map((s) => `${s.id}:${group(s)}`).join();
};
