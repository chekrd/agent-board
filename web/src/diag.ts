// DIAG(paste-loss): a temporary recorder for text pasted or dictated into a reply box that never landed. It keeps the
// focus, input, paste and mount events of the last minutes, and "Paste missed?" under a reply box files them with a
// new task that investigates. Remove this module and every line marked DIAG(paste-loss) once the loss is fixed.
import { api, upload } from './api.ts';
import type { RepoView, Session } from './types.ts';

type Entry = [ms: number, type: string, detail: unknown, active: string | null, windowFocused: boolean];

const MAX = 3000;
const entries: Entry[] = [];
const started = Date.now();

const serials = new WeakMap<object, number>();
let serial = 0;

// An element as the report names it: a serial per element, so a box that remounted reads as another number.
export function describe(el: EventTarget | null | undefined): string | null {
  if (!el) return null;
  if (el === window) return 'window';
  if (el === document) return 'document';
  if (!(el instanceof Element)) return String(el);
  if (!serials.has(el)) serials.set(el, ++serial);
  const h = el as HTMLElement;
  const bits = [`${el.tagName.toLowerCase()}#${serials.get(el)}`];
  if (el.id) bits.push(`id=${el.id}`);
  for (const k of ['draft', 'session', 'card', 'tile', 'queued', 'kind'] as const) if (h.dataset?.[k] !== undefined) bits.push(`${k}=${h.dataset[k]}`);
  const label = el.getAttribute('aria-label');
  if (label) bits.push(`"${label.slice(0, 40)}"`);
  if (!el.isConnected) bits.push('detached');
  return bits.join(' ');
}

export function diag(type: string, detail: unknown = null) {
  entries.push([Math.round(performance.now()), type, detail, describe(document.activeElement), document.hasFocus()]);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
}

const boxesIn = (n: Node) => (n instanceof HTMLTextAreaElement && n.dataset.draft ? [n] : n instanceof Element ? [...n.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')] : []);

if (typeof window !== 'undefined') {
  const on = (target: EventTarget, type: string, fn: (e: any) => void) => target.addEventListener(type, fn, true);
  on(window, 'focus', (e: FocusEvent) => e.target === window && diag('window-focus'));
  on(window, 'blur', (e: FocusEvent) => e.target === window && diag('window-blur'));
  on(window, 'focusin', (e: FocusEvent) => diag('focusin', { target: describe(e.target), from: describe(e.relatedTarget) }));
  on(window, 'focusout', (e: FocusEvent) => diag('focusout', { target: describe(e.target), to: describe(e.relatedTarget) }));
  on(document, 'visibilitychange', () => diag('visibility', document.visibilityState));
  on(window, 'pointerdown', (e: PointerEvent) => diag('pointerdown', describe(e.target)));
  on(window, 'keydown', (e: KeyboardEvent) => {
    const mods = `${e.metaKey ? 'Meta+' : ''}${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}`;
    const key = mods || e.key.length > 1 ? `${mods}${e.key}` : 'char';
    diag('keydown', { key, target: describe(e.target), composing: e.isComposing, repeat: e.repeat });
  });
  on(window, 'paste', (e: ClipboardEvent) => diag('paste', {
    target: describe(e.target),
    types: [...(e.clipboardData?.types ?? [])],
    textLength: e.clipboardData?.getData('text/plain').length ?? null,
    files: e.clipboardData?.files.length ?? 0,
    trusted: e.isTrusted,
  }));
  addEventListener('paste', (e) => diag('paste-done', { defaultPrevented: e.defaultPrevented }));
  on(window, 'beforeinput', (e: InputEvent) => diag('beforeinput', { inputType: e.inputType, dataLength: e.data?.length ?? null, target: describe(e.target), trusted: e.isTrusted }));
  on(window, 'input', (e: InputEvent) => diag('input', {
    inputType: e.inputType,
    target: describe(e.target),
    valueLength: e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement ? e.target.value.length : null,
  }));
  on(window, 'compositionstart', (e: CompositionEvent) => diag('compositionstart', describe(e.target)));
  on(window, 'compositionend', (e: CompositionEvent) => diag('compositionend', { target: describe(e.target), dataLength: e.data.length }));
  on(window, 'pagehide', () => diag('pagehide'));
  on(window, 'pageshow', () => diag('pageshow'));
  navigation.addEventListener('currententrychange', () => diag('route', location.pathname));

  let active: Element | null = null;
  const watch = () => {
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.removedNodes) for (const b of boxesIn(n)) diag('box-removed', describe(b));
        for (const n of r.addedNodes) for (const b of boxesIn(n)) diag('box-added', describe(b));
      }
      if (active && !active.isConnected) diag('focused-element-removed', describe(active));
      active = document.activeElement;
    }).observe(document.body, { childList: true, subtree: true });
    on(window, 'focusin', () => {
      active = document.activeElement;
    });
  };
  if (document.body) watch();
  else addEventListener('DOMContentLoaded', watch);
  diag('load', { at: new Date(started).toISOString() });
}

