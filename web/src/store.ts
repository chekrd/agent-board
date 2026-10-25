import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { wsUrl } from './api.ts';
import { orderKey } from './order.ts';
import { active } from './outbox.ts';
import { sends } from './sends.ts';
import type { RepoView, Session } from './types.ts';
import { isEditable, menuOpen } from './useKeys.ts';
import { attentionChangesAt } from './util.ts';

export type Link = 'connecting' | 'live' | 'reconnecting';

interface State {
  roots: string[];
  repos: RepoView[];
  sessions: Session[];
  link: Link;
  // link === 'live', for today's connection dot.
  connected: boolean;
  // The top bar offers to reload into a new build: in 15 s no moment came when reloading would lose nothing, or
  // reloading for that build already brought this tab back to the build it runs.
  newVersion: boolean;
}

const RELOAD_CAP_MS = 15_000;
const RELOADED_FOR = 'agent-board:reloaded-for';

let state: State = { roots: [], repos: [], sessions: [], link: 'connecting', connected: false, newVersion: false };
const subscribers = new Set<() => void>();
let order = '';

// On the queue the tiles' reorder would cut a card's own transition short, and under a sheet or dialog it has nothing
// to show.
const reorderShows = () => document.documentElement.dataset.view !== 'queue' && !document.querySelector('dialog[open]');

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
  // A reorder that comes while one runs skips it, which rejects the skipped one's ready.
  if (animate) document.startViewTransition(() => flushSync(notify)).ready.catch(() => {});
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
    // Views redraw a session when its object changes, so one whose attention changed is replaced by a copy.
    const at = Date.now();
    const sessions = state.sessions.map((s) => ((attentionChangesAt(s) ?? Infinity) <= at ? { ...s } : s));
    sends.confirm(sessions);
    set({ ...state, sessions });
    wakeAtNextChange();
  }, next - now);
}

// The build this page runs, named by its entry script: import.meta.url names whichever chunk this module lands in,
// and a split that moved it would reload the page in a loop.
const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
// The build the gate waits to reload into: the newest one announced, unless that is the page's own.
let armedFor: string | null = null;
let armedAt = 0;
let checking: ReturnType<typeof setTimeout> | undefined;

function reloadedFor() {
  try {
    return sessionStorage.getItem(RELOADED_FOR);
  } catch {
    return null;
  }
}

const offer = (newVersion: boolean) => {
  if (state.newVersion !== newVersion) set({ ...state, newVersion });
};

// A message names the build the server serves. A new one reloads the page once nothing would be lost: the server
// can be reached, no send is held, under way or waiting, no field is focused (a draft or a rename), and no dialog or
// menu is open. Held sends keep their own timers meanwhile, and after 15 s the top bar offers the reload instead.
// The page's own build announced again stands the gate down. A reload for a build that already brought the tab back
// to the entry it runs would do so on every connect (the server reads some other script as the entry), so the top
// bar offers that one at once.
function announced(uiEntry: unknown) {
  if (typeof uiEntry !== 'string' || !uiEntry || import.meta.env.DEV || !entry) return;
  const build = new URL(uiEntry, location.href).href;
  if (build === entry) {
    armedFor = null;
    clearTimeout(checking);
    return offer(false);
  }
  if (build === armedFor) return;
  if (!armedFor) armedAt = Date.now();
  armedFor = build;
  clearTimeout(checking);
  if (reloadedFor() === `${entry} ${build}`) return offer(true);
  check();
}

function check() {
  if (!armedFor) return;
  const free = state.link === 'live' && !sends.items().some(active) && !isEditable(document.activeElement) &&
    !document.querySelector('dialog[open]') && !menuOpen();
  if (free) {
    try {
      sessionStorage.setItem(RELOADED_FOR, `${entry} ${armedFor}`);
    } catch {
      // Without storage nothing stops a mismatch from reloading on every connect.
    }
    return location.reload();
  }
  if (Date.now() - armedAt >= RELOAD_CAP_MS) offer(true);
  checking = setTimeout(check, 250);
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
        announced(uiEntry);
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
