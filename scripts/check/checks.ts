import assert from 'node:assert/strict';
import { until, type Look, type Page } from './cdp.ts';
import type { Entry, Mock } from './mock.ts';

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

// Waits until the mock has answered requests that match.
const logged = (mock: Mock, what: string, match: (e: Entry) => boolean) =>
  until(`${what} in the mock's log`, async () => {
    const found = (await mock.log()).filter((e) => match(e) && e.status !== null);
    return found.length ? found : null;
  });

// Page functions: they run in the browser, so they use only their arguments.

const connection = () => {
  const dot = document.querySelector('[data-connected]');
  const [r, g] = (dot ? getComputedStyle(dot).backgroundColor.match(/\d+/g) ?? [] : []).map(Number);
  return { connected: dot?.getAttribute('data-connected') ?? null, red: r > g, green: g > r };
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
  return r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
};

// Scrolls the diff list to one end and tells whether the line numbers there reach `line`.
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

export const checks: Check[] = [
  {
    name: 'P0.2 board: 11 tiles, Archived (1) collapsed, title (3); an option answers once and the tile turns working',
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      const board = await page.eval(() => ({
        tiles: [...document.querySelectorAll('[data-tile]')].filter((t) => !t.closest('details')).length,
        archived: document.querySelector('details > summary')?.textContent,
        open: document.querySelector('details')?.open,
        title: document.title,
      }));
      assert.deepEqual(board, { tiles: 11, archived: 'Archived (1)', open: false, title: '(3) Agent Board' });
      await shot('board');

      await page.click('[data-tile] a', 'Merge guest cart on login');
      await page.until('the task page with its 3 options', () => location.pathname === '/s/s-cart/details' && document.querySelectorAll('button[name="choice"]').length === 3);
      await shot('task-ask');
      await page.click('button[name="choice"]', 'Keep the account cart');
      const answers = await logged(mock, 'the answer', (e) => e.action === 'answer');
      assert.equal(answers.length, 1);
      const [a] = answers;
      assert.deepEqual([a.sessionId, a.body.key, a.body.choice, a.status], ['s-cart', 'q:toolu_01Cart', 'Keep the account cart', 204]);

      await page.click('a[href="/"]');
      await page.until('the s-cart tile to turn working', () => document.querySelector('[data-tile]:has(a[href="/s/s-cart/details"])')?.getAttribute('data-attention') === 'working');
      assert.equal(await page.eval(() => document.title), '(2) Agent Board');
      await shot('board-answered');
    },
  },
  {
    name: 'P0.3 a refused answer (/mock/fail, stale) shows the toast "this question is no longer open"',
    expectedErrors: [/this question is no longer open/, /status of 400/],
    async run({ page, mock, shot }) {
      await mock.post('/mock/fail', { error: 'this question is no longer open', code: 'stale' });
      await page.goto(`${mock.url}/`);
      await page.click('[data-tile] a', 'Retry failed webhooks');
      await page.until('the menu with its 2 questions', () => location.pathname === '/s/s-hooks/details' && document.querySelectorAll('fieldset').length === 2);
      await page.click('fieldset button', 'Exponential, 5 tries');
      await page.click('fieldset button', 'Email the account owner');
      await shot('task-menu');
      await page.click('button[type="submit"]', 'Send answer');
      const toast = await page.until('the error toast', () => [...document.querySelectorAll('[role="alert"]')].map((t) => t.firstChild?.textContent).join('\n'));
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
    name: 'P0.5 a dropped connection (/mock/drop 3 s): the dot turns red, then green',
    expectedErrors: [/WebSocket/, /ERR_CONNECTION/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the live dot', () => document.querySelector('[data-connected="true"]') !== null);
      assert.deepEqual(await page.eval(connection), { connected: 'true', red: false, green: true });
      const start = Date.now();
      await mock.post('/mock/drop', { ms: 3000 });
      await page.until('the dot to turn red', () => document.querySelector('[data-connected="false"]') !== null);
      const down = Date.now() - start;
      assert.deepEqual(await page.eval(connection), { connected: 'false', red: true, green: false });
      await shot('connection-dropped');
      await until('the dot to turn green again', () => page.eval(() => document.querySelector('[data-connected="true"]') !== null), 10_000);
      const back = Date.now() - start;
      assert.ok(down < 1500, `red after ${down} ms`);
      assert.ok(back >= 3000, `green after ${back} ms, inside the drop`);
      assert.deepEqual(await page.eval(connection), { connected: 'true', red: false, green: true });
      await shot('connection-back');
    },
  },
  {
    name: 'P0 narrow smoke: no sideways scroll on the board or the task page; New task and the options stay reachable',
    narrow: true,
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      assert.ok(await page.eval(reachable, 'button', 'New task'), 'New task is out of reach');
      await shot('narrow-board');
      await page.goto(`${mock.url}/s/s-cart/details`);
      await page.until('the options', () => document.querySelectorAll('button[name="choice"]').length === 3);
      assert.deepEqual(await page.eval(sidewaysScroll), []);
      assert.ok(await page.eval(reachable, 'button[name="choice"]', 'Merge both carts'), 'the first option is out of reach');
      await shot('narrow-task');
    },
  },
];
