import type { Session } from './db.ts';

type Task = Pick<Session, 'id' | 'conversation' | 'history' | 'pid' | 'status'>;

// The task a conversation belongs to: the one running it, or one that ran it before a /clear and now runs it again.
export const taskOf = <T extends Task>(tasks: readonly T[], conversation: string) =>
  tasks.find((t) => t.conversation === conversation) ?? tasks.find((t) => t.history.some((h) => h.id === conversation));

// The task whose Claude, process `pid`, has left its conversation for another: by /clear or /resume.
export const leftBy = <T extends Task>(tasks: readonly T[], pid: number, live: ReadonlySet<string>) =>
  tasks.find((t) => t.pid === pid && t.status !== 'exited' && !live.has(t.conversation));

// The task runs `conversation` from now on. The one it ran goes into its history, and with it what was read from that
// transcript alone: its turns, its open question or menu. The task's name, findings, artifacts and subtasks stay.
export function handOver(s: Pick<Session, 'conversation' | 'history' | 'lastMessage'>, conversation: string, now: number) {
  return {
    conversation,
    history: [...s.history.filter((h) => h.id !== conversation), { id: s.conversation, lastMessage: s.lastMessage, until: now }],
    lastMessage: null, lastTurn: null, question: null, menu: null, dismissedAsk: null, activity: null,
  } satisfies Partial<Session>;
}
