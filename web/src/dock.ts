import { answeredLine } from '../../server/decision.ts';
import { compare } from './order.ts';
import type { Item } from './outbox.ts';
import type { Session } from './types.ts';
import { attentionOf } from './util.ts';

// The agents dock: the agents not waiting on the developer, one capsule each.

export type CapsuleState = 'working' | 'held' | 'sending' | 'waiting' | 'sent';

export interface Capsule {
  session: Session;
  state: CapsuleState;
  // The send the capsule stands for, from the press until a snapshot shows that it took.
  send: Item | null;
}

const UNCONFIRMED: ReadonlySet<string> = new Set(['held', 'sending', 'waiting', 'sent']);

// A session whose send is held, under way or not yet confirmed has left the deck for the dock, newest send first;
// the working sessions follow in board order. A command keeps its card, so it has no capsule.
export function dockOf(sessions: readonly Session[], items: readonly Item[], now = Date.now()) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const sends = new Map<string, Capsule>();
  for (const send of items.toReversed()) {
    const session = byId.get(send.sessionId);
    if (!session || send.command || !UNCONFIRMED.has(send.state) || sends.has(session.id)) continue;
    sends.set(session.id, { session, state: send.state as CapsuleState, send });
  }
  const working = sessions.filter((s) => !s.archived && !sends.has(s.id) && attentionOf(s, now) === 'working').sort(compare);
  return {
    capsules: [...sends.values(), ...working.map((session): Capsule => ({ session, state: 'working', send: null }))],
    working: working.length,
    ended: sessions.filter((s) => !s.archived && s.status === 'exited').sort(compare),
  };
}

// The capsule's second line. The countdown never reads more than the hold, as `now` may come from a clock that ticks
// once a second.
export function lineOf({ session, send }: Capsule, now: number, holdMs: number) {
  if (!send) return session.activity?.step ?? 'Starting';
  const dismiss = send.action === 'dismiss';
  if (send.state === 'held') {
    const left = Math.min(Math.ceil(holdMs / 1000), Math.max(1, Math.ceil((send.dueAt - now) / 1000)));
    return `${dismiss ? 'Dismissing' : 'Sending'} in ${left} s`;
  }
  if (send.state === 'sending') return dismiss ? 'Dismissing…' : 'Sending…';
  if (send.state === 'waiting') return 'Waiting for Pitwall';
  return dismiss ? 'Dismissed' : 'Sent';
}

// The sessions whose sent item left the outbox between two of its states, as a snapshot confirmed it (or 15 s
// passed): each turns back into its working capsule, with a ring.
export function confirmed(before: readonly Item[], after: readonly Item[]) {
  const kept = new Set(after.map((i) => i.id));
  return before.filter((i) => i.state === 'sent' && !kept.has(i.id)).map((i) => i.sessionId);
}

// What the hover card says was sent: the send's own label until a snapshot confirms it, then what the server
// recorded, for as long as the turn that answer started runs.
export function answeredOf({ session, send }: Capsule) {
  if (send) return `${send.action === 'dismiss' ? 'You dismissed' : 'You answered'}: ${send.label}`;
  const text = answeredLine(session);
  return text === null ? null : `You answered: ${text}`;
}
