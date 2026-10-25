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
  scenario?: string;
  // Console errors the check provokes on purpose.
  expectedErrors?: RegExp[];
  run: (t: Context) => Promise<void>;
}

const logged = (mock: Mock, what: string, match: (e: Entry) => boolean) =>
  until(`${what} in the mock's log`, async () => {
    const found = (await mock.log()).filter((e) => match(e) && e.status !== null);
    return found.length ? found : null;
  });

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

const sidewaysScroll = () => {
  const wide = (el: Element) => el.scrollWidth > el.clientWidth + 1;
  const out = wide(document.scrollingElement!) ? ['the page'] : [];
  for (const el of document.querySelectorAll('body *')) {
    const { overflowX } = getComputedStyle(el);
    if ((overflowX === 'auto' || overflowX === 'scroll') && wide(el) && !el.closest('pre, code, textarea')) {
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

export const checks: Check[] = [
  {
    name: 'P0.2 board: 11 tiles, Archived (1) collapsed, title (3); an option answers once and the tile turns working',
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

      await page.goto(`${mock.url}/s/s-cart/overview`);
      await page.until('the sheet with its 3 options', () => location.pathname === '/s/s-cart/overview' && document.querySelectorAll('button[name="choice"]').length === 3);
      await shot('task-ask');
      await page.click('button[name="choice"]', 'Keep the account cart');
      const answers = await logged(mock, 'the answer', (e) => e.action === 'answer');
      assert.equal(answers.length, 1);
      const [a] = answers;
      assert.deepEqual([a.sessionId, a.body.key, a.body.choice, a.status], ['s-cart', 'q:toolu_01Cart', 'Keep the account cart', 204]);

      await page.click('#task-sheet button[aria-label^="Back to"]');
      await page.until('the sheet to close', () => !document.querySelector('#task-sheet[open]'));
      await page.goto(`${mock.url}/wall`);
      await page.until('the s-cart tile to turn working', () => document.querySelector('[data-tile][data-session="s-cart"]')?.getAttribute('data-attention') === 'working');
      assert.equal((await mock.log()).filter((e) => e.action === 'answer').length, 1);
      assert.equal(await page.eval(() => document.title), '(2) Agent Board');
      await shot('board-answered');
    },
  },
  {
    name: 'P0.3 a refused answer (/mock/fail, stale) shows the toast "this question is no longer open"',
    expectedErrors: [/this question is no longer open/, /status of 400/],
    async run({ page, mock, shot }) {
      await mock.post('/mock/fail', { error: 'this question is no longer open', code: 'stale' });
      await page.goto(`${mock.url}/s/s-hooks/overview`);
      await page.until('the menu with its 2 questions', () => location.pathname === '/s/s-hooks/overview' && document.querySelectorAll('fieldset').length === 2);
      await page.click('fieldset button', 'Exponential, 5 tries');
      await page.click('fieldset button', 'Email the account owner');
      await shot('task-menu');
      await page.click('button[type="submit"]', 'Send answer');
      const toast = await page.until('the error toast', () => [...document.querySelectorAll<HTMLElement>('[data-toast][data-kind="error"]')].map((t) => t.innerText.trim()).join('\n'));
      assert.equal(toast, 'this question is no longer open');
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
    name: 'P0 narrow smoke: no sideways scroll on the board or in the sheet; New task and the options stay reachable',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/wall`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      await page.until('New task in reach', reachable, 'button', 'New task');
      await shot('narrow-board');
      await page.goto(`${mock.url}/s/s-cart/details`);
      await page.until('the options', () => document.querySelectorAll('button[name="choice"]').length === 3);
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      // The sheet slides up as it opens.
      await page.until('the first option in reach', reachable, 'button[name="choice"]', 'Merge both carts');
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
      await page.goto(`${mock.url}/s/s-cart/details`);
      await page.until('the options', () => document.querySelectorAll('button[name="choice"]').length === 3);
      await shot('task-ask');
      await page.goto(`${mock.url}/s/s-hooks/details`);
      await page.until('the menu with its 2 questions', () => document.querySelectorAll('fieldset').length === 2);
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
    name: 'P1a.compat-accept today\'s UI accepts the second opinion on a question and on a menu; the snapshot names what was sent',
    async run({ page, mock, shot }) {
      const { legacy } = await mock.get('/mock');
      const sessionOf = async (id: string) => (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === id);
      for (const [id, key, text] of [
        ['s-cart', 'q:toolu_01Cart', 'Merge both carts. Cap each line at available stock and show a toast listing anything trimmed.'],
        ['s-hooks', 'm:toolu_01Hooks', 'Backoff: Exponential, 5 tries · Give up: Email the account owner, Disable the endpoint'],
      ]) {
        await page.goto(`${mock.url}/s/${id}/details`);
        await page.click('button', 'Accept & send');
        const [accepted] = await logged(mock, `the accepted second opinion of ${id}`, (e) => e.action === 'accept-advice' && e.sessionId === id);
        assert.deepEqual([accepted.status, accepted.body.key], [204, key]);
        const s = await sessionOf(id);
        if (legacy) assert.equal('answered' in s, false);
        else assert.deepEqual([s.answered.key, s.answered.text], [key, text]);
        await until(`${id} to start working`, async () => (await sessionOf(id)).status === 'working');
        await shot(`accepted-${id}`);
      }
    },
  },
  {
    name: 'P1a.compat-dismiss today\'s UI dismisses a question: it closes, the tile leaves Decide, and nothing counts as answered',
    async run({ page, mock, shot }) {
      const { legacy } = await mock.get('/mock');
      await page.goto(`${mock.url}/s/s-cart/details`);
      await page.click('button[value="dismiss"]');
      const [dismissed] = await logged(mock, 'the dismissal', (e) => e.action === 'dismiss');
      assert.deepEqual([dismissed.sessionId, dismissed.status, dismissed.body.key], ['s-cart', 204, 'q:toolu_01Cart']);
      const s = (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === 's-cart');
      assert.deepEqual([s.question, s.dismissedAsk, s.status, s.answered], [null, 'toolu_01Cart', 'idle', legacy ? undefined : null]);
      await page.click('#task-sheet button[aria-label^="Back to"]');
      await page.until('the sheet to close', () => !document.querySelector('#task-sheet[open]'));
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
    name: 'P4.15 answering in the sheet still works until P5: an option on s-cart sends answer with its key and choice',
    async run({ page, mock }) {
      await openSheetOf(page, mock, 's-cart');
      await page.click('#task-sheet button[name="choice"]', 'Keep the account cart');
      const answers = await logged(mock, 'the answer', (e) => e.action === 'answer');
      assert.deepEqual(answers.map((a) => [a.sessionId, a.body.key, a.body.choice, a.status]), [['s-cart', 'q:toolu_01Cart', 'Keep the account cart', 204]]);
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
        card: !!document.querySelector('[data-card]'),
        value: document.querySelector<HTMLTextAreaElement>('#new-task-inline textarea')?.value,
        focused: document.activeElement === document.querySelector('#new-task-inline textarea'),
        toasts: [...document.querySelectorAll('[data-toast]')].length,
      }));
      assert.deepEqual(held, { card: false, value: 'Fix the login we fix 3 x\n', focused: true, toasts: 0 });
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
      await page.hover(box.x, box.y);
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
  },
];
