import { useSyncExternalStore } from 'react';

export interface Route {
  sessionId: string | null;
  tab: string;
}

navigation.addEventListener('navigate', (event) => {
  const url = new URL(event.destination.url);
  if (!event.canIntercept || event.hashChange || event.downloadRequest !== null) return;
  if (url.origin !== location.origin || url.pathname.startsWith('/api')) return;
  event.intercept();
});

const subscribe = (fn: () => void) => {
  navigation.addEventListener('currententrychange', fn);
  return () => navigation.removeEventListener('currententrychange', fn);
};

function parse(href: string): Route {
  const match = new URL(href).pathname.match(/^\/s\/([^/]+)(?:\/([^/]+))?/);
  return match ? { sessionId: match[1], tab: match[2] ?? 'details' } : { sessionId: null, tab: '' };
}

export function useRoute() {
  const href = useSyncExternalStore(subscribe, () => navigation.currentEntry?.url ?? location.href);
  return parse(href);
}

export const sessionPath = (id: string, tab = 'details') => `/s/${id}/${tab}`;

export const go = (path: string) => navigation.navigate(path);
