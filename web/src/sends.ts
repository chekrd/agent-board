import { useSyncExternalStore } from 'react';
import { sessionAction } from './api.ts';
import { putBack, release, takeDraft, type Draft } from './components/Composer.tsx';
import { dismissToast, toast } from './components/Toasts.tsx';
import { createOutbox, NO_ANSWER_MS, type Item, type Outgoing, type Request } from './outbox.ts';
import { queue } from './queue.ts';
import { go, openSheet } from './router.ts';
import type { Session } from './types.ts';

export const HOLD_MS = 5000;

// Keepalive requests in flight share 64 KiB, and one that would pass it fails at once. A body that does not fit
// goes as a plain request, which may not finish if the page goes away meanwhile.
const KEEPALIVE_BYTES = 60_000;
let keptAlive = 0;

function post(o: Outgoing) {
  const size = new TextEncoder().encode(JSON.stringify(o.body)).length;
  const keepalive = keptAlive + size <= KEEPALIVE_BYTES;
  if (keepalive) keptAlive += size;
  return sessionAction(o.sessionId, o.action, o.body, { keepalive }).finally(() => {
    if (keepalive) keptAlive -= size;
  });
}

export interface Restore {
  // The task as the toasts name it.
  name: string;
  // What the send took from the reply box.
  draft: Draft | null;
  // Sent from its card, which left the queue with it.
  dealt: boolean;
}

const subscribers = new Set<() => void>();

// The page's outbox. Every answering request goes through hold(); opening a session's terminal posts what it holds
// first, so a held answer is not pasted into a terminal someone is typing in.
export const sends = createOutbox<Restore>({
  post,
  holdMs: HOLD_MS,
  onChange: () => {
    review();
    for (const fn of subscribers) fn();
  },
});

const short = (text: string) => (text.length > 120 ? `${text.slice(0, 119).trimEnd()}…` : text);
const quote = (text: string) => `“${short(text)}”`;

function heldText(i: Item<Restore>) {
  if (i.command) return `Sending ${short(i.label)} to ${i.restore.name}`;
  if (i.action === 'dismiss') return `Dismissing ${quote(i.label)}`;
  return `Sending ${quote(i.label)} to ${i.restore.name}`;
}

// A card whose send failed waits right after the card being read; Show brings it to the front, or opens the task when
// it no longer waits.
function show(id: string) {
  if (!queue.state().order.includes(id)) return openSheet(id, 'overview');
  queue.jump(id);
  go('/');
}

function announce(i: Item<Restore>) {
  const { name } = i.restore;
  const session = i.sessionId;
  if (i.state === 'held') {
    return toast('undo', heldText(i), { session, until: i.dueAt, lasts: HOLD_MS + 2000, action: { label: 'Undo', kbd: 'Z', run: () => undo(i.id) } });
  }
  if (i.state === 'waiting') return toast('info', `Waiting for Agent Board to send ${quote(i.label)} to ${name}`, { session, lasts: NO_ANSWER_MS });
  if (i.state === 'failed') return toast('error', `Not sent to ${name}: ${i.error}`, { session, action: { label: 'Show', run: () => show(session) } });
  if (i.state === 'answered') return toast('info', `Already answered elsewhere; nothing was sent to ${name}`, { session });
  return null;
}

// Each item as last told, with the toast that told it.
const told = new Map<string, { item: Item<Restore>; toast: number | null }>();
// Items whose draft went back to the reply box, which still shows their pictures.
const givenBack = new Set<string>();

// Tells each change of an item's state once: the hold with its Undo, a wait for the server, a refusal, an answer from
// elsewhere. A refused card comes back after the card being read, and the reply box gets back what the send took. An
// item gone for good lets go of the pictures it took along.
function review() {
  const items = sends.items();
  for (const i of items) {
    const was = told.get(i.id);
    if (was?.item.state === i.state) continue;
    if (was?.toast) dismissToast(was.toast);
    told.set(i.id, { item: i, toast: announce(i) });
    if (i.state !== 'failed' && i.state !== 'answered') continue;
    givenBack.add(i.id);
    if (i.restore.draft) putBack(i.sessionId, i.restore.draft);
    if (i.state === 'failed') queue.notSent(i.sessionId, i.error ?? 'the send failed');
    queueMicrotask(() => sends.take(i.id));
  }
  for (const [id, was] of told) {
    if (items.some((i) => i.id === id)) continue;
    told.delete(id);
    if (was.toast && was.item.state !== 'failed' && was.item.state !== 'answered') dismissToast(was.toast);
    if (!givenBack.delete(id) && was.item.restore.draft) release(was.item.restore.draft);
  }
}

// Holds an answering request for 5 s. What it takes along from the reply box leaves the box, and comes back if the
// send is taken back or refused.
export function hold(s: Session, request: Request, name: string, { dealt = false } = {}) {
  const { text, files } = request.body;
  const draft = request.action === 'answer' && (text !== undefined || !!files?.length) ? takeDraft(s.id) : null;
  return sends.hold(s, request, { name, draft, dealt });
}

// Takes back a held send, the newest without an id. A card dealt out with it comes back to the front, and the reply
// box gets back what the send took from it.
export function undo(id?: string) {
  const item = sends.items().filter((i) => i.state === 'held' && (id === undefined || i.id === id)).at(-1);
  if (!item) return;
  const back = () => {
    givenBack.add(item.id);
    if (!sends.undo(item.id)) {
      givenBack.delete(item.id);
      return false;
    }
    if (item.restore.draft) putBack(item.sessionId, item.restore.draft);
    return true;
  };
  if (item.restore.dealt) queue.restore(item.sessionId, back);
  else back();
}

// The page is going away or being frozen: whatever has not been posted yet goes now. Not on visibilitychange,
// since whoever comes back within 5 s can still take it back.
const flush = () => sends.flush((o) => void post(o).catch(() => {}));

addEventListener('pagehide', flush);
document.addEventListener('freeze', flush);

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
};

export const useSends = () => useSyncExternalStore(subscribe, sends.items);

// The sessions out of the deck while their send is held or not yet confirmed. Read through the hook, so that a view
// computing the deck from it is computed again when it changes.
export const useBusy = () => useSyncExternalStore(subscribe, sends.busy);
