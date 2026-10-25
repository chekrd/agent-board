import assert from 'node:assert/strict';
import { sleep, until, type Look, type Page } from './cdp.ts';
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
  {
    name: 'P2.1 fonts: Bricolage Grotesque and Hanken Grotesk come with the app, and the page asks no host but 127.0.0.1',
    async run({ page, mock }) {
      await page.goto(`${mock.url}/`);
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
      await page.goto(`${mock.url}/`);
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
      await page.goto(`${mock.url}/`);
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
      await page.click('a[href="/"]');
      await page.until('the s-cart tile to leave Decide', () =>
        document.querySelector('[data-tile]:has(a[href="/s/s-cart/details"])')?.getAttribute('data-attention') === 'idle');
      await shot('dismissed');
    },
  },
  {
    name: 'P1a.mock-reset an answer still typing when the scenario loads again fails and leaves the fresh scenario alone',
    async run({ mock }) {
      const { legacy } = await mock.get('/mock');
      const cart = async () => (await mock.get('/api/state')).sessions.find((s: { id: string }) => s.id === 's-cart');
      const answer = fetch(`${mock.url}/api/sessions/s-cart/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'q:toolu_01Cart', choice: 'Keep the account cart' }),
      });
      if (legacy) await answer;
      else await until('the answer to be claimed and typing', async () => (await cart()).answered);
      await mock.post('/mock/scenario/queue');
      const reply = await answer;
      assert.deepEqual([reply.status, reply.status === 204 ? null : (await reply.json()).error], legacy ? [204, null] : [400, 'the mock loaded another scenario meanwhile']);
      await sleep(1000);
      const s = await cart();
      assert.deepEqual([s.question?.toolUseId, s.answered ?? null, s.status], ['toolu_01Cart', null, 'idle']);
    },
  },
  {
    name: 'P3.reload-gate a new build reloads the board when nothing is focused; a focused draft holds it until a click outside, the New task dialog until it closes; the page\'s own entry never reloads it',
    async run({ page, mock, shot }) {
      const mark = () => page.eval(() => void ((window as unknown as { probe?: number }).probe = 1));
      const marked = () => page.eval(() => (window as unknown as { probe?: number }).probe === 1);
      const newBuild = () => mock.post('/mock/ui-entry', { src: '/assets/index-next.js' });
      // The old document goes away under a call, so a failed call means "not yet".
      const reloaded = (what: string) => until(`the page to reload ${what}`, async () => {
        try {
          return await page.eval(() => (window as unknown as { probe?: number }).probe === undefined && document.readyState === 'complete');
        } catch {
          return false;
        }
      });

      await page.goto(`${mock.url}/`);
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);
      await mark();
      await newBuild();
      await reloaded('with nothing focused');
      await page.until('the tiles', () => document.querySelectorAll('[data-tile]').length > 0);

      await mark();
      const own = await page.eval(() => document.querySelector('script[type="module"][src]')!.getAttribute('src')!);
      await mock.post('/mock/ui-entry', { src: own });
      await mock.post('/mock/ui-entry', { src: `${mock.url}${own}` });
      await sleep(3000);
      assert.equal(await marked(), true, 'its own entry reloaded the page');

      await page.goto(`${mock.url}/s/s-reviews/details`);
      await page.click('textarea');
      await page.type('Ship it after lunch');
      await mark();
      await newBuild();
      await sleep(3000);
      const typing = await page.eval(() => [
        (window as unknown as { probe?: number }).probe, document.activeElement?.tagName, document.querySelector('textarea')?.value,
      ]);
      assert.deepEqual(typing, [1, 'TEXTAREA', 'Ship it after lunch']);
      await shot('draft-holds-reload');
      await page.click('h4', 'Status');
      await reloaded('once focus left the draft');

      await page.goto(`${mock.url}/`);
      await page.click('button', 'New task');
      await page.until('the New task dialog', () => !!document.querySelector<HTMLDialogElement>('dialog#new-task')?.open);
      const blurred = await page.eval(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        return document.activeElement === document.body;
      });
      assert.equal(blurred, true, 'only the open dialog holds the reload');
      await mark();
      await newBuild();
      await sleep(3000);
      assert.equal(await marked(), true, 'reloaded under the New task dialog');
      await shot('dialog-holds-reload');
      await page.click('dialog#new-task button', 'Cancel');
      await reloaded('once the dialog closed');
    },
  },
  {
    name: 'P3.reload-offline a new build waits for the server: focus leaving a draft while the server cannot be reached does not reload the board, and it reloads once the server is back',
    expectedErrors: [/WebSocket/, /ERR_CONNECTION/],
    async run({ page, mock, shot }) {
      await page.goto(`${mock.url}/s/s-reviews/details`);
      await page.click('textarea');
      await page.type('Ship it after lunch');
      await page.eval(() => void ((window as unknown as { probe?: number }).probe = 1));
      await mock.post('/mock/ui-entry', { src: '/assets/index-offline.js' });
      await mock.post('/mock/drop', { ms: 4000 });
      try {
        await page.until('the server to drop the page', () => fetch('/').then(() => false, () => true));
        await page.click('h4', 'Status');
        await sleep(1500);
        const kept = await page.eval(() => [
          (window as unknown as { probe?: number }).probe, document.activeElement === document.body, document.querySelector('textarea')?.value,
        ]);
        assert.deepEqual(kept, [1, true, 'Ship it after lunch'], 'reloaded while the server could not be reached');
        await shot('offline-holds-reload');
      } finally {
        // The next check's reset cannot reach the mock until the drop is over.
        await until('the drop to end', () => mock.get('/mock').then(() => true, () => false), 10_000);
      }
      await until('the page to reload once the server is back', async () => {
        try {
          return await page.eval(() => (window as unknown as { probe?: number }).probe === undefined && document.readyState === 'complete');
        } catch {
          return false;
        }
      }, 10_000);
      await page.until('the task page', () => document.querySelector('textarea') !== null);
    },
  },
];
