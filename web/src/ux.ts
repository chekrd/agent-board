// How the board is used, to tell what to improve: which screens, keys and controls, what a key press that did nothing
// was, sends and their Undo, cards shown, dialogs, slow responses and errors, each with how busy the board was. Never
// what is typed or what a task says: task names in a control or an error read as `task`, and the server drops
// content fields besides. It stays on this Mac, in state.db's ux_events; `pnpm ux` reports it.

type Data = Record<string, unknown>;

interface UxEvent {
  at: number;
  name: string;
  data?: Data;
}

const page = typeof crypto !== 'undefined' ? crypto.randomUUID() : 'test';
let queued: UxEvent[] = [];

// How busy the board is, which each event carries, and the task names to keep out of what it records.
let board = { tasks: 0, deck: 0 };
let names: string[] = [];

export function setBoard(next: { tasks: number; deck: number; names: string[] }) {
  board = { tasks: next.tasks, deck: next.deck };
  names = next.names.filter((n) => n.length >= 3);
}

export const redact = (text: string, known = names) => known.toSorted((a, b) => b.length - a.length).reduce((t, n) => t.replaceAll(n, 'task'), text);

export function track(name: string, data?: Data) {
  const event: UxEvent = { at: Date.now(), name, data: { ...data, board } };
  queued.push(event);
  if (queued.length >= 50) flush();
  return event;
}

// The keepalive budget is shared with the sends that go out as the page goes away, so only a small batch takes it.
function flush({ leaving = false } = {}) {
  if (!queued.length || typeof fetch === 'undefined') return;
  const body = JSON.stringify({ page, events: queued });
  queued = [];
  fetch('/api/ux', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: leaving && body.length < 4000 }).catch(() => {});
}

// A control as the report names it: its label, else its text, with numbers folded so `5h 34%` and `5h 61%` count as
// one, and an option counted as such rather than by what Claude wrote in it.
export function controlName(el: Element) {
  if (el.closest('[data-option]')) return 'option';
  const named = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '';
  const name = redact(named.replace(/\s+/g, ' ').trim()).replace(/\d+/g, '#');
  return name ? name.slice(0, 40) : el.tagName.toLowerCase();
}

export const screenOf = (pathname: string) => {
  const task = /^\/s\/[^/]+(?:\/([^/]+))?/.exec(pathname);
  if (task) return `task/${task[1] ?? 'overview'}`;
  return pathname === '/wall' ? 'wall' : 'queue';
};

function areaOf(el: Element) {
  if (el.closest('[data-toast]')) return 'toast';
  const dialog = el.closest('dialog[id]');
  const base = dialog?.id === 'task-sheet' ? screenOf(location.pathname)
    : dialog ? dialog.id
      : el.closest('[popover]') ? 'popover'
        : el.closest('.views') ? (document.documentElement.dataset.view ?? 'view') : 'topbar';
  const kind = el.closest<HTMLElement>('[data-kind]')?.dataset.kind;
  return kind ? `${base}/${kind}` : base;
}

const CONTROL = 'button, a[href], summary, select, [role="tab"], [role="option"], [role="menuitem"], input[type="checkbox"], input[type="radio"]';

// Time on each screen while the page is in sight, told when it is left.
let screen = '';
let since = 0;

function leave() {
  if (screen && since) track('screen', { screen, ms: Date.now() - since });
  since = 0;
}

function enter(next: string) {
  if (next === screen) return;
  leave();
  screen = next;
  if (document.visibilityState === 'visible') since = Date.now();
}

if (typeof window !== 'undefined') {
  track('load', { width: innerWidth, height: innerHeight, screen: screenOf(location.pathname) });
  enter(screenOf(location.pathname));
  navigation.addEventListener('currententrychange', () => enter(screenOf(location.pathname)));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      since = Date.now();
      return;
    }
    leave();
    flush();
  });
  addEventListener('pagehide', () => {
    leave();
    flush({ leaving: true });
  });
  addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest(CONTROL) : null;
    if (!el) return;
    track('click', { control: controlName(el), area: areaOf(el), via: e.detail === 0 ? 'keyboard' : 'pointer' });
  }, true);
  setInterval(flush, 15_000);

  const opened = new Map<Element, number>();
  const watchDialogs = () => new MutationObserver((records) => {
    for (const r of records) {
      const d = r.target as HTMLDialogElement;
      if (!(d instanceof HTMLDialogElement) || !d.id) continue;
      if (d.open && !opened.has(d)) {
        opened.set(d, Date.now());
        track('dialog-open', { dialog: d.id, screen });
      } else if (!d.open && opened.has(d)) {
        track('dialog-close', { dialog: d.id, ms: Date.now() - opened.get(d)! });
        opened.delete(d);
      }
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  if (document.body) watchDialogs();
  else addEventListener('DOMContentLoaded', watchDialogs);

  // Slow responses to a click or key (INP's measure: input to the next paint) and the main thread held up.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[]) {
        if (e.duration < 200 || !e.interactionId) continue;
        const el = e.target instanceof Element ? (e.target.closest(CONTROL) ?? e.target) : null;
        track('slow', { event: e.name, ms: Math.round(e.duration), control: el ? controlName(el) : null, screen });
      }
    }).observe({ type: 'event', durationThreshold: 200, buffered: true } as PerformanceObserverInit);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= 200) track('freeze', { ms: Math.round(e.duration), screen });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // A browser without these entry types records neither.
  }
  const crash = (error: unknown, where: string | null) =>
    track('crash', { error: redact(String(error instanceof Error ? `${error.name}: ${error.message}` : error)).slice(0, 160), where, screen });
  addEventListener('error', (e) => crash(e.error ?? e.message, e.filename ? `${e.filename.split('/').at(-1)}:${e.lineno}` : null));
  addEventListener('unhandledrejection', (e) => crash(e.reason, null));
}
