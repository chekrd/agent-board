import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { wsUrl } from './api.ts';
import { SHEET_DIALOG } from './keys.ts';
import { orderKey } from './order.ts';
import { active } from './outbox.ts';
import { sends } from './sends.ts';
import type { RepoView, Session } from './types.ts';
import { isEditable, menuOpen } from './useKeys.ts';
import { attentionChangesAt } from './util.ts';

// Connecting until the first snapshot, live while the socket is open, reconnecting after a drop.
export type Link = 'connecting' | 'live' | 'reconnecting';

interface State {
  roots: string[];
  repos: RepoView[];
  sessions: Session[];
  link: Link;
  // link === 'live', for today's connection dot.
  connected: boolean;
  // A new build has waited 15 s for a moment when reloading loses nothing.
  newVersion: boolean;
}

const RELOAD_CAP_MS = 15_000;

let state: State = { roots: [], repos: [], sessions: [], link: 'connecting', connected: false, newVersion: false };
const subscribers = new Set<() => void>();
let order = '';

// On the queue the tiles' reorder would cut a card's own transition short, and under a sheet it has nothing to show.
const reorderShows = () => document.documentElement.dataset.view !== 'queue' && !document.querySelector(`#${SHEET_DIALOG}[open]`);

// The state changes at once and only the redraw waits for a reorder's transition, so a set made meanwhile builds on
// the newest state and is not undone when the transition applies.
function set(next: State) {
  const key = orderKey(next.sessions);
  const animate = key !== order && state.link === 'live' && !document.hidden && reorderShows();
  order = key;
  state = next;
  const notify = () => {
    for (const fn of subscribers) fn();
  };
  if (animate) document.startViewTransition(() => flushSync(notify));
  else notify();
}


let wake: ReturnType<typeof setTimeout> | undefined;

// A menu answered from the board turns from working to Needs focus by the clock alone, with no snapshot to say so;
// its send counts as taken then, so the card comes back.
function wakeAtNextChange() {
  clearTimeout(wake);
  const now = Date.now();
  const next = Math.min(...state.sessions.flatMap((s) => {
    const at = attentionChangesAt(s);
    return at !== null && at > now ? [at] : [];
  }));
  if (next === Infinity) return;
  wake = setTimeout(() => {
    sends.confirm(state.sessions);
    set({ ...state });
    wakeAtNextChange();
  }, next - now);
}


// The build this page runs, named by its entry script: import.meta.url names whichever chunk this module lands in,
// and a split that moved it would reload the page in a loop.
const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
let reloading = false;

// A new build reloads the page once nothing would be lost: the server can be reached, no send is held, under way or
// waiting, no field is focused (a draft or a rename), and no dialog or menu is open. Held sends keep their own
// timers meanwhile, and after 15 s the top bar offers the reload instead.
function reloadWhenFree() {
  if (reloading) return;
  reloading = true;
  const since = Date.now();
  const check = () => {
    const free = state.link === 'live' && !sends.items().some(active) && !isEditable(document.activeElement) &&
      !document.querySelector('dialog[open]') && !menuOpen();
    if (free) return location.reload();
    if (!state.newVersion && Date.now() - since >= RELOAD_CAP_MS) set({ ...state, newVersion: true });
    setTimeout(check, 250);
  };
  check();
}

async function connect() {
  for (;;) {
    try {
      const ws = new WebSocketStream(wsUrl('/ws/events'));
      const { readable } = await ws.opened;
      for await (const message of readable) {
        const { uiEntry, ...next } = JSON.parse(String(message));
        sends.reconcile(next.sessions);
        sends.confirm(next.sessions);
        sends.reconnected();
        set({ ...state, ...next, link: 'live', connected: true });
        wakeAtNextChange();
        if (uiEntry && !import.meta.env.DEV && entry && new URL(uiEntry, location.href).href !== entry) reloadWhenFree();
      }
    } catch {
      // reconnect below
    }
    if (state.link === 'live') set({ ...state, link: 'reconnecting', connected: false });
    await new Promise((r) => setTimeout(r, 1000));
  }
}

void connect();

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};

export const useStore = () => useSyncExternalStore(subscribe, () => state);
