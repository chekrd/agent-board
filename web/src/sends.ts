import { useSyncExternalStore } from 'react';
import { sessionAction } from './api.ts';
import { createOutbox, type Outgoing } from './outbox.ts';

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

const subscribers = new Set<() => void>();

// The page's outbox. Every answering request goes through sends.hold(); opening a session's terminal calls
// sends.sendNow(id), so a held answer is not pasted into a terminal someone is typing in.
export const sends = createOutbox({
  post,
  holdMs: HOLD_MS,
  onChange: () => {
    for (const fn of subscribers) fn();
  },
});

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