const onScreen = (el: Element) => !el.closest('[inert]') && el.checkVisibility();

function snapshot(extra: Record<string, unknown>) {
  const selection = document.getSelection();
  return {
    at: new Date().toISOString(),
    url: location.href,
    windowFocused: document.hasFocus(),
    visibility: document.visibilityState,
    active: describe(document.activeElement),
    selection: selection ? { anchor: describe(selection.anchorNode?.parentElement), type: selection.type } : null,
    view: document.documentElement.dataset.view ?? null,
    deal: document.documentElement.dataset.deal ?? null,
    boxes: [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')].map((b) => ({
      box: describe(b),
      onScreen: onScreen(b),
      focused: b === document.activeElement,
      value: b.value,
      selection: [b.selectionStart, b.selectionEnd],
    })),
    ...extra,
  };
}

const sessionOf = (s: Session) => ({
  id: s.id, title: s.title, status: s.status, waitingFor: s.waitingFor, archived: s.archived, question: s.question?.title ?? null, menu: !!s.menu, updatedAt: s.updatedAt,
});

// Files what the recorder holds, with the page as it is now, and starts a task in the Pitwall repository that
// investigates it. Returns the task's session.
export async function reportPasteLoss({ sessions, repos, session, extra }: { sessions: Session[]; repos: RepoView[]; session: string; extra: Record<string, unknown> }) {
  diag('report', { session });
  const repo = repos.find((r) => /\/pitwall\/?$/.test(r.path)) ?? repos.find((r) => r.name === 'pitwall');
  if (!repo) throw new Error('the Pitwall repository is not on the board');
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(4, 14);
  const report = {
    note: 'Events oldest first: [ms since page load, type, detail, active element, window focused]. Elements read tag#serial; a new serial for a box means it remounted.',
    pageLoaded: new Date(started).toISOString(),
    nowMs: Math.round(performance.now()),
    reportedFrom: session,
    snapshot: snapshot(extra),
    sessions: sessions.map(sessionOf),
    userAgent: navigator.userAgent,
    events: entries,
  };
  const path = await upload(new File([JSON.stringify(report, null, 1)], `paste-loss-${stamp}.json`, { type: 'application/json' }));
  const prompt = [
    'Text I pasted or dictated (SuperWhisper) into a Pitwall reply box did not land, though I saw the caret in the box. I clicked "Paste missed?" right after.',
    `The board's recorder report is ${path} (JSON). \`events\` are the last few thousand focus, input, paste, keydown, box mount/remount, hold and state events, oldest first; \`snapshot\` is the page at the click; \`reportedFrom\` is the session whose box I reported from.`,
    'Find the cause from the evidence: read the report, the recorder in web/src/diag.ts and every line marked DIAG(paste-loss), and the history of this bug in ~/git/github/fieldbook/docs/projects/agent-board/review-findings.md (search for "paste").',
    'Reproduce it in pnpm e2e if you can, fix it, and keep the recorder in place until I confirm the fix holds. If the report shows the text never reached the page (no paste or beforeinput event), say so: the loss is then outside the board.',
  ].join('\n\n');
  const created = await api<{ path: string; sessionId: string | null }>('POST', '/api/worktrees', { repoId: repo.id, name: `paste-loss-${stamp}`, prompt });
  return { path, session: created.sessionId };
}
