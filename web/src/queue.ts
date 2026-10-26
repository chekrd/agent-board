import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { decisionKey } from '../../server/decision.ts';
import { kindOf, refreeze, resolveFront, rotate, targetOf, type Frozen } from './deck.ts';
import type { MenuAnswer, Session } from './types.ts';

// The queue's own state, which no snapshot carries: the card being read, what ⏎ sends on each decision, the key
// guard, and the markers the cards show.

export const GUARD_MS = 900;
export const UPDATED_MS = 10_000;
export const FRESH_MS = 2600;
const KEPT = 100;
const FRONT_KEY = 'agent-board:front';
const FROZEN_KEY = 'agent-board:frozen';
const PICKS_KEY = 'agent-board:picks';

// How a card change moves: an answer drops down, a dismissal or archive goes sideways, a skip goes back, and a send
// taken back comes back.
export type Deal = 'down' | 'side' | 'back' | 'enter' | 'enter-back';

export interface NotSent {
  message: string;
  shown: boolean;
}

export interface QueueState {
  front: string | null;
  // The card the queue view draws, which lags the front while the reader types in what would go away.
  shown: string | null;
  // The deck as last shown, front first, which tells who follows a card that leaves.
  order: readonly string[];
  // Decision keys there when the page loaded or drawn at the front since; null before the first snapshot.
  seen: ReadonlySet<string> | null;
  frozen: ReadonlyMap<string, Frozen>;
  guardUntil: number;
  // Session ids, each with the time its "Updated just now" or its fresh ring ends.
  updated: ReadonlyMap<string, number>;
  fresh: ReadonlyMap<string, number>;
  // A send that failed: while its card is in the deck it waits right after the front until it has been there once,
  // with this message.
  notSent: ReadonlyMap<string, NotSent>;
}

// The card at the front left the deck for a reason outside this page: answered in the terminal, Claude moved on.
export interface Left {
  type: 'left';
  id: string;
}

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface QueueDeps {
  now?: () => number;
  storage?: Storage | null;
  transition?: (change: () => void, deal: Deal) => void;
  later?: (fn: () => void, ms: number) => void;
}

const waiting = (notSent: ReadonlyMap<string, NotSent>) => new Set([...notSent].filter(([, n]) => !n.shown).map(([id]) => id));

// The deck as the queue shows it: its front card and the rest in reading order.
export function arrange(deck: readonly Session[], q: QueueState) {
  const front = resolveFront(deck, q.front, q.order);
  return rotate(deck, front, waiting(q.notSent));
}

// What a card asks of the reader: a change of it is an update of the card being read.
export const signature = (s: Session, now: number) => `${kindOf(s, now)}:${decisionKey(s)}`;

