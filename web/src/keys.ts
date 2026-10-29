import type { Kind } from './deck.ts';

// The board's keys as data: KEYS drives keyAction and the Keys dialog's rows, so the dialog cannot drift from what
// the keys do. useKeys reads the DOM into a KeyContext; nothing here touches it.

export type Tab = 'overview' | 'diff' | 'artifacts' | 'conversation';

export interface Key {
  key: string;
  code: string;
  repeat?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

export interface Target {
  // A field: its keys are its own.
  editable: boolean;
  // A button, link or the like, which Enter and Space activate.
  control: boolean;
  option: boolean;
  // The diff's resize handle, which takes its own arrows.
  resizer: boolean;
}

export interface Card {
  kind: Kind;
  // Ask and end of turn: how many options there are.
  options: number;
  // A menu: how many options each question has.
  questions: number[];
  // A menu of one single-choice question, which a pick sends.
  lone: boolean;
  // A done second opinion, which E copies into the composer.
  suggestion: boolean;
  primary: boolean;
  why: boolean;
  composing: boolean;
}

export interface KeyContext {
  view: 'queue' | 'wall';
  sheet: { tab: Tab; artifacts: boolean } | null;
  card: Card | null;
  deck: number;
  guarded: boolean;
  // A send waits out its hold, which Undo can still take back.
  held: boolean;
  repos: boolean;
  target: Target;
  // A modal dialog other than the sheet: only ? passes, to close Keys.
  modal: 'keys' | 'other' | null;
  // The `popover` attribute of each open popover.
  popovers: readonly string[];
}

export type Action =
  | { type: 'option'; index: number }
  | { type: 'pick'; question: number; option: number; send: boolean }
  | { type: 'primary' }
  | { type: 'skip' }
  | { type: 'previous' }
  | { type: 'details' }
  | { type: 'compose' }
  | { type: 'edit' }
  | { type: 'elaborate' }
  | { type: 'open'; tab: 'overview' | 'diff' }
  | { type: 'archive' }
  | { type: 'undo' }
  | { type: 'view'; to: 'queue' | 'wall' }
  | { type: 'new-task' }
  | { type: 'keys' }
  | { type: 'tab'; tab: Tab }
  | { type: 'file'; step: 1 | -1 }
  | { type: 'close'; what: 'why' | 'composer' }
  | { type: 'back' };

export const KEYS_DIALOG = 'keys';
export const SHEET_DIALOG = 'task-sheet';

type Scope = 'queue' | 'wall' | 'sheet';

interface Row {
  keys: string;
  help: string;
  scopes: Scope[];
  // An answer key: it waits out the guard after a card change.
  guarded?: boolean;
  repeats?: boolean;
  matches: (e: Key) => boolean;
  act: (ctx: KeyContext, e: Key) => Action | null;
}

// Digits by the physical key: on many non-US layouts the number row types letters or symbols without Shift.
const digit = (e: Key) => Number(/^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1] ?? 0);
const named = (...keys: string[]) => (e: Key) => keys.includes(e.key) || keys.includes(e.key.toLowerCase());
const deciding = (card: Card | null) => card?.kind === 'ask' || card?.kind === 'turn';

function numbered(card: Card | null, n: number): Action | null {
  if (deciding(card)) return n <= card!.options ? { type: 'option', index: n - 1 } : null;
  if (card?.kind !== 'menu') return null;
  let at = n - 1;
  for (const [question, count] of card.questions.entries()) {
    if (at < count) return { type: 'pick', question, option: at, send: card.lone };
    at -= count;
  }
  return null;
}

