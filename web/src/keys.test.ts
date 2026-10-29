import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Kind } from './deck.ts';
import { keyAction, KEYS, rowFor, typingLock, type Card, type Key, type KeyContext, type Target } from './keys.ts';

const page: Target = { editable: false, control: false, option: false, resizer: false };
const card = (kind: Kind, patch: Partial<Card> = {}): Card =>
  ({ kind, options: 3, questions: [], lone: false, suggestion: false, primary: true, why: false, composing: false, ...patch });
const ctx = (patch: Partial<KeyContext> = {}): KeyContext =>
  ({ view: 'queue', sheet: null, card: card('ask'), deck: 3, guarded: false, held: false, repos: true, target: page, modal: null, popovers: [], ...patch });

const CODES: Record<string, string> = { Enter: 'Enter', Escape: 'Escape', ' ': 'Space', '?': 'Slash', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
const key = (k: string, patch: Partial<Key> = {}): Key => ({ key: k, code: CODES[k] ?? (/^\d$/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`), ...patch });

test('digits match the physical key: é on the 2 key sends option 2 on an ask card, and the keypad works too', () => {
  assert.deepEqual(keyAction(ctx(), { key: 'é', code: 'Digit2' }), { type: 'option', index: 1 });
  assert.deepEqual(keyAction(ctx({ card: card('turn') }), { key: '3', code: 'Numpad3' }), { type: 'option', index: 2 });
  assert.equal(keyAction(ctx(), { key: "'", code: 'Digit4' }), null, 'no fourth option');
  assert.equal(keyAction(ctx(), { key: '2', code: 'KeyQ' }), null, 'a 2 typed elsewhere on some layout');
});

test('on a menu a digit picks the option numbered across its questions, and on a lone single-choice menu it sends', () => {
  const two = ctx({ card: card('menu', { options: 0, questions: [3, 3] }) });
  assert.deepEqual(keyAction(two, key('4')), { type: 'pick', question: 1, option: 0, send: false });
  assert.deepEqual(keyAction(two, key('3')), { type: 'pick', question: 0, option: 2, send: false });
  assert.equal(keyAction(two, key('7')), null);
  assert.deepEqual(keyAction(ctx({ card: card('menu', { options: 0, questions: [3], lone: true }) }), key('2')), { type: 'pick', question: 0, option: 1, send: true });
  assert.equal(keyAction(ctx({ card: card('prompt') }), key('1')), null);
});

test('the keys stay off while guarded (answer keys only), on auto-repeat, with Meta, Ctrl or Alt, in a field, and under a dialog other than the sheet', () => {
  const guarded = ctx({ guarded: true, card: card('idle') });
  for (const k of ['1', 'Enter', 'w', 'x']) assert.equal(keyAction(guarded, key(k)), null, `${k} while guarded`);
  assert.equal(keyAction(ctx({ guarded: true, card: card('ask', { suggestion: true }) }), key('e')), null);
  assert.deepEqual(keyAction(guarded, key('ArrowRight')), { type: 'skip' });
  assert.deepEqual(keyAction(ctx({ guarded: true }), key('y')), { type: 'elaborate' });

  assert.equal(keyAction(ctx(), key('Enter', { repeat: true })), null);
  assert.equal(keyAction(ctx(), key('1', { repeat: true })), null);
  assert.deepEqual(keyAction(ctx(), key('ArrowRight', { repeat: true })), { type: 'skip' });

  for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) assert.equal(keyAction(ctx(), key('z', { [mod]: true })), null, mod);
  assert.equal(keyAction(ctx(), key('1', { isComposing: true })), null);
  assert.equal(keyAction(ctx(), key('Enter', { defaultPrevented: true })), null);
  assert.equal(keyAction(ctx({ target: { ...page, editable: true } }), key('x')), null);
  assert.equal(keyAction(ctx({ target: { ...page, resizer: true } }), key('ArrowLeft')), null);

  const dialog = ctx({ modal: 'other' });
  for (const k of ['z', '?', 'v', 'Escape', '1']) assert.equal(keyAction(dialog, key(k)), null, `${k} under a dialog`);
  assert.deepEqual(keyAction(ctx({ modal: 'keys' }), key('?')), { type: 'keys' }, '? closes Keys');
  assert.equal(keyAction(ctx({ modal: 'keys' }), key('z')), null);
});

test('only the ⋯ menu stops the keys: an open toast or hover card does not', () => {
  assert.deepEqual(keyAction(ctx({ popovers: ['manual'] }), key('z')), { type: 'undo' });
  assert.deepEqual(keyAction(ctx({ popovers: ['hint', 'manual'] }), key('ArrowLeft')), { type: 'previous' });
  assert.equal(keyAction(ctx({ popovers: ['manual', 'auto'] }), key('z')), null);
  assert.equal(keyAction(ctx({ popovers: ['auto'] }), key('?')), null);
});

test('Enter or Space on a focused button is the button\'s; Space on a focused option toggles the details instead', () => {
  const button = ctx({ target: { ...page, control: true } });
  assert.equal(keyAction(button, key('Enter')), null);
  assert.equal(keyAction(button, key(' ')), null);
  assert.deepEqual(keyAction(button, key('w')), { type: 'compose' });
  const option = ctx({ target: { ...page, control: true, option: true } });
  assert.deepEqual(keyAction(option, key(' ')), { type: 'details' });
  assert.equal(keyAction(option, key('Enter')), null, 'Enter on an option clicks it, which sends it');
  assert.deepEqual(keyAction(ctx(), key('Enter')), { type: 'primary' });
  assert.equal(keyAction(ctx({ card: card('ask', { primary: false }) }), key('Enter')), null);
});

test('Z takes back the last send anywhere, guarded or not, in the sheet too', () => {
  assert.deepEqual(keyAction(ctx({ guarded: true }), key('Z')), { type: 'undo' });
  assert.deepEqual(keyAction(ctx({ view: 'wall', card: null, deck: 0 }), key('z')), { type: 'undo' });
  assert.deepEqual(keyAction(ctx({ sheet: { tab: 'diff', artifacts: false } }), key('z')), { type: 'undo' });
});

test('in the sheet 1 to 4 switch tabs (3 when there are artifacts), J and K act only on Diff, Esc goes back, and V, N and the card keys do nothing', () => {
  const overview = ctx({ sheet: { tab: 'overview', artifacts: false } });
  assert.deepEqual(keyAction(overview, { key: '+', code: 'Digit1' }), { type: 'tab', tab: 'overview' });
  assert.deepEqual(keyAction(overview, key('2')), { type: 'tab', tab: 'diff' });
  assert.equal(keyAction(overview, key('3')), null);
  assert.deepEqual(keyAction(ctx({ sheet: { tab: 'overview', artifacts: true } }), key('3')), { type: 'tab', tab: 'artifacts' });
  assert.deepEqual(keyAction(overview, key('4')), { type: 'tab', tab: 'conversation' });
  assert.equal(keyAction(overview, key('5')), null);
  assert.equal(keyAction(overview, key('j')), null);
  const diff = ctx({ sheet: { tab: 'diff', artifacts: false } });
  assert.deepEqual(keyAction(diff, key('j')), { type: 'file', step: 1 });
  assert.deepEqual(keyAction(diff, key('K', { repeat: true })), { type: 'file', step: -1 });
  for (const k of ['v', 'n', 'Enter', 'ArrowRight', 'w']) assert.equal(keyAction(diff, key(k)), null, `${k} in the sheet`);
  assert.deepEqual(keyAction(diff, key('Escape')), { type: 'back' });
  assert.deepEqual(keyAction(diff, key('?')), { type: 'keys' });
});

test('V switches views (to an empty queue too), N needs a repository, and Esc closes Elaborate, then the composer, then leaves the Wall', () => {
  assert.deepEqual(keyAction(ctx(), key('v')), { type: 'view', to: 'wall' });
  assert.deepEqual(keyAction(ctx({ view: 'wall' }), key('V')), { type: 'view', to: 'queue' });
  assert.deepEqual(keyAction(ctx({ view: 'wall', card: null, deck: 0 }), key('v')), { type: 'view', to: 'queue' });
  assert.deepEqual(keyAction(ctx({ view: 'wall' }), key('n')), { type: 'new-task' });
  assert.equal(keyAction(ctx({ repos: false }), key('n')), null);
  assert.deepEqual(keyAction(ctx({ card: card('ask', { why: true, composing: true }) }), key('Escape')), { type: 'close', what: 'why' });
  assert.deepEqual(keyAction(ctx({ card: card('ask', { composing: true }) }), key('Escape')), { type: 'close', what: 'composer' });
  assert.equal(keyAction(ctx(), key('Escape')), null);
  assert.deepEqual(keyAction(ctx({ view: 'wall' }), key('Escape')), { type: 'view', to: 'queue' });
  for (const at of [ctx({ held: true }), ctx({ held: true, view: 'wall' }), ctx({ held: true, sheet: { tab: 'diff', artifacts: false } }), ctx({ held: true, card: card('ask', { composing: true }) })]) {
    assert.deepEqual(keyAction(at, key('Escape')), { type: 'undo' }, 'a held send goes back first');
  }
  assert.equal(keyAction(ctx({ view: 'wall', deck: 0, card: null }), key('Escape')), null);
});

test('each card kind takes its own keys: W, E, Y and Space on decisions, X and W on Your turn, O and D on any card', () => {
  const idle = ctx({ card: card('idle') });
  assert.deepEqual(keyAction(idle, key('x')), { type: 'archive' });
  assert.deepEqual(keyAction(idle, key('w')), { type: 'compose' });
  for (const k of ['e', 'y', ' ', '1']) assert.equal(keyAction(idle, key(k)), null, `${k} on Your turn`);
  assert.equal(keyAction(ctx(), key('x')), null);
  assert.equal(keyAction(ctx(), key('e')), null, 'no suggestion to edit');
  assert.deepEqual(keyAction(ctx({ card: card('turn', { suggestion: true }) }), key('e')), { type: 'edit' });
  assert.deepEqual(keyAction(ctx({ card: card('prompt') }), key('d')), { type: 'open', tab: 'diff' });
  assert.deepEqual(keyAction(ctx({ card: card('menu') }), key('O')), { type: 'open', tab: 'overview' });
  assert.equal(keyAction(ctx({ deck: 1 }), key('ArrowRight')), null, 'nothing to skip to');
  assert.equal(keyAction(ctx({ card: null, deck: 0 }), key('o')), null);
});

test('every row of the Keys table does something, so the Keys dialog lists exactly what the keys do', () => {
  const samples: Record<string, [KeyContext, Key]> = {
    '1 – 9': [ctx(), key('1')],
    '↵': [ctx(), key('Enter')],
    '→': [ctx(), key('ArrowRight')],
    '←': [ctx(), key('ArrowLeft')],
    Space: [ctx(), key(' ')],
    W: [ctx(), key('w')],
    E: [ctx({ card: card('ask', { suggestion: true }) }), key('e')],
    Y: [ctx(), key('y')],
    'O / D': [ctx(), key('o')],
    X: [ctx({ card: card('idle') }), key('x')],
    Z: [ctx(), key('z')],
    V: [ctx(), key('v')],
    N: [ctx(), key('n')],
    '1 / 2 / 3 / 4': [ctx({ sheet: { tab: 'overview', artifacts: true } }), key('3')],
    'J / K': [ctx({ sheet: { tab: 'diff', artifacts: true } }), key('k')],
    Esc: [ctx({ view: 'wall' }), key('Escape')],
    '?': [ctx(), key('?')],
  };
  assert.deepEqual(KEYS.map((r) => r.keys), Object.keys(samples));
  for (const row of KEYS) {
    const [c, e] = samples[row.keys];
    assert.ok(row.help, `${row.keys} has no description`);
    assert.equal(rowFor(c, e), row, row.keys);
    assert.notEqual(keyAction(c, e), null, row.keys);
  }
});

test('the typing lock: after a field unmounts under typing, each key only keeps the keys off for another second; a click or Esc ends it', () => {
  let now = 0;
  const lock = typingLock(() => now);
  assert.equal(lock.takes(key('x')), false);
  lock.start();
  now = 900;
  assert.equal(lock.takes(key('w')), true, 'the rest of "we fix 3 x" goes nowhere');
  now = 1800;
  assert.equal(lock.takes(key('3')), true, 'each key keeps it a second longer');
  now = 2700;
  assert.equal(lock.takes(key('x')), true);
  now = 3701;
  assert.equal(lock.locked(), false);
  assert.equal(lock.takes(key('x')), false, 'a pause of a second ends it');
  lock.start();
  lock.end();
  assert.equal(lock.takes(key('z')), false, 'a click ends it');
  lock.start();
  assert.equal(lock.takes(key('Escape')), false, 'Esc ends it and goes through');
  assert.equal(lock.takes(key('z')), false);
});
