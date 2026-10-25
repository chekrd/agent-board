import { useSyncExternalStore } from 'react';
import { sessionAction } from './api.ts';
import { createOutbox, type Body, type Outgoing } from './outbox.ts';

export const HOLD_MS = 5000;

// Keepalive requests in flight share 64 KiB. A bigger body goes as a plain request, which may not finish if the
// page goes away meanwhile.
const KEEPALIVE_BYTES = 60_000;

const bytes = (body: Body) => new TextEncoder().encode(JSON.stringify(body)).length;

const post = (o: Outgoing, keepalive = bytes(o.body) < KEEPALIVE_BYTES) => sessionAction(o.sessionId, o.action, o.body, { keepalive });

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

// The page is going away or being frozen: what is held or waiting goes out now. Not on visibilitychange, since
// whoever comes back within 5 s can still take it back.
function flush() {
  let budget = KEEPALIVE_BYTES;
  sends.flush((o) => {
    const size = bytes(o.body);
    const keepalive = size <= budget;
    if (keepalive) budget -= size;
    post(o, keepalive).catch(() => {});
  });
}

addEventListener('pagehide', flush);
document.addEventListener('freeze', flush);

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
};

export const useSends = () => useSyncExternalStore(subscribe, sends.items);
