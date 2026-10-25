import { checkDecision, decisionKey, Refusal } from '../../server/decision.ts';
import type { MenuAnswer, Session, SessionStatus } from './types.ts';

export type Action = 'answer' | 'answer-menu' | 'accept-advice' | 'dismiss';

// `key` is the decision the card showed, null for a plain message. It is always sent, since the server takes a
// missing key for a page from before that check.
export interface Body {
  key?: string | null;
  choice?: string;
  text?: string;
  files?: string[];
  toolUseId?: string;
  answers?: MenuAnswer[];
  adviceAt?: number;
}

export interface Request {
  action: Action;
  body: Body;
  // What the toast quotes: the option, the reply or the picks.
  label: string;
  // A `/` or `!` command: the server types it as it is, so it answers nothing and keeps its card.
  command?: boolean;
}

export type State = 'held' | 'sending' | 'waiting' | 'sent' | 'failed' | 'answered';

export interface Item<R = unknown> extends Request {
  id: string;
  sessionId: string;
  key: string | null;
  typed: boolean;
  command: boolean;
  // The session as the press found it, to tell from a later snapshot that the send took.
  status: SessionStatus;
  lastTurn: string | null;
  restore: R;
  dueAt: number;
  state: State;
  sentAt?: number;
  error?: string;
  code?: string;
}

export interface Outgoing {
  sessionId: string;
  action: Action;
  body: Body;
}

export interface Folded extends Outgoing {
  ids: string[];
}

export interface Timers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

export const NO_ANSWER_MS = 30_000;
export const CONFIRM_MS = 15_000;
export const NO_ANSWER = "No answer from Agent Board; check the session's terminal before sending again";

export const active = (i: Item) => i.state === 'held' || i.state === 'sending' || i.state === 'waiting';

const isNote = (i: Item) => i.action === 'answer' && i.key === null && !i.command;
const isAnswer = (i: Item) => i.action === 'answer' && i.key !== null && !i.command;

// Everything a flush sends goes out at once and can reach the server in any order. A note that lands first would
// claim an end-of-turn decision before its answer, or be refused before a question's answer, and either way one of
// the two would be lost with no page left to say so. So a session's notes ride along with its decision answer, or
// with its first note.
function fold(due: readonly Item[]): Folded[] {
  const host = new Map<string, Item>();
  for (const i of due) if (isAnswer(i) && !host.has(i.sessionId)) host.set(i.sessionId, i);
  for (const i of due) if (isNote(i) && !host.has(i.sessionId)) host.set(i.sessionId, i);
  const out: Folded[] = [];
  for (const i of due) {
    const h = host.get(i.sessionId);
    if (!h || (i !== h && !isNote(i))) {
      out.push({ sessionId: i.sessionId, action: i.action, body: i.body, ids: [i.id] });
      continue;
    }
    if (out.some((o) => o.ids.includes(h.id))) continue;
    const group = due.filter((g) => g === h || (g.sessionId === h.sessionId && isNote(g)));
    const text = group.map((g) => g.body.text).filter(Boolean).join('\n\n');
    const files = group.flatMap((g) => g.body.files ?? []);
    const body: Body = { ...h.body };
    delete body.text;
    delete body.files;
    if (text) body.text = text;
    if (files.length) body.files = files;
    out.push({ sessionId: h.sessionId, action: h.action, body, ids: group.map((g) => g.id) });
  }
  return out;
}

