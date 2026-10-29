import { useSyncExternalStore } from 'react';

export type View = 'queue' | 'wall';
export type Tab = 'overview' | 'diff' | 'artifacts' | 'conversation';

export interface Sheet {
  id: string;
  tab: Tab;
  item: string | null;
}

export interface Route {
  view: View;
  sheet: Sheet | null;
}

const TABS: readonly string[] = ['overview', 'diff', 'artifacts', 'conversation'];

const TASK_PATH = /^\/s\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?/;

// What had focus when a task opened over the view, to have it back when the task closes.
let opener: HTMLElement | null = null;
export const openerOfTask = () => opener;

// An open task covers the view, which keeps its own scroll, so neither resets on a route change.
navigation.addEventListener('navigate', (event) => {
  const url = new URL(event.destination.url);
  if (!event.canIntercept || event.hashChange || event.downloadRequest !== null || event.navigationType === 'reload') return;
  if (url.origin !== location.origin || url.pathname.startsWith('/api')) return;
  if (TASK_PATH.test(url.pathname) && !TASK_PATH.test(location.pathname)) {
    opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  }
  event.intercept({ focusReset: 'manual', scroll: 'manual' });
});

const subscribe = (fn: () => void) => {
  navigation.addEventListener('currententrychange', fn);
  return () => navigation.removeEventListener('currententrychange', fn);
};

// A task opened on the board covers the view it was opened from; a task loaded cold covers the queue.
function parse(href: string, state: unknown): Route {
  const { pathname } = new URL(href);
  const match = pathname.match(TASK_PATH);
  if (!match) return { view: pathname === '/wall' ? 'wall' : 'queue', sheet: null };
  const tab = (TABS.includes(match[2]) ? match[2] : 'overview') as Tab;
  const base = (state as { base?: string } | undefined)?.base;
  return { view: base === '/wall' ? 'wall' : 'queue', sheet: { id: match[1], tab, item: match[3] ?? null } };
}

const current = () => parse(navigation.currentEntry?.url ?? location.href, navigation.currentEntry?.getState());

export function useRoute() {
  const entry = useSyncExternalStore(subscribe, () => navigation.currentEntry);
  return parse(entry?.url ?? location.href, entry?.getState());
}

export const viewPath = (view: View) => (view === 'wall' ? '/wall' : '/');

export const sessionPath = (id: string, tab: Tab = 'overview', item?: string | null) => `/s/${id}/${tab}${item ? `/${item}` : ''}`;

// An aborted navigation rejects both promises, which the error toasts would otherwise report.
function settle(result: NavigationResult) {
  result.committed?.catch(() => {});
  result.finished?.catch(() => {});
}

export const go = (path: string, options?: NavigationNavigateOptions) => settle(navigation.navigate(path, options));

export function openSheet(id: string, tab: Tab = 'overview', item?: string | null) {
  const route = current();
  go(sessionPath(id, tab, item), { state: { base: viewPath(route.view) }, history: route.sheet ? 'replace' : 'push' });
}

// Tabs and artifacts replace the entry, so one step back still closes the sheet.
export function showTab(tab: Tab, item?: string | null) {
  const { sheet } = current();
  if (sheet) go(sessionPath(sheet.id, tab, item), { history: 'replace', state: navigation.currentEntry?.getState() });
}

// Stepping back into another document would load the board afresh and lose what the page shows, such as the toast
// that the task is gone.
export function closeSheet() {
  const route = current();
  if (!route.sheet) return;
  const base = viewPath(route.view);
  const entry = navigation.currentEntry;
  const previous = entry && entry.index > 0 ? navigation.entries()[entry.index - 1] : undefined;
  if (previous?.sameDocument && previous.url && new URL(previous.url).pathname === base) settle(navigation.back());
  else go(base, { history: 'replace' });
}

export function closeSheetOf(id: string) {
  if (current().sheet?.id === id) closeSheet();
}

// The open task's page gives way to another task's, in the same history entry.
export function moveSheetOf(id: string, to: string) {
  if (current().sheet?.id === id) openSheet(to);
}

// Closes the sheet onto the queue, also when it was opened over the Wall; Back then goes to the Wall.
export function closeSheetToQueue() {
  if (current().view === 'queue') closeSheet();
  else go(viewPath('queue'), { history: 'replace' });
}

// The queue, from wherever the page is: an open sheet closes onto it, and the Wall goes to it.
export function showQueue() {
  if (current().sheet) closeSheetToQueue();
  else go(viewPath('queue'));
}
