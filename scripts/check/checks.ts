import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { decisionKey } from '../../server/decision.ts';
import { KEYS } from '../../web/src/keys.ts';
import { sleep, until, type Look, type Page } from './cdp.ts';
import { startMock, type Entry, type Mock } from './mock.ts';

const BUILD = join(import.meta.dirname, '..', '..', 'web', 'dist');

export interface Context {
  page: Page;
  mock: Mock;
  look: Look;
  // Saves a screenshot when the run collects them (--shots).
  shot: (name: string) => Promise<void>;
}

export interface Check {
  name: string;
  // Runs in the narrow window (390×844) instead of the wide ones.
  narrow?: boolean;
  // Runs with this motion preference in every look.
  motion?: Look['motion'];
  scenario?: string;
  // Console errors the check provokes on purpose.
  expectedErrors?: RegExp[];
  run: (t: Context) => Promise<void>;
}

const logged = (mock: Mock, what: string, match: (e: Entry) => boolean, timeout = 5000) =>
  until(`${what} in the mock's log`, async () => {
    const found = (await mock.log()).filter((e) => match(e) && e.status !== null);
    return found.length ? found : null;
  }, timeout);

// A mock of its own over a copy of the build. `build()` writes a new build there, an index.html that names a copy of
// the entry script, and returns that script.
async function withOwnBuild(run: (own: Mock, build: () => string) => Promise<void>) {
  const dist = mkdtempSync(join(tmpdir(), 'agent-board-dist-'));
  let own: Mock | undefined;
  try {
    cpSync(BUILD, dist, { recursive: true });
    own = await startMock({ dist });
    await run(own, () => {
      const html = readFileSync(join(dist, 'index.html'), 'utf8');
      const entry = html.match(/src="([^"]+\.js)"/)![1];
      const next = entry.replace(/\.js$/, '-next.js');
      copyFileSync(join(dist, entry), join(dist, next));
      writeFileSync(join(dist, 'index.html'), html.replace(entry, next));
      return next;
    });
  } finally {
    await own?.stop();
    rmSync(dist, { recursive: true, force: true });
  }
}

// Every load and reload of the page requests its document again.
const loads = (page: Page, url: string) => page.requests.filter((u) => u === url).length;

// Page functions: they run in the browser, so they use only their arguments.

// The connection pill: its state, its text, and whether its dot is green (live) or warm (reconnecting).
const connection = () => {
  const pill = document.querySelector<HTMLElement>('[data-link]');
  const dot = pill?.firstElementChild;
  const [r, g] = (dot ? getComputedStyle(dot).backgroundColor.match(/\d+/g) ?? [] : []).map(Number);
  return { link: pill?.dataset.link ?? null, text: pill?.innerText.trim() ?? null, warm: r > g, green: g > r };
};

// What scrolls sideways, but for code and the agents dock, which does so by design in a narrow window.
const sidewaysScroll = () => {
  const wide = (el: Element) => el.scrollWidth > el.clientWidth + 1;
  const out = wide(document.scrollingElement!) ? ['the page'] : [];
  for (const el of document.querySelectorAll('body *')) {
    const { overflowX } = getComputedStyle(el);
    if ((overflowX === 'auto' || overflowX === 'scroll') && wide(el) && !el.closest('pre, code, textarea, [data-dock]')) {
      out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
    }
  }
  return out;
};

const reachable = (selector: string, text: string) => {
  const el = [...document.querySelectorAll(selector)].find((e) => (e.textContent ?? '').includes(text));
  if (!el) return false;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  // Layout positions are fractional and scroll offsets whole pixels, so an element scrolled into view can stick out by less than one.
  return r.width > 0 && r.left > -1 && r.top > -1 && r.right < innerWidth + 1 && r.bottom < innerHeight + 1;
};

const edgeLine = (end: 'top' | 'bottom', line: number) => {
  const list = document.querySelector('section[data-file]')?.parentElement;
  if (!list) return false;
  list.scrollTop = end === 'top' ? 0 : list.scrollHeight;
  const pre = list.querySelector('diffs-container')?.shadowRoot?.querySelector('pre');
  const numbers = [...(pre?.querySelectorAll('[data-column-number]') ?? [])].map((l) => Number(l.getAttribute('data-column-number')));
  return numbers.length > 0 && (end === 'top' ? Math.min(...numbers) : Math.max(...numbers)) === line;
};

const luminance = (rgb: string) => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).map((c) => Number(c) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// What a check leaves on the page's window: a marker a reload would drop, and the messages of a socket of its own.
interface Probe {
  e2eMarker?: boolean;
  e2eMessages: { uiEntry?: string | null; sessions: { title: string | null }[] }[];
}

// The first message the check's socket got, or the first that shows `title`.
const received = (title: string | null) => {
  const m = (window as unknown as Probe).e2eMessages?.find((m) => title === null || m.sessions.some((s) => s.title === title));
  return m && { carries: 'uiEntry' in m, uiEntry: m.uiEntry ?? null };
};

// Whether the check's socket got a message that shows `title` and names `entry`.
const named = (entry: string, title: string) =>
  !!(window as unknown as Probe).e2eMessages?.some((m) => m.uiEntry === entry && m.sessions.some((s) => s.title === title));

const navigation = () => ({
  marker: (window as unknown as Probe).e2eMarker ?? null,
  type: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type ?? null,
  entry: document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null,
});

// Sets the marker and opens the check's socket; returns the page's entry script.
const listen = () => {
  const w = window as unknown as Probe;
  w.e2eMarker = true;
  w.e2eMessages = [];
  new WebSocket(`ws://${location.host}/ws/events`).onmessage = (e) => w.e2eMessages.push(JSON.parse(e.data));
  return document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null;
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.json': 'application/json',
};

// The build with no board behind it: the page loads, and its socket never opens, so no snapshot ever arrives.
async function withoutBoard(run: (url: string) => Promise<void>) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://board').pathname;
    if (path === '/favicon.ico') return void res.writeHead(204).end();
    const file = extname(path) ? join(BUILD, path) : join(BUILD, 'index.html');
    const body = file.startsWith(BUILD) ? await readFile(file).catch(() => null) : null;
    res.writeHead(body ? 200 : 404, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
}

const tiles = () => document.querySelectorAll('[data-tile]').length > 0;

const sheetOpen = () => !!document.querySelector('#task-sheet:modal');

// No transition is running, as when a sheet or dialog has finished sliding in.
const settled = () => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState === 'finished');

async function openFromWall(page: Page, mock: Mock, id: string) {
  await page.goto(`${mock.url}/wall`);
  await page.until('the tiles', tiles);
  await page.click(`[data-tile][data-session="${id}"] a`);
  await page.until(`the sheet of ${id}`, sheetOpen);
}

// A task waiting in the queue, whose tile goes to its card instead.
async function openSheetOf(page: Page, mock: Mock, id: string) {
  await page.goto(`${mock.url}/s/${id}/overview`);
  await page.until(`the sheet of ${id}`, sheetOpen);
}

// The labels of the open ⋯ menu.
const menuItems = () => {
  const menu = document.querySelector(':popover-open');
  return menu && [...menu.querySelectorAll('button')].map((b) => b.firstElementChild?.textContent);
};

// A frame of the board's own page at another width, which draws what a window that wide would.
const frame = (path: string, width: number, height: number) =>
  new Promise<void>((done) => {
    document.getElementById('e2e-frame')?.remove();
    const f = document.createElement('iframe');
    f.id = 'e2e-frame';
    f.src = path;
    f.style.cssText = `position: fixed; inset: 0 auto auto 0; width: ${width}px; height: ${height}px; border: 0; z-index: 9999; background: Canvas`;
    f.onload = () => done();
    document.body.append(f);
  });

// The meter in the page, or in the frame: whether it meets the wordmark or Repos, its segments' widths, its bars, the
// text it carries for screen readers and the text it shows.
const meterIn = (inFrame: boolean) => {
  const doc = inFrame ? (document.getElementById('e2e-frame') as HTMLIFrameElement).contentDocument! : document;
  const box = (el: Element | null) => el?.getBoundingClientRect() ?? null;
  const meets = (a: DOMRect | null, b: DOMRect | null) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const wordmark = box(doc.querySelector('[data-wordmark]'));
  const repos = box(doc.querySelector('[data-repos]'));
  const parts = [box(doc.querySelector('[data-meter]')), box(doc.querySelector('[data-meter] [role="group"]'))];
  return {
    overlap: parts.some((m) => meets(m, wordmark) || meets(m, repos)),
    segments: [...doc.querySelectorAll('[data-segment]')].map((s) => Math.round(s.getBoundingClientRect().width * 10) / 10),
    bars: [...doc.querySelectorAll('[data-bar]')].map((b) => b.textContent),
    label: doc.querySelector('[data-meter] [role="group"]')?.getAttribute('aria-label') ?? null,
    shown: (doc.querySelector('[data-meter]') as HTMLElement | null)?.innerText.trim() ?? null,
    justIn: [...doc.querySelectorAll<HTMLElement>('[data-justin]')].map((j) => j.innerText.trim()),
  };
};

// The toasts of a kind: what each shows, whether it sits inside the open sheet, and whether a point in its middle hits
// it; null while there is none.
const toastsOf = (kind: string) => {
  const shown = [...document.querySelectorAll<HTMLElement>(`[data-toast][data-kind="${kind}"]`)].map((t) => {
    const r = t.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { kind: t.dataset.kind, text: t.innerText.trim(), inSheet: !!t.closest('#task-sheet'), hit: !!hit && t.contains(hit) };
  });
  return shown.length ? shown : null;
};

// One file of the diff on its own, whole, with the way back to all files.
const wholeFile = (path: string) =>
  document.querySelector('[data-theme="dark"] code')?.textContent === path && document.querySelectorAll('section[data-file]').length === 1 &&
  !!document.querySelector('[data-theme="dark"] > div')?.textContent?.includes('← All files');

// The connection pill once it reads `link` and, while reconnecting, says since when.
const pillAt = (link: string) => {
  const p = document.querySelector<HTMLElement>('[data-link]');
  if (p?.dataset.link !== link || (link === 'reconnecting' && !p.title)) return null;
  return { link: p.dataset.link, text: p.innerText.trim(), title: p.title, breathing: getComputedStyle(p.firstElementChild!).animationName };
};

// The reload pill and what the page has: the marker a reload would drop, the link, and the New task prompt. With
// `until` set, null until the pill shows or the board reconnects.
const reloadState = (until: 'pill' | 'reconnecting' | null) => {
  const state = {
    pill: document.querySelector<HTMLElement>('[data-new-version]')?.innerText.trim() ?? null,
    link: document.querySelector<HTMLElement>('[data-link]')?.dataset.link ?? null,
    marker: (window as unknown as Probe).e2eMarker ?? null,
    prompt: document.querySelector<HTMLTextAreaElement>('#new-task-inline textarea')?.value ?? null,
    typing: document.activeElement === document.querySelector('#new-task-inline textarea'),
  };
  return (until === 'pill' && !state.pill) || (until === 'reconnecting' && state.link !== 'reconnecting') ? null : state;
};

// The queue's card: whose it is, its kind and key, its name for screen readers, the text of its header and of the
// whole card, and what its primary says and whether the guard holds it.
const card = () => {
  const c = document.querySelector<HTMLElement>('[data-card]');
  if (!c) return null;
  const primary = c.querySelector<HTMLElement>('[data-primary]');
  return {
    session: c.dataset.session ?? null,
    kind: c.dataset.kind ?? null,
    key: c.dataset.key ?? null,
    label: c.getAttribute('aria-label'),
    header: c.querySelector('header')?.innerText ?? '',
    text: c.innerText,
    primary: primary?.firstElementChild?.textContent ?? null,
    disabled: primary?.matches(':disabled') ?? null,
    guarded: primary?.hasAttribute('data-guarded') ?? null,
  };
};

// `id` is the card and no deal is moving it.
const frontIs = (id: string) => document.querySelector<HTMLElement>('[data-card]')?.dataset.session === id && !document.documentElement.dataset.deal;

// No card is being dealt, and every animation that ends has ended.
const still = () => !document.documentElement.dataset.deal &&
  document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity);

// The element shows whole: inside the window and inside every box around it that clips.
const whole = (selector: string) => {
  const el = document.querySelector(selector);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || r.top < -1 || r.left < -1 || r.bottom > innerHeight + 1 || r.right > innerWidth + 1) return false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(p);
    if (overflowX === 'visible' && overflowY === 'visible') continue;
    const b = p.getBoundingClientRect();
    if (r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.right > b.right + 1) return false;
  }
  return true;
};

// The peeks behind the card, each with its place, session and text.
const peeks = () => [...document.querySelectorAll<HTMLElement>('[data-peek]')].map((p) => ({ peek: p.dataset.peek, session: p.dataset.session, text: p.innerText.trim() }));

const segmentsNow = () => [...document.querySelectorAll<HTMLElement>('[data-segment]')].map((s) => ({
  session: s.dataset.session, current: s.hasAttribute('data-current'), new: s.hasAttribute('data-new'), width: Math.round(s.getBoundingClientRect().width),
}));

async function openQueue(page: Page, mock: Mock, front = 's-cart') {
  await page.goto(`${mock.url}/`);
  await page.until(`the card of ${front}`, frontIs, front);
}

// A held send goes out 5 s after the press.
const HELD_MS = 5500;
const POSTED_MS = 8000;

// The session actions the mock has answered, the page's reads left out.
const actions = async (mock: Mock) => (await mock.log()).filter((e) => e.method === 'POST' && e.action !== null && e.status !== null);

const stateOf = async (mock: Mock, id: string) => (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === id);

const unguarded = () => !document.querySelector('[data-primary][data-guarded]');

// `id` is the card, and the guard that came with it is over, so an answer key counts.
async function ready(page: Page, id: string) {
  await page.until(`the card of ${id}`, frontIs, id);
  await page.until('the guard to end', unguarded);
}

