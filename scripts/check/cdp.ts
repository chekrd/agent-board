import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { LIVE_PORT, refuseLive } from '../isolate.ts';

export const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

export interface Look {
  scheme: 'dark' | 'light';
  width: number;
  height: number;
  motion: 'no-preference' | 'reduce';
}

export const lookName = (l: Look) => `${l.scheme}-${l.width}x${l.height}${l.motion === 'reduce' ? '-reduced' : ''}`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Truthy<T> = Exclude<T, null | undefined | false | 0 | ''>;

// Polls `fn` until it returns something truthy.
export async function until<T>(what: string, fn: () => T | Promise<T>, timeout = 5000): Promise<Truthy<T>> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value as Truthy<T>;
    if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await sleep(50);
  }
}

interface CdpEvent {
  method: string;
  params: any;
  sessionId?: string;
}

export type Page = Awaited<ReturnType<Browser['newPage']>>;
export type Browser = Awaited<ReturnType<typeof launch>>;

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
};

// A headless browser of its own: a fresh profile, a DevTools port nobody else knows, and only the pages it opens.
// Its resolver fails every host on the live board's port, so no page, request or WebSocket in it can reach that board.
export async function launch(binary = process.env.BROWSER || BRAVE) {
  const profile = mkdtempSync(join(tmpdir(), 'agent-board-e2e-'));
  const child = spawn(binary, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--use-mock-keychain', '--password-store=basic',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    `--host-resolver-rules=MAP *:${LIVE_PORT} ~NOTFOUND`, 'about:blank',
  ], { stdio: 'ignore' });
  let exited = false;
  child.once('exit', () => (exited = true));

  const discard = () => {
    if (!exited) child.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  };
  let socket: WebSocket;
  try {
    const [port, path] = await until('the DevToolsActivePort file', async () => {
      if (exited) throw new Error(`the browser exited at start: ${binary}`);
      const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n');
      return port && path ? [Number(port), path] as const : null;
    }, 20_000);
    refuseLive(port);
    socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { perMessageDeflate: false, maxPayload: 512 << 20 });
    await new Promise((ok, fail) => socket.once('open', ok).once('error', fail));
  } catch (err) {
    discard();
    throw err;
  }

  let seq = 0;
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void; method: string }>();
  const listeners = new Set<(e: CdpEvent) => void>();
  socket.on('message', (data) => {
    const msg = JSON.parse(String(data));
    const call = msg.id === undefined ? undefined : pending.get(msg.id);
    if (call) {
      pending.delete(msg.id);
      if (msg.error) call.fail(new Error(`${call.method}: ${msg.error.message}`));
      else call.ok(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });
  socket.on('close', () => {
    for (const call of pending.values()) call.fail(new Error(`${call.method}: the browser connection closed`));
    pending.clear();
  });
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((ok, fail) => {
      const id = ++seq;
      pending.set(id, { ok, fail, method });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });

  async function newPage(look: Look) {
    const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const cdp = (method: string, params: object = {}) => send(method, params, sessionId);
    const errors: string[] = [];
    const onEvent = (e: CdpEvent) => {
      if (e.sessionId !== sessionId) return;
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        errors.push(`uncaught: ${d.exception?.description ?? d.text}`);
      } else if (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'assert')) {
        errors.push(`console: ${e.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ')}`);
      } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        errors.push(`log: ${e.params.entry.text} ${e.params.entry.url ?? ''}`.trim());
      }
    };
    listeners.add(onEvent);
    await Promise.all([cdp('Page.enable'), cdp('Runtime.enable'), cdp('Log.enable')]);
    await cdp('Emulation.setDeviceMetricsOverride', { width: look.width, height: look.height, deviceScaleFactor: 1, mobile: false });
    await cdp('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: look.scheme }, { name: 'prefers-reduced-motion', value: look.motion }],
    });

    const evaluate = async (expression: string) => {
      const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(`in the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    // `fn` runs in the page: it can use only its arguments, which must be JSON.
    const run = <A extends unknown[], T>(fn: (...args: A) => T, ...args: A): Promise<Awaited<T>> => evaluate(`(${fn})(...${JSON.stringify(args)})`);

    const mouse = (type: string, x: number, y: number) =>
      cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });

    const nextEvent = (method: string) => {
      let fired = false;
      const fn = (e: CdpEvent) => {
        if (e.sessionId !== sessionId || e.method !== method) return;
        fired = true;
        listeners.delete(fn);
      };
      listeners.add(fn);
      return () => fired;
    };

    return {
      errors,
      eval: run,
      // Polls a page function until it returns something truthy.
      until: <A extends unknown[], T>(what: string, fn: (...args: A) => T, ...args: A) => until(what, () => run(fn, ...args)),
      async goto(url: string) {
        refuseLive(url);
        const loaded = nextEvent('Page.loadEventFired');
        const { errorText } = await cdp('Page.navigate', { url });
        if (errorText) throw new Error(`could not open ${url}: ${errorText}`);
        await until(`${url} to load`, loaded, 15_000);
      },
      // A real pointer click in the middle of the first visible match (whose text contains `text`). A View Transition
      // takes every click while it runs, and one may start between press and release, so a click that did not
      // reach the element is tried again.
      async click(selector: string, text = '') {
        const what = `${selector}${text ? ` with "${text}"` : ''}`;
        for (let attempt = 0; attempt < 10; attempt++) {
          const at = await until(`${what} to take a click`, () => run((selector: string, text: string) => {
            const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.checkVisibility() && (e.textContent ?? '').includes(text));
            if (!el) return null;
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            const r = el.getBoundingClientRect();
            const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            const hit = document.elementFromPoint(at.x, at.y);
            if (!hit || !el.contains(hit)) return null;
            const marks = window as unknown as { e2eClicked?: boolean };
            marks.e2eClicked = false;
            el.addEventListener('click', () => (marks.e2eClicked = true), { capture: true, once: true });
            return at;
          }, selector, text));
          await mouse('mouseMoved', at.x, at.y);
          await mouse('mousePressed', at.x, at.y);
          await mouse('mouseReleased', at.x, at.y);
          // A new document (the click loaded a page) no longer has the mark.
          if ((await run(() => (window as unknown as { e2eClicked?: boolean }).e2eClicked)) !== false) return;
          await sleep(100);
        }
        throw new Error(`${what} never received a click`);
      },
      async key(key: string) {
        const k = KEYS[key] ?? { code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
        const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
        await cdp('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text && { text: k.text, unmodifiedText: k.text }) });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      },
      type: (text: string) => cdp('Input.insertText', { text }),
      async shot(file: string) {
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, Buffer.from(data, 'base64'));
      },
      async close() {
        listeners.delete(onEvent);
        await send('Target.closeTarget', { targetId }).catch(() => {});
        await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
      },
    };
  }

  return {
    newPage,
    async close() {
      await Promise.race([send('Browser.close').catch(() => {}), sleep(3000)]);
      socket.close();
      for (let i = 0; i < 40 && !exited; i++) await sleep(50);
      discard();
    },
  };
}