// Sends held for a moment so they can be taken back, then posted once with the body frozen at the press:
//   held ─due─▶ sending ─204 or 400 answered─▶ sent ─the snapshot shows it took, or 15 s─▶ gone
//                  ├─400─▶ failed   ├─network error─▶ waiting ─reconnected()─▶ sending   └─30 s, no answer─▶ failed
// A held item the snapshot shows the server would refuse fails unposted, or is `answered` when another window
// answered it. Failed and answered items stay until take(), for the page to say so and restore from `restore`.
export function createOutbox<R = unknown>(o: { post: (out: Outgoing) => Promise<unknown>; onChange?: () => void; holdMs?: number; timers?: Partial<Timers> }) {
  const holdMs = o.holdMs ?? 5000;
  const now = () => (o.timers?.now ?? Date.now)();
  const later = (fn: () => void, ms: number) => (o.timers?.setTimeout ?? setTimeout)(fn, ms);
  const cancel = (t: unknown) => (o.timers?.clearTimeout ?? clearTimeout)(t as ReturnType<typeof setTimeout>);

  let items: readonly Item<R>[] = [];
  let busyOf: { items: readonly Item<R>[]; ids: ReadonlySet<string> } | null = null;
  let seq = 0;
  const timers = new Map<string, unknown>();
  // One post at a time per session, in press order, as the server types them one at a time anyway. An item waiting
  // for its turn is `sending` but not yet `posting`.
  const chains = new Map<string, Promise<void>>();
  const posting = new Set<string>();
  const waiters: (() => void)[] = [];

  const find = (id: string) => items.find((i) => i.id === id);

  function set(next: readonly Item<R>[]) {
    items = next;
    o.onChange?.();
    if (!items.some(active)) for (const done of waiters.splice(0)) done();
  }

  const patch = (id: string, change: Partial<Item<R>>) => set(items.map((i) => (i.id === id ? { ...i, ...change } : i)));

  function schedule(id: string, ms: number, fn: () => void) {
    clear(id);
    timers.set(id, later(() => {
      timers.delete(id);
      fn();
    }, ms));
  }

  function clear(id: string) {
    if (timers.has(id)) cancel(timers.get(id));
    timers.delete(id);
  }

  function drop(id: string) {
    clear(id);
    if (find(id)) set(items.filter((i) => i.id !== id));
  }

  function sent(id: string) {
    if (find(id)?.command) return drop(id);
    patch(id, { state: 'sent', sentAt: now() });
    schedule(id, CONFIRM_MS, () => drop(id));
  }

  function refused(id: string, err: unknown) {
    if (err instanceof TypeError) return patch(id, { state: 'waiting' });
    const code = (err as { code?: string } | null)?.code;
    if (code === 'answered') return sent(id);
    patch(id, { state: 'failed', error: err instanceof Error ? err.message : String(err), code });
  }

  function attempt(id: string) {
    const item = find(id);
    if (item?.state !== 'sending') return Promise.resolve();
    return new Promise<void>((done) => {
      let over = false;
      const end = (fn: () => void) => {
        if (over) return;
        over = true;
        posting.delete(id);
        clear(id);
        fn();
        done();
      };
      schedule(id, NO_ANSWER_MS, () => end(() => patch(id, { state: 'failed', error: NO_ANSWER, code: 'no-answer' })));
      posting.add(id);
      let posted: Promise<unknown>;
      try {
        posted = o.post({ sessionId: item.sessionId, action: item.action, body: item.body });
      } catch (err) {
        posted = Promise.reject(err);
      }
      posted.then(() => end(() => sent(id)), (err) => end(() => refused(id, err)));
    });
  }

  function send(id: string) {
    const item = find(id);
    if (item?.state !== 'held' && item?.state !== 'waiting') return;
    clear(id);
    patch(id, { state: 'sending' });
    const before = chains.get(item.sessionId);
    const run = before ? before.then(() => attempt(id)) : attempt(id);
    chains.set(item.sessionId, run);
    void run.then(() => {
      if (chains.get(item.sessionId) === run) chains.delete(item.sessionId);
    });
  }

  // What the server would answer now, judged from a snapshot, for a held or waiting item; null when it would take it.
  function verdict(i: Item<R>, s: Session | undefined): Partial<Item<R>> | null {
    if (!s) return { state: 'failed', error: 'the task is gone', code: 'gone' };
    if (s.status === 'exited') return { state: 'failed', error: 'this session has ended; continue it first', code: 'ended' };
    try {
      checkDecision(s, i.key, i.typed);
      return null;
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      if (err.code !== 'answered') return { state: 'failed', error: err.message, code: err.code };
      // A waiting item may have landed on its first try, before the connection broke.
      return i.state === 'waiting' ? { state: 'sent', sentAt: now() } : { state: 'answered' };
    }
  }

  // The snapshot shows the session moved on from what the item answered. An answer lands as `answered` before
  // Claude starts, so that alone would bring the card back as Your turn for a moment.
  function took(i: Item<R>, s: Session | undefined) {
    if (!s) return true;
    if (s.status !== i.status && s.status !== 'idle') return true;
    if (s.lastTurn !== i.lastTurn) return true;
    const open = decisionKey(s);
    if (i.action === 'dismiss') return open !== i.key;
    if (i.action === 'answer-menu') return s.menu?.toolUseId !== i.body.toolUseId;
    return open !== null && open !== i.key;
  }

  return {
    items: () => items,

    hold(s: Session, request: Request, restore: R) {
      const id = `send-${++seq}`;
      const body = structuredClone(request.body);
      const item: Item<R> = {
        ...request, body, id, sessionId: s.id,
        key: request.action === 'answer-menu' ? `m:${body.toolUseId}` : (body.key ?? null),
        typed: request.action === 'answer' && !body.choice,
        command: !!request.command, status: s.status, lastTurn: s.lastTurn, restore, dueAt: now() + holdMs, state: 'held',
      };
      set([...items, item]);
      schedule(id, holdMs, () => send(id));
      return id;
    },

    // Takes back a held item, the newest without an id, and returns it so its draft can be restored.
    undo(id?: string) {
      const held = items.filter((i) => i.state === 'held');
      const item = id === undefined ? held.at(-1) : held.find((i) => i.id === id);
      if (!item) return null;
      drop(item.id);
      return item;
    },

    // Removes a failed or answered item once the page has shown it.
    take(id: string) {
      const item = find(id);
      if (item?.state !== 'failed' && item?.state !== 'answered') return null;
      drop(id);
      return item;
    },

    // The early check, on every snapshot: what the server would refuse fails here, with nothing posted. Commands
    // are typed before any check, so none is held back. Returns the items it failed or found answered.
    reconcile(sessions: readonly Session[]) {
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const judged = items.map((i) => {
        const v = i.command || (i.state !== 'held' && i.state !== 'waiting') ? null : verdict(i, byId.get(i.sessionId));
        return v ? { ...i, ...v } : i;
      });
      const changed = judged.filter((i, at) => i !== items[at]);
      if (!changed.length) return [];
      for (const i of changed) clear(i.id);
      set(judged);
      for (const i of changed) if (i.state === 'sent') schedule(i.id, CONFIRM_MS, () => drop(i.id));
      return changed.filter((i) => i.state !== 'sent');
    },

    confirm(sessions: readonly Session[]) {
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const done = items.filter((i) => i.state === 'sent' && took(i, byId.get(i.sessionId)));
      for (const i of done) clear(i.id);
      if (done.length) set(items.filter((i) => !done.includes(i)));
    },

    reconnected() {
      for (const i of items) if (i.state === 'waiting') send(i.id);
    },

    // Posts a session's held items now, in press order, as when its terminal opens and a paste would land there.
    sendNow(sessionId: string) {
      for (const i of items) if (i.sessionId === sessionId && i.state === 'held') send(i.id);
    },

    // The page is going away: hands every item not posted yet to `send` once, a session's notes folded in. That
    // includes one queued behind its session's post under way, whose turn would never come.
    flush(send: (out: Folded) => void) {
      const due = items.filter((i) => i.state === 'held' || i.state === 'waiting' || (i.state === 'sending' && !posting.has(i.id)));
      if (!due.length) return;
      for (const out of fold(due)) send(out);
      const at = now();
      for (const i of due) clear(i.id);
      set(items.flatMap((i) => (!due.includes(i) ? [i] : i.command ? [] : [{ ...i, state: 'sent' as const, sentAt: at }])));
      for (const i of due) if (!i.command) schedule(i.id, CONFIRM_MS, () => drop(i.id));
    },

    idle() {
      return items.some(active) ? new Promise<void>((done) => waiters.push(done)) : Promise.resolve();
    },

    // The sessions out of the deck while their send is held, under way or not yet confirmed. A command keeps its card.
    busy(): ReadonlySet<string> {
      if (busyOf?.items !== items) {
        busyOf = { items, ids: new Set(items.filter((i) => !i.command && (active(i) || i.state === 'sent')).map((i) => i.sessionId)) };
      }
      return busyOf.ids;
    },
  };
}

export type Outbox<R = unknown> = ReturnType<typeof createOutbox<R>>;