export const KEYS: readonly Row[] = [
  { keys: '1 – 9', help: 'Send that option; in a menu, pick it', scopes: ['queue'], guarded: true, matches: (e) => digit(e) > 0, act: (ctx, e) => numbered(ctx.card, digit(e)) },
  { keys: '↵', help: 'What the main button says: send the choice, the picks or open the terminal', scopes: ['queue'], guarded: true, matches: named('Enter'), act: (ctx) => (ctx.card?.primary ? { type: 'primary' } : null) },
  { keys: '→', help: 'Skip: the card goes to the back of the deck', scopes: ['queue'], repeats: true, matches: named('ArrowRight'), act: (ctx) => (ctx.card && ctx.deck > 1 ? { type: 'skip' } : null) },
  { keys: '←', help: 'Bring the last card back to the front', scopes: ['queue'], repeats: true, matches: named('ArrowLeft'), act: (ctx) => (ctx.card && ctx.deck > 1 ? { type: 'previous' } : null) },
  { keys: 'Space', help: "Show or hide Claude's details", scopes: ['queue'], matches: named(' '), act: (ctx) => (deciding(ctx.card) ? { type: 'details' } : null) },
  { keys: 'W', help: 'Write your own answer', scopes: ['queue'], guarded: true, matches: named('w'), act: (ctx) => (deciding(ctx.card) || ctx.card?.kind === 'idle' ? { type: 'compose' } : null) },
  { keys: 'E', help: 'Edit the suggestion before sending it', scopes: ['queue'], guarded: true, matches: named('e'), act: (ctx) => (deciding(ctx.card) && ctx.card!.suggestion ? { type: 'edit' } : null) },
  { keys: 'Y', help: 'Elaborate: the background, read from the code', scopes: ['queue'], matches: named('y'), act: (ctx) => (deciding(ctx.card) ? { type: 'elaborate' } : null) },
  { keys: 'O / D', help: 'Open the task on Overview or Diff', scopes: ['queue'], matches: named('o', 'd'), act: (ctx, e) => (ctx.card ? { type: 'open', tab: e.key.toLowerCase() === 'o' ? 'overview' : 'diff' } : null) },
  { keys: 'X', help: 'Archive a finished task', scopes: ['queue'], guarded: true, matches: named('x'), act: (ctx) => (ctx.card?.kind === 'idle' ? { type: 'archive' } : null) },
  { keys: 'Z', help: 'Take back the last send while it waits to go out', scopes: ['queue', 'wall', 'sheet'], matches: named('z'), act: () => ({ type: 'undo' }) },
  { keys: 'V', help: 'Switch between Queue and Wall', scopes: ['queue', 'wall'], matches: named('v'), act: (ctx) => ({ type: 'view', to: ctx.view === 'queue' ? 'wall' : 'queue' }) },
  { keys: 'N', help: 'New task', scopes: ['queue', 'wall'], matches: named('n'), act: (ctx) => (ctx.repos ? { type: 'new-task' } : null) },
  {
    keys: '1 / 2 / 3 / 4', help: 'In an open task: Overview, Diff, Artifacts, Conversation', scopes: ['sheet'], matches: (e) => digit(e) > 0 && digit(e) <= 4,
    act: (ctx, e) => (digit(e) === 1 ? { type: 'tab', tab: 'overview' } : digit(e) === 2 ? { type: 'tab', tab: 'diff' } : digit(e) === 4 ? { type: 'tab', tab: 'conversation' }
      : ctx.sheet?.artifacts ? { type: 'tab', tab: 'artifacts' } : null),
  },
  { keys: 'J / K', help: 'In the diff: next or previous file', scopes: ['sheet'], repeats: true, matches: named('j', 'k'), act: (ctx, e) => (ctx.sheet?.tab === 'diff' ? { type: 'file', step: e.key.toLowerCase() === 'j' ? 1 : -1 } : null) },
  {
    keys: 'Esc', help: 'Take back a send that waits to go out; else close what is open; from a task, back to where it was opened; then back to the queue', scopes: ['queue', 'wall', 'sheet'], matches: named('Escape'),
    act: (ctx) => (ctx.held ? { type: 'undo' } : ctx.sheet ? { type: 'back' } : ctx.view === 'wall' ? (ctx.deck ? { type: 'view', to: 'queue' } : null)
      : ctx.card?.why ? { type: 'close', what: 'why' } : ctx.card?.composing ? { type: 'close', what: 'composer' } : null),
  },
  { keys: '?', help: 'These keys', scopes: ['queue', 'wall', 'sheet'], matches: named('?'), act: () => ({ type: 'keys' }) },
];

// The row a key press belongs to, or null when the press is not the board's: a shortcut with a modifier, a key in a
// field or on the resize handle, Enter or Space on a control (native activation wins, except Space on an option,
// which toggles the details), or a dialog or the ⋯ menu open. Toasts and hover cards are popovers too, but not menus.
export function rowFor(ctx: KeyContext, e: Key): Row | null {
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (ctx.target.editable || ctx.target.resizer) return null;
  if (ctx.popovers.includes('auto')) return null;
  if (ctx.modal && !(ctx.modal === 'keys' && e.key === '?')) return null;
  if (ctx.target.control && (e.key === 'Enter' || (e.key === ' ' && !ctx.target.option))) return null;
  const scope: Scope = ctx.sheet ? 'sheet' : ctx.view;
  return KEYS.find((r) => r.scopes.includes(scope) && r.matches(e)) ?? null;
}

export function keyAction(ctx: KeyContext, e: Key): Action | null {
  const row = rowFor(ctx, e);
  if (!row || (row.guarded && ctx.guarded) || (e.repeat && !row.repeats)) return null;
  return row.act(ctx, e);
}

export const LOCK_MS = 1000;

// Focus lost to a field that unmounted lands on the page, and the rest of a sentence would run as shortcuts: a
// digit sends an option, X archives. So the keys stay off while typing goes on: each key pressed while locked keeps
// the lock for another second and does nothing else. A click ends it, and so does Esc, which goes through: a reply
// sent with Enter starts the lock, and Esc right after it takes the send back.
export function typingLock(now: () => number = Date.now) {
  let until = 0;
  return {
    start() {
      until = now() + LOCK_MS;
    },
    end() {
      until = 0;
    },
    locked: () => now() < until,
    takes(e: Key) {
      if (now() >= until) return false;
      if (e.key === 'Escape') {
        until = 0;
        return false;
      }
      until = now() + LOCK_MS;
      return true;
    },
  };
}