// Records every deal the page runs from now on.
const watchDeals = () => {
  const w = window as unknown as { e2eDeals: string[] };
  w.e2eDeals = [];
  let last: string | undefined;
  new MutationObserver(() => {
    const deal = document.documentElement.dataset.deal;
    if (deal && deal !== last) w.e2eDeals.push(deal);
    last = deal;
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-deal'] });
};
const dealt = () => (window as unknown as { e2eDeals?: string[] }).e2eDeals ?? [];

// Pastes a one-pixel PNG into the reply box, as a screenshot from the clipboard comes.
const pastePng = (selector: string) => {
  const field = document.querySelector<HTMLTextAreaElement>(selector)!;
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const data = new DataTransfer();
  data.items.add(new File([png], 'shot.png', { type: 'image/png' }));
  field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
};

// The reply box in `scope`: its text, each attachment as "<state> <name>", and whether it has focus.
const replyIn = (scope: string) => {
  const field = document.querySelector<HTMLTextAreaElement>(`${scope} textarea`);
  const box = field?.closest('section');
  return field && box ? {
    value: field.value,
    files: [...box.querySelectorAll<HTMLElement>('[data-state]')].map((f) => `${f.dataset.state} ${f.querySelector('button')?.getAttribute('aria-label')?.replace(/^Remove /, '')}`),
    focused: document.activeElement === field,
  } : null;
};

// Pressing a key on the card from a script, as auto-repeat or a fast double press would.
const pressEnter = (gaps: number[], repeat = false) =>
  new Promise<void>((done) => {
    const press = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', repeat, bubbles: true, cancelable: true }));
    press();
    let at = 0;
    for (const gap of gaps) setTimeout(press, (at += gap));
    setTimeout(done, at + 50);
  });

// The agents dock as drawn: its label and count, the ended pill, the box of the capsules' grid and how far it scrolls,
// and each capsule with its state, name, second line (in a mono font or not), clock, PR dot (its animation), Worth-
// knowing dot and boxes; null while there is no dock.
const dockState = () => {
  const dock = document.querySelector<HTMLElement>('[data-dock]');
  if (!dock) return null;
  const box = (el: Element | null | undefined) => {
    const r = el?.getBoundingClientRect();
    return r ? { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: r.width, height: r.height } : null;
  };
  const grid = dock.querySelector('[data-capsule]')?.parentElement;
  const ended = dock.querySelector<HTMLAnchorElement>('a[href="/wall"]');
  return {
    label: dock.getAttribute('aria-label'),
    count: (dock.firstElementChild as HTMLElement).innerText,
    ended: ended && { text: ended.innerText.trim(), title: ended.title },
    box: box(dock),
    grid: grid && { box: box(grid), scrollHeight: grid.scrollHeight, clientHeight: grid.clientHeight },
    capsules: [...dock.querySelectorAll<HTMLElement>('[data-capsule]')].map((c) => {
      const name = c.querySelector('button strong');
      const line = name?.parentElement?.nextElementSibling;
      const pr = c.querySelector('button [data-pr]');
      return {
        session: c.dataset.session!,
        state: c.dataset.state,
        name: name?.textContent,
        line: line?.textContent,
        mono: !!line && getComputedStyle(line).fontFamily.includes('monospace'),
        clock: c.querySelector('[data-clock]')?.textContent ?? null,
        pr: pr && getComputedStyle(pr).animationName,
        know: !!c.querySelector('button [data-know]'),
        box: box(c),
        nameBox: box(name),
        lineBox: box(line),
      };
    }),
  };
};

// A capsule's hover card while it is open: its popover type, what it says, its box and its capsule's.
const hoverCard = (id: string) => {
  const capsule = document.querySelector(`[data-capsule][data-session="${id}"]`);
  const card = capsule?.querySelector<HTMLElement>('[data-hovercard]');
  if (!capsule || !card?.matches(':popover-open')) return null;
  const r = card.getBoundingClientRect();
  const c = capsule.querySelector('button')!.getBoundingClientRect();
  return {
    popover: card.popover,
    text: card.innerText,
    box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    capsule: { left: c.left, right: c.right, top: c.top },
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
  };
};

// The sessions whose hover card is open.
const openCards = () => [...document.querySelectorAll('[data-hovercard]:popover-open')].map((c) => c.closest<HTMLElement>('[data-capsule]')?.dataset.session);

const docked = (n: number) => document.querySelectorAll('[data-dock] [data-capsule]').length === n;

// The card's primary shows whole in the window at the top of the page's scroll and at its bottom, and whether the page
// scrolls at all, which the second needs to mean anything.
const primaryAtEnds = () => {
  const page = document.scrollingElement!;
  const inView = () => {
    const r = document.querySelector('[data-primary]')!.getBoundingClientRect();
    return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  };
  page.scrollTop = 0;
  const top = inView();
  page.scrollTop = page.scrollHeight;
  const bottom = inView();
  const scrolls = page.scrollTop > 0;
  page.scrollTop = 0;
  return { top, bottom, scrolls };
};

// The card in a narrow window: whether its columns, or a menu's questions, stand one under the other, which peeks
// and slivers show, and how many rows the footer's buttons take.
const narrowCard = () => {
  const c = document.querySelector('[data-card]')!;
  const stacked = (els: Element[]) => {
    const rs = els.map((e) => e.getBoundingClientRect());
    return rs.every((r, i) => i === 0 || (Math.abs(r.left - rs[0].left) < 1 && r.top >= rs[i - 1].bottom - 1));
  };
  const shown = (el: Element | null) => !!el?.checkVisibility();
  return {
    stacked: stacked([...c.querySelectorAll('[data-side]')]) && stacked([...c.querySelectorAll('section[role="group"]')]),
    peeks: [...document.querySelectorAll<HTMLElement>('[data-peek]')].filter(shown).map((p) => p.dataset.peek),
    sliver: shown(document.querySelector('[data-sliver]')),
    footRows: new Set([...c.querySelectorAll('footer button')].filter(shown).map((b) => Math.round(b.getBoundingClientRect().top))).size,
  };
};

// Starts noting every animation the page runs, with when it ends after it starts; `animations()` stops and returns them.
const noteAnimations = () => {
  const w = window as unknown as { e2eAnimations: Map<Animation, string>; e2eNoting: boolean };
  w.e2eAnimations = new Map();
  w.e2eNoting = true;
  const tick = () => {
    for (const a of document.getAnimations()) {
      const name = a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? `transition of ${a.transitionProperty}` : 'animation';
      const target = (a.effect as KeyframeEffect | null)?.target;
      const where = target ? `${target.tagName.toLowerCase()}${(a.effect as KeyframeEffect).pseudoElement ?? ''}` : '';
      w.e2eAnimations.set(a, `${name} on ${where}: ${Math.round(Number(a.effect?.getComputedTiming().endTime) * 100) / 100} ms`);
    }
    if (w.e2eNoting) requestAnimationFrame(tick);
  };
  tick();
};
const animations = () => {
  const w = window as unknown as { e2eAnimations: Map<Animation, string>; e2eNoting: boolean };
  w.e2eNoting = false;
  return [...w.e2eAnimations.entries()].map(([a, text]) => ({ text, end: Number(a.effect?.getComputedTiming().endTime) }));
};

export const checks: Check[] = [
  {
    name: 'P0.2 board: 11 tiles, Archived (1) collapsed, title (3); an option on the card answers once and the tile turns working',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      const board = await page.eval(() => ({
        tiles: [...document.querySelectorAll('[data-tile]')].filter((t) => !t.closest('details')).length,
        archived: document.querySelector('details > summary')?.textContent,
        open: document.querySelector('details')?.open,
        title: document.title,
      }));
      assert.deepEqual(board, { tiles: 11, archived: 'Archived (1)', open: false, title: '(3) Agent Board' });
      await shot('board');

      await openQueue(page, mock);
      await ready(page, 's-cart');
      await shot('task-ask');
      await page.click('[data-card] [data-option]', 'Keep the account cart');
      const answers = await logged(mock, 'the answer', (e) => e.action === 'answer', POSTED_MS);
      assert.equal(answers.length, 1);
      const [a] = answers;
      assert.deepEqual([a.sessionId, a.body.key, a.body.choice, a.status], ['s-cart', 'q:toolu_01Cart', 'Keep the account cart', 204]);

      await page.goto(`${mock.url}/wall`);
      await page.until('the s-cart tile to turn working', () => document.querySelector('[data-tile][data-session="s-cart"]')?.getAttribute('data-attention') === 'working');
      assert.equal((await mock.log()).filter((e) => e.action === 'answer').length, 1);
      assert.equal(await page.eval(() => document.title), '(2) Agent Board');
      await shot('board-answered');
    },
  },
  {
    name: 'P0.3 a refused answer (/mock/fail, stale) says why in a toast: Not sent to Retry failed webhooks: this question is no longer open',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      await mock.post('/mock/fail', { error: 'this question is no longer open', code: 'stale' });
      await openQueue(page, mock);
      await page.key('ArrowRight');
      await ready(page, 's-hooks');
      await page.key('6');
      await page.until('Disable the endpoint unpicked', () => document.querySelector('[data-card] [data-option="6"]')?.getAttribute('aria-pressed') === 'false');
      await shot('task-menu');
      await page.click('[data-card] [data-primary]');
      const toast = await until('the error toast', () => page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-toast][data-kind="error"]')].map((t) => t.innerText.trim()).join('\n')), POSTED_MS);
      assert.equal(toast, 'Not sent to Retry failed webhooks: this question is no longer open\nShow');
      const [sent] = await logged(mock, 'the menu answer', (e) => e.action === 'answer-menu');
      assert.deepEqual([sent.sessionId, sent.status, sent.code, sent.body.toolUseId], ['s-hooks', 400, 'stale', 'toolu_01Hooks']);
      assert.deepEqual(sent.body.answers, [{ labels: ['Exponential, 5 tries'], other: '' }, { labels: ['Email the account owner'], other: '' }]);
      await shot('toast-refused');
    },
  },
  {
    name: 'P0.4 diff: the fixture patch (12 files from ff30c77) renders split and dark; a file in the tree opens whole',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-cart/diff`);
      const files = await page.until('the file tree', () => document.querySelectorAll('nav[aria-label="Changed files"] a').length);
      assert.equal(files, 12);
      // An added file has no old side to show, so "split" means every modified file shows both.
      const layout = await page.until('every file rendered', () => {
        const rendered = [...document.querySelectorAll('section[data-file]')].map((s) => ({
          file: s.getAttribute('data-file'),
          type: s.querySelector('diffs-container')?.shadowRoot?.querySelector('pre[data-diff-type]')?.getAttribute('data-diff-type'),
        }));
        const modified = [...document.querySelectorAll('nav[aria-label="Changed files"] a:has([data-type="change"])')].map((a) => a.getAttribute('title'));
        return rendered.length === 12 && rendered.every((r) => r.type) && { modified: modified.toSorted(), split: rendered.filter((r) => r.type === 'split').map((r) => r.file).toSorted() };
      });
      const view = await page.eval(() => ({
        toolbar: document.querySelector('[data-theme="dark"] > div')?.textContent ?? '',
        background: getComputedStyle(document.querySelector('[data-theme="dark"]')!).backgroundColor,
      }));
      assert.match(view.toolbar, /12 files · \+368 −55 against origin\/main/);
      assert.ok(luminance(view.background) < 0.05, `the diff background ${view.background} is not dark`);
      assert.equal(layout.modified.length, 7);
      assert.deepEqual(layout.split, layout.modified);
      await shot('diff');

      await page.click('nav[aria-label="Changed files"] a[title="server/git.ts"]');
      await page.until('server/git.ts alone, as a whole file', () =>
        document.querySelector('[data-theme="dark"] code')?.textContent === 'server/git.ts' && document.querySelectorAll('section[data-file]').length === 1 &&
        !!document.querySelector('[data-theme="dark"] > div')?.textContent?.includes('← All files'));
      await page.until('its first change in view', () => !!document.querySelector('section[data-file] diffs-container')?.shadowRoot?.querySelector('[data-line-type^="change-"]'));
      await shot('diff-whole-file');
      // The file opens at its first change and renders only the lines near the viewport, so look at both ends.
      await page.until('line 1 at the top of server/git.ts', edgeLine, 'top', 1);
      await page.until('line 181 at the bottom of server/git.ts', edgeLine, 'bottom', 181);
      assert.equal(await page.eval(() => document.querySelector('section[data-file] diffs-container')?.shadowRoot?.querySelector('pre')?.getAttribute('data-diff-type')), 'split');
      const [file] = await logged(mock, 'the whole-file request', (e) => e.path === '/api/diff/file');
      assert.equal(new URLSearchParams(file.query).get('path'), 'server/git.ts');
    },
  },
  {
    name: 'P0.5 a dropped connection (/mock/drop 3 s): the pill turns Reconnecting… with a warm dot, then Live with a green one',
    expectedErrors: [/WebSocket/, /ERR_CONNECTION/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the live pill', () => document.querySelector('[data-link="live"]') !== null);
      assert.deepEqual(await page.eval(connection), { link: 'live', text: 'Live', warm: false, green: true });
      const start = Date.now();
      await mock.post('/mock/drop', { ms: 3000 });
      await page.until('the pill to turn reconnecting', () => document.querySelector('[data-link="reconnecting"]') !== null);
      const down = Date.now() - start;
      assert.deepEqual(await page.eval(connection), { link: 'reconnecting', text: 'Reconnecting…', warm: true, green: false });
      await shot('connection-dropped');
      await until('the pill to turn live again', () => page.eval(() => document.querySelector('[data-link="live"]') !== null), 10_000);
      const back = Date.now() - start;
      assert.ok(down < 1500, `reconnecting after ${down} ms`);
      assert.ok(back >= 3000, `live after ${back} ms, inside the drop`);
      assert.deepEqual(await page.eval(connection), { link: 'live', text: 'Live', warm: false, green: true });
      await shot('connection-back');
    },
  },
  {
    name: 'P0 narrow smoke: no sideways scroll on the board or in the sheet; New task and the way from the sheet to the card stay reachable',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.until('New task in reach', reachable, 'button', 'New task');
      await shot('narrow-board');
      await page.goto(`${mock.url}/s/s-cart/details`);
      await page.until('the queue box', () => !!document.querySelector('#task-sheet [data-queued]'));
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      // The sheet slides up as it opens.
      await page.until('Answer it on its card in reach', reachable, '#task-sheet [data-queued] button', 'Answer it on its card');
      await shot('narrow-task');
    },
  },
  {
    name: 'P2.1 fonts: Bricolage Grotesque and Hanken Grotesk come with the app, and the page asks no host but 127.0.0.1',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      const fonts = await page.eval(async () => {
        await new Promise(requestAnimationFrame);
        await document.fonts.ready;
        return {
          display: document.fonts.check('600 38px "Bricolage Grotesque Variable"'),
          text: document.fonts.check('15px "Hanken Grotesk Variable"'),
          loaded: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', '')))].toSorted(),
        };
      });
      // check() is true for a family that nothing declares, too; only the loaded faces show the fonts arrived.
      assert.deepEqual(fonts, { display: true, text: true, loaded: ['Bricolage Grotesque Variable', 'Hanken Grotesk Variable'] });
      const files = page.requests.filter((url) => url.endsWith('.woff2')).map((url) => new URL(url).pathname.split('/').at(-1)!.replace(/-[\w-]{8}\.woff2$/, ''));
      assert.deepEqual(files.toSorted(), ['bricolage-grotesque-latin-opsz-normal', 'hanken-grotesk-latin-wght-normal']);
      const outside = page.requests.filter((url) => !/^(data|blob):/.test(url) && new URL(url).hostname !== '127.0.0.1');
      assert.deepEqual(outside, []);
    },
  },
  {
    name: "P2.2 the page background is C's ground: #110f0c in dark, #eeeae1 in light",
    async run({ page, mock, look, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      const background = await page.eval(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
      assert.deepEqual(background, ['rgba(0, 0, 0, 0)', look.scheme === 'dark' ? 'rgb(17, 15, 12)' : 'rgb(238, 234, 225)']);
      await shot('board');
    },
  },
  {
    name: 'P2.3 the Diff tab stays dark in the light theme too, and the older token names resolve dark inside it',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-cart/diff`);
      await page.until('the file tree', () => document.querySelectorAll('nav[aria-label="Changed files"] a').length === 12);
      const view = await page.eval(() => {
        const { backgroundColor, color } = getComputedStyle(document.querySelector('[data-theme="dark"]')!);
        return { backgroundColor, color };
      });
      assert.ok(luminance(view.backgroundColor) < 0.05, `the diff background ${view.backgroundColor} is not dark`);
      assert.ok(luminance(view.color) > 0.5, `the diff text ${view.color} is not light`);
      await shot('diff');
    },
  },
  {
    name: 'P2.4 no console errors on the board, a decision, a menu, a reply with a table, the diff or an artifact',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      await openQueue(page, mock);
      await page.until('the options', () => document.querySelectorAll('[data-card] [data-option]').length === 3);
      await shot('task-ask');
      await page.key('ArrowRight');
      await page.until('the menu with its 2 questions', () => document.querySelectorAll('[data-card] section[role="group"]').length === 2);
      await shot('task-menu');
      await page.goto(`${mock.url}/s/s-reviews/details`);
      await page.until('the latest reply with its table', () => document.querySelector('section table') !== null);
      await shot('task-reply');
      await page.goto(`${mock.url}/s/s-cart/diff`);
      await page.until('every file rendered', () => [...document.querySelectorAll('section[data-file] diffs-container')].filter((d) => d.shadowRoot?.querySelector('pre')).length === 12);
      await page.goto(`${mock.url}/s/s-cart/artifacts`);
      await page.until('the artifact', () => document.querySelector('iframe') !== null);
      await shot('artifact');
      assert.deepEqual(page.errors, []);
    },
  },
  {
    name: 'P1a.mock-contract two answers at once to one end-of-turn decision: one 204 and one 400 answered (two 204s with --legacy), both in /mock/log',
    expectedErrors: [/status of 400/],
    async run({ page, mock }) {
      const { legacy } = await mock.get('/mock');
      const group = async () => (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === 's-group');
      const { summary } = await group();
      const body = { key: `s:${summary.basis}`, choice: summary.decision.options[0].label };
      // Not the board: today's UI throws when the double send of --legacy reorders it twice at once.
      await page.goto(`${mock.url}/mock`);
      const replies = await page.eval(async (body) => {
        const post = async () => {
          const res = await fetch('/api/sessions/s-group/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          return { status: res.status, body: res.status === 204 ? null : await res.json() };
        };
        return Promise.all([post(), post()]);
      }, body);
      const second = legacy ? { status: 204, body: null } : { status: 400, body: { error: 'you already answered this', code: 'answered' } };
      assert.deepEqual(replies.toSorted((a, b) => a.status - b.status), [{ status: 204, body: null }, second]);
      const entries = await logged(mock, 'both answers', (e) => e.action === 'answer' && e.sessionId === 's-group');
      assert.deepEqual(entries.toSorted((a, b) => a.status! - b.status!).map((e) => [e.status, e.code, e.body]), [
        [204, null, body],
        [second.status, second.body?.code ?? null, body],
      ]);
      const after = await group();
      if (legacy) assert.equal('answered' in after, false);
      else assert.deepEqual([after.answered.key, after.answered.text], [body.key, body.choice]);
      await until('s-group to start on the answer, with no step yet', async () => {
        const s = await group();
        return s.status === 'working' && s.activity.step === (legacy ? 'Thinking' : null);
      });
    },
  },
  {
    name: 'P1a.compat-accept the card accepts the second opinion on a question and on a menu; the snapshot names what was sent',
    async run({ page, mock, shot }) {
      const { legacy } = await mock.get('/mock');
      const sessionOf = async (id: string) => (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === id);
      for (const [id, key, text, action] of [
        ['s-cart', 'q:toolu_01Cart', 'Merge both carts. Cap each line at available stock and show a toast listing anything trimmed.', 'accept-advice'],
        ['s-hooks', 'm:toolu_01Hooks', 'Backoff: Exponential, 5 tries · Give up: Email the account owner, Disable the endpoint', 'answer-menu'],
      ]) {
        await page.goto(`${mock.url}/`);
        await page.click(`[data-segment][data-session="${id}"]`);
        await ready(page, id);
        assert.equal((await page.eval(card))!.primary, 'Accept suggestion');
        // The segment keeps focus after the click, and ⏎ on it would press it again.
        await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.key('Enter');
        const [accepted] = await logged(mock, `the accepted second opinion of ${id}`, (e) => e.action === action && e.sessionId === id, POSTED_MS);
        assert.deepEqual([accepted.status, accepted.body.key ?? `m:${accepted.body.toolUseId}`], [204, key]);
        const s = await sessionOf(id);
        if (legacy) assert.equal('answered' in s, false);
        else assert.deepEqual([s.answered.key, s.answered.text], [key, text]);
        await until(`${id} to start working`, async () => (await sessionOf(id)).status === 'working');
        await shot(`accepted-${id}`);
      }
    },
  },
  {
    name: 'P1a.compat-dismiss the card dismisses a question: it closes, the tile leaves Decide, and nothing counts as answered',
    async run({ page, mock, shot }) {
      const { legacy } = await mock.get('/mock');
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.click('[data-card] footer button', 'Dismiss');
      const [dismissed] = await logged(mock, 'the dismissal', (e) => e.action === 'dismiss', POSTED_MS);
      assert.deepEqual([dismissed.sessionId, dismissed.status, dismissed.body.key], ['s-cart', 204, 'q:toolu_01Cart']);
      const s = (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === 's-cart');
      assert.deepEqual([s.question, s.dismissedAsk, s.status, s.answered], [null, 'toolu_01Cart', 'idle', legacy ? undefined : null]);
      await page.goto(`${mock.url}/wall`);
      await page.until('the s-cart tile to leave Decide', () =>
        document.querySelector('[data-tile][data-session="s-cart"]')?.getAttribute('data-attention') === 'idle');
      await shot('dismissed');
    },
  },
  {
    name: 'P1a.mock-reset an answer still typing when the scenario loads again fails and leaves the fresh scenario alone; so does a note waiting behind an answer to an end-of-turn decision',
    async run({ mock }) {
      const { legacy } = await mock.get('/mock');
      const sessionsNow = async () => new Map<string, any>((await mock.get('/api/state')).sessions.map((s: { id: string }) => [s.id, s]));
      const answer = (id: string, body: object) => fetch(`${mock.url}/api/sessions/${id}/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const { summary } = (await sessionsNow()).get('s-group');
      const sends = [
        answer('s-cart', { key: 'q:toolu_01Cart', choice: 'Keep the account cart' }),
        answer('s-group', { key: `s:${summary.basis}`, choice: summary.decision.options[0].label }),
      ];
      if (legacy) await Promise.all(sends);
      else await until('both answers to be claimed and typing', async () => {
        const now = await sessionsNow();
        return now.get('s-cart').answered && now.get('s-group').answered;
      });
      // A message meets an end-of-turn decision and claims it, so one still waiting its turn must not reach the fresh s-group.
      sends.push(answer('s-group', { key: null, text: 'Also bump the version' }));
      if (legacy) await sends[2];
      else await until('the note to wait its turn', async () => (await mock.log()).some((e) => e.sessionId === 's-group' && e.body.key === null && e.status === null));
      await mock.post('/mock/scenario/queue');
      const replies = await Promise.all(sends.map(async (sent) => {
        const reply = await sent;
        return [reply.status, reply.status === 204 ? null : (await reply.json()).error];
      }));
      assert.deepEqual(replies, Array(3).fill(legacy ? [204, null] : [400, 'the mock loaded another scenario meanwhile']));
      await sleep(1000);
      const now = await sessionsNow();
      const [cart, group] = [now.get('s-cart'), now.get('s-group')];
      assert.deepEqual([cart.question?.toolUseId, cart.answered ?? null, cart.status], ['toolu_01Cart', null, 'idle']);
      assert.deepEqual([decisionKey(group), group.answered ?? null, group.status], [`s:${summary.basis}`, null, 'idle']);
    },
  },
  {
    name: 'P1b.ui-entry a socket gets uiEntry, the build\'s entry script, on open and in every snapshot pushed after (on --legacy only on open); the open page keeps itself when the entry is its own',
    async run({ page, mock }) {
      const { legacy } = await mock.get('/mock');
      await page.goto(`${mock.url}/`);
      await page.until('the first snapshot', () => /^\(\d+\) Agent Board$/.test(document.title));
      const entry = await page.eval(listen);
      assert.match(entry ?? '', /^\/assets\/index-[\w-]+\.js$/);
      assert.deepEqual(await page.until('the snapshot on open', received, null), { carries: true, uiEntry: entry });
      const title = 'Lazy-load product reviews, patched';
      await mock.post('/mock/patch', { id: 's-reviews', patch: { title } });
      assert.deepEqual(await page.until('the snapshot pushed after the patch', received, title), legacy ? { carries: false, uiEntry: null } : { carries: true, uiEntry: entry });
      // The page's own socket got the same push; a reload it caused would have replaced the document by now.
      await sleep(1000);
      assert.deepEqual(await page.eval(navigation), { marker: true, type: 'navigate', entry });
    },
  },
  {
    name: 'P1b.ui-entry-build a build written into the folder the server serves reaches an open page: it reloads into the new entry once, and stays',
    async run({ page }) {
      await withOwnBuild(async (own, build) => {
        const url = `${own.url}/`;
        await page.goto(url);
        await page.until('the first snapshot', () => /^\(\d+\) Agent Board$/.test(document.title));
        await page.eval(() => void ((window as unknown as Probe).e2eMarker = true));
        const next = build();
        // Read twice 2 s apart before it counts, so the reload comes 2 to 4 s after the build.
        const reloaded = await until('the page to reload into the new build', () => page.eval(navigation).then((n) => n.entry === next && n, () => null), 15_000);
        assert.deepEqual(reloaded, { marker: null, type: 'reload', entry: next });
        await page.until('the first snapshot', () => /^\(\d+\) Agent Board$/.test(document.title));
        await page.eval(() => void ((window as unknown as Probe).e2eMarker = true));
        await own.post('/mock/patch', { id: 's-reviews', patch: { title: 'Lazy-load product reviews, patched' } });
        await sleep(3000);
        assert.deepEqual([await page.eval(navigation), loads(page, url)], [{ marker: true, type: 'reload', entry: next }, 2]);
      });
    },
  },
  {
    name: 'P1b.ui-entry-early a page loaded from a new build before the server has taken it loads once and stays: the snapshot on open and one pushed meanwhile name no entry, and the one when the build is taken names its entry',
    async run({ page }) {
      await withOwnBuild(async (own, build) => {
        const url = `${own.url}/`;
        const next = build();
        await page.goto(url);
        // Time for the reload a snapshot on open naming the older entry would cause.
        await sleep(500);
        assert.equal(loads(page, url), 1, 'the page reloaded');
        await page.until('the first snapshot', () => /^\(\d+\) Agent Board$/.test(document.title));
        assert.equal(await page.eval(listen), next);
        assert.deepEqual(await page.until('the snapshot on open', received, null), { carries: true, uiEntry: null });
        const title = 'Lazy-load product reviews, patched';
        await own.post('/mock/patch', { id: 's-reviews', patch: { title } });
        await sleep(300);
        assert.equal(loads(page, url), 1, 'the snapshot pushed after the patch reloaded the page');
        // The build is taken two polls 2 s apart after it lands, so this push comes before.
        assert.deepEqual(await page.until('the snapshot pushed after the patch', received, title), { carries: true, uiEntry: null });
        await page.until('the snapshot pushed when the build is taken', named, next, title);
        // The page's own socket got the same pushes; a reload they caused would have replaced the document by now.
        await sleep(1000);
        assert.deepEqual([await page.eval(navigation), loads(page, url)], [{ marker: true, type: 'navigate', entry: next }, 1]);
      });
    },
  },
  {
    name: 'P3.reload-gate a new build reloads the board when nothing is focused; a focused prompt holds it until a click outside, the New task dialog until it closes; the page\'s own entry never reloads it, nor a build it already reloaded for',
    async run({ page, mock, shot }) {
      const mark = () => page.eval(() => void ((window as unknown as { probe?: number }).probe = 1));
      const marked = () => page.eval(() => (window as unknown as { probe?: number }).probe === 1);
      const newBuild = (n: number) => mock.post('/mock/ui-entry', { src: `/assets/index-next${n}.js` });
      // The old document goes away under a call, so a failed call means "not yet".
      const reloaded = (what: string) => until(`the page to reload ${what}`, async () => {
        try {
          return await page.eval(() => (window as unknown as { probe?: number }).probe === undefined && document.readyState === 'complete');
        } catch {
          return false;
        }
      });

      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      await mark();
      await newBuild(1);
      await reloaded('with nothing focused');
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);

      await mark();
      const own = await page.eval(() => document.querySelector('script[type="module"][src]')!.getAttribute('src')!);
      await mock.post('/mock/ui-entry', { src: own });
      await mock.post('/mock/ui-entry', { src: `${mock.url}${own}` });
      await sleep(3000);
      assert.equal(await marked(), true, 'its own entry reloaded the page');

      await page.goto(`${mock.url}/wall`);
      await page.click('#new-task-inline textarea');
      await page.type('Ship it after lunch');
      await mark();
      await newBuild(2);
      await sleep(3000);
      const typing = await page.eval(() => [
        (window as unknown as { probe?: number }).probe, document.activeElement?.tagName, document.querySelector<HTMLTextAreaElement>('#new-task-inline textarea')?.value,
      ]);
      assert.deepEqual(typing, [1, 'TEXTAREA', 'Ship it after lunch']);
      await shot('draft-holds-reload');
      await page.click('main h1');
      await reloaded('once focus left the prompt');

      await page.goto(`${mock.url}/`);
      await page.click('button', 'New task');
      await page.until('the New task dialog', () => !!document.querySelector<HTMLDialogElement>('dialog#new-task')?.open);
      const blurred = await page.eval(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        return document.activeElement === document.body;
      });
      assert.equal(blurred, true, 'only the open dialog holds the reload');
      await mark();
      await newBuild(3);
      await sleep(3000);
      assert.equal(await marked(), true, 'reloaded under the New task dialog');
      await shot('dialog-holds-reload');
      await page.key('Escape');
      await reloaded('once the dialog closed');

      // The mock serves the same entry whatever it announces, so each reload above came back to it, as when the
      // server reads some other script as the entry.
      await page.until('the card', () => !!document.querySelector('[data-card]'));
      await mark();
      await newBuild(3);
      await sleep(3000);
      assert.equal(await marked(), true, 'reloaded again for a build that brought it back to its own entry');
    },
  },
  {
    name: 'P3.reload-offline a new build waits for the server: focus leaving a prompt while the server cannot be reached does not reload the board, and it reloads once the server is back and names that build',
    expectedErrors: [/WebSocket/, /ERR_CONNECTION/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.click('#new-task-inline textarea');
      await page.type('Ship it after lunch');
      await page.eval(() => void ((window as unknown as { probe?: number }).probe = 1));
      await mock.post('/mock/ui-entry', { src: '/assets/index-offline.js' });
      await mock.post('/mock/drop', { ms: 4000 });
      try {
        await page.until('the server to drop the page', () => fetch('/').then(() => false, () => true));
        await page.click('main h1');
        await sleep(1500);
        const kept = await page.eval(() => [
          (window as unknown as { probe?: number }).probe, document.activeElement === document.body, document.querySelector<HTMLTextAreaElement>('#new-task-inline textarea')?.value,
        ]);
        assert.deepEqual(kept, [1, true, 'Ship it after lunch'], 'reloaded while the server could not be reached');
        await shot('offline-holds-reload');
      } finally {
        // The next check's reset cannot reach the mock until the drop is over.
        await until('the drop to end', () => mock.get('/mock').then(() => true, () => false), 10_000);
      }
      // A server back with the new build names it to the page that reconnects; the mock names the build it serves, so
      // the check names the new one again once the page is live.
      const back = await until('the page to reconnect', async () => {
        try {
          return await page.eval(() => ((window as unknown as { probe?: number }).probe === undefined ? 'reloaded' : document.querySelector('[data-link="live"]') ? 'live' : null));
        } catch {
          return null;
        }
      }, 10_000);
      if (back === 'live') await mock.post('/mock/ui-entry', { src: '/assets/index-offline.js' });
      await until('the page to reload once the server is back', async () => {
        try {
          return await page.eval(() => (window as unknown as { probe?: number }).probe === undefined && document.readyState === 'complete');
        } catch {
          return false;
        }
      }, 10_000);
      await page.until('the Wall', () => document.querySelector('#new-task-inline textarea') !== null);
    },
  },
  {
    name: 'P4.1 the Wall: its title and the queue\'s counts, Back to the queue Esc; tiles in priority order with repo · branch and no rank or line counts; Archived (1) collapsed; working clocks tick; Esc goes to the queue and V back; a menu answered from the board that stays open turns Needs focus by the clock alone',
    async run({ page, mock, shot }) {
      const wall = () => ({
        title: document.querySelector('main h1')?.textContent,
        sub: document.querySelector('main h1 + p')?.textContent,
        back: document.querySelector('main a[href="/"]')?.textContent,
        order: [...document.querySelectorAll<HTMLElement>('[data-tile]')].filter((t) => !t.closest('details')).map((t) => `${t.dataset.session} ${t.dataset.attention}`),
        archived: document.querySelector('main details > summary')?.textContent,
        open: document.querySelector<HTMLDetailsElement>('main details')?.open,
        texts: Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-tile]')].map((t) => [t.dataset.session, t.innerText])) as Record<string, string>,
      });
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      const shown = await page.eval(wall);
      assert.deepEqual({ ...shown, texts: undefined }, {
        title: 'Every agent, in priority order',
        sub: '3 decisions · 1 terminal prompt · 2 finished turns wait in the queue.',
        back: 'Back to the queue Esc',
        order: [
          's-cart decide', 's-hooks decide', 's-group decide', 's-astro focus', 's-reviews idle', 's-anchors idle',
          's-invoice working', 's-search working', 's-thumbs working', 's-split exited', 's-stripe exited',
        ],
        archived: 'Archived (1)',
        open: false,
        texts: undefined,
      });
      for (const [id, text] of Object.entries(shown.texts)) {
        assert.doesNotMatch(text, /#\d|(^|\s)[+−]\d/, `${id} shows a rank or a line count`);
      }
      assert.match(shown.texts['s-cart'], /storefront · guest-cart-merge/);
      assert.match(shown.texts['s-invoice'], /billing-api · invoice-rounding/);
      const clock = () => document.querySelector('[data-tile][data-session="s-invoice"] [title="How long the turn has run"]')?.textContent;
      const first = await page.eval(clock);
      await sleep(1100);
      const second = await page.eval(clock);
      assert.match(first ?? '', /^\d+:\d\d$/);
      assert.notEqual(second, first, 'the working clock did not tick');
      await shot('wall');

      await page.key('Escape');
      await page.until('the queue', () => location.pathname === '/' && document.documentElement.dataset.view === 'queue' && !!document.querySelector('[data-card]'));
      await page.key('v');
      await page.until('the Wall again', () => location.pathname === '/wall' && document.documentElement.dataset.view === 'wall');

      const hooks = () => [document.querySelector('[data-tile][data-session="s-hooks"]')?.getAttribute('data-attention'), document.title];
      await mock.post('/mock/patch', { id: 's-hooks', patch: { answered: { key: 'm:toolu_01Hooks', text: 'Backoff: Exponential, 5 tries', at: Date.now() - 8000 } } });
      await page.until('the answered menu to count as working', () => document.querySelector('[data-tile][data-session="s-hooks"]')?.getAttribute('data-attention') === 'working');
      assert.deepEqual(await page.eval(hooks), ['working', '(2) Agent Board']);
      await page.until('the menu still open to need focus', () => document.querySelector('[data-tile][data-session="s-hooks"]')?.getAttribute('data-attention') === 'focus');
      assert.deepEqual(await page.eval(hooks), ['focus', '(2) Agent Board']);
    },
  },
  {
    name: 'P4.2 the top bar: Live and (3) in the tab title; six meter segments whose counts are only in the aria-label, then Repos, the view toggle and New task; before the first snapshot the pill reads Connecting… and every view says so',
    expectedErrors: [/WebSocket/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the card', card);
      const bar = await page.eval(() => {
        const left = (s: string) => document.querySelector(s)?.getBoundingClientRect().left ?? NaN;
        const right = (s: string) => document.querySelector(s)?.getBoundingClientRect().right ?? NaN;
        const pill = document.querySelector<HTMLElement>('[data-link]');
        return {
          link: [pill?.dataset.link, pill?.innerText.trim()],
          title: document.title,
          segments: document.querySelectorAll('[data-segment]').length,
          label: document.querySelector('[data-meter] [role="group"]')?.getAttribute('aria-label'),
          shown: document.querySelector<HTMLElement>('header')?.innerText,
          order: right('[data-meter] [role="group"]') <= left('[data-repos]') && left('[data-repos]') < left('nav[aria-label="View"]') &&
            left('nav[aria-label="View"]') < left('button[aria-label="New task"]'),
        };
      });
      assert.deepEqual({ ...bar, shown: undefined }, {
        link: ['live', 'Live'], title: '(3) Agent Board', segments: 6, label: '3 decisions · 1 terminal prompt · 2 finished turns', shown: undefined, order: true,
      });
      assert.doesNotMatch(bar.shown ?? '', /\d/, 'the top bar shows a count');
      await shot('top-bar');

      await withoutBoard(async (url) => {
        for (const path of ['/', '/wall', '/s/s-cart/overview']) {
          await page.goto(`${url}${path}`);
          await sleep(300);
          const before = await page.eval(() => ({
            link: document.querySelector<HTMLElement>('[data-link]')?.dataset.link,
            text: document.querySelector<HTMLElement>('[data-link]')?.innerText.trim(),
            view: [...document.querySelectorAll<HTMLElement>('main, #task-sheet[open]')].map((v) => v.innerText.trim()).at(-1),
          }));
          assert.deepEqual(before, { link: 'connecting', text: 'Connecting…', view: 'Connecting…' }, path);
        }
        await shot('connecting');
      });
    },
  },
  {
    name: 'P4.3 the meter at volume: 24 and 45 cards keep it clear of the wordmark and Repos at 1440 and 1100 px, 45 draw bars of 30, 5 and 10; 20 cards at 1100 px keep every segment 6 px or wider; counts stay in the aria-label, and an arrival shows the Just-in chip, short where the slot is narrow',
    scenario: 'volume',
    async run({ page, mock, look, shot }) {
      const load = async (scenario: string, ready: (inFrame: boolean) => boolean) => {
        await mock.post(`/mock/scenario/${scenario}`);
        await page.goto(`${mock.url}/`);
        await page.until(`${scenario} in the meter`, ready, false);
        await page.eval(frame, '/', 1100, 900);
        await page.until(`${scenario} in the meter at 1100 px`, ready, true);
        return [await page.eval(meterIn, false), await page.eval(meterIn, true)];
      };
      const bars = (inFrame: boolean) => {
        const doc = inFrame ? (document.getElementById('e2e-frame') as HTMLIFrameElement).contentDocument : document;
        return doc?.querySelectorAll('[data-bar]').length === 3;
      };
      const twenty = (inFrame: boolean) => {
        const doc = inFrame ? (document.getElementById('e2e-frame') as HTMLIFrameElement).contentDocument : document;
        return doc?.querySelectorAll('[data-segment]').length === 20;
      };

      for (const [wide, at1100] of [await load('volume', bars)]) {
        for (const m of [wide, at1100]) {
          assert.deepEqual([m.overlap, m.label, m.shown, m.justIn], [false, '14 decisions · 3 terminal prompts · 7 finished turns', '14\n3\n7', []]);
        }
      }
      await shot('meter-volume-1100');
      await page.eval(() => document.getElementById('e2e-frame')?.remove());
      await shot('meter-volume');

      for (const m of await load('volume45', bars)) {
        assert.deepEqual([m.overlap, m.bars, m.label], [false, ['30', '5', '10'], '30 decisions · 5 terminal prompts · 10 finished turns']);
      }
      await page.eval(() => document.getElementById('e2e-frame')?.remove());
      await shot('meter-volume45');

      const [wide, narrow] = await load('volume20', twenty);
      for (const m of [wide, narrow]) {
        assert.deepEqual([m.overlap, m.label, m.shown, m.justIn], [false, '12 decisions · 3 terminal prompts · 5 finished turns', '', []]);
        assert.ok(m.segments.every((w) => w >= 6), `segments ${m.segments.join(', ')}`);
      }
      await mock.post('/mock/add', { template: 'ask', id: 's-new', rank: 2 });
      await page.until('the Just-in chip at 1100 px', () =>
        !!(document.getElementById('e2e-frame') as HTMLIFrameElement).contentDocument?.querySelector('[data-justin]'));
      assert.deepEqual((await page.eval(meterIn, true)).justIn, ['Just in']);
      assert.deepEqual((await page.eval(meterIn, false)).justIn, [look.width > 1100 ? 'Just in: Retire the v1 orders API' : 'Just in']);
      await shot('meter-just-in-1100');
    },
  },
  {
    name: 'P4.4 a tile opens its sheet on Overview, which takes focus itself: the working banner with a 30 px clock that ticks, Worth knowing, the composer, Status · updated, the latest reply, Facts and the Artifacts links; Esc in the composer\'s command list closes only the list',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.click('[data-tile][data-session="s-invoice"] p');
      await page.until('the sheet', sheetOpen);
      assert.deepEqual(await page.eval(() => [location.pathname, document.activeElement?.id]), ['/s/s-invoice/overview', 'task-sheet']);
      const clock = () => {
        const c = document.querySelector<HTMLElement>('#task-sheet [title="Time since your last message"]');
        return c && { text: c.textContent, size: getComputedStyle(c).fontSize };
      };
      const first = await page.until('the working banner', clock);
      const overview = await page.eval(() => {
        const sheet = document.querySelector<HTMLElement>('#task-sheet')!;
        return {
          working: sheet.innerText.includes('Claude is working'),
          know: sheet.innerText.includes('Two customers were billed one cent too much'),
          composer: !!sheet.querySelector('textarea'),
          status: [...sheet.querySelectorAll('h3')].map((h) => h.textContent).find((t) => t?.startsWith('Status')),
          reply: sheet.innerText.includes("CLAUDE'S LATEST REPLY") && sheet.innerText.includes('The cent goes missing'),
          facts: [...sheet.querySelectorAll('dt')].map((d) => d.textContent),
          artifacts: [...sheet.querySelectorAll('aside button')].map((b) => b.querySelector('strong')?.textContent),
        };
      });
      assert.equal(first.size, '30px');
      assert.deepEqual({ ...overview, status: undefined }, {
        working: true, know: true, composer: true, status: undefined, reply: true,
        facts: ['Task', 'Worktree', 'Pull request', 'Terminal', 'Session'], artifacts: ['Where the cent goes missing'],
      });
      assert.match(overview.status ?? '', /^Status · updated \d+m ago$/);
      await sleep(1100);
      assert.notEqual((await page.eval(clock))?.text, first.text, 'the clock did not tick');
      await page.until('the sheet to settle', settled);
      await shot('sheet-overview');

      await page.click('#task-sheet textarea');
      await page.type('/re');
      await page.until('the command list', () => document.querySelectorAll('#task-sheet [role="listbox"] [role="option"]').length > 0);
      await page.key('Escape');
      await page.until('the list to close', () => !document.querySelector('#task-sheet [role="listbox"]'));
      assert.deepEqual(await page.eval(() => [!!document.querySelector('#task-sheet:modal'), document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')?.value]), [true, '/re']);
    },
  },
  {
    name: 'P4.5 Diff: 2 replaces the entry; the tree resizes by key and resets on a double click, kept in localStorage; a file opens whole, J and K step; Esc goes back to all files, a second Esc closes the sheet and focus returns to the tile\'s name',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.eval(() => document.querySelector<HTMLElement>('[data-tile][data-session="s-invoice"] a')!.focus());
      await page.key('Enter');
      await page.until('the sheet', sheetOpen);
      const entries = await page.eval(() => window.navigation.entries().length);
      await page.key('2');
      await page.until('the file tree', () => location.pathname === '/s/s-invoice/diff' && document.querySelectorAll('nav[aria-label="Changed files"] a').length === 12);
      assert.equal(await page.eval(() => window.navigation.entries().length), entries, 'the tab pushed an entry');
      await page.until('the diff', () => document.querySelectorAll('section[data-file] diffs-container').length > 0);
      await shot('sheet-diff');

      const width = () => ({
        now: document.querySelector('[role="separator"]')?.getAttribute('aria-valuenow'),
        kept: localStorage.getItem('diff-tree-width'),
      });
      await page.eval(() => document.querySelector<HTMLElement>('[role="separator"]')!.focus());
      await page.key('ArrowRight');
      await page.key('ArrowRight');
      assert.deepEqual(await page.eval(width), { now: '292', kept: '292' });
      await page.key('ArrowLeft');
      assert.deepEqual(await page.eval(width), { now: '276', kept: '276' });
      await page.eval(() => document.querySelector('[role="separator"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      assert.deepEqual(await page.eval(width), { now: '260', kept: '260' });

      await page.click('nav[aria-label="Changed files"] a[title="server/git.ts"]');
      await page.until('server/git.ts whole', wholeFile, 'server/git.ts');
      await page.key('j');
      await page.until('the next file whole', wholeFile, 'server/mcpGuard.test.ts');
      await page.key('k');
      await page.until('the file before whole', wholeFile, 'server/git.ts');
      await shot('sheet-diff-file');

      await page.key('Escape');
      await page.until('all files again', () => document.querySelectorAll('section[data-file]').length === 12);
      assert.equal(await page.eval(sheetOpen), true, 'Esc in one file closed the sheet');
      await page.key('Escape');
      await page.until('the sheet to close', () => !document.querySelector('#task-sheet[open]') && location.pathname === '/wall');
      assert.equal(await page.eval(() => document.activeElement?.closest('[data-tile]')?.getAttribute('data-session') + ' ' + document.activeElement?.tagName), 's-invoice A');
    },
  },
  {
    name: 'P4.6 browser Back closes the sheet; a sheet whose task goes away closes with "That task is gone."',
    async run({ page, mock }) {
      await openFromWall(page, mock, 's-invoice');
      await page.eval(() => history.back());
      await page.until('the sheet to close on Back', () => !document.querySelector('#task-sheet[open]') && location.pathname === '/wall');

      await openFromWall(page, mock, 's-split');
      await mock.post('/api/sessions/s-split/forget');
      await page.until('the sheet to close', () => !document.querySelector('#task-sheet[open]') && location.pathname === '/wall');
      assert.deepEqual(await page.until('the toast', toastsOf, 'info'), [{ kind: 'info', text: 'That task is gone.', inSheet: false, hit: true }]);
    },
  },
  {
    name: 'P4.7 Artifacts: 3 opens the list as a column beside a sandboxed frame of the newest artifact, with Open in new tab as a link; another artifact replaces the entry',
    async run({ page, mock, shot }) {
      await openSheetOf(page, mock, 's-cart');
      const entries = await page.eval(() => window.navigation.entries().length);
      await page.key('3');
      await page.until('the artifacts', () => location.pathname === '/s/s-cart/artifacts' && document.querySelector('#task-sheet iframe') !== null);
      const shown = await page.eval(() => {
        const frame = document.querySelector('#task-sheet iframe')!;
        const link = [...document.querySelectorAll<HTMLAnchorElement>('#task-sheet a')].find((a) => a.textContent?.includes('Open in new tab'));
        return {
          column: getComputedStyle(document.querySelector('[role="tablist"][aria-label="Artifacts"]')!).flexDirection,
          list: [...document.querySelectorAll('[aria-label="Artifacts"] [role="tab"] strong')].map((t) => t.textContent),
          sandbox: frame.getAttribute('sandbox'),
          src: frame.getAttribute('src'),
          link: link && [link.getAttribute('href'), link.target],
        };
      });
      assert.deepEqual(shown, {
        column: 'column', list: ['Login flow with the merge step', 'Cart merge — before and after'], sandbox: 'allow-scripts',
        src: '/api/sessions/s-cart/artifacts/art-cart-2', link: ['/api/sessions/s-cart/artifacts/art-cart-2', '_blank'],
      });
      await page.until('the sheet to settle', settled);
      await shot('sheet-artifacts');
      await page.click('[aria-label="Artifacts"] [role="tab"]', 'Cart merge');
      await page.until('the other artifact', () => location.pathname === '/s/s-cart/artifacts/art-cart-1' &&
        document.querySelector('#task-sheet iframe')?.getAttribute('src') === '/api/sessions/s-cart/artifacts/art-cart-1');
      assert.equal(await page.eval(() => window.navigation.entries().length), entries, 'a tab or an artifact pushed an entry');
    },
  },
  {
    name: 'P4.8 rename: Esc keeps the title and the sheet; Enter sends rename with the new title',
    async run({ page, mock, shot }) {
      await openSheetOf(page, mock, 's-reviews');
      const title = () => document.querySelector('#task-sheet h2')?.textContent;
      await page.click('#task-sheet h2 button');
      await page.until('the rename field', () => document.activeElement?.getAttribute('aria-label') === 'Task name');
      await page.type(' X');
      await page.key('Escape');
      await page.until('the title back', () => document.querySelector('#task-sheet h2')?.textContent === 'Lazy-load product reviews');
      assert.equal(await page.eval(sheetOpen), true, 'Esc in the rename field closed the sheet');
      await page.click('#task-sheet h2 button');
      await page.until('the rename field', () => document.activeElement?.getAttribute('aria-label') === 'Task name');
      await page.type(' X');
      await shot('rename');
      await page.key('Enter');
      const [renamed] = await logged(mock, 'the rename', (e) => e.action === 'rename');
      assert.deepEqual([renamed.sessionId, renamed.body, renamed.status], ['s-reviews', { title: 'Lazy-load product reviews X' }, 204]);
      await page.until('the new title', () => document.querySelector('#task-sheet h2')?.textContent === 'Lazy-load product reviews X');
      assert.equal(await page.eval(title), 'Lazy-load product reviews X');
    },
  },
  {
    name: 'P4.9 the ⋯ menu lists what each session can do; Delete worktree… asks in a dialog that names the branch, the path and the loss, starts on Cancel and closes on Esc; a failed loss check says so; Delete worktree deletes',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      const open = async (id: string) => {
        await page.click(`[data-tile][data-session="${id}"] button[aria-label="Session actions"]`);
        return page.until(`the menu of ${id}`, menuItems);
      };
      assert.deepEqual(await open('s-stripe'), ['Continue', 'Open in Finder', 'Open in VS Code', 'Archive', 'Remove from list', 'Delete worktree…']);
      await page.key('Escape');
      await page.until('the menu to close', () => !document.querySelector(':popover-open'));
      assert.deepEqual(await open('s-invoice'), ['Terminal', 'Open in Finder', 'Open in VS Code', 'Quit Claude', 'Archive', 'Delete worktree…']);
      await shot('session-menu');

      const asked = () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#delete-worktree');
        if (!d?.open || d.innerText.includes('Checking')) return null;
        return {
          title: d.querySelector('h2')?.textContent,
          path: d.querySelector('code')?.textContent,
          text: d.innerText,
          loss: [...d.querySelectorAll('li')].map((l) => l.textContent),
          focus: document.activeElement?.textContent,
        };
      };
      await page.click(':popover-open button', 'Delete worktree');
      const shown = await page.until('the delete dialog', asked);
      assert.deepEqual({ ...shown, text: undefined }, {
        title: 'Delete the worktree and its local branch invoice-rounding?', path: '~/code/worktrees/invoice-rounding/billing-api', text: undefined,
        loss: ['3 uncommitted or untracked files', '2 commits that no other branch or remote has'], focus: 'Cancel',
      });
      assert.match(shown.text, /This throws away:/);
      await page.until('the dialog to settle', settled);
      await shot('delete-dialog');
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#delete-worktree[open]'));

      await open('s-stripe');
      await page.click(':popover-open button', 'Delete worktree');
      const failed = await page.until('the failed loss check', asked);
      assert.match(failed.text, /Could not check what would be lost \(git status failed: fatal: unable to read the index\); uncommitted changes and unpushed commits may be lost\./);
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#delete-worktree[open]'));

      await open('s-invoice');
      await page.click(':popover-open button', 'Delete worktree');
      await page.until('the delete dialog', asked);
      await page.click('dialog#delete-worktree button', 'Delete worktree');
      const [deleted] = await logged(mock, 'the deletion', (e) => e.method === 'POST' && e.action === 'delete-worktree');
      assert.deepEqual([deleted.sessionId, deleted.status], ['s-invoice', 204]);
      await page.until('the tile to go', () => !document.querySelector('[data-tile][data-session="s-invoice"]'));
    },
  },
  {
    name: 'P4.10 New task on the Wall: ⌘↵ creates from the prompt, repository and name and opens the new sheet; a refused name shows inline and keeps the fields; Existing branch lists the server\'s branches as chips with the hint',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      const submit = () => document.querySelector('#new-task-inline textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
      await page.goto(`${mock.url}/wall`);
      await page.until('the New task form', () => !!document.querySelector('#new-task-inline textarea'));
      await page.click('#new-task-inline textarea');
      await page.type('Fix the login redirect');
      await page.eval(() => {
        const repo = document.querySelector<HTMLSelectElement>('#new-task-inline select')!;
        repo.value = '1';
        repo.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.click('#new-task-inline input[placeholder="fix-login-redirect"]');
      await page.type('fix-login');
      await shot('new-task-wall');
      await page.eval(submit);
      const [created] = await logged(mock, 'the new task', (e) => e.method === 'POST' && e.path === '/api/worktrees');
      const { repoId, name, prompt, startClaude, existingBranch } = created.body;
      assert.deepEqual({ repoId, name, prompt, startClaude, existingBranch, status: created.status }, {
        repoId: 1, name: 'fix-login', prompt: 'Fix the login redirect', startClaude: true, existingBranch: false, status: 200,
      });
      await page.until('its sheet', () => !!document.querySelector('#task-sheet:modal') && /^\/s\/[^/]+\/overview$/.test(location.pathname) &&
        document.querySelector('#task-sheet h2')?.textContent === 'fix-login');
      await page.click('#task-sheet button[aria-label^="Back to"]');
      await page.until('an empty form', () => !document.querySelector('#task-sheet[open]') && document.querySelector<HTMLTextAreaElement>('#new-task-inline textarea')?.value === '');

      await page.click('#new-task-inline textarea');
      await page.type('Try a refused name');
      await page.click('#new-task-inline input[placeholder="fix-login-redirect"]');
      await page.type('fail');
      await page.eval(submit);
      const error = await page.until('the inline error', () => document.querySelector('#new-task-inline [role="alert"]')?.textContent);
      assert.match(error, /cannot be created here/);
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('#new-task-inline textarea, #new-task-inline input')].map((f) => f.value)), ['Try a refused name', 'fail']);

      await page.click('#new-task-inline button', 'More options');
      await page.click('#new-task-inline label', 'Existing branch');
      await logged(mock, 'the branches', (e) => e.method === 'GET' && e.path === '/api/repos/1/branches');
      const chips = await page.until('the branch chips', () => {
        const list = [...document.querySelectorAll('#new-task-inline [aria-label="Branches"] button')].map((b) => [b.querySelector('code')?.textContent, b.querySelector('span')?.textContent ?? '']);
        return list.length && list;
      });
      for (const chip of [['main', 'main checkout'], ['guest-cart-merge', 'own worktree'], ['release/2026.10', '']]) assert.deepEqual(chips.find((c) => c[0] === chip[0]), chip);
      const hint = () => document.querySelector('#new-task-inline form > p:not([role])')?.textContent;
      assert.equal(await page.eval(hint), 'Switches ~/code/storefront to the branch and starts Claude there.');
      await page.click('#new-task-inline [aria-label="Branches"] button', 'guest-cart-merge');
      await page.until('the hint for a branch with its own worktree', () =>
        document.querySelector('#new-task-inline form > p:not([role])')?.textContent === 'Starts Claude in ~/code/worktrees/guest-cart-merge/storefront, where it is checked out.');
      await shot('new-task-existing-branch');
    },
  },
  {
    name: 'P4.11 Repos: Add, a folder\'s ×, Rescan, Settings Save, Remove worktree and Continue send their requests, and Continue opens the sheet',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.click('[data-repos]');
      await page.until('Repos', () => !!document.querySelector('dialog#workspace:modal'));
      assert.equal(await page.eval(() => document.activeElement?.id), 'workspace');
      await page.until('the sheet to settle', settled);
      await shot('repos');
      const request = async (what: string, method: string, path: string) => (await logged(mock, what, (e) => e.method === method && e.path === path)).at(-1)!;

      await page.click('#workspace input[aria-label="Repository or folder"]');
      await page.type('~/code/payments');
      await page.click('#workspace button[type="submit"]', 'Add');
      assert.deepEqual((await request('Add', 'POST', '/api/repos')).body, { path: '~/code/payments' });
      await page.click('#workspace button[aria-label="Stop scanning ~/code"]');
      assert.deepEqual((await request('the folder\'s ×', 'DELETE', '/api/roots')).body, { path: '~/code' });
      await page.click('#workspace button', 'Rescan');
      await request('Rescan', 'POST', '/api/rescan');
      await page.click('#workspace button', 'Settings');
      await page.click('#workspace input[name="baseBranch"]');
      await page.type('origin/develop');
      await page.click('#workspace button[type="submit"]', 'Save');
      assert.equal((await request('Save', 'PATCH', '/api/repos/1')).body.baseBranch, 'origin/develop');
      const row = '#workspace [data-worktree="~/code/worktrees/lazy-reviews/storefront"]';
      await page.click(`${row} button`, 'Remove');
      await page.click(`${row} button[type="submit"]`, 'Remove worktree');
      assert.deepEqual((await request('Remove worktree', 'DELETE', '/api/worktrees')).body, {
        repoId: 1, path: '~/code/worktrees/lazy-reviews/storefront', deleteBranch: false, force: false,
      });
      await page.click('#workspace [data-worktree="~/code/storefront"] button', 'Continue');
      assert.deepEqual((await request('Continue', 'POST', '/api/sessions')).body, { repoId: 1, worktree: '~/code/storefront', continueId: 'c-sf-1' });
      await page.until('the continued conversation\'s sheet', () =>
        location.pathname === '/s/c-sf-1/overview' && !!document.querySelector('#task-sheet:modal') && !document.querySelector('dialog#workspace[open]'));
    },
  },
  {
    name: 'P4.12 toasts inside the open sheet: an error from its ⋯ menu shows in the sheet and takes the point at its middle; an archive\'s Undo and a toast\'s × both work there',
    expectedErrors: [/boom/, /status of 400/],
    async run({ page, mock, shot }) {
      await openFromWall(page, mock, 's-invoice');
      await mock.post('/mock/fail', { error: 'boom' });
      await page.click('#task-sheet button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Archive');
      assert.deepEqual(await page.until('the error toast', toastsOf, 'error'), [{ kind: 'error', text: 'boom', inSheet: true, hit: true }]);

      await page.click('#task-sheet button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Archive');
      await logged(mock, 'the archive', (e) => e.action === 'archive' && e.body.archived === true && e.status === 204);
      assert.deepEqual(await page.until('the undo toast', toastsOf, 'undo'), [{ kind: 'undo', text: 'Archived Fix invoice PDF rounding\nUndo', inSheet: true, hit: true }]);
      await shot('toasts-in-sheet');
      await page.click('[data-toast][data-kind="undo"] button', 'Undo');
      const [unarchived] = await logged(mock, 'the undo', (e) => e.action === 'archive' && e.body.archived === false);
      assert.deepEqual([unarchived.sessionId, unarchived.status], ['s-invoice', 204]);
      await page.click('[data-toast][data-kind="error"] button[aria-label="Dismiss"]');
      await page.until('the toasts to go', () => !document.querySelector('[data-toast]'));
      assert.equal(await page.eval(sheetOpen), true);
    },
  },
  {
    name: 'P4.13 ? opens Keys with the rows of the KEYS table and Esc closes it; with the delete dialog open ? does nothing',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.key('?');
      const rows = await page.until('the Keys dialog', () =>
        document.querySelector<HTMLDialogElement>('dialog#keys')?.open && [...document.querySelectorAll('dialog#keys dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
      assert.deepEqual(rows, KEYS.map((r) => [r.keys, r.help]));
      assert.equal(await page.eval(() => document.activeElement?.id), 'keys');
      await page.until('the dialog to settle', settled);
      await shot('keys');
      await page.key('Escape');
      await page.until('Keys to close', () => !document.querySelector('dialog#keys[open]'));

      await page.click('[data-tile][data-session="s-invoice"] button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Delete worktree');
      await page.until('the delete dialog', () => !!document.querySelector('dialog#delete-worktree[open]'));
      await page.key('?');
      await sleep(300);
      assert.deepEqual(await page.eval(() => [!!document.querySelector('dialog#keys[open]'), !!document.querySelector('dialog#delete-worktree[open]')]), [false, true]);
    },
  },
  {
    name: 'P4.14 a dropped connection: within 1.5 s the pill reads Reconnecting…, breathes and says since when, then Live again',
    expectedErrors: [/WebSocket/, /ERR_CONNECTION/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the live pill', () => document.querySelector('[data-link="live"]') !== null);
      const start = Date.now();
      await mock.post('/mock/drop', { ms: 3000 });
      try {
        const down = await page.until('the pill to turn reconnecting', pillAt, 'reconnecting');
        assert.ok(Date.now() - start < 1500, `reconnecting after ${Date.now() - start} ms`);
        assert.deepEqual({ ...down, title: undefined }, { link: 'reconnecting', text: 'Reconnecting…', title: undefined, breathing: 'breathe' });
        assert.match(down.title, /^Lost the connection to Agent Board at .+; what you see may be out of date\. Answers you send wait and go out once it is back\.$/);
        await shot('reconnecting');
      } finally {
        await until('the drop to end', () => mock.get('/mock').then(() => true, () => false), 10_000);
      }
      const back = await until('the pill to turn live again', () => page.eval(pillAt, 'live'), 10_000);
      assert.deepEqual({ ...back, breathing: undefined }, { link: 'live', text: 'Live', title: '', breathing: undefined });
    },
  },
  {
    name: 'P4.16 narrow window: no sideways scroll on the Wall or in the sheet, which is full width; New task and the sheet\'s close stay in reach; the reload pill meets nothing else in the top bar and shows its whole text',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.until('New task in reach', reachable, 'button[aria-label="New task"]', '');
      await shot('narrow-wall');

      // A build this tab already reloaded for is offered at once.
      const build = '/assets/index-narrow.js';
      await page.eval((build: string) => {
        const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')!.src;
        sessionStorage.setItem('agent-board:reloaded-for', `${entry} ${new URL(build, location.href).href}`);
      }, build);
      await mock.post('/mock/ui-entry', { src: build });
      await page.until('the reload pill', () => !!document.querySelector('[data-new-version]'));
      const bar = await page.eval(() => {
        const box = (s: string) => document.querySelector(s)?.getBoundingClientRect();
        const pill = document.querySelector<HTMLElement>('[data-new-version]')!;
        const at = pill.getBoundingClientRect();
        const meets = (b: DOMRect | undefined) => !!b && at.left < b.right && b.left < at.right && at.top < b.bottom && b.top < at.bottom;
        const others = ['[data-wordmark]', '[data-link]', '[data-meter]', '[data-repos]', 'nav[aria-label="View"]', 'button[aria-label="New task"]'];
        return { meets: others.filter((s) => meets(box(s))), cut: pill.scrollWidth > pill.clientWidth, inside: at.left >= 0 && at.right <= innerWidth };
      });
      assert.deepEqual(bar, { meets: [], cut: false, inside: true });
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await shot('narrow-reload-pill');
      await page.click('[data-tile][data-session="s-invoice"] a');
      await page.until('the sheet', sheetOpen);
      await page.until('the sheet to settle', settled);
      const sheet = await page.eval(() => {
        const r = document.querySelector('#task-sheet')!.getBoundingClientRect();
        return { left: Math.round(r.left), width: Math.round(r.width), innerWidth };
      });
      assert.deepEqual(sheet, { left: 0, width: sheet.innerWidth, innerWidth: sheet.innerWidth });
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.until('the sheet\'s close in reach', reachable, '#task-sheet button[aria-label^="Back to"]', '');
      await shot('narrow-sheet');
    },
  },
  {
    name: 'P4.17 the reload pill: a new build announced while the New task prompt has focus offers "New version · Reload" after 15 s with the link live; the page\'s own build clears it, another arms it again, and the pill itself reloads while the prompt keeps focus, noting the build it reloaded for',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.click('#new-task-inline textarea');
      await page.type('Fix the login redirect');
      await page.eval(() => void ((window as unknown as Probe).e2eMarker = true));
      const own = await page.eval(() => document.querySelector('script[type="module"][src]')!.getAttribute('src')!);
      const offered = async (build: string) => {
        const at = Date.now();
        await mock.post('/mock/ui-entry', { src: build });
        await sleep(1000);
        assert.deepEqual(await page.eval(reloadState, null), { pill: null, link: 'live', marker: true, prompt: 'Fix the login redirect', typing: true });
        const state = await until('the reload pill', () => page.eval(reloadState, 'pill'), 20_000);
        assert.ok(Date.now() - at >= 14_500, `offered after ${Date.now() - at} ms`);
        assert.deepEqual(state, { pill: 'New version · Reload', link: 'live', marker: true, prompt: 'Fix the login redirect', typing: true });
      };
      await offered('/assets/index-next1.js');
      await shot('reload-pill');
      await mock.post('/mock/ui-entry', { src: own });
      await page.until('the pill to go', () => !document.querySelector('[data-new-version]'));
      await offered('/assets/index-next2.js');
      // Clicked from the page, so the prompt keeps focus: the gate stays shut, and only the pill can reload.
      const typing = await page.eval(() => {
        setTimeout(() => document.querySelector<HTMLButtonElement>('[data-new-version]')!.click());
        return document.activeElement === document.querySelector('#new-task-inline textarea');
      });
      assert.equal(typing, true, 'the prompt lost focus before the pill was clicked');
      await until('the page to reload', async () => {
        try {
          return await page.eval(() => (window as unknown as Probe).e2eMarker === undefined && document.readyState === 'complete');
        } catch {
          return false;
        }
      });
      await page.until('the prompt kept through the reload', () => document.querySelector<HTMLTextAreaElement>('#new-task-inline textarea')?.value === 'Fix the login redirect');
      assert.equal(await page.eval(() => {
        const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')!.src;
        return sessionStorage.getItem('agent-board:reloaded-for') === `${entry} ${new URL('/assets/index-next2.js', location.href).href}`;
      }), true, 'the pill did not note the build it reloaded for');
    },
  },
  {
    name: 'P4.17 the reload pill hides while the board reconnects',
    expectedErrors: [/WebSocket/, /ERR_CONNECTION/],
    async run({ page, mock }) {
      await page.goto(`${mock.url}/wall`);
      await page.click('#new-task-inline textarea');
      await page.type('Fix the login redirect');
      await mock.post('/mock/ui-entry', { src: '/assets/index-next1.js' });
      await until('the reload pill', () => page.eval(() => !!document.querySelector('[data-new-version]')), 20_000);
      await mock.post('/mock/drop', { ms: 3000 });
      try {
        const dropped = await page.until('the board to reconnect', reloadState, 'reconnecting');
        assert.deepEqual([dropped.link, dropped.pill], ['reconnecting', null]);
      } finally {
        await until('the drop to end', () => mock.get('/mock').then(() => true, () => false), 10_000);
      }
      await until('the link to come back', () => page.eval(() => document.querySelector('[data-link="live"]') !== null), 10_000);
    },
  },
  {
    name: 'P4.18 New task keeps one set of fields: a prompt typed on the Wall is in the dialog N opens over the queue, and a reload keeps it',
    async run({ page, mock, shot }) {
      const dialogPrompt = () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#new-task');
        const prompt = d?.querySelector('textarea');
        return d?.open && prompt && { value: prompt.value, focused: document.activeElement === prompt };
      };
      await page.goto(`${mock.url}/wall`);
      await page.click('#new-task-inline textarea');
      await page.type('Typed on the Wall');
      await page.click('nav[aria-label="View"] a', 'Queue');
      await page.until('the queue', () => location.pathname === '/');
      await page.key('n');
      assert.deepEqual(await page.until('the New task dialog', dialogPrompt), { value: 'Typed on the Wall', focused: true });
      await page.until('the dialog to settle', settled);
      await shot('new-task-dialog');
      await page.key('Escape');
      await page.until('the dialog to close', () => !document.querySelector('dialog#new-task[open]'));
      await page.goto(`${mock.url}/`);
      await page.until('the card', card);
      await page.key('n');
      assert.deepEqual(await page.until('the New task dialog after a reload', dialogPrompt), { value: 'Typed on the Wall', focused: true });
    },
  },
  {
    name: 'P4.esc-layers Esc over one file of the diff closes what is on top first: Keys, the ⋯ menu and the delete dialog each close and leave the file on its own; then Esc goes back to all files, and then closes the sheet',
    async run({ page, mock }) {
      await openFromWall(page, mock, 's-invoice');
      await page.key('2');
      await page.until('the file tree', () => document.querySelectorAll('nav[aria-label="Changed files"] a').length === 12);
      await page.click('nav[aria-label="Changed files"] a[title="server/git.ts"]');
      await page.until('server/git.ts whole', wholeFile, 'server/git.ts');
      const layers = () => ({
        keys: !!document.querySelector('dialog#keys[open]'),
        menu: !!document.querySelector('[popover="auto"]:popover-open'),
        delete: !!document.querySelector('dialog#delete-worktree[open]'),
        sheet: !!document.querySelector('#task-sheet:modal'),
        files: document.querySelectorAll('section[data-file]').length,
      });
      const escape = async (what: string, selector: string, open: () => Promise<void>) => {
        await open();
        await page.until(what, (s: string) => !!document.querySelector(s), selector);
        await page.key('Escape');
        await page.until(`${what} to close`, (s: string) => !document.querySelector(s), selector);
        await sleep(150);
        assert.deepEqual(await page.eval(layers), { keys: false, menu: false, delete: false, sheet: true, files: 1 }, what);
        assert.equal(await page.eval(wholeFile, 'server/git.ts'), true, `Esc on ${what} let go of the one file`);
      };
      await escape('Keys', 'dialog#keys[open]', () => page.key('?'));
      await escape('the ⋯ menu', '[popover="auto"]:popover-open', () => page.click('#task-sheet button[aria-label="Session actions"]'));
      await escape('the delete dialog', 'dialog#delete-worktree[open]', async () => {
        await page.click('#task-sheet button[aria-label="Session actions"]');
        await page.click(':popover-open button', 'Delete worktree');
      });
      await page.key('Escape');
      await page.until('all files again', () => document.querySelectorAll('section[data-file]').length === 12);
      assert.equal(await page.eval(sheetOpen), true, 'Esc in one file closed the sheet');
      await page.key('Escape');
      await page.until('the sheet to close', () => !document.querySelector('#task-sheet[open]') && location.pathname === '/wall');
    },
  },
  {
    name: 'P4.close-in-place a sheet loaded in a tab after another page of the board closes in place: the page does not load again, and it says the task is gone',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the card', card);
      await page.goto(`${mock.url}/s/s-nope/overview`);
      await page.until('the sheet to close', () => !document.querySelector('#task-sheet[open]') && location.pathname === '/');
      assert.deepEqual(await page.until('the toast', toastsOf, 'info'), [{ kind: 'info', text: 'That task is gone.', inSheet: false, hit: true }]);
      assert.deepEqual(await page.eval(() => ({
        loaded: new URL(performance.getEntriesByType('navigation')[0].name).pathname,
        at: window.navigation.currentEntry?.index,
        entries: window.navigation.entries().map((e) => new URL(e.url!).pathname),
      })), { loaded: '/s/s-nope/overview', at: 1, entries: ['/', '/'] });
    },
  },
  {
    name: 'P4.branches-once New task\'s two hosts share one read of the branch list: Existing branch and a change of repository each ask the server once, and the dialog shows the same chips',
    async run({ page, mock }) {
      const reads = async (repo: number) => (await mock.log()).filter((e) => e.method === 'GET' && e.path === `/api/repos/${repo}/branches`).length;
      const chips = (host: string) => [...document.querySelectorAll(`${host} [aria-label="Branches"] code`)].map((c) => c.textContent);
      const pick = (repo: string) => {
        const select = document.querySelector<HTMLSelectElement>('#new-task-inline select')!;
        select.value = repo;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      await page.goto(`${mock.url}/wall`);
      await page.until('the New task form', () => !!document.querySelector('#new-task-inline textarea'));
      await page.eval(pick, '1');
      await page.click('#new-task-inline button', 'More options');
      await page.click('#new-task-inline label', 'Existing branch');
      await page.until('the storefront branches', (host: string) => [...document.querySelectorAll(`${host} [aria-label="Branches"] code`)].some((c) => c.textContent === 'guest-cart-merge'), '#new-task-inline');
      await sleep(300);
      assert.equal(await reads(1), 1);
      await page.eval(pick, '2');
      await page.until('the billing-api branches', (host: string) => [...document.querySelectorAll(`${host} [aria-label="Branches"] code`)].some((c) => c.textContent === 'webhook-retries'), '#new-task-inline');
      await sleep(300);
      assert.deepEqual([await reads(1), await reads(2)], [1, 1]);
      assert.deepEqual(await page.eval(chips, 'dialog#new-task'), await page.eval(chips, '#new-task-inline'));
    },
  },
  {
    name: 'P4.delete-stays-closed a delete dialog closed just as its loss check comes back stays closed',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      // The loss check's answer waits until the check lets it through.
      await page.eval(() => {
        const w = window as unknown as { fetch: typeof fetch; e2eRelease: () => void };
        const real = w.fetch.bind(w);
        w.e2eRelease = () => {};
        w.fetch = (input, init) => {
          const response = real(input, init);
          if (!String(input).endsWith('/delete-worktree') || init?.method !== 'GET') return response;
          return new Promise((resolve) => (w.e2eRelease = () => resolve(response)));
        };
      });
      await page.click('[data-tile][data-session="s-invoice"] button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Delete worktree');
      await page.until('the loss check under way', () => !!document.querySelector('dialog#delete-worktree[open]')?.textContent?.includes('Checking'));
      // Closed the moment the answer is drawn, before the effects of that render run.
      await page.eval(() => {
        const dialog = document.querySelector<HTMLDialogElement>('dialog#delete-worktree')!;
        const drawn = new MutationObserver(() => {
          if (dialog.textContent?.includes('Checking')) return;
          drawn.disconnect();
          dialog.close();
        });
        drawn.observe(dialog, { subtree: true, childList: true, characterData: true });
        (window as unknown as { e2eRelease: () => void }).e2eRelease();
      });
      await sleep(400);
      assert.equal(await page.eval(() => !!document.querySelector('dialog#delete-worktree[open]')), false, 'the dialog opened again');
    },
  },
  {
    name: 'S1.ui-entry-sticky an entry /mock/ui-entry names is named again by every later push (none on --legacy) and to every socket that opens later, until {src: null} or a scenario load clears it',
    async run({ page, mock }) {
      const { legacy } = await mock.get('/mock');
      type Sockets = Record<string, { uiEntry?: string | null; sessions: { id: string; title: string | null }[] }[]>;
      const openSocket = (name: string) => {
        const w = window as unknown as { e2eSockets?: Sockets };
        const messages: Sockets[string] = [];
        (w.e2eSockets ??= {})[name] = messages;
        new WebSocket(`ws://${location.host}/ws/events`).onmessage = (e) => messages.push(JSON.parse(e.data));
      };
      // Once the socket has had `n` messages: whether each names an entry, which one, and the title of s-reviews.
      const heardOn = (name: string, n: number) => {
        const messages = (window as unknown as { e2eSockets?: Sockets }).e2eSockets?.[name] ?? [];
        return messages.length >= n && messages.map((m) => ({ carries: 'uiEntry' in m, uiEntry: m.uiEntry ?? null, title: m.sessions.find((s) => s.id === 's-reviews')?.title ?? null }));
      };
      const heard = (name: string, n: number) => page.until(`socket ${name} to get ${n} messages`, heardOn, name, n);
      const open = async (name: string) => {
        await page.eval(openSocket, name);
        await heard(name, 1);
      };

      // Not the board, which would reload into the entry named.
      await page.goto(`${mock.url}/mock`);
      await open('a');
      const [{ uiEntry: entry, title }] = await heard('a', 1);
      assert.match(entry ?? '', /^\/assets\/index-[\w-]+\.js$/);
      const src = '/assets/index-sticky.js';
      const [once, twice] = [`${title}, patched`, `${title}, patched again`];
      await mock.post('/mock/ui-entry', { src });
      await mock.post('/mock/patch', { id: 's-reviews', patch: { title: once } });
      await open('b');
      await mock.post('/mock/ui-entry', { src: null });
      await mock.post('/mock/patch', { id: 's-reviews', patch: { title: twice } });
      await open('c');
      await mock.post('/mock/ui-entry', { src });
      await mock.post('/mock/scenario/queue');
      await open('d');

      const told = (uiEntry: string | null, title: string | null) => ({ carries: true, uiEntry, title });
      const pushed = (uiEntry: string | null, title: string | null) => (legacy ? { carries: false, uiEntry: null, title } : told(uiEntry, title));
      assert.deepEqual(await heard('a', 7), [
        told(entry, title), told(src, title), pushed(src, once), told(entry, once), pushed(entry, twice), told(src, twice), pushed(entry, title),
      ]);
      assert.deepEqual(await heard('b', 5), [told(src, once), told(entry, once), pushed(entry, twice), told(src, twice), pushed(entry, title)]);
      assert.deepEqual(await heard('c', 3), [told(entry, twice), told(src, twice), pushed(entry, title)]);
      assert.deepEqual(await heard('d', 1), [told(entry, title)]);
    },
  },
  {
    name: 'S1.new-task a New task with a prompt is working right after it is made, with no step yet (Thinking on --legacy) and its clock from that moment',
    async run({ mock }) {
      const { legacy } = await mock.get('/mock');
      const before = Date.now();
      const { sessionId } = await mock.post('/api/worktrees', { repoId: 1, name: 'starting-step', prompt: 'Make the cart test stop flaking', startClaude: true });
      const after = Date.now();
      const s = (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === sessionId);
      assert.deepEqual([s.status, s.activity.step], ['working', legacy ? 'Thinking' : null]);
      assert.ok(s.activity.since >= before && s.activity.since <= after, `the clock runs from ${s.activity.since}, not from the New task at ${before}–${after}`);
    },
  },
  {
    name: 'P5.1.1 the first card is s-cart, an ask, with Retry failed webhooks and Group board tiles by repo peeking out behind it and the sliver; its meter segment is the current one, 40 px wide',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      assert.deepEqual(await page.eval(() => [document.querySelector<HTMLElement>('[data-card]')?.dataset.kind, document.title]), ['ask', '(3) Agent Board']);
      assert.deepEqual((await page.eval(peeks)).map((p) => [p.peek, p.session, p.text.split('\n')[0]]), [
        ['1', 's-hooks', 'Retry failed webhooks'], ['2', 's-group', 'Group board tiles by repo'],
      ]);
      assert.equal(await page.eval(() => !!document.querySelector('[data-sliver]')), true);
      const segments = await page.until('the current segment at full width', () => {
        const all = [...document.querySelectorAll<HTMLElement>('[data-segment]')].map((s) => ({ session: s.dataset.session, current: s.hasAttribute('data-current'), width: s.getBoundingClientRect().width }));
        return all[0]?.width === 40 && all;
      });
      assert.deepEqual(segments.map((s) => [s.session, s.current]), [
        ['s-cart', true], ['s-hooks', false], ['s-group', false], ['s-astro', false], ['s-reviews', false], ['s-anchors', false],
      ]);
      await page.until('the card to settle', still);
      await shot('queue-ask');
    },
  },
  {
    name: 'P5.1.2 the card header names the task, Overview, Diff and Artifacts 2 but no repo or branch; the meta has the rank reason and no rank number; Artifacts 2, O and D open the sheet',
    async run({ page, mock }) {
      await openQueue(page, mock);
      const { header } = (await page.eval(card))!;
      for (const text of ['Merge guest cart on login', 'Overview', 'Diff', 'Artifacts 2', 'Blocks the checkout fix; Claude idles until you answer']) assert.ok(header.includes(text), `the header lacks ${text}:\n${header}`);
      for (const text of ['storefront', 'guest-cart-merge']) assert.ok(!header.includes(text), `the header names ${text}`);
      assert.doesNotMatch(header, /#\d/);
      const closed = () => !document.querySelector('#task-sheet[open]') && location.pathname === '/';
      await page.click('[data-card] header button', 'Artifacts 2');
      await page.until('the Artifacts tab', () => location.pathname === '/s/s-cart/artifacts' && !!document.querySelector('#task-sheet:modal'));
      await page.key('Escape');
      await page.until('the sheet to close', closed);
      await page.key('o');
      await page.until('Overview', () => location.pathname === '/s/s-cart/overview' && !!document.querySelector('#task-sheet:modal'));
      await page.key('Escape');
      await page.until('the sheet to close', closed);
      await page.key('d');
      await page.until('Diff', () => location.pathname === '/s/s-cart/diff' && !!document.querySelector('#task-sheet:modal'));
    },
  },
  {
    name: 'P5.1.3 the whole card fits the window and the page does not scroll: Worth knowing, the headline, the brief, the details, all three options with their descriptions and the suggestion show',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.until('the card to settle', still);
      const fit = await page.eval(() => ({ card: !!document.querySelector('[data-card]'), scroll: document.scrollingElement!.scrollHeight, height: innerHeight }));
      assert.equal(fit.scroll, fit.height, 'the page scrolls');
      const parts = [
        '[data-card]', '[data-card] [data-know]', '[data-card] h1', '[data-card] h1 + p', '[data-card] section[aria-label="Claude\'s details"]',
        '[data-card] [data-option="1"]', '[data-card] [data-option="2"]', '[data-card] [data-option="3"]', '[data-card] [data-suggestion]', '[data-card] [data-primary]',
      ];
      for (const selector of parts) assert.equal(await page.eval(whole, selector), true, `${selector} does not show whole`);
      const options = await page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-card] [data-option]')].map((o) => o.innerText.split('\n').slice(0, 2)));
      assert.deepEqual(options.map((o) => o[0]), ['1', '2', '3']);
      const text = (await page.eval(card))!.text;
      for (const part of [
        'Guest carts live in a cookie that expires after 24 h', 'What should happen to a guest cart when the shopper logs in?', 'Both carts can hold items; today the guest cart is silently dropped.',
        "CLAUDE'S DETAILS", 'Add up quantities per product, capped at stock; a toast lists anything trimmed', 'Drop the guest cart as today, but tell the shopper',
        'A choice dialog after login; one more step before checkout',
      ]) assert.ok(text.includes(part), `the card lacks ${part}`);
      await shot('queue-fit');
    },
  },
  {
    name: 'P5.1.4 option 1 carries Second opinion · 82% and Recommended, the reply, the reasoning, Edit E and high confidence, with the frozen highlight; the primary reads Accept suggestion',
    async run({ page, mock }) {
      await openQueue(page, mock);
      const first = await page.eval(() => {
        const option = document.querySelector('[data-card] [data-option="1"]')!.parentElement as HTMLElement;
        return { frozen: option.hasAttribute('data-frozen'), others: [...document.querySelectorAll('[data-card] [data-option]')].filter((o) => o.parentElement!.hasAttribute('data-frozen')).length, text: option.innerText };
      });
      assert.deepEqual([first.frozen, first.others], [true, 1]);
      for (const part of [
        'Second opinion · 82%', 'Recommended', 'Merge both carts. Cap each line at available stock and show a toast listing anything trimmed.',
        'CHK-412 says a cart must never lose items', 'Edit\nE', 'high confidence',
      ]) assert.ok(first.text.includes(part), `option 1 lacks ${part}:\n${first.text}`);
      assert.equal((await page.eval(card))!.primary, 'Accept suggestion');
    },
  },
  {
    name: 'P5.1.5 → skips to s-hooks, a menu whose questions stand side by side numbered 1–3 and 4–6 over the band Second opinion · 64% · medium, and focus moves onto it from the card that went; five more come back to s-cart, and ← brings the last card, Fix broken doc anchors',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.eval(() => document.querySelector<HTMLElement>('[data-card] [data-option="2"]')!.focus());
      await page.key('ArrowRight');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.equal(await page.eval(() => (document.activeElement as HTMLElement | null)?.dataset.session ?? document.activeElement?.tagName), 's-hooks');
      const menu = await page.eval(() => ({
        columns: [...document.querySelectorAll('[data-card] section[role="group"]')].map((q) => [...q.querySelectorAll<HTMLElement>('[data-option]')].map((o) => o.dataset.option)),
        tops: [...document.querySelectorAll('[data-card] section[role="group"]')].map((q) => Math.round(q.getBoundingClientRect().top)),
        band: document.querySelector<HTMLElement>('[data-card] [data-advice]')?.innerText ?? '',
      }));
      assert.deepEqual(menu.columns, [['1', '2', '3'], ['4', '5', '6']]);
      assert.equal(menu.tops[0], menu.tops[1], 'the questions are not side by side');
      assert.match(menu.band, /^Second opinion · 64% · medium/);
      await page.until('the card to settle', still);
      await shot('queue-menu');
      for (const id of ['s-group', 's-astro', 's-reviews', 's-anchors', 's-cart']) {
        await page.key('ArrowRight');
        await page.until(`${id} at the front`, frontIs, id);
      }
      await page.key('ArrowLeft');
      await page.until('the last card at the front', frontIs, 's-anchors');
      assert.match((await page.eval(card))!.label ?? '', /^Fix broken doc anchors · Your turn$/);
    },
  },
  {
    name: 'P5.1.6 Space hides the details and the toggle reads Show; → then ← brings s-cart back with its details shown',
    async run({ page, mock }) {
      await openQueue(page, mock);
      const details = () => {
        const section = document.querySelector<HTMLElement>('[data-card] section[aria-label="Claude\'s details"]');
        const toggle = section?.querySelector('button');
        return section && { shown: section.innerText.includes('CartService.mergeOnLogin'), toggle: toggle?.textContent, expanded: toggle?.getAttribute('aria-expanded') };
      };
      assert.deepEqual(await page.eval(details), { shown: true, toggle: 'Hide Space', expanded: 'true' });
      await page.key(' ');
      assert.deepEqual(await page.until('the details hidden', () => {
        const section = document.querySelector<HTMLElement>('[data-card] section[aria-label="Claude\'s details"]');
        return section && !section.innerText.includes('CartService.mergeOnLogin') && { toggle: section.querySelector('button')?.textContent, expanded: section.querySelector('button')?.getAttribute('aria-expanded') };
      }), { toggle: 'Show Space', expanded: 'false' });
      await page.key('ArrowRight');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('ArrowLeft');
      await page.until('s-cart again', frontIs, 's-cart');
      assert.deepEqual(await page.eval(details), { shown: true, toggle: 'Hide Space', expanded: 'true' });
    },
  },
  {
    name: 'P5.1.7 Elaborate: Y opens the explanation below the details, which stay, and asks for it once; it arrives about 1.2 s later; Y closes it. On s-group it fails with Could not explain: … and Retry asks again',
    async run({ page, mock, shot }) {
      await mock.post('/mock/patch', { id: 's-cart', patch: { explanation: null } });
      await openQueue(page, mock);
      await page.key('y');
      const below = (text: string) => {
        const why = document.querySelector<HTMLElement>('[data-card] [data-elaborate]');
        const details = document.querySelector<HTMLElement>('[data-card] section[aria-label="Claude\'s details"]');
        return !!why && !!details && why.innerText.includes(text) && details.innerText.includes('CartService.mergeOnLogin') &&
          !!(details.compareDocumentPosition(why) & Node.DOCUMENT_POSITION_FOLLOWING) && details.parentElement === why.parentElement;
      };
      await page.until('the explanation loading below the details', below, 'Reading the code to explain this…');
      const [asked] = await logged(mock, 'the request for the explanation', (e) => e.action === 'elaborate');
      assert.deepEqual([asked.sessionId, asked.body, asked.status], ['s-cart', { key: 'q:toolu_01Cart' }, 204]);
      await page.until('the explanation', below, 'Background.');
      const took = Date.now() - asked.at;
      assert.ok(took > 900 && took < 3000, `the explanation came ${took} ms after the request`);
      assert.equal(await page.eval(() => document.querySelector('[data-card] footer button[aria-pressed="true"]')?.textContent), 'Elaborate Y');
      await page.until('the card to settle', still);
      await shot('queue-elaborate');
      await page.key('y');
      await page.until('the explanation to close', () => !document.querySelector('[data-card] [data-elaborate]'));
      assert.equal(await page.eval(() => document.querySelector<HTMLElement>('[data-card] section[aria-label="Claude\'s details"]')?.innerText.includes('CartService.mergeOnLogin')), true);
      assert.equal((await mock.log()).filter((e) => e.action === 'elaborate').length, 1);

      await page.click('[data-peek="2"] > span');
      await page.until('s-group at the front', frontIs, 's-group');
      await page.key('y');
      const failed = await page.until('the failure', () => {
        const why = document.querySelector<HTMLElement>('[data-card] [data-elaborate="failed"]');
        return why?.innerText.includes('Retry') && why.innerText;
      });
      assert.match(failed, /Could not explain: the explanation run timed out after 300 s/);
      await page.click('[data-card] [data-elaborate] button', 'Retry');
      const asks = await until('the second request', async () => {
        const found = (await mock.log()).filter((e) => e.action === 'elaborate' && e.sessionId === 's-group' && e.status !== null);
        return found.length === 2 && found;
      });
      assert.deepEqual(asks.map((e) => [e.body.key, e.status]), [['s:t-group-4', 204], ['s:t-group-4', 204]]);
    },
  },
  {
    name: 'P5.1.8 W opens the reply box, focused; /re lists /review and /rename, Esc closes only the list, Tab completes "/rename ", and a second Esc closes the box and focuses the card',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.until('the guard to end', () => !document.querySelector('[data-primary][data-guarded]'));
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('/re');
      const listed = () => {
        const list = [...document.querySelectorAll('[data-card] [role="listbox"] [role="option"] code')].map((c) => c.textContent);
        return list.length ? list : null;
      };
      const list = await page.until('the command list', listed);
      assert.ok(list.includes('/rename') && list.includes('/review'), list.join(', '));
      await page.until('the card to settle', still);
      await shot('queue-composer');
      await page.key('Escape');
      await page.until('the list to close', () => !document.querySelector('[data-card] [role="listbox"]'));
      const box = () => ({ value: document.querySelector<HTMLTextAreaElement>('[data-card] textarea')?.value ?? null, focused: document.activeElement?.matches('[data-card] textarea') ?? false });
      assert.deepEqual(await page.eval(box), { value: '/re', focused: true });
      await page.type('n');
      assert.deepEqual(await page.until('the list again', listed), ['/rename']);
      await page.key('Tab');
      assert.deepEqual(await page.until('the completion', () => document.querySelector<HTMLTextAreaElement>('[data-card] textarea')?.value === '/rename ' && !document.querySelector('[data-card] [role="listbox"]') && true), true);
      await page.key('Escape');
      await page.until('the box to close and the card to take focus', () => !document.querySelector('[data-card] textarea') && document.activeElement?.hasAttribute('data-card'));
    },
  },
  {
    name: 'P5.1.9 E opens the reply box with the second opinion\'s reply, focused',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.until('the guard to end', () => !document.querySelector('[data-primary][data-guarded]'));
      await page.key('e');
      const box = await page.until('the reply box', () => {
        const field = document.querySelector<HTMLTextAreaElement>('[data-card] textarea');
        return field && { value: field.value, focused: document.activeElement === field };
      });
      assert.deepEqual(box, { value: 'Merge both carts. Cap each line at available stock and show a toast listing anything trimmed.', focused: true });
    },
  },
  {
    name: 'P5.1.10 a click on peek 2 brings s-group to the front; the 5th meter segment shows Lazy-load product reviews as a Your-turn card with its summary, latest reply, Status, the reply box, Reply ↵ and Archive X',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await page.until('s-group at the front', frontIs, 's-group');
      await page.click('[data-segment]:nth-child(5)');
      await page.until('s-reviews at the front', frontIs, 's-reviews');
      const shown = (await page.eval(card))!;
      assert.deepEqual([shown.kind, shown.label, shown.primary], ['idle', 'Lazy-load product reviews · Your turn', 'Reply']);
      for (const part of [
        'Reviews now load when scrolled into view', "CLAUDE'S LATEST REPLY", 'The reviews section now loads when it comes within 600 px', 'STATUS', 'Reviews split into a lazy chunk (41 kB)', 'MESSAGE CLAUDE', 'Archive\nX',
      ]) assert.ok(shown.text.includes(part), `the card lacks ${part}`);
      assert.equal(await page.eval(() => !!document.querySelector('[data-card] textarea') && !!document.querySelector('[data-card] table')), true);
      await page.until('the card to settle', still);
      await shot('queue-your-turn');
    },
  },
  {
    name: 'P5.1.11 Needs focus: Migrate docs to Astro 5 says Claude shows a permission prompt in its terminal, the plate names the tty and the subject, and ⏎ (Terminal) asks for the terminal at once',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-astro"]');
      await page.until('s-astro at the front', frontIs, 's-astro');
      const shown = (await page.eval(card))!;
      assert.deepEqual([shown.kind, shown.primary], ['prompt', 'Terminal']);
      assert.ok(shown.text.includes('Claude is showing a permission prompt for Bash(pnpm dlx @astrojs/upgrade) in its terminal'), shown.text);
      assert.ok(shown.text.includes('Claude’s terminal · /dev/ttys017\nBash(pnpm dlx @astrojs/upgrade)'), shown.text);
      await page.until('the card to settle', still);
      await shot('queue-needs-focus');
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.until('the guard to end', () => !document.querySelector('[data-primary][data-guarded]'));
      const pressed = Date.now();
      await page.key('Enter');
      const [focus] = await logged(mock, 'the terminal request', (e) => e.action === 'focus');
      assert.deepEqual([focus.sessionId, focus.status], ['s-astro', 204]);
      assert.ok(focus.at - pressed < 1000, `asked for the terminal ${focus.at - pressed} ms after ⏎`);
    },
  },
  {
    name: 'P5.1.12 with s-hooks at the front an urgent new decision arrives: the front stays, the Just-in chip names it and its segment is marked; the chip brings it to the front and goes',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.key('ArrowRight');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      const label = (await page.eval(card))!.label;
      await mock.post('/mock/add', { template: 'ask', id: 's-new', rank: 1 });
      const chip = await page.until('the Just-in chip', () => document.querySelector<HTMLElement>('[data-justin]')?.innerText.trim());
      assert.equal(chip, 'Just in: Retire the v1 orders API');
      assert.equal((await page.eval(card))!.label, label);
      assert.deepEqual((await page.eval(segmentsNow)).filter((s) => s.new).map((s) => s.session), ['s-new']);
      await page.click('[data-justin]');
      await page.until('s-new at the front', frontIs, 's-new');
      await page.until('the chip to go', () => !document.querySelector('[data-justin]') && !document.querySelector('[data-segment][data-new]'));
    },
  },
  {
    name: 'P5.1.13 when s-hooks, at the front, stops waiting for a reason outside the page, the card after it comes up and a toast says Retry failed webhooks no longer waits',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.key('ArrowRight');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await mock.post('/mock/patch', { id: 's-hooks', patch: { menu: null, status: 'working' } });
      await page.until('s-group at the front', frontIs, 's-group');
      assert.deepEqual(await page.until('the toast', toastsOf, 'info'), [{ kind: 'info', text: 'Retry failed webhooks no longer waits', inSheet: false, hit: true }]);
    },
  },
  {
    name: 'P5.1.14 a new decision on s-cart, at the front, updates it in place: its key is q:toolu_02, it reads Updated just now, and the guard holds the primary for about 0.9 s',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.until('the guard to end', () => !document.querySelector('[data-primary][data-guarded]'));
      const before = (await page.eval(card))!;
      await mock.post('/mock/patch', {
        id: 's-cart',
        patch: { question: { toolUseId: 'toolu_02', title: 'Merge the carts for app logins too?', options: [{ label: 'Yes, everywhere' }, { label: 'Only on the web' }] } },
      });
      const sent = Date.now();
      const updated = await page.until('the update', () => {
        const c = document.querySelector<HTMLElement>('[data-card]');
        return c?.dataset.key === 'q:toolu_02' && !!c.querySelector('[data-primary][data-guarded]') && { session: c.dataset.session, label: c.getAttribute('aria-label'), text: c.querySelector('header')!.innerText };
      });
      assert.deepEqual([updated.session, updated.label], ['s-cart', before.label]);
      assert.match(updated.text, /Updated just now/);
      await page.until('the guard to end', () => !document.querySelector('[data-primary][data-guarded]'));
      const held = Date.now() - sent;
      assert.ok(held > 700 && held < 1600, `the guard ended ${held} ms after the update`);
      assert.match((await page.eval(card))!.text, /Merge the carts for app logins too\?[\s\S]*Yes, everywhere[\s\S]*Only on the web/);
      await shot('queue-updated');
    },
  },
  {
    name: 'P5.1.15 a reload keeps the card at the front: s-group, brought up by a click on its peek, is still there',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await page.until('s-group at the front', frontIs, 's-group');
      await page.goto(`${mock.url}/`);
      await page.until('the card', card);
      assert.equal((await page.eval(card))!.session, 's-group');
    },
  },
  {
    name: 'P5.1.16 with nothing waiting / reads Nothing needs you. with the Queue toggle off; a decision that arrives brings the queue with it at the front',
    scenario: 'zero',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the resting Wall', () => document.querySelector('main h1')?.textContent === 'Nothing needs you.');
      assert.deepEqual(await page.eval(() => [location.pathname, document.querySelector('nav[aria-label="View"] a[aria-label="Queue"]')?.getAttribute('aria-disabled'), !!document.querySelector('[data-card]')]), ['/', 'true', false]);
      await shot('queue-zero');
      await mock.post('/mock/add', { template: 'ask', id: 's-new', rank: 1 });
      await page.until('the new card at the front', frontIs, 's-new');
      assert.deepEqual(await page.eval(() => [location.pathname, document.querySelector('nav[aria-label="View"] a[aria-label="Queue"]')?.getAttribute('aria-disabled') ?? null]), ['/', null]);
    },
  },
  {
    name: 'P5.1.17 an ended session with an open question stays out of the deck, the meter and the tab title, and is on the Wall as Ended',
    scenario: 'ended-question',
    async run({ page, mock }) {
      await openQueue(page, mock);
      assert.deepEqual((await page.eval(segmentsNow)).map((s) => s.session), ['s-cart', 's-hooks', 's-group', 's-astro', 's-reviews', 's-anchors']);
      assert.equal(await page.eval(() => document.title), '(3) Agent Board');
      for (let i = 0; i < 6; i++) {
        assert.notEqual((await page.eval(card))!.session, 's-gone');
        await page.key('ArrowRight');
        await page.until('the next card', () => !document.documentElement.dataset.deal);
      }
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      assert.equal(await page.eval(() => document.querySelector('[data-tile][data-session="s-gone"]')?.getAttribute('data-attention')), 'exited');
    },
  },
  {
    name: 'P5.1.18 long details and eight options: the left column scrolls inside the card, and the options and the footer stay in view',
    scenario: 'long',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.until('the card to settle', still);
      const left = await page.eval(() => {
        const column = document.querySelector('[data-card] [data-side="left"]')!;
        return { scrolls: column.scrollHeight > column.clientHeight + 20, page: document.scrollingElement!.scrollHeight === innerHeight, options: document.querySelectorAll('[data-card] [data-option]').length };
      });
      assert.deepEqual(left, { scrolls: true, page: true, options: 8 });
      for (const selector of ['[data-card] [data-primary]', '[data-card] [data-option="1"]', '[data-card] [data-option="2"]']) {
        assert.equal(await page.eval(whole, selector), true, `${selector} is out of view`);
      }
      await shot('queue-long');
    },
  },
  {
    name: 'P5.1.19 a second opinion still running shows a spinner, a ticking clock, the step and Stop, which stops it at once; Retry asks again; on a menu the band shows running and failed too',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await page.until('s-group at the front', frontIs, 's-group');
      const running = () => {
        const box = document.querySelector<HTMLElement>('[data-card] [data-advice="running"]');
        return box && { text: box.innerText, spinner: !!box.querySelector('[aria-hidden]'), clock: box.querySelector('strong + span')?.textContent ?? null };
      };
      const first = await page.until('the running second opinion', running);
      assert.match(first.text, /^Second opinion in progress\s+\d+:\d\d\s+Stop\s+Read web\/src\/order\.ts$/);
      assert.equal(first.spinner, true);
      await sleep(1100);
      assert.notEqual((await page.eval(running))?.clock, first.clock, 'the clock did not tick');
      await page.until('the card to settle', still);
      await shot('queue-advice-running');
      const pressed = Date.now();
      await page.click('[data-card] [data-advice] button', 'Stop');
      const [stop] = await logged(mock, 'the stop', (e) => e.action === 'stop-advice');
      assert.deepEqual([stop.sessionId, stop.body, stop.status], ['s-group', { key: 's:t-group-4' }, 204]);
      assert.ok(stop.at - pressed < 1000, `stopped ${stop.at - pressed} ms after the press`);
      const stopped = await page.until('the stopped box', () => document.querySelector<HTMLElement>('[data-card] [data-advice="failed"]')?.innerText);
      assert.match(stopped, /^Second opinion stopped\s+Retry$/);
      await page.click('[data-card] [data-advice] button', 'Retry');
      const [retry] = await logged(mock, 'the retry', (e) => e.action === 'retry-advice');
      assert.deepEqual([retry.sessionId, retry.body, retry.status], ['s-group', { key: 's:t-group-4' }, 204]);

      await mock.post('/mock/advice', { id: 's-hooks', state: 'thinking' });
      await page.click('[data-segment][data-session="s-hooks"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      const band = await page.until('the band running', running);
      assert.match(band.text, /^Second opinion in progress\s+\d+:\d\d\s+Stop\s+Read the changed files$/);
      await mock.post('/mock/advice', { id: 's-hooks', state: 'failed' });
      const failed = await page.until('the band failed', () => document.querySelector<HTMLElement>('[data-card] [data-advice="failed"]')?.innerText);
      assert.match(failed, /^Second opinion failed: the advisor gave an empty answer\s+Retry$/);
      await page.until('the card to settle', still);
      await shot('queue-menu-advice-failed');
    },
  },
  {
    name: 'P5.1.20 N opens New task over the queue with the prompt focused and Esc closes it; V goes to the Wall and back; on the Wall a waiting tile brings its card to the front and a working one opens its sheet over the Wall',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.key('n');
      await page.until('New task, its prompt focused', () => !!document.querySelector<HTMLDialogElement>('dialog#new-task')?.open && document.activeElement === document.querySelector('dialog#new-task textarea'));
      await page.key('Escape');
      // The prompt keeps focus while the dialog fades out.
      await page.until('the dialog to close', () => !document.querySelector('dialog#new-task[open]') && !document.activeElement?.closest('dialog'));
      await page.key('v');
      await page.until('the Wall', () => location.pathname === '/wall' && document.querySelectorAll('[data-tile]').length > 0);
      await page.key('v');
      await page.until('the queue', () => location.pathname === '/' && !!document.querySelector('[data-card]'));
      await page.key('v');
      await page.until('the Wall', () => location.pathname === '/wall' && document.querySelectorAll('[data-tile]').length > 0);
      await page.click('[data-tile][data-session="s-group"] p');
      await page.until('s-group at the front of the queue', () => location.pathname === '/' && document.querySelector<HTMLElement>('[data-card]')?.dataset.session === 's-group');
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await page.click('[data-tile][data-session="s-invoice"] p');
      await page.until('the sheet over the Wall', () => location.pathname === '/s/s-invoice/overview' && !!document.querySelector('#task-sheet:modal') &&
        (window.navigation.currentEntry?.getState() as { base?: string } | undefined)?.base === '/wall');
    },
  },
  {
    name: 'P5.1.21 typing in New task on the resting Wall while a session arrives: the queue waits, so "we fix 3 x" and Enter stay in the prompt; nothing is held, archived or undone; once focus leaves, the card comes up',
    scenario: 'zero',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the resting Wall', () => document.querySelector('main h1')?.textContent === 'Nothing needs you.');
      await page.click('#new-task-inline textarea');
      await page.type('Fix the login ');
      await mock.post('/mock/add', { template: 'idle', id: 's-idle' });
      await page.until('the arrival in the meter', () => !!document.querySelector('[data-segment][data-session="s-idle"]'));
      for (const key of 'we fix 3 x') await page.key(key);
      await page.key('Enter');
      await sleep(300);
      const held = await page.eval(() => ({
        sub: document.querySelector('main h1 + p')?.textContent,
        card: !!document.querySelector('[data-card]'),
        value: document.querySelector<HTMLTextAreaElement>('#new-task-inline textarea')?.value,
        focused: document.activeElement === document.querySelector('#new-task-inline textarea'),
        toasts: [...document.querySelectorAll('[data-toast]')].length,
      }));
      assert.deepEqual(held, { sub: '1 finished turn waits in the queue.', card: false, value: 'Fix the login we fix 3 x\n', focused: true, toasts: 0 });
      assert.deepEqual((await mock.log()).filter((e) => e.path.startsWith('/api/sessions/')), []);
      await shot('queue-waits-for-typing');
      await page.click('main h1');
      await page.until('the card once focus left', frontIs, 's-idle');
      await sleep(300);
      assert.deepEqual((await mock.log()).filter((e) => e.path.startsWith('/api/sessions/')), []);
    },
  },
  {
    name: 'P5.1.22 a menu answered from the board but still open 10 s later is Needs focus: Claude still shows its menu in the terminal, and ⏎ opens the terminal',
    scenario: 'menu-stuck',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-hooks"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      const shown = (await page.eval(card))!;
      assert.deepEqual([shown.kind, shown.label, shown.primary], ['prompt', 'Retry failed webhooks · Needs focus', 'Terminal']);
      assert.ok(shown.text.includes('Claude still shows its menu in the terminal'), shown.text);
      await page.until('the card to settle', still);
      await shot('queue-menu-stuck');
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.until('the guard to end', () => !document.querySelector('[data-primary][data-guarded]'));
      await page.key('Enter');
      const [focus] = await logged(mock, 'the terminal request', (e) => e.action === 'focus');
      assert.deepEqual([focus.sessionId, focus.status], ['s-hooks', 204]);
    },
  },
  {
    name: 'P5.1.23 s-group waits for its second opinion with the primary off as Pick an option; when the advice finishes it becomes what ⏎ sends: Suggestion ready · Accept, guarded about 0.9 s, its option highlighted',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await page.until('s-group at the front', frontIs, 's-group');
      await page.until('the guard to end', () => !document.querySelector('[data-primary][data-guarded]'));
      assert.deepEqual(await page.eval(() => {
        const c = document.querySelector<HTMLElement>('[data-card]')!;
        return [c.querySelector('[data-primary]')?.firstElementChild?.textContent, c.querySelector<HTMLButtonElement>('[data-primary]')?.disabled, c.querySelectorAll('[data-frozen]').length];
      }), ['Pick an option', true, 0]);
      await mock.post('/mock/advice', { id: 's-group', state: 'done', choice: 'By attention', confidence: 74 });
      const done = Date.now();
      const relabelled = await page.until('the relabel', () => {
        const c = document.querySelector<HTMLElement>('[data-card]')!;
        const p = c.querySelector<HTMLButtonElement>('[data-primary]')!;
        return p.hasAttribute('data-guarded') && {
          label: p.firstElementChild?.textContent, disabled: p.disabled,
          frozen: [...c.querySelectorAll('[data-frozen] [data-option]')].map((o) => o.textContent?.slice(0, 13)),
        };
      });
      assert.deepEqual(relabelled, { label: 'Suggestion ready · Accept', disabled: false, frozen: ['1By attention'] });
      await page.until('the guard to end', () => !document.querySelector('[data-primary][data-guarded]'));
      const held = Date.now() - done;
      assert.ok(held > 700 && held < 1600, `the guard ended ${held} ms after the advice finished`);
      await page.until('the card to settle', still);
      await shot('queue-suggestion-ready');
    },
  },
  {
    name: 'P5.1.24 narrow window: the queue has no sideways scroll and its primary stays in reach',
    narrow: true,
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.until('the card to settle', still);
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      assert.equal(await page.eval(() => {
        const r = document.querySelector('[data-primary]')!.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }), true, 'the primary is not in the window at the top of the page');
      await shot('narrow-queue');
      await page.until('the primary in reach', reachable, '[data-primary]', '');
      await page.click('[data-segment][data-session="s-hooks"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.until('the primary in reach', reachable, '[data-primary]', '');
      await shot('narrow-queue-menu');
    },
  },
  {
    name: 'P5.1.wall-age at rest a Wall tile\'s age ends at the tile\'s padding edge, where its ⋯ shows instead on hover',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      const gaps = await page.eval(() => [...document.querySelectorAll<HTMLElement>('[data-tile]')].filter((t) => t.checkVisibility()).map((t) => {
        const style = getComputedStyle(t);
        const edge = t.getBoundingClientRect().right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
        const age = t.querySelector('[data-age]')!.getBoundingClientRect();
        return Math.round((edge - age.right) * 10) / 10;
      }));
      assert.ok(gaps.length >= 11);
      assert.deepEqual(gaps.filter((g) => Math.abs(g) > 0.5), [], `ages end ${gaps.join(', ')} px from the padding edge`);
      const tile = '[data-tile][data-session="s-invoice"]';
      const box = await page.eval((tile: string) => {
        const r = document.querySelector(`${tile} p`)!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, tile);
      await page.pointAt(box.x, box.y);
      await page.until('the ⋯ in the age\'s place', (tile: string) => {
        const menu = document.querySelector<HTMLElement>(`${tile} button[aria-label="Session actions"]`)!;
        const age = document.querySelector<HTMLElement>(`${tile} [data-age]`)!;
        return getComputedStyle(menu.parentElement!).opacity === '1' && getComputedStyle(age).opacity === '0';
      }, tile);
    },
  },  {
    name: 'P5.1.n1-card typing in the reply box holds the card as it is: a new decision on it waits, then updates it in place with the same box and draft; the card leaving waits too, with word that it no longer waits, until focus leaves',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.until('the guard to end', () => !document.querySelector('[data-primary][data-guarded]'));
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('only if stock');
      await page.eval(() => void ((window as unknown as { e2eField?: Element }).e2eField = document.querySelector('[data-card] textarea')!));
      const box = () => {
        const field = document.querySelector<HTMLTextAreaElement>('[data-card] textarea');
        return {
          session: document.querySelector<HTMLElement>('[data-card]')?.dataset.session, key: document.querySelector<HTMLElement>('[data-card]')?.dataset.key,
          value: field?.value, focused: !!field && document.activeElement === field, same: !!field && field === (window as unknown as { e2eField?: Element }).e2eField,
        };
      };
      await mock.post('/mock/patch', { id: 's-cart', patch: { question: { toolUseId: 'toolu_02', title: 'Merge the carts for app logins too?' } } });
      await until('the new decision in the snapshot', async () => (await mock.get('/api/state')).sessions.find((x: { id: string }) => x.id === 's-cart').question.toolUseId === 'toolu_02');
      await sleep(500);
      assert.deepEqual(await page.eval(box), { session: 's-cart', key: 'q:toolu_01Cart', value: 'only if stock', focused: true, same: true });
      await page.click('[data-card] h1');
      await page.until('the update in place', () => document.querySelector<HTMLElement>('[data-card]')?.dataset.key === 'q:toolu_02');
      assert.deepEqual(await page.eval(box), { session: 's-cart', key: 'q:toolu_02', value: 'only if stock', focused: false, same: true });
      assert.match((await page.eval(card))!.header, /Updated just now/);

      await page.click('[data-card] textarea');
      await page.type(' allows');
      await mock.post('/mock/patch', { id: 's-cart', patch: { question: null, status: 'working' } });
      assert.deepEqual(await page.until('the toast', toastsOf, 'info'), [{ kind: 'info', text: 'Merge guest cart on login no longer waits', inSheet: false, hit: true }]);
      await sleep(300);
      assert.deepEqual(await page.eval(box), { session: 's-cart', key: 'q:toolu_02', value: 'only if stock allows', focused: true, same: true });
      // Not on the card, which goes as the pointer goes down.
      await page.click('main span', 'Previous');
      await page.until('the card after it once focus left', frontIs, 's-hooks');
    },
  },  {
    name: 'P5.1.d4 a decision without options shows its second opinion as a block of its own, highlighted as what ⏎ accepts, with Edit; Accept suggestion is the primary',
    scenario: 'freetext',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-flag"]');
      await page.until('s-flag at the front', frontIs, 's-flag');
      const shown = await page.eval(() => {
        const block = document.querySelector<HTMLElement>('[data-card] [data-suggestion]')!;
        return {
          options: document.querySelectorAll('[data-card] [data-option]').length, frozen: block.hasAttribute('data-frozen'), text: block.innerText,
          buttons: [...block.querySelectorAll('button')].map((b) => b.textContent),
        };
      });
      assert.deepEqual({ ...shown, text: undefined }, { options: 0, frozen: true, text: undefined, buttons: ['Edit E'] });
      assert.match(shown.text, /^Second opinion · 77%\s+Call it `checkout\.mergeGuestCart`, like the other checkout flags\.\s+Every flag in config\/flags\.ts follows checkout\.<feature>\.\s+Edit\s+E\s+high confidence$/);
      assert.equal((await page.eval(card))!.primary, 'Accept suggestion');
      await page.until('the card to settle', still);
      await shot('queue-free-text');
    },
  },
  {
    name: 'P5.2.1 ⏎ on s-cart deals it down and s-hooks comes up; the toast says Sending “Merge both carts” to Merge guest cart on login, counts down and offers Undo Z; the meter and the tab title count 2 decisions; 5 s on, one accept-advice goes out with the second opinion it showed',
    async run({ page, mock, shot }) {
      const { advice } = await stateOf(mock, 's-cart');
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(watchDeals);
      await page.key('Enter');
      const pressed = Date.now();
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(dealt), ['down']);
      const [held] = await page.until('the undo toast', toastsOf, 'undo');
      assert.match(held.text, /^Sending “Merge both carts” to Merge guest cart on login · [1-5] s\s+Undo\s+Z$/);
      const count = () => Number(document.querySelector('[data-toast][data-kind="undo"]')?.textContent?.match(/· (\d) s/)?.[1]);
      const first = await page.eval(count);
      await sleep(1100);
      assert.ok((await page.eval(count)) < first, 'the countdown did not count down');
      assert.deepEqual(await page.eval(() => [document.querySelector('[data-meter] [role="group"]')?.getAttribute('aria-label'), document.title]), [
        '2 decisions · 1 terminal prompt · 2 finished turns', '(2) Agent Board',
      ]);
      await shot('queue-held');
      await sleep(HELD_MS - (Date.now() - pressed));
      const sent = await actions(mock);
      assert.deepEqual(sent.map((e) => [e.action, e.sessionId, e.body, e.status]), [['accept-advice', 's-cart', { key: 'q:toolu_01Cart', adviceAt: advice.at }, 204]]);
      assert.ok(sent[0].at - pressed >= 4900, `posted ${sent[0].at - pressed} ms after ⏎`);
    },
  },
  {
    name: 'P5.2.2 Undo gives back what the send took: option 2 with a note and a pasted picture held, Z within 3 s brings s-cart back with both in the reply box and nothing goes out; sent again, the answer carries the choice, the note and the picture',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('only if stock allows');
      await page.eval(pastePng, '[data-card] textarea');
      await page.until('the picture uploaded', () => !!document.querySelector('[data-card] [data-state="ready"]'));
      await page.click('[data-card] [data-option="2"]');
      const pressed = Date.now();
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(replyIn, '[data-card]'), null, 'the reply box went with s-cart');
      await page.key('z');
      await page.until('s-cart back at the front', frontIs, 's-cart');
      assert.ok(Date.now() - pressed < 3000, `back ${Date.now() - pressed} ms after the press`);
      assert.deepEqual({ ...(await page.eval(replyIn, '[data-card]')), focused: undefined }, { value: 'only if stock allows', files: ['ready shot.png'], focused: undefined });
      assert.equal(await page.eval(() => document.querySelector('[data-toast][data-kind="undo"]')), null, 'the undo toast stayed');
      await sleep(6000);
      assert.deepEqual(await actions(mock), []);

      await page.until('the guard to end', unguarded);
      await page.click('[data-card] [data-option="2"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      const [answer] = await logged(mock, 'the answer', (e) => e.action === 'answer', POSTED_MS);
      const [upload] = await logged(mock, 'the upload', (e) => e.path === '/api/uploads');
      assert.deepEqual([answer.sessionId, answer.status, { ...answer.body, files: undefined }], ['s-cart', 204, {
        key: 'q:toolu_01Cart', choice: 'Keep the account cart', text: 'only if stock allows', files: undefined,
      }]);
      assert.equal(upload.body.filename, 'shot.png');
      assert.equal(answer.body.files.length, 1);
      assert.match(answer.body.files[0], /\/uploads\/[\w-]+\/shot\.png$/);
    },
  },
  {
    name: 'P5.2.3 the choice frozen while the second opinion runs stays: with Send “Merge both carts” shown, advice that finishes on Ask the shopper shows on option 3, option 1 keeps the highlight, and ⏎ answers Merge both carts, not the advice',
    scenario: 'freeze',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      assert.equal((await page.eval(card))!.primary, 'Send “Merge both carts”');
      await mock.post('/mock/advice', { id: 's-cart', state: 'done', choice: 'Ask the shopper', confidence: 71 });
      const third = await page.until('the late second opinion on option 3', () => {
        const option = document.querySelector('[data-card] [data-option="3"]')?.parentElement;
        return option?.innerText.includes('Second opinion · 71%') && option.innerText;
      });
      assert.match(third, /Ask the shopper, because it fits what the task asks for\./);
      const frozen = await page.eval(() => [...document.querySelectorAll('[data-card] [data-frozen] [data-option]')].map((o) => (o as HTMLElement).dataset.option));
      assert.deepEqual([frozen, (await page.eval(card))!.primary], [['1'], 'Send “Merge both carts”']);
      await shot('queue-freeze');
      await page.until('the guard to end', unguarded);
      await page.key('Enter');
      await sleep(HELD_MS);
      assert.deepEqual((await actions(mock)).map((e) => [e.action, e.body]), [['answer', { key: 'q:toolu_01Cart', choice: 'Merge both carts' }]]);
    },
  },
  {
    name: 'P5.2.4 a second opinion that came in after the freeze is accepted by its own digit: 3 sends accept-advice with the new advice\'s at',
    scenario: 'freeze',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      const advice = await mock.post('/mock/advice', { id: 's-cart', state: 'done', choice: 'Ask the shopper', confidence: 71 });
      await page.until('the late second opinion on option 3', () => !!document.querySelector('[data-card] [data-option="3"]')?.parentElement?.innerText.includes('Second opinion · 71%'));
      await page.until('the guard to end', unguarded);
      await page.key('3');
      await sleep(HELD_MS);
      assert.deepEqual((await actions(mock)).map((e) => [e.action, e.body]), [['accept-advice', { key: 'q:toolu_01Cart', adviceAt: advice.at }]]);
    },
  },
  {
    name: 'P5.2.5 advice that changes after the freeze relabels the primary to Send “Merge both carts”, guarded about 0.9 s, and ⏎ answers with that choice instead of accepting',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      assert.equal((await page.eval(card))!.primary, 'Accept suggestion');
      await mock.post('/mock/advice', { id: 's-cart', state: 'done', choice: 'Merge both carts' });
      const changed = Date.now();
      await page.until('the relabel, guarded', () => {
        const c = document.querySelector<HTMLElement>('[data-card] [data-primary]');
        return c?.firstElementChild?.textContent === 'Send “Merge both carts”' && c.hasAttribute('data-guarded');
      });
      await page.until('the guard to end', unguarded);
      const held = Date.now() - changed;
      assert.ok(held > 700 && held < 1600, `the guard ended ${held} ms after the advice changed`);
      await page.key('Enter');
      await sleep(HELD_MS);
      assert.deepEqual((await actions(mock)).map((e) => [e.action, e.body]), [['answer', { key: 'q:toolu_01Cart', choice: 'Merge both carts' }]]);
    },
  },
  {
    name: 'P5.2.6 the server refuses an accept whose advice changed during the hold: 400 advice-changed, the toast Not sent to Merge guest cart on login: the second opinion changed; read it again, s-cart back as peek 1 marked Not sent, and Show brings it to the front with the banner',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await mock.post('/mock/advice', { id: 's-cart', state: 'done', choice: 'Merge both carts' });
      const [refused] = await logged(mock, 'the refused accept', (e) => e.action === 'accept-advice', POSTED_MS);
      assert.deepEqual([refused.status, refused.code], [400, 'advice-changed']);
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.equal(error.text, 'Not sent to Merge guest cart on login: the second opinion changed; read it again\nShow');
      const [first] = await page.until('s-cart as peek 1', () => {
        const p = document.querySelector<HTMLElement>('[data-peek="1"]');
        return p?.dataset.session === 's-cart' && [p.innerText];
      });
      assert.match(first, /not sent/i);
      assert.equal((await page.eval(card))!.session, 's-hooks');
      await shot('queue-not-sent-peek');
      await page.click('[data-toast][data-kind="error"] button', 'Show');
      await page.until('s-cart at the front', frontIs, 's-cart');
      assert.equal(await page.eval(() => document.querySelector('[data-card] [data-not-sent]')?.textContent), 'Not sent: the second opinion changed; read it again');
      await page.until('the card to settle', still);
      await shot('queue-not-sent-banner');
    },
  },
  {
    name: 'P5.2.7 the key guard: ⏎ as the first card comes up does nothing; two ⏎ 300 ms apart hold one send, and two 650 ms apart one more while the card after it stays; an auto-repeated ⏎ does nothing, and a double click on an option holds it once',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.eval(pressEnter, []);
      await sleep(300);
      assert.deepEqual([(await page.eval(card))!.session, await page.eval(toastsOf, 'undo')], ['s-cart', null], 'the first card was not guarded');
      await ready(page, 's-cart');
      await page.eval(pressEnter, [300]);
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.equal((await page.eval(toastsOf, 'undo'))?.length, 1);
      await page.until('the guard to end', unguarded);
      await page.eval(pressEnter, [650]);
      await page.until('s-group at the front', frontIs, 's-group');
      await sleep(400);
      assert.equal((await page.eval(card))!.session, 's-group', 'the second ⏎ answered the card after it');
      await page.until('the guard to end', unguarded);
      await page.eval(pressEnter, [], true);
      await sleep(400);
      assert.equal((await page.eval(card))!.session, 's-group', 'an auto-repeated ⏎ answered');
      await page.dblclick('[data-card] [data-option="2"]');
      await page.until('s-astro at the front', frontIs, 's-astro');
      await sleep(HELD_MS + 600);
      assert.deepEqual((await actions(mock)).map((e) => [e.sessionId, e.action, e.body.choice ?? null]).toSorted(), [
        ['s-cart', 'accept-advice', null], ['s-group', 'answer', 'By repo'], ['s-hooks', 'answer-menu', null],
      ]);
    },
  },
  {
    name: 'P5.2.8 Space on a focused option shows or hides the details and holds nothing',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(() => document.querySelector<HTMLElement>('[data-card] [data-option="2"]')!.focus());
      await page.key(' ');
      await page.until('the details hidden', () => document.querySelector('[data-card] section[aria-label="Claude\'s details"] button')?.getAttribute('aria-expanded') === 'false');
      assert.deepEqual([(await page.eval(card))!.session, await page.eval(toastsOf, 'undo')], ['s-cart', null]);
      await sleep(HELD_MS);
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'P5.2.9 the menu: its picks start as the second opinion\'s, Accept suggestion; 4 unpicks Email the account owner, Send answer; Use the suggestion picks them again; an empty question 2 reads Answer both questions, off; picked again, ⏎ sends answer-menu with the picks on screen',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await page.key('ArrowRight');
      await ready(page, 's-hooks');
      const primary = () => [document.querySelector('[data-card] [data-primary]')?.firstElementChild?.textContent, document.querySelector<HTMLButtonElement>('[data-card] [data-primary]')?.disabled];
      const picks = () => [...document.querySelectorAll('[data-card] section[role="group"]')].map((q) => [...q.querySelectorAll('[aria-pressed="true"]')].map((o) => o.querySelector('span span')?.textContent));
      assert.deepEqual(await page.eval(primary), ['Accept suggestion', false]);
      await page.key('4');
      await page.until('Send answer', (label: string) => document.querySelector('[data-card] [data-primary]')?.firstElementChild?.textContent === label, 'Send answer');
      await page.click('[data-card] button', 'Use the suggestion');
      await page.until('Accept suggestion', (label: string) => document.querySelector('[data-card] [data-primary]')?.firstElementChild?.textContent === label, 'Accept suggestion');
      assert.deepEqual(await page.eval(picks), [['Exponential, 5 tries'], ['Email the account owner', 'Disable the endpoint']]);
      await page.key('4');
      await page.key('6');
      await page.until('Answer both questions', (label: string) => document.querySelector('[data-card] [data-primary]')?.firstElementChild?.textContent === label, 'Answer both questions');
      assert.deepEqual(await page.eval(primary), ['Answer both questions', true]);
      await page.key('5');
      await page.until('Send answer', (label: string) => document.querySelector('[data-card] [data-primary]')?.firstElementChild?.textContent === label, 'Send answer');
      const onScreen = await page.eval(picks);
      await shot('queue-menu-picks');
      await page.key('Enter');
      await page.until('s-group at the front', frontIs, 's-group');
      const [sent] = await logged(mock, 'the menu answer', (e) => e.action === 'answer-menu', POSTED_MS);
      assert.deepEqual([sent.status, sent.body.toolUseId], [204, 'toolu_01Hooks']);
      assert.deepEqual(sent.body.answers, onScreen.map((labels) => ({ labels, other: '' })));
      assert.deepEqual(onScreen, [['Exponential, 5 tries'], ['Post to #billing-alerts']]);
    },
  },
  {
    name: 'P5.2.10 a menu of one single-choice question: its digit holds answer-menu with that pick',
    scenario: 'lone-menu',
    async run({ page, mock }) {
      await openQueue(page, mock, 's-lone');
      await ready(page, 's-lone');
      await page.key('2');
      await page.until('the undo toast', toastsOf, 'undo');
      const [sent] = await logged(mock, 'the menu answer', (e) => e.action === 'answer-menu', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, { toolUseId: 'toolu_01Lone', answers: [{ labels: ['Every 15 min, 8 tries'], other: '' }] }]);
    },
  },
  {
    name: 'P5.2.11 your own answer: W, "Use the cache" and Enter hold answer with the key and the text, and the card deals out',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('Use the cache');
      await page.eval(watchDeals);
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(dealt), ['down']);
      assert.match((await page.until('the undo toast', toastsOf, 'undo'))[0].text, /^Sending “Use the cache” to Merge guest cart on login/);
      assert.equal(await page.eval(() => document.activeElement?.closest('[data-card]')?.getAttribute('data-session') ?? null), 's-hooks', 'focus stayed on the page');
      const [sent] = await logged(mock, 'the answer', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, { key: 'q:toolu_01Cart', text: 'Use the cache' }]);
    },
  },
  {
    name: 'P5.2.12 a command: /compact and Enter hold it with a toast Sending /compact …, the card stays and its reply box is empty and says the question stays open; it goes out 5 s on; Z puts it back in the box instead',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      const command = async () => {
        await page.type('/compact');
        await page.until('the command list', () => [...document.querySelectorAll('[data-card] [role="option"] code')].some((c) => c.textContent === '/compact'));
        await page.key('Enter');
        return page.until('the undo toast', toastsOf, 'undo');
      };
      const [held] = await command();
      assert.match(held.text, /^Sending \/compact to Merge guest cart on login · [1-5] s/);
      assert.deepEqual(await page.eval(() => [
        document.querySelector<HTMLElement>('[data-card]')?.dataset.session, document.querySelector<HTMLTextAreaElement>('[data-card] textarea')?.value,
        document.querySelector('[data-card] [role="status"]')?.textContent,
      ]), ['s-cart', '', '/compact goes to the terminal as typed; the question stays open.']);
      await shot('queue-command');
      const [sent] = await logged(mock, 'the command', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, { key: 'q:toolu_01Cart', text: '/compact' }]);

      await command();
      await page.click('[data-card] h1');
      await page.key('z');
      await page.until('the command back in the box', () => document.querySelector<HTMLTextAreaElement>('[data-card] textarea')?.value === '/compact');
      assert.equal((await page.eval(card))!.session, 's-cart');
      await sleep(6000);
      assert.equal((await actions(mock)).length, 1, 'the command taken back went out');
    },
  },
  {
    name: 'P5.2.13 Dismiss deals s-cart sideways with the toast Dismissing “…” and Undo, and 5 s on dismiss goes out with its key',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(watchDeals);
      await page.click('[data-card] footer button', 'Dismiss');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(dealt), ['side']);
      assert.match((await page.until('the undo toast', toastsOf, 'undo'))[0].text, /^Dismissing “What should happen to a guest cart when the shopper logs in\?” · [1-5] s\s+Undo\s+Z$/);
      const [sent] = await logged(mock, 'the dismissal', (e) => e.action === 'dismiss', POSTED_MS);
      assert.deepEqual([sent.sessionId, sent.status, sent.body], ['s-cart', 204, { key: 'q:toolu_01Cart' }]);
    },
  },
  {
    name: 'P5.2.14 Your turn: ⏎ (Reply) focuses the reply box and Enter holds a message whose raw body has "key":null; X archives Fix broken doc anchors at once, its card goes sideways, and the toast\'s Undo unarchives it',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-reviews"]');
      await ready(page, 's-reviews');
      // The segment keeps focus after the click, and ⏎ on it would press it again.
      await page.eval(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.key('Enter');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('Commit it and open a PR');
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      const [sent] = await logged(mock, 'the message', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.sessionId, sent.status, sent.body], ['s-reviews', 204, { key: null, text: 'Commit it and open a PR' }]);
      assert.match(sent.raw ?? '', /"key":null/);

      await page.click('[data-segment][data-session="s-anchors"]');
      await ready(page, 's-anchors');
      await page.eval(watchDeals);
      const pressed = Date.now();
      await page.key('x');
      const [archived] = await logged(mock, 'the archive', (e) => e.action === 'archive');
      assert.deepEqual([archived.sessionId, archived.body, archived.status], ['s-anchors', { archived: true }, 204]);
      assert.ok(archived.at - pressed < 1000, `archived ${archived.at - pressed} ms after X`);
      await page.until('s-anchors gone', () => !document.querySelector('[data-card][data-session="s-anchors"]') && !document.documentElement.dataset.deal);
      assert.deepEqual(await page.eval(dealt), ['side']);
      const toast = await page.until('the archive toast', () => [...document.querySelectorAll<HTMLElement>('[data-toast][data-kind="undo"]')].find((t) => t.innerText.startsWith('Archived'))?.innerText);
      assert.equal(toast, 'Archived Fix broken doc anchors\nUndo');
      await page.click('[data-toast][data-kind="undo"] button', 'Undo');
      const [back] = await logged(mock, 'the unarchive', (e) => e.action === 'archive' && e.body.archived === false);
      assert.deepEqual([back.sessionId, back.status], ['s-anchors', 204]);
      await page.until('s-anchors back at the front', frontIs, 's-anchors');
    },
  },
  {
    name: 'P5.2.15 a refused send: with /mock/fail stale, ⏎ on s-cart with a note gets a 400 at 5 s, an error toast, and s-cart comes back as peek 1 marked Not sent; Show brings it to the front with the banner and the note back in its reply box',
    expectedErrors: [/status of 400/],
    async run({ page, mock, shot }) {
      await mock.post('/mock/fail', { error: 'this question is no longer open', code: 'stale' });
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('only if stock allows');
      await page.click('[data-card] h1');
      assert.equal((await page.eval(card))!.primary, 'Send “Merge both carts” + your note');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      const [refused] = await logged(mock, 'the refused answer', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([refused.status, refused.code, refused.body], [400, 'stale', { key: 'q:toolu_01Cart', choice: 'Merge both carts', text: 'only if stock allows' }]);
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.equal(error.text, 'Not sent to Merge guest cart on login: this question is no longer open\nShow');
      assert.match(await page.until('s-cart as peek 1', () => {
        const p = document.querySelector<HTMLElement>('[data-peek="1"]');
        return p?.dataset.session === 's-cart' && p.innerText;
      }), /not sent/i);
      await page.click('[data-toast][data-kind="error"] button', 'Show');
      await page.until('s-cart at the front', frontIs, 's-cart');
      assert.equal(await page.eval(() => document.querySelector('[data-card] [data-not-sent]')?.textContent), 'Not sent: this question is no longer open');
      assert.deepEqual({ ...(await page.eval(replyIn, '[data-card]')), focused: undefined }, { value: 'only if stock allows', files: [], focused: undefined });
      await page.until('the card to settle', still);
      await shot('queue-refused');
    },
  },
  {
    name: 'P5.2.16 the early check: an answer held on s-group whose turn moves on (lastTurn t9) fails with Not sent to Group board tiles by repo: this question is no longer open, and nothing is posted',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await ready(page, 's-group');
      await page.key('1');
      await page.until('s-astro at the front', frontIs, 's-astro');
      await mock.post('/mock/patch', { id: 's-group', patch: { lastTurn: 't9' } });
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.equal(error.text, 'Not sent to Group board tiles by repo: this question is no longer open\nShow');
      await sleep(HELD_MS);
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'P5.2.16-working the early check when the session went on working: Show opens its sheet on Overview, and the answer it held is back in the sheet\'s reply box',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.click('[data-peek="2"] > span');
      await ready(page, 's-group');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('Group by repo, attention inside');
      await page.key('Enter');
      await page.until('s-astro at the front', frontIs, 's-astro');
      await mock.post('/mock/patch', { id: 's-group', patch: { lastTurn: 't9', status: 'working', activity: { step: 'Edit web/src/order.ts', since: Date.now() } } });
      const [error] = await page.until('the error toast', toastsOf, 'error');
      assert.equal(error.text, 'Not sent to Group board tiles by repo: this question is no longer open\nShow');
      await page.click('[data-toast][data-kind="error"] button', 'Show');
      await page.until('the sheet of s-group', () => location.pathname === '/s/s-group/overview' && !!document.querySelector('#task-sheet:modal'));
      assert.deepEqual({ ...(await page.eval(replyIn, '#task-sheet')), focused: undefined }, { value: 'Group by repo, attention inside', files: [], focused: undefined });
      await sleep(HELD_MS);
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'P5.2.17 answered elsewhere: a send held on s-cart whose decision another window answers is dropped with word that it was already answered, and nothing is posted',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await mock.post('/mock/patch', { id: 's-cart', patch: { answered: { key: 'q:toolu_01Cart', text: 'Merge both carts', at: Date.now() } } });
      const [info] = await page.until('the toast', toastsOf, 'info');
      assert.equal(info.text, 'Already answered elsewhere; nothing was sent to Merge guest cart on login');
      assert.equal(await page.eval(toastsOf, 'undo'), null);
      await sleep(HELD_MS);
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'P5.2.18 reconnecting: a send held as the connection drops for 8 s waits for Agent Board at about 5 s, and goes out once, after the pill reads Live again',
    expectedErrors: [/WebSocket/, /ERR_/],
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('Enter');
      const pressed = Date.now();
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await mock.post('/mock/drop', { ms: 8000 });
      try {
        await page.until('the pill to turn reconnecting', pillAt, 'reconnecting');
        const [waiting] = await until('the waiting toast', () => page.eval(toastsOf, 'info'), 8000);
        const at = Date.now() - pressed;
        assert.ok(at > 4500 && at < 7000, `waiting after ${at} ms`);
        assert.equal(waiting.text, 'Waiting for Agent Board to send “Merge both carts” to Merge guest cart on login');
      } finally {
        await until('the drop to end', () => mock.get('/mock').then(() => true, () => false), 10_000);
      }
      await until('the pill to turn live again', () => page.eval(pillAt, 'live'), 10_000);
      const sent = await until('the post', async () => {
        const posted = await actions(mock);
        return posted.length && posted;
      }, POSTED_MS);
      assert.deepEqual(sent.map((e) => [e.action, e.sessionId, e.status]), [['accept-advice', 's-cart', 204]]);
      assert.ok(sent[0].at - pressed > 8000, `posted ${sent[0].at - pressed} ms after ⏎, inside the drop`);
      await sleep(1000);
      assert.equal((await actions(mock)).length, 1);
    },
  },
  {
    name: 'P5.2.19 pagehide: an option pressed, then the page left within 1 s, still reaches the server at once: the page posts what it holds as it goes',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('1');
      const pressed = Date.now();
      await sleep(300);
      await page.goto('about:blank');
      const [sent] = await logged(mock, 'the answer posted on pagehide', (e) => e.action === 'accept-advice');
      assert.deepEqual([sent.sessionId, sent.status], ['s-cart', 204]);
      assert.ok(sent.at - pressed < 2000, `posted ${sent.at - pressed} ms after the press`);
    },
  },
  {
    name: 'P5.2.20 the reload gate: a new build announced while a send is held does not reload the page until it went out, and then it does',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(() => void ((window as unknown as { e2eProbe?: number }).e2eProbe = 1));
      await page.key('1');
      const pressed = Date.now();
      await mock.post('/mock/ui-entry', { src: '/assets/next.js' });
      await sleep(2000);
      assert.equal(await page.eval(() => (window as unknown as { e2eProbe?: number }).e2eProbe), 1, 'reloaded with a send held');
      const loadedAt = await until('the page to reload', async () => {
        try {
          return await page.eval(() => ((window as unknown as { e2eProbe?: number }).e2eProbe === undefined && document.readyState === 'complete' ? performance.timeOrigin : 0));
        } catch {
          return 0;
        }
      }, 7000 - (Date.now() - pressed));
      const [sent] = await logged(mock, 'the held answer', (e) => e.action === 'accept-advice');
      assert.equal(sent.status, 204);
      assert.ok(sent.at < loadedAt, `the answer went out ${sent.at - loadedAt} ms after the reload`);
    },
  },
  {
    name: 'P5.2.21 In your queue: O on s-cart opens Overview with In your queue · Decision, the problem, Second opinion: Merge both carts · 82% and Answer it on its card, and no answer controls; that button closes the sheet with s-cart at the front, also from over the Wall',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('o');
      await page.until('the sheet', () => location.pathname === '/s/s-cart/overview' && !!document.querySelector('#task-sheet:modal'));
      const box = () => {
        const q = document.querySelector<HTMLElement>('#task-sheet [data-queued]');
        return q && { text: [...q.children].map((c) => c.textContent), controls: document.querySelectorAll('#task-sheet [data-option], #task-sheet textarea, #task-sheet input:not([type="file"])').length };
      };
      assert.deepEqual(await page.until('the queue box', box), {
        text: ['In your queue · Decision', 'What should happen to a guest cart when the shopper logs in?', 'Second opinion: Merge both carts · 82%', 'Answer it on its card'], controls: 0,
      });
      assert.equal(await page.eval(() => [...document.querySelectorAll('#task-sheet button')].some((b) => /dismiss|accept|send/i.test(b.textContent ?? ''))), false);
      await page.until('the sheet to settle', settled);
      await shot('sheet-in-your-queue');
      await page.click('#task-sheet [data-queued] button', 'Answer it on its card');
      await page.until('the queue with s-cart at the front', () => !document.querySelector('#task-sheet[open]') && location.pathname === '/' && document.querySelector<HTMLElement>('[data-card]')?.dataset.session === 's-cart');

      // A waiting task's tile goes to its card, so this sheet is over the Wall because its task asked while it was open.
      await openFromWall(page, mock, 's-invoice');
      await mock.post('/mock/patch', {
        id: 's-invoice',
        patch: { status: 'idle', activity: null, question: { toolUseId: 'toolu_inv', category: 'plan-problem', askedAt: Date.now(), title: 'Round half cents to even?', details: '', options: [{ label: 'Yes' }, { label: 'No' }] } },
      });
      assert.deepEqual((await page.until('the queue box', box))?.text.slice(0, 2), ['In your queue · Decision', 'Round half cents to even?']);
      await page.click('#task-sheet [data-queued] button', 'Answer it on its card');
      await page.until('the queue with s-invoice at the front', () => !document.querySelector('#task-sheet[open]') && location.pathname === '/' && document.querySelector<HTMLElement>('[data-card]')?.dataset.session === 's-invoice');
      await page.eval(() => history.back());
      await page.until('the Wall again on Back', () => location.pathname === '/wall' && !document.querySelector('#task-sheet[open]'));

      await page.goto(`${mock.url}/s/s-hooks/overview`);
      assert.deepEqual((await page.until('the queue box', box))?.text.slice(0, 1), ['In your queue · Asked in the terminal']);
    },
  },
  {
    name: 'P5.2.22 the sheet\'s reply box: a message typed in Fix invoice PDF rounding and Enter shows a toast with Undo in the sheet, which stays open, and 5 s on answer goes out with "key":null and the text',
    async run({ page, mock, shot }) {
      await openFromWall(page, mock, 's-invoice');
      await page.click('#task-sheet textarea');
      await page.type('Also round the tax lines');
      await page.key('Enter');
      const [held] = await page.until('the undo toast', toastsOf, 'undo');
      assert.deepEqual({ ...held, text: undefined }, { kind: 'undo', text: undefined, inSheet: true, hit: true });
      assert.match(held.text, /^Sending “Also round the tax lines” to Fix invoice PDF rounding · [1-5] s\s+Undo\s+Z$/);
      assert.deepEqual([await page.eval(sheetOpen), (await page.eval(replyIn, '#task-sheet'))?.value], [true, '']);
      await shot('sheet-held');
      const [sent] = await logged(mock, 'the message', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.sessionId, sent.status, sent.body], ['s-invoice', 204, { key: null, text: 'Also round the tax lines' }]);
      assert.match(sent.raw ?? '', /"key":null/);
      assert.equal(await page.eval(sheetOpen), true);
    },
  },
  {
    name: 'P5.2.23 Terminal posts a send held on its session at once, before it asks for the terminal',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('v');
      await page.until('the Wall', tiles);
      await page.click('[data-tile][data-session="s-cart"] button[aria-label="Session actions"]');
      await page.click(':popover-open button', 'Terminal');
      const opened = Date.now();
      const [focus] = await logged(mock, 'the terminal request', (e) => e.action === 'focus');
      const sent = await actions(mock);
      assert.deepEqual(sent.map((e) => [e.action, e.sessionId, e.status]), [['accept-advice', 's-cart', 204], ['focus', 's-cart', 204]]);
      assert.ok(sent[0].at - opened < 1000 && focus.at - opened < 3000, `posted ${sent[0].at - opened} ms and focused ${focus.at - opened} ms after Terminal`);
    },
  },
  {
    name: 'P5.2.24 Enter in a menu\'s own answer, with every question answered, holds answer-menu with that answer',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.key('ArrowRight');
      await ready(page, 's-hooks');
      await page.click('[data-card] input[aria-label="Your own answer: Backoff"]');
      await page.type('Every 10 min, 6 tries');
      await page.key('Enter');
      await page.until('s-group at the front', frontIs, 's-group');
      assert.match((await page.until('the undo toast', toastsOf, 'undo'))[0].text, /^Sending “Backoff: Every 10 min, 6 tries · Give up: Email the account owner, Disable the endpoint” to Retry failed webhooks/);
      const [sent] = await logged(mock, 'the menu answer', (e) => e.action === 'answer-menu', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, {
        toolUseId: 'toolu_01Hooks', answers: [{ labels: [], other: 'Every 10 min, 6 tries' }, { labels: ['Email the account owner', 'Disable the endpoint'], other: '' }],
      }]);
    },
  },
  {
    name: 'P5.2.25 a reload loses nothing: the draft in a card\'s reply box, its attachment and the frozen choice come back',
    scenario: 'freeze',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await mock.post('/mock/advice', { id: 's-cart', state: 'done', choice: 'Ask the shopper', confidence: 71 });
      await page.until('the late second opinion on option 3', () => !!document.querySelector('[data-card] [data-option="3"]')?.parentElement?.innerText.includes('Second opinion · 71%'));
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('only if stock allows');
      await page.eval(pastePng, '[data-card] textarea');
      await page.until('the picture uploaded', () => !!document.querySelector('[data-card] [data-state="ready"]'));
      await page.goto(`${mock.url}/`);
      await page.until('the card of s-cart', frontIs, 's-cart');
      const kept = await page.until('the reply box', replyIn, '[data-card]');
      assert.deepEqual({ ...kept, focused: undefined }, { value: 'only if stock allows', files: ['ready shot.png'], focused: undefined });
      const frozen = await page.eval(() => [...document.querySelectorAll('[data-card] [data-frozen] [data-option]')].map((o) => (o as HTMLElement).dataset.option));
      assert.deepEqual([frozen, (await page.eval(card))!.primary], [['1'], 'Send “Merge both carts” + your note']);
      await page.until('the card to settle', still);
      await shot('queue-after-reload');
    },
  },
  {
    name: 'P5.2.26 narrow window: with a send held, the queue has no sideways scroll, and both its primary and the undo toast stay in reach',
    narrow: true,
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.until('the primary in reach', reachable, '[data-primary]', '');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.until('the undo toast in reach', reachable, '[data-toast][data-kind="undo"]', 'Sending');
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.until('the next primary in reach', reachable, '[data-primary]', '');
      await shot('narrow-held');
    },
  },
  {
    name: 'P5.2.n16 commands skip the early check: /compact held on s-cart goes out although a new question replaced the card\'s decision meanwhile',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('/compact');
      await page.until('the command list', () => [...document.querySelectorAll('[data-card] [role="option"] code')].some((c) => c.textContent === '/compact'));
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      await mock.post('/mock/patch', { id: 's-cart', patch: { question: { toolUseId: 'toolu_02', title: 'Merge the carts for app logins too?', options: [{ label: 'Yes' }, { label: 'No' }] } } });
      // The card keeps its decision while focus is in its reply box.
      await page.click('[data-card] h1');
      await page.until('the new decision on the card', () => document.querySelector<HTMLElement>('[data-card]')?.dataset.key === 'q:toolu_02');
      const [sent] = await logged(mock, 'the command', (e) => e.action === 'answer', POSTED_MS);
      assert.deepEqual([sent.status, sent.body], [204, { key: 'q:toolu_01Cart', text: '/compact' }]);
      assert.equal(await page.eval(toastsOf, 'error'), null);
    },
  },
  {
    name: 'P5.2.undo-sheet the toast\'s Undo takes back a message sent from a sheet over the queue: the text is back in its reply box, nothing goes out, and the card being read stays, with no word that anything stopped waiting',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.goto(`${mock.url}/s/s-invoice/overview`);
      await page.until('the sheet over the queue', () => !!document.querySelector('#task-sheet:modal') && document.documentElement.dataset.view === 'queue');
      await page.click('#task-sheet textarea');
      await page.type('Also round the tax lines');
      await page.key('Enter');
      await page.until('the undo toast', toastsOf, 'undo');
      await page.click('[data-toast][data-kind="undo"] button', 'Undo');
      await page.until('the message back in the reply box', () => document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')?.value === 'Also round the tax lines');
      await sleep(1000);
      assert.deepEqual([await page.eval(toastsOf, 'info'), await page.eval(toastsOf, 'undo')], [null, null]);
      await page.click('#task-sheet button[aria-label^="Back to"]');
      await page.until('the card of s-cart', frontIs, 's-cart');
      await sleep(HELD_MS - 1000);
      assert.deepEqual(await actions(mock), []);
    },
  },
  {
    name: 'P6.menu-outside a click beside the sheet while its ⋯ menu is open closes only the menu; after a click inside the sheet closed the menu, Esc still closes the sheet, and a click beside it with no menu open does too',
    async run({ page, mock, shot }) {
      const layers = () => ({ menu: !!document.querySelector('[popover="auto"]:popover-open'), sheet: !!document.querySelector('#task-sheet:modal'), path: location.pathname });
      const menu = async () => {
        await page.click('#task-sheet button[aria-label="Session actions"]');
        await page.until('the ⋯ menu', () => !!document.querySelector('[popover="auto"]:popover-open'));
      };
      await openFromWall(page, mock, 's-invoice');
      await page.until('the sheet to settle', settled);
      await menu();
      await page.pointAt(12, 12, true);
      await page.until('the menu to close', () => !document.querySelector('[popover="auto"]:popover-open'));
      await sleep(400);
      assert.deepEqual(await page.eval(layers), { menu: false, sheet: true, path: '/s/s-invoice/overview' });
      await shot('sheet-after-menu-outside');

      await menu();
      await page.click('#task-sheet [role="tablist"]');
      await page.until('the menu to close', () => !document.querySelector('[popover="auto"]:popover-open'));
      await sleep(100);
      assert.deepEqual(await page.eval(layers), { menu: false, sheet: true, path: '/s/s-invoice/overview' });
      await page.key('Escape');
      await page.until('Esc to close the sheet', () => !document.querySelector('#task-sheet[open]') && location.pathname === '/wall');

      await page.click('[data-tile][data-session="s-invoice"] a');
      await page.until('the sheet again', sheetOpen);
      await page.until('the sheet to settle', settled);
      await page.pointAt(12, 12, true);
      await page.until('a click beside it to close the sheet', () => !document.querySelector('#task-sheet[open]') && location.pathname === '/wall');
    },
  },
  {
    name: 'P6.repos-connecting Repos says Connecting… until the first snapshot, and its empty state once the board says there are no repositories',
    scenario: 'norepos',
    expectedErrors: [/WebSocket/],
    async run({ page, mock, shot }) {
      const repos = () => document.querySelector<HTMLDialogElement>('dialog#workspace')?.open && document.querySelector<HTMLElement>('dialog#workspace')!.innerText;
      await withoutBoard(async (url) => {
        await page.goto(`${url}/`);
        await page.click('[data-repos]');
        const text = await page.until('Repos', repos);
        assert.match(text, /Connecting…/);
        assert.doesNotMatch(text, /Add a repository or a folder of repositories to begin/);
        await page.until('the dialog to settle', settled);
        await shot('repos-connecting');
      });
      await page.goto(`${mock.url}/`);
      await page.until('the live pill', () => !!document.querySelector('[data-link="live"]'));
      await page.click('[data-repos]');
      const text = await page.until('Repos', repos);
      assert.match(text, /Add a repository or a folder of repositories to begin\./);
      assert.doesNotMatch(text, /Connecting…/);
    },
  },
  {
    name: 'P6.1 the dock under the queue: "3 working", then the three working agents in board order, each with its name, a mono step and a clock that ticks; Fix invoice PDF rounding has a breathing PR dot and a Worth-knowing dot, Typo-tolerant search a Worth-knowing dot; "2 ended" names them and opens the Wall',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 3);
      const dock = (await page.eval(dockState))!;
      assert.deepEqual(dock.capsules.map((c) => [c.session, c.state, c.name, c.line, c.mono, c.pr, c.know]), [
        ['s-invoice', 'working', 'Fix invoice PDF rounding', 'Bash: pnpm test invoices --run', true, 'breathe', true],
        ['s-search', 'working', 'Typo-tolerant search', 'Bash: pnpm search:reindex', true, null, true],
        ['s-thumbs', 'working', 'Artifact thumbnails in Overview', 'Edit web/src/components/Artifacts.tsx', true, null, false],
      ]);
      assert.deepEqual([dock.label, dock.count, dock.ended], [
        'Agents not waiting on you', '3 working', { text: '2 ended', title: 'Ended: Split-only diff view, Upgrade Stripe SDK to v18. Open the Wall to see them.' },
      ]);
      assert.equal(dock.box!.bottom, await page.eval(() => innerHeight), 'the dock is not at the bottom of the window');
      assert.ok(dock.capsules.every((c) => c.box!.top === dock.capsules[0].box!.top && c.box!.height === 50), 'the capsules are not one row of 50 px');
      for (const c of dock.capsules) assert.match(c.clock ?? '', /^\d+:\d\d$/, c.session);
      await sleep(1100);
      const ticked = (await page.eval(dockState))!.capsules;
      for (const [i, c] of ticked.entries()) assert.notEqual(c.clock, dock.capsules[i].clock, `the clock of ${c.session} did not tick`);
      await shot('dock');

      await page.click('[data-dock] a[href="/wall"]');
      await page.until('the Wall, with no dock', () => location.pathname === '/wall' && !!document.querySelector('[data-tile]') && !document.querySelector('[data-dock]'));
    },
  },
  {
    name: 'P6.2 hovering "Fix invoice PDF rounding" opens its card 150 ms later, a hint popover above the capsule with repo · branch, the step and the clock, the PR chip, Worth knowing and the summary; it closes when the pointer leaves, and keyboard focus opens a card at once while Tab passes the cards by',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 3);
      await page.eval(() => {
        const w = window as unknown as { e2eHover: { entered?: number; opened?: number } };
        w.e2eHover = {};
        const capsule = document.querySelector('[data-capsule][data-session="s-invoice"]')!;
        capsule.addEventListener('pointerover', () => (w.e2eHover.entered ??= performance.now()));
        capsule.querySelector('[data-hovercard]')!.addEventListener('toggle', (e) => {
          if ((e as ToggleEvent).newState === 'open') w.e2eHover.opened ??= performance.now();
        });
      });
      await page.hover('[data-capsule][data-session="s-invoice"] button');
      await page.until('the hover card', hoverCard, 's-invoice');
      await page.until('the card to settle', settled);
      const card = (await page.eval(hoverCard, 's-invoice'))!;
      const { entered, opened } = await page.eval(() => (window as unknown as { e2eHover: { entered: number; opened: number } }).e2eHover);
      assert.ok(opened - entered >= 140 && opened - entered < 1000, `the card opened ${Math.round(opened - entered)} ms after the pointer entered`);
      assert.equal(card.popover, 'hint');
      assert.ok(card.inside, 'the card is not inside the window');
      assert.ok(card.box.bottom <= card.capsule.top, `the card ends at ${card.box.bottom}, below the capsule's top at ${card.capsule.top}`);
      assert.ok(Math.abs(card.box.left - card.capsule.left) < 1, 'the card does not start where its capsule does');
      for (const part of [
        'Fix invoice PDF rounding', 'billing-api · invoice-rounding', 'Bash: pnpm test invoices --run', 'PR 1842 · checks running',
        'Worth knowing: Two customers were billed one cent too much on three September invoices; support may want to know.',
        'Totals now use integer cents end to end; re-running the invoice tests before pushing the fix.',
      ]) {
        assert.ok(card.text.includes(part), `the card lacks "${part}":\n${card.text}`);
      }
      assert.match(card.text, /(^|\s)\d+:\d\d(\s|$)/);
      assert.doesNotMatch(card.text, /You answered/);
      await shot('hover-card');

      await page.pointAt(720, 200);
      await page.until('the card to close', () => !document.querySelector('[data-hovercard]:popover-open'));

      await page.eval(() => document.querySelector<HTMLElement>('[data-capsule][data-session="s-invoice"] button')!.focus());
      await page.key('Tab');
      assert.deepEqual(await page.eval(openCards), ['s-search'], 'Tab did not open the next capsule\'s card at once');
      await page.key('Tab');
      assert.equal(await page.eval(() => document.activeElement?.closest<HTMLElement>('[data-capsule]')?.dataset.session), 's-thumbs');
      assert.deepEqual(await page.eval(openCards), ['s-thumbs']);
    },
  },
  {
    name: 'P6.3 a click on a capsule opens its sheet on Overview over the queue, with its hover card closed; Esc goes back to the queue',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 3);
      await page.hover('[data-capsule][data-session="s-invoice"] button');
      await page.until('the hover card', hoverCard, 's-invoice');
      await page.click('[data-capsule][data-session="s-invoice"] button');
      await page.until('the sheet', sheetOpen);
      assert.deepEqual(await page.eval(() => [location.pathname, window.navigation.currentEntry?.getState()]), ['/s/s-invoice/overview', { base: '/' }]);
      assert.deepEqual(await page.eval(openCards), []);
      await page.key('Escape');
      await page.until('the queue', () => location.pathname === '/' && !document.querySelector('#task-sheet[open]') && !!document.querySelector('[data-dock]'));
    },
  },
  {
    name: 'P6.4 sixteen working agents (volume) at 1440×900: "16 working", every capsule 230 px wide or more and every name and step 80 px or more; the dock is 128 px tall at most and scrolls, the queue above keeps clear of it, and a capsule scrolled into view shows its whole card, over the dock\'s edge',
    scenario: 'volume',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 16);
      const dock = (await page.eval(dockState))!;
      assert.equal(dock.count, '16 working');
      assert.ok(dock.capsules.every((c) => c.state === 'working'));
      for (const c of dock.capsules) {
        assert.ok(c.box!.width >= 230, `${c.session} is ${c.box!.width} px wide`);
        assert.ok(c.nameBox!.width >= 80 && c.lineBox!.width >= 80, `${c.session}: name ${c.nameBox!.width} px, step ${c.lineBox!.width} px`);
      }
      assert.ok(dock.box!.height <= 128, `the dock is ${dock.box!.height} px tall`);
      assert.ok(dock.grid!.scrollHeight > dock.grid!.clientHeight, 'the capsules do not scroll');
      // Once P5 draws the card, it and the top of each option show above the dock.
      const room = await page.eval(() => {
        const dock = document.querySelector('[data-dock]')!.getBoundingClientRect();
        const card = document.querySelector('[data-card]');
        const shown = (el: Element) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(12, r.height / 2));
          return r.top < dock.top && !!hit && el.contains(hit);
        };
        return {
          view: document.querySelector('main')!.getBoundingClientRect().bottom <= dock.top + 1,
          card: card && { above: card.getBoundingClientRect().bottom <= dock.top + 1, options: [...card.querySelectorAll('[data-option]')].map(shown) },
        };
      });
      assert.equal(room.view, true, 'the queue runs under the dock');
      if (room.card) assert.deepEqual(room.card, { above: true, options: room.card.options.map(() => true) });
      await shot('dock-volume');

      const last = dock.capsules.at(-1)!;
      await page.hover(`[data-capsule][data-session="${last.session}"] button`);
      await page.until('the card of the last capsule', hoverCard, last.session);
      await page.until('the card to settle', settled);
      const card = (await page.eval(hoverCard, last.session))!;
      const grid = (await page.eval(dockState))!.grid!.box!;
      assert.ok(card.text.startsWith(last.name!), 'the card is not that capsule\'s');
      assert.ok(card.inside, `the card of ${last.session} is not inside the window`);
      assert.ok(card.box.bottom <= card.capsule.top, 'the card is not above its capsule');
      assert.ok(card.box.top < grid.top, 'the card does not reach out of the dock');
      // The card takes no pointer, so let it take one for a moment: wherever it is drawn, nothing covers or clips it.
      const whole = await page.eval((id: string) => {
        const card = document.querySelector<HTMLElement>(`[data-capsule][data-session="${id}"] [data-hovercard]`)!;
        const r = card.getBoundingClientRect();
        card.inert = false;
        try {
          return [[r.left + 8, r.top + 8], [r.right - 8, r.top + 8], [r.left + 8, r.bottom - 8], [r.right - 8, r.bottom - 8]]
            .every(([x, y]) => card.contains(document.elementFromPoint(x, y)));
        } finally {
          card.inert = true;
        }
      }, last.session);
      assert.equal(whole, true, 'part of the card is clipped or covered');
      await shot('hover-card-volume');
    },
  },
  {
    name: 'P6.5 narrow window: the dock is one row of 250 px capsules that scrolls sideways while the page does not, no hover card opens, and a click on a capsule opens its sheet',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 3);
      const row = await page.eval(() => {
        const dock = document.querySelector<HTMLElement>('[data-dock]')!;
        const capsules = [...dock.querySelectorAll('[data-capsule]')].map((c) => c.getBoundingClientRect());
        return { rows: new Set(capsules.map((r) => Math.round(r.top))).size, widths: capsules.map((r) => r.width), scrolls: dock.scrollWidth > dock.clientWidth };
      });
      assert.deepEqual(row, { rows: 1, widths: [250, 250, 250], scrolls: true });
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.hover('[data-capsule][data-session="s-thumbs"] button');
      await sleep(400);
      assert.deepEqual(await page.eval(openCards), []);
      await shot('narrow-dock');
      await page.click('[data-capsule][data-session="s-thumbs"] button');
      await page.until('the sheet of s-thumbs', () => location.pathname === '/s/s-thumbs/overview' && !!document.querySelector('#task-sheet:modal'));
    },
  },
  {
    name: 'P6.hover-under-sheet a hover card never stays over the sheet: not when the sheet opens while the card shows, nor when it opens before the hover delay runs out, nor from Enter on a capsule the keyboard opened a card for',
    async run({ page, mock }) {
      const open = (path: string) => window.navigation.navigate(path, { state: { base: '/' } }).finished?.catch(() => {});
      const cleared = async () => {
        await page.until('the sheet', sheetOpen);
        await sleep(400);
        assert.deepEqual(await page.eval(openCards), []);
        await page.key('Escape');
        await page.until('the sheet to close', () => !document.querySelector('#task-sheet[open]') && location.pathname === '/');
      };
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 3);

      await page.hover('[data-capsule][data-session="s-invoice"] button');
      await page.until('the hover card', hoverCard, 's-invoice');
      await page.eval(open, '/s/s-cart/overview');
      await cleared();

      await page.pointAt(720, 200);
      await page.hover('[data-capsule][data-session="s-search"] button');
      await page.eval(open, '/s/s-cart/overview');
      await cleared();

      await page.pointAt(720, 200);
      await page.eval(() => document.querySelector<HTMLElement>('[data-capsule][data-session="s-invoice"] button')!.focus());
      await page.key('Tab');
      assert.deepEqual(await page.eval(openCards), ['s-search']);
      await page.key('Enter');
      await page.until('the sheet of s-search', () => location.pathname === '/s/s-search/overview');
      await cleared();
    },
  },
  {
    name: 'P6.resting with nothing in the queue / rests on the Wall, which has every agent on it, and draws no dock, as C does; the first card that arrives brings the dock',
    scenario: 'zero',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the resting Wall', () => document.querySelector('main h1')?.textContent === 'Nothing needs you.');
      await sleep(300);
      assert.equal(await page.eval(() => !!document.querySelector('[data-dock]')), false);
      await mock.post('/mock/add', { template: 'ask', id: 's-new', rank: 1 });
      await page.until('the dock', docked, 3);
    },
  },
  {
    name: 'P6.edge-card the card of a capsule at the right edge of the window, where it cannot open rightwards, opens leftwards from the capsule\'s end and stays inside the window (volume45, no ended pill)',
    scenario: 'volume45',
    async run({ page, mock, look, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the dock', docked, 16);
      const id = await page.eval(() => {
        const capsules = [...document.querySelectorAll<HTMLElement>('[data-dock] [data-capsule]')];
        const right = Math.max(...capsules.map((c) => c.getBoundingClientRect().right));
        return capsules.find((c) => c.getBoundingClientRect().right === right)!.dataset.session!;
      });
      await page.hover(`[data-capsule][data-session="${id}"] button`);
      await page.until('its card', hoverCard, id);
      await page.until('the card to settle', settled);
      const card = (await page.eval(hoverCard, id))!;
      assert.ok(card.capsule.left + (card.box.right - card.box.left) > look.width, 'the card would have fitted rightwards');
      assert.ok(card.inside, 'the card is not inside the window');
      assert.ok(Math.abs(card.box.right - card.capsule.right) < 1, 'the card does not end where its capsule ends');
      assert.ok(card.box.bottom <= card.capsule.top, 'the card is not above its capsule');
      await shot('hover-card-edge');
    },
  },
  {
    name: 'P7.leave-deals Quit Claude and Delete worktree from the card\'s ⋯ deal the card out sideways, as Archive does; the card after it comes up, with no word that anything stopped waiting',
    async run({ page, mock }) {
      const confirmable = () => {
        const d = document.querySelector<HTMLDialogElement>('dialog#delete-worktree');
        return !!d?.open && !d.innerText.includes('Checking');
      };
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(watchDeals);
      await page.click('[data-card] button[aria-label="Session actions"]');
      await page.until('the menu', menuItems);
      await page.click(':popover-open button', 'Quit Claude');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      assert.deepEqual(await page.eval(dealt), ['side']);
      const [quit] = await logged(mock, 'the quit', (e) => e.action === 'quit');
      assert.deepEqual([quit.sessionId, quit.status], ['s-cart', 204]);

      await ready(page, 's-hooks');
      await page.click('[data-card] button[aria-label="Session actions"]');
      await page.until('the menu', menuItems);
      await page.click(':popover-open button', 'Delete worktree');
      await page.until('the delete dialog', confirmable);
      await page.click('dialog#delete-worktree button', 'Delete worktree');
      await page.until('s-group at the front', frontIs, 's-group');
      assert.deepEqual(await page.eval(dealt), ['side', 'side']);
      const [deleted] = await logged(mock, 'the deletion', (e) => e.method === 'POST' && e.action === 'delete-worktree');
      assert.deepEqual([deleted.sessionId, deleted.status], ['s-hooks', 204]);
      await sleep(600);
      assert.equal(await page.eval(() => !!document.querySelector('[data-session="s-cart"]:is([data-segment], [data-peek]), [data-session="s-hooks"]:is([data-segment], [data-peek])')), false);
      assert.deepEqual([await page.eval(toastsOf, 'info'), await page.eval(toastsOf, 'error')], [null, null]);
    },
  },
  {
    name: 'P7.archive-stays an archive shows at once and stays: a snapshot pushed before the server has stored it does not bring the card back for a moment',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.click('[data-segment][data-session="s-reviews"]');
      await ready(page, 's-reviews');
      await mock.post('/mock/delay', { ms: 1500 });
      await page.key('x');
      const shownAnywhere = () => !!document.querySelector('[data-session="s-reviews"]:is([data-segment], [data-peek], [data-card])');
      await page.until('s-reviews to leave', () => !document.querySelector('[data-session="s-reviews"]:is([data-segment], [data-peek], [data-card])'));
      await page.eval(() => {
        const w = window as unknown as { e2eBack: boolean };
        w.e2eBack = false;
        new MutationObserver(() => {
          if (document.querySelector('[data-session="s-reviews"]:is([data-segment], [data-peek], [data-card])')) w.e2eBack = true;
        }).observe(document.body, { subtree: true, childList: true, attributes: true });
      });
      await mock.post('/mock/patch', { id: 's-invoice', patch: { activity: { step: 'Bash: pnpm test invoices --run --reporter=dot' } } });
      await page.until('that snapshot', () => !!document.querySelector('[data-capsule][data-session="s-invoice"]')?.textContent?.includes('--reporter=dot'));
      const [archived] = await logged(mock, 'the archive', (e) => e.action === 'archive', 4000);
      assert.deepEqual([archived.sessionId, archived.status], ['s-reviews', 204]);
      await sleep(300);
      assert.deepEqual([await page.eval(() => (window as unknown as { e2eBack: boolean }).e2eBack), await page.eval(shownAnywhere)], [false, false]);
      assert.equal((await stateOf(mock, 's-reviews')).archived, true);
    },
  },
  {
    name: 'P7.skip-ends-wait a click on Skip that ends a wait for typing brings up the card that waited and skips nothing; the next click skips',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('Let me think');
      await mock.post('/mock/patch', { id: 's-cart', patch: { question: null, status: 'working', activity: { step: 'Edit src/cart/mergeCarts.ts', since: Date.now() } } });
      await page.until('s-cart to leave the deck', () => !document.querySelector('[data-segment][data-session="s-cart"]'));
      assert.equal(await page.eval(() => document.querySelector<HTMLElement>('[data-card]')?.dataset.session), 's-cart', 'the card did not wait for the typing');
      await page.eval(watchDeals);
      await page.click('main button[aria-label="Skip to the next card"]');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await sleep(700);
      assert.deepEqual([await page.eval(() => document.querySelector<HTMLElement>('[data-card]')?.dataset.session), await page.eval(dealt)], ['s-hooks', []]);
      await page.click('main button[aria-label="Skip to the next card"]');
      await page.until('s-group at the front', frontIs, 's-group');
      assert.deepEqual(await page.eval(dealt), ['back']);
    },
  },
  {
    name: 'P7.dock-waits typing in New task on the resting Wall holds the dock back with the queue: a card that arrives meanwhile brings neither until focus leaves the prompt',
    scenario: 'zero',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
      await page.until('the resting Wall', () => document.querySelector('main h1')?.textContent === 'Nothing needs you.');
      await page.click('#new-task-inline textarea');
      await page.type('Add retries');
      await mock.post('/mock/add', { template: 'ask', id: 's-new', rank: 1 });
      await page.until('the arrival in the meter', () => !!document.querySelector('[data-segment][data-session="s-new"]'));
      await sleep(400);
      assert.deepEqual(await page.eval(() => [!!document.querySelector('[data-dock]'), !!document.querySelector('[data-card]')]), [false, false]);
      await page.key('Escape');
      await page.until('the card and the dock', () => !!document.querySelector('[data-card]') && !!document.querySelector('[data-dock]'));
    },
  },
  {
    name: 'P7.new-task-fade Esc closes New task over the queue and takes focus out of its prompt at once, so a key typed while the dialog fades out does not land in it',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.key('n');
      await page.until('the prompt, focused', () => document.activeElement?.matches('#new-task textarea'));
      await page.type('Fix');
      await page.key('Escape');
      await page.key('q');
      await sleep(400);
      assert.deepEqual(await page.eval(() => ({
        open: document.querySelector<HTMLDialogElement>('#new-task')!.open,
        prompt: document.querySelector<HTMLTextAreaElement>('#new-task textarea')!.value,
        inside: !!document.activeElement?.closest('#new-task'),
      })), { open: false, prompt: 'Fix', inside: false });
    },
  },
  {
    name: 'P7.picker-outside a click beside New task while its repository picker is open closes only the picker; the next click beside it closes the dialog',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await page.key('n');
      await page.until('New task', () => !!document.querySelector('#new-task:modal'));
      await page.until('the dialog to settle', settled);
      await page.click('#new-task select');
      await page.until('the picker', () => document.querySelector('#new-task select')!.matches(':open'));
      await page.pointAt(24, 860, true);
      await page.until('the picker to close', () => !document.querySelector('#new-task select')!.matches(':open'));
      await sleep(300);
      assert.equal(await page.eval(() => !!document.querySelector('#new-task:modal')), true, 'the click closed the dialog with the picker');
      await page.pointAt(24, 860, true);
      await page.until('the dialog to close', () => !document.querySelector('#new-task[open]'));
    },
  },
  {
    name: 'P7.phone-toast narrow window: the undo toast of a message sent from a sheet sits at the bottom of the window, clear of the sheet\'s head, and takes a click',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-invoice/overview`);
      await page.until('the sheet', sheetOpen);
      await page.click('#task-sheet textarea');
      await page.type('Also round the tax lines');
      await page.key('Enter');
      const [toast] = await page.until('the undo toast', toastsOf, 'undo');
      const at = await page.eval(() => {
        const t = document.querySelector('[data-toast][data-kind="undo"]')!.getBoundingClientRect();
        const head = document.querySelector('#task-sheet header')!.getBoundingClientRect();
        return { clear: t.top >= head.bottom || t.bottom <= head.top, bottom: innerHeight - t.bottom, inside: t.left >= 0 && t.right <= innerWidth };
      });
      assert.deepEqual({ ...at, bottom: at.bottom <= 40, hit: toast.hit }, { clear: true, bottom: true, inside: true, hit: true });
      await shot('phone-sheet-toast');
      await page.click('[data-toast][data-kind="undo"] button', 'Undo');
      await page.until('the message back in the reply box', () => document.querySelector<HTMLTextAreaElement>('#task-sheet textarea')?.value === 'Also round the tax lines');
    },
  },
  {
    name: 'P7.reply-hint with the reply box and its command list open, the hint line under the box shows whole, above the column\'s faded edge and the footer',
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.key('w');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await page.type('/re');
      await page.until('the command list', () => document.querySelectorAll('[data-card] [role="option"]').length > 0);
      await sleep(200);
      const at = await page.eval(() => {
        const hint = [...document.querySelectorAll('[data-card] section p')].find((p) => p.textContent?.startsWith('Enter sends'))!.getBoundingClientRect();
        const column = document.querySelector('[data-card] [data-side="right"]')!.getBoundingClientRect();
        const foot = document.querySelector('[data-card] footer')!.getBoundingClientRect();
        return { hint: Math.round(hint.bottom), fade: Math.round(column.bottom - 22), foot: Math.round(foot.top) };
      });
      assert.ok(at.hint <= at.fade && at.hint <= at.foot, `the hint line ends at ${at.hint}, the fade starts at ${at.fade} and the footer at ${at.foot}`);
      await shot('queue-composer');
    },
  },
  {
    name: 'P7.phone-card narrow window: every kind of card is one column with one peek, its footer takes at most two rows, and the primary shows at the top and the bottom of the page; the reply box scrolls into view above the footer',
    narrow: true,
    async run({ page, mock, shot }) {
      await openQueue(page, mock);
      for (const id of ['s-cart', 's-hooks', 's-group', 's-astro', 's-reviews']) {
        await page.until(`the card of ${id}`, frontIs, id);
        await page.until('the card to settle', still);
        const shape = await page.eval(narrowCard);
        assert.deepEqual({ ...shape, footRows: shape.footRows <= 2 }, { stacked: true, peeks: ['1'], sliver: false, footRows: true }, `${id}: ${JSON.stringify(shape)}`);
        assert.deepEqual(await page.eval(primaryAtEnds), { top: true, bottom: true, scrolls: true }, id);
        assert.deepEqual(await page.eval(sidewaysScroll), [], id);
        if (id === 's-cart') await shot('phone-ask');
        if (id === 's-hooks') await shot('phone-menu');
        await page.key('ArrowRight');
      }
      await page.until('s-anchors at the front', frontIs, 's-anchors');
      await page.click('[data-segment][data-session="s-cart"]');
      await ready(page, 's-cart');
      await page.click('[data-card] footer button', 'Write my own');
      await page.until('the reply box, focused', () => document.activeElement?.matches('[data-card] textarea'));
      await sleep(200);
      const reply = await page.eval(() => {
        const hint = [...document.querySelectorAll('[data-card] section p')].find((p) => p.textContent?.startsWith('Enter sends'))!.getBoundingClientRect();
        const box = document.querySelector('[data-card] textarea')!.getBoundingClientRect();
        const foot = document.querySelector('[data-card] footer')!.getBoundingClientRect();
        return { box: box.top >= 0 && box.bottom <= foot.top, hint: hint.bottom <= foot.top };
      });
      assert.deepEqual(reply, { box: true, hint: true });
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await shot('phone-reply');
    },
  },
  {
    name: 'P7.phone-sideways narrow window: nothing scrolls sideways on the Wall, in the sheet\'s tabs, in New task, Repos, Keys, Delete worktree or the ⋯ menu, and each dialog fits the window; only the diff\'s code and the artifacts list scroll sideways, by design',
    narrow: true,
    async run({ page, mock, shot }) {
      const inside = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return r.left >= -1 && r.right <= innerWidth + 1;
      };
      const sideways = async (where: string, byDesign?: RegExp) =>
        assert.deepEqual((await page.eval(sidewaysScroll)).filter((s) => !byDesign?.test(s)), [], where);
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', tiles);
      await sideways('the Wall');
      await shot('phone-wall');
      for (const tab of ['diff', 'artifacts', 'overview']) {
        await page.goto(`${mock.url}/s/s-cart/${tab}`);
        await page.until('the sheet', sheetOpen);
        await page.until('the sheet to settle', settled);
        if (tab === 'diff') await page.until('the diff', () => document.querySelectorAll('section[data-file] diffs-container').length === 12);
        await sideways(`the sheet's ${tab}`, tab === 'diff' ? /^div\.\w+_diffs$/ : tab === 'artifacts' ? /^div\.\w+_list$/ : undefined);
        assert.equal(await page.eval(inside, '#task-sheet'), true);
        await shot(`phone-sheet-${tab}`);
      }
      await page.click('#task-sheet header button[aria-label="Session actions"]');
      await page.until('the menu', menuItems);
      await sideways('the ⋯ menu');
      assert.equal(await page.eval(inside, ':popover-open'), true, 'the ⋯ menu');
      await page.click(':popover-open button', 'Delete worktree');
      await page.until('the delete dialog', () => !!document.querySelector('dialog#delete-worktree li'));
      await page.until('the dialog to settle', settled);
      await sideways('Delete worktree');
      assert.equal(await page.eval(inside, 'dialog#delete-worktree'), true);
      await shot('phone-delete');
      await page.key('Escape');

      await openQueue(page, mock);
      await page.key('n');
      await page.until('New task', () => !!document.querySelector('#new-task:modal'));
      await page.click('#new-task button', 'More options');
      await page.until('the dialog to settle', settled);
      await sideways('New task');
      assert.equal(await page.eval(inside, '#new-task'), true);
      await shot('phone-new-task');
      await page.key('Escape');
      await page.until('New task to close', () => !document.querySelector('#new-task[open]'));
      await page.click('button[data-repos]');
      await page.until('Repos', () => !!document.querySelector('#workspace:modal section'));
      await page.until('the dialog to settle', settled);
      await sideways('Repos');
      assert.equal(await page.eval(inside, '#workspace'), true);
      await shot('phone-repos');
      await page.key('Escape');
      await page.until('Repos to close', () => !document.querySelector('#workspace[open]'));
      await page.key('?');
      await page.until('Keys', () => !!document.querySelector('#keys:modal'));
      await page.until('the dialog to settle', settled);
      await sideways('Keys');
      assert.equal(await page.eval(inside, '#keys'), true);
    },
  },
  {
    name: 'P7.reduced-motion with reduced motion a card change runs no animation longer than 10 ms: skip, previous, a peek, an answer, its Undo and the answer again until its capsule rings',
    motion: 'reduce',
    async run({ page, mock }) {
      await openQueue(page, mock);
      await ready(page, 's-cart');
      await page.eval(noteAnimations);
      await page.key('ArrowRight');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('ArrowLeft');
      await page.until('s-cart at the front', frontIs, 's-cart');
      await page.click('[data-peek="1"] > span');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('ArrowLeft');
      await ready(page, 's-cart');
      await page.key('Enter');
      await page.until('s-hooks at the front', frontIs, 's-hooks');
      await page.key('z');
      await ready(page, 's-cart');
      await page.key('Enter');
      await sleep(HELD_MS);
      await page.until('the answered capsule ringing', () => !!document.querySelector('[data-capsule][data-session="s-cart"][data-fresh]'));
      await sleep(300);
      const all = await page.eval(animations);
      assert.ok(all.length > 0, 'no animation was noted');
      assert.deepEqual(all.filter((a) => !(a.end <= 10)).map((a) => a.text), []);
    },
  },
];