export function createQueue({ now = Date.now, storage = null, transition = (change) => change(), later = (fn, ms) => void setTimeout(fn, ms) }: QueueDeps = {}) {
  const read = <T>(key: string, parse: (raw: string) => T, fallback: T) => {
    try {
      const raw = storage?.getItem(key);
      return raw ? parse(raw) : fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key: string, value: string | null) => {
    try {
      if (value === null) storage?.removeItem(key);
      else storage?.setItem(key, value);
    } catch {
      // A page without storage keeps it in memory only.
    }
  };

  let state: QueueState = {
    front: read<string | null>(FRONT_KEY, (raw) => raw, null),
    shown: null,
    order: [],
    seen: null,
    frozen: read(FROZEN_KEY, (raw) => new Map<string, Frozen>(JSON.parse(raw)), new Map()),
    guardUntil: 0,
    updated: new Map(),
    fresh: new Map(),
    notSent: new Map(),
  };
  // A menu's picks, by decision. They are a draft, as a reply box's text is: the card that comes back, after a skip,
  // an Undo or a reload, shows them as they were.
  let picks = read(PICKS_KEY, (raw) => new Map<string, MenuAnswer[]>(JSON.parse(raw)), new Map());
  const keep = <T>(map: Map<string, T>) => {
    for (const old of map.keys()) if (map.size > KEPT) map.delete(old);
    return map;
  };
  const subscribers = new Set<() => void>();
  // Fronts leaving through this page's own send, archive or quit, which need no "no longer waits".
  const own = new Set<string>();
  // The front card as last arranged, to tell an outside change of it.
  let arranged: { id: string; sig: string; target: string } | null = null;
  // The card as the view last drew it.
  let drawn: { id: string; sig: string } | null = null;
  // The deck of the last sync, which a move arranges again around its new front.
  let deck: readonly Session[] = [];

  function commit(next: QueueState) {
    if (next.front !== state.front) write(FRONT_KEY, next.front);
    if (next.frozen !== state.frozen) write(FROZEN_KEY, JSON.stringify([...next.frozen]));
    state = next;
    for (const fn of subscribers) fn();
  }

  // Marks end by the clock, so a view showing one needs a new state when it does.
  const expire = (ms: number) =>
    later(() => {
      const at = now();
      const live = (m: ReadonlyMap<string, number>) => new Map([...m].filter(([, until]) => until > at));
      commit({ ...state, updated: live(state.updated), fresh: live(state.fresh) });
    }, ms);

  const guard = () => {
    expire(GUARD_MS);
    return now() + GUARD_MS;
  };

  const markUpdated = (updated: ReadonlyMap<string, number>, id: string) => {
    expire(UPDATED_MS);
    return new Map(updated).set(id, now() + UPDATED_MS);
  };

  // Arranges the deck around `pinned`, the card wanted at the front: it keeps the pin, or moves it to the card that
  // followed it, and restarts the guard when the card at the front, its decision or what ⏎ sends changes.
  function arrangeAround(pinned: string | null): Left[] {
    const at = now();
    const events: Left[] = [];
    let { guardUntil, updated, frozen, notSent } = state;
    const seen = state.seen ?? new Set(deck.flatMap((s) => decisionKey(s) ?? []));
    const front = resolveFront(deck, pinned, state.order);
    if (pinned && front !== pinned && !own.has(pinned)) events.push({ type: 'left', id: pinned });
    for (const id of own) if (!deck.some((s) => s.id === id)) own.delete(id);

    const card = deck.find((s) => s.id === front) ?? null;
    const key = card && decisionKey(card);
    const update = (id: string) => {
      updated = markUpdated(updated, id);
      guardUntil = guard();
    };
    if (card && key) {
      const was = frozen.get(key);
      const re = was && refreeze(was, card);
      if (re) {
        frozen = new Map(frozen).set(key, re.frozen);
        if (re.why === 'rewritten') update(card.id);
        else guardUntil = guard();
      }
    }
    const before = arranged?.id ?? null;
    const sig = card ? signature(card, at) : '';
    const target = card ? targetOf(card, (key && frozen.get(key)) || null, at) : '';
    if (card && before !== card.id) guardUntil = guard();
    else if (card && arranged!.sig !== sig) update(card.id);
    else if (card && arranged!.target !== target) guardUntil = guard();
    arranged = card ? { id: card.id, sig, target } : null;

    const pending = front ? notSent.get(front) : undefined;
    if (front && pending?.shown === false) notSent = new Map(notSent).set(front, { ...pending, shown: true });
    if (before && front !== before && notSent.get(before)?.shown) notSent = new Map([...notSent].filter(([id]) => id !== before));
    const inDeck = (id: string) => deck.some((s) => s.id === id);
    if ([...notSent.keys()].some((id) => !inDeck(id))) notSent = new Map([...notSent].filter(([id]) => inDeck(id)));
    const order = rotate(deck, front, waiting(notSent)).map((s) => s.id);
    const same = front === state.front && order.join() === state.order.join() && seen === state.seen && frozen === state.frozen &&
      updated === state.updated && notSent === state.notSent && guardUntil === state.guardUntil;
    if (!same) commit({ ...state, front, order, seen, frozen, updated, notSent, guardUntil });
    return events;
  }

  const move = (front: string, deal: Deal) => transition(() => void arrangeAround(front), deal);

  // Skip and previous are off for the rest of the press that ended a wait for typing: the card that waited has just
  // come up, and the press was aimed at the one before it.
  let still = false;

  function deal(way: Deal, change: () => void) {
    if (state.front && (way === 'down' || way === 'side')) own.add(state.front);
    const guardUntil = guard();
    commit({ ...state, guardUntil });
    transition(change, way);
  }

  return {
    state: () => state,
    subscribe(fn: () => void) {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },
    guarded: () => now() < state.guardUntil,

    // Call with every new deck once the first snapshot is in.
    sync(next: readonly Session[]): Left[] {
      deck = next;
      return arrangeAround(state.front);
    },

    skip() {
      const next = state.order[1];
      if (next && !still) move(next, 'back');
    },
    previous() {
      const last = state.order.at(-1);
      if (last && last !== state.front && !still) move(last, 'enter-back');
    },
    holdMoves(on: boolean) {
      still = on;
    },
    jump(id: string) {
      if (id !== state.front && deck.some((s) => s.id === id)) move(id, 'enter');
    },

    // The view draws this card at the front, or none. Only a card the reader has seen stops being an arrival, and
    // one drawn late, after typing held it back, still starts the guard and shows as updated when it is.
    show(card: Session | null) {
      const sig = card ? signature(card, now()) : '';
      if (card?.id === drawn?.id && sig === (drawn?.sig ?? '')) return;
      const before = drawn;
      drawn = card ? { id: card.id, sig } : null;
      let { seen, guardUntil, updated } = state;
      const key = card && decisionKey(card);
      if (key && seen && !seen.has(key)) seen = new Set(seen).add(key);
      if (card) guardUntil = guard();
      if (card && before?.id === card.id) updated = markUpdated(updated, card.id);
      commit({ ...state, shown: card?.id ?? null, seen, guardUntil, updated });
    },

    // Applies a change that takes the front card away (a send, dismissal, archive) as one deal. The guard starts
    // at once, so a second press before the next card is up cannot answer it.
    deal,
    own(id: string) {
      own.add(id);
    },
    // Takes a session out of the deck from this page, as an archive, a quit or a deleted worktree does: its card
    // leaves sideways when it is the one being read. Returns whether it was.
    leave(id: string, change: () => void) {
      own.add(id);
      if (state.front !== id) {
        change();
        return false;
      }
      deal('side', change);
      return true;
    },
    // Takes a deal back: when `change` puts the card in the deck again, it comes back to the front.
    restore(id: string, change: () => boolean) {
      transition(() => {
        if (change()) commit({ ...state, front: id });
      }, 'enter-back');
    },

    // Written from the render that first showed the card, with the value it drew.
    freeze(key: string, value: Frozen) {
      if (state.frozen.has(key)) return;
      commit({ ...state, frozen: keep(new Map(state.frozen).set(key, value)) });
    },
    picksOf: (key: string) => picks.get(key) ?? null,
    pick(key: string, value: readonly MenuAnswer[]) {
      picks = keep(new Map(picks).set(key, value.map((p) => ({ labels: [...p.labels], other: p.other }))));
      write(PICKS_KEY, JSON.stringify([...picks]));
    },
    notSent(id: string, message: string) {
      commit({ ...state, notSent: new Map(state.notSent).set(id, { message, shown: false }) });
    },
    fresh(id: string) {
      expire(FRESH_MS);
      commit({ ...state, fresh: new Map(state.fresh).set(id, now() + FRESH_MS) });
    },
  };
}

export type Queue = ReturnType<typeof createQueue>;

let dealt = 0;

// Only the card moves: the page under it updates live. Off the queue, or under a dialog the transition would draw
// over, the change just happens.
function viewTransition(change: () => void, deal: Deal) {
  const root = document.documentElement;
  if (!document.startViewTransition || root.dataset.view !== 'queue' || document.querySelector('dialog:modal')) return change();
  const token = ++dealt;
  root.dataset.deal = deal;
  const done = () => {
    if (dealt === token) delete root.dataset.deal;
  };
  // A deal that starts while one runs skips it, which rejects the skipped one's ready.
  const t = document.startViewTransition(() => flushSync(change));
  t.ready.catch(() => {});
  t.finished.then(done, done);
}

function sessionStorageOrNull() {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

export const queue = createQueue(typeof document === 'undefined' ? {} : { storage: sessionStorageOrNull(), transition: viewTransition });

export const useQueue = () => useSyncExternalStore(queue.subscribe, queue.state);
