import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { wsUrl } from './api.ts';
import { reportColorScheme } from './colorScheme.ts';
import { orderKey } from './order.ts';
import type { RepoView, Session } from './types.ts';

interface State {
  roots: string[];
  repos: RepoView[];
  sessions: Session[];
  connected: boolean;
}

let state: State = { roots: [], repos: [], sessions: [], connected: false };
const subscribers = new Set<() => void>();

function set(next: State) {
  const reordered = orderKey(next.sessions) !== orderKey(state.sessions);
  const apply = () => {
    state = next;
    for (const fn of subscribers) fn();
  };
  if (reordered && state.connected && !document.hidden) document.startViewTransition(() => flushSync(apply));
  else apply();
}

async function connect() {
  for (;;) {
    try {
      const ws = new WebSocketStream(wsUrl('/ws/events'));
      const { readable } = await ws.opened;
      void reportColorScheme();
      for await (const message of readable) set({ ...JSON.parse(String(message)), connected: true });
    } catch {
      // reconnect below
    }
    if (state.connected) set({ ...state, connected: false });
    await new Promise((r) => setTimeout(r, 1000));
  }
}

void connect();

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};

export const useStore = () => useSyncExternalStore(subscribe, () => state);
