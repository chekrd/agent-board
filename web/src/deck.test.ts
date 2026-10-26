import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  arrivals, choose, deckOf, dismissal, freeze, isCommand, kindOf, meter, METER_SEGMENTS, primary, promptOf, refreeze, resolveFront,
  rotate, successor, targetOf, typed, type Composer, type Frozen,
} from './deck.ts';
import { advice, menu, options, question, session, turn } from './testing.ts';
import type { Command, Session } from './types.ts';

const ids = (list: readonly { id: string }[]) => list.map((s) => s.id);
const none = new Set<string>();

const ask = (id: string, patch: Partial<Session> = {}) => session(id, { question: question(`q-${id}`), ...patch });
const ended = (id: string, patch: Partial<Session> = {}) => session(id, { summary: turn('t1'), ...patch });

const cart = ask('cart');
const answeredMenu = (at: number) => session('hooks', { status: 'waiting', menu: menu('m1'), answered: { key: 'm:m1', text: 'Backoff: Linear', at } });

test('the deck: decisions by rank with unranked ones last, then by age; then Needs focus, then Your turn', () => {
  const deck = deckOf([
    session('your-turn', { createdAt: 1 }),
    session('needs-focus', { status: 'waiting', waitingFor: 'permission prompt' }),
    ask('unranked', { createdAt: 3 }),
    ended('second', { rank: 2 }),
    ask('older', { rank: 1, createdAt: 1 }),
    session('first', { rank: 1, createdAt: 2, status: 'waiting', menu: menu('m1') }),
  ], none);
  assert.deepEqual(ids(deck), ['older', 'first', 'second', 'unranked', 'needs-focus', 'your-turn']);
});

test('the deck leaves out archived, working, ended and busy sessions, an ended one with an open question, and an answered menu still open', () => {
  const deck = deckOf([
    ask('archived', { archived: true }),
    session('working', { status: 'working' }),
    session('ended', { status: 'exited' }),
    ask('gone', { status: 'exited' }),
    ask('held'),
    answeredMenu(100_000),
    ask('kept'),
  ], new Set(['held']), 105_000);
  assert.deepEqual(ids(deck), ['kept']);
});

test('a menu still open 10 s after the board answered it comes back as Needs focus: Claude still shows it in the terminal', () => {
  const stuck = answeredMenu(100_000);
  assert.deepEqual(ids(deckOf([stuck], none, 110_000)), ['hooks']);
  assert.equal(kindOf(stuck, 110_000), 'prompt');
  assert.deepEqual(promptOf(stuck, 110_000), { headline: 'Claude still shows its menu in the terminal', subject: null });
  assert.deepEqual(primary(stuck, null, {}, 110_000).press, { intent: 'terminal' });
});

test('the kind of a card: menu, ask, end of turn, Needs focus or Your turn', () => {
  assert.equal(kindOf(session('s', { status: 'waiting', menu: menu('m1') })), 'menu');
  assert.equal(kindOf(cart), 'ask');
  assert.equal(kindOf(ended('s')), 'turn');
  assert.equal(kindOf(session('s', { status: 'waiting' })), 'prompt');
  assert.equal(kindOf(session('s')), 'idle');
  assert.equal(kindOf(session('s', { status: 'working' })), null);
});

test('the Needs-focus card names what the terminal shows, and its subject when there is one', () => {
  assert.deepEqual(promptOf(session('s', { status: 'waiting', waitingFor: 'a permission prompt for Bash: pnpm test' })), {
    headline: 'Claude is showing a permission prompt for Bash: pnpm test in its terminal', subject: 'Bash: pnpm test',
  });
  assert.deepEqual(promptOf(session('s', { status: 'waiting', waitingFor: 'its start-up prompt' })), {
    headline: 'Claude is showing its start-up prompt in its terminal', subject: null,
  });
});

test('rotate turns the deck to its front card, round to the start, with a send that failed right after the front', () => {
  const deck = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  assert.deepEqual(ids(rotate(deck, 'c')), ['c', 'd', 'a', 'b']);
  assert.deepEqual(ids(rotate(deck, 'c', new Set(['b']))), ['c', 'b', 'd', 'a']);
  assert.deepEqual(ids(rotate(deck, 'c', new Set(['c']))), ['c', 'd', 'a', 'b']);
  assert.deepEqual(ids(rotate(deck, 'gone')), ['a', 'b', 'c', 'd']);
  assert.deepEqual(rotate([], 'a'), []);
});

test('successor: the card after the leaving one in the order last shown, passing over cards that left too, round to the start', () => {
  const last = ['c', 'd', 'a', 'b'];
  const deck = (...list: string[]) => list.map((id) => ({ id }));
  assert.equal(successor(last, 'c', deck('a', 'b', 'd')), 'd');
  assert.equal(successor(last, 'c', deck('a', 'b')), 'a');
  assert.equal(successor(last, 'b', deck('a', 'd')), 'd', 'it wraps');
  assert.equal(successor(last, 'x', deck('a', 'b')), 'a', 'one never shown starts from the front of the order');
  assert.equal(successor(last, 'c', deck('new')), 'new', 'nothing shown is left');
  assert.equal(successor(last, 'c', []), null);
});

test('the front card: the pinned one while it is in the deck, else the one that followed it, else the first', () => {
  const deck = ['a', 'b', 'c'].map((id) => ({ id }));
  assert.equal(resolveFront(deck, 'b', ['b', 'c', 'a']), 'b');
  assert.equal(resolveFront(deck.filter((s) => s.id !== 'b'), 'b', ['b', 'c', 'a']), 'c');
  assert.equal(resolveFront(deck, null, []), 'a');
  assert.equal(resolveFront([], 'b', ['b']), null);
});

test('arrivals: decisions new since the page loaded and not yet shown, newest first; a new decision on the front card is an update', () => {
  const deck = [
    ask('seeded'),
    session('first', { question: question('q-first', options('A'), 5) }),
    session('second', { question: question('q-second', options('A'), 9) }),
    session('front', { question: question('q-front2') }),
    session('your-turn'),
  ];
  const seen = new Set(['q:q-seeded', 'q:q-front']);
  assert.deepEqual(ids(arrivals(deck, seen, 'front')), ['second', 'first']);
  assert.deepEqual(ids(arrivals(deck, new Set([...seen, 'q:q-second', 'q:q-front2']), 'first')), [], 'each key shown at the front counts as seen');
});

test('freeze: the done second opinion\'s option, its free-text reply, Claude\'s recommended option, or nothing; a menu takes the advice\'s picks', () => {
  const choices = [{ label: 'Keep' }, { label: 'Merge', recommended: true }];
  const s = session('s', { question: question('q1', choices) });
  assert.deepEqual(freeze({ ...s, advice: advice('q:q1', { choice: 'Keep', at: 7 }) }), { via: 'advice', label: 'Keep', adviceAt: 7 });
  assert.deepEqual(freeze({ ...s, advice: advice('q:q1', { choice: null, at: 8 }) }), { via: 'advice', label: null, adviceAt: 8 });
  assert.deepEqual(freeze({ ...s, advice: advice('q:q1', { state: 'thinking' }) }), { via: 'recommended', label: 'Merge' });
  assert.deepEqual(freeze({ ...s, advice: advice('q:old', { choice: 'Keep' }) }), { via: 'recommended', label: 'Merge' }, 'advice for an earlier decision');
  assert.deepEqual(freeze(session('s', { question: question('q1') })), { via: 'none', label: null });

  const m = session('m', { status: 'waiting', menu: menu('m1') });
  const answers = [{ labels: ['Linear'], other: '' }, { labels: ['Email', 'Log'], other: '' }];
  assert.deepEqual(freeze({ ...m, advice: advice('m:m1', { answers, at: 9 }) }), { via: 'menu', picks: answers, adviceAt: 9 });
  assert.deepEqual(freeze(m), { via: 'menu', picks: [{ labels: [], other: '' }, { labels: [], other: '' }], adviceAt: null });
  assert.deepEqual(freeze({ ...m, advice: advice('m:m1', { answers: answers.slice(1) }) }), freeze(m), 'picks for another menu shape');
  assert.equal(freeze(session('s')), null);
});

test('a second opinion that finishes fills a frozen nothing, as a late suggestion; once there is a target, nothing replaces it', () => {
  const s = session('s', { question: question('q1') });
  const done = { ...s, advice: advice('q:q1', { choice: 'Merge', at: 9 }) };
  assert.deepEqual(refreeze({ via: 'none', label: null }, done), { frozen: { via: 'advice', label: 'Merge', adviceAt: 9, late: true }, why: 'suggestion' });
  assert.deepEqual(refreeze({ via: 'none', label: null }, { ...done, advice: advice('q:q1', { choice: null, at: 9 }) })?.frozen,
    { via: 'advice', label: null, adviceAt: 9, late: true }, 'a free-text reply on a decision with options');
  assert.equal(refreeze({ via: 'none', label: null }, { ...s, advice: advice('q:q1', { state: 'thinking' }) }), null);
  assert.equal(refreeze({ via: 'recommended', label: 'Keep' }, done), null);
  assert.equal(refreeze({ via: 'advice', label: 'Keep', adviceAt: 7 }, done), null, 'a newer second opinion');
  assert.equal(refreeze({ via: 'advice', label: null, adviceAt: 7 }, done), null);
  const m = session('m', { status: 'waiting', menu: menu('m1') });
  assert.equal(refreeze(freeze(m)!, { ...m, advice: advice('m:m1', { answers: [{ labels: ['Linear'], other: '' }, { labels: ['Log'], other: '' }] }) }), null);
});

test('a late suggestion relabels the primary, which was "Pick an option", to say it is ready and that ⏎ accepts it', () => {
  const s = session('s', { question: question('q1'), advice: advice('q:q1', { choice: 'Merge', at: 9 }) });
  const accept = { action: 'accept-advice', body: { key: 'q:q1', adviceAt: 9 }, label: 'Merge' };
  assert.deepEqual(primary(s, { via: 'advice', label: 'Merge', adviceAt: 9, late: true }), { label: 'Suggestion ready · Accept', disabled: false, press: accept });
  assert.equal(primary(s, { via: 'advice', label: 'Merge', adviceAt: 9 }).label, 'Accept suggestion', 'done when the card was first shown');
  const free = { ...s, advice: advice('q:q1', { choice: null, answer: 'Do both', at: 9 }) };
  assert.equal(primary(free, { via: 'advice', label: null, adviceAt: 9, late: true }).label, 'Suggestion ready · Accept');
  assert.equal(primary(s, { via: 'advice', label: 'Merge', adviceAt: 9, late: true }, { composer: { open: true, text: 'why not', files: [] } }).label,
    'Send “Merge” + your note');
});

test('a rewrite of the decision that drops the frozen option freezes it again', () => {
  const rewritten = ended('s', { summary: turn('t1', options('Ship now', 'Wait')) });
  assert.deepEqual(refreeze({ via: 'advice', label: 'Ship', adviceAt: 7 }, rewritten), { frozen: { via: 'none', label: null }, why: 'rewritten' });
  assert.equal(refreeze({ via: 'advice', label: 'Wait', adviceAt: 7 }, rewritten), null);
});

const closed: Composer = { open: false, text: '', files: [] };
const open = (text: string, files: string[] = [], uploading = false): Composer => ({ open: true, text, files, uploading });

test('the primary on an ask card, for every frozen choice and composer state', () => {
  const s = session('s', { question: question('q1', [{ label: 'Keep' }, { label: 'Merge', recommended: true }]), advice: advice('q:q1', { choice: 'Keep', at: 7 }) });
  const advised: Frozen = { via: 'advice', label: 'Keep', adviceAt: 7 };
  const accept = { action: 'accept-advice', body: { key: 'q:q1', adviceAt: 7 }, label: 'Keep' };
  assert.deepEqual(primary(s, advised, { composer: closed }), { label: 'Accept suggestion', disabled: false, press: accept });
  assert.deepEqual(primary(s, advised, { composer: open('  ') }).press, accept, 'an empty composer adds nothing');
  assert.deepEqual(primary(s, advised, { composer: { ...closed, text: 'hidden draft' } }).press, accept, 'a closed composer sends nothing unseen');
  assert.deepEqual(primary(s, advised, { composer: open(' only if stock allows ', ['/u/a.png']) }), {
    label: 'Send “Keep” + your note', disabled: false,
    press: { action: 'answer', body: { key: 'q:q1', choice: 'Keep', text: 'only if stock allows', files: ['/u/a.png'] }, label: 'Keep' },
  });
  assert.deepEqual(primary(s, advised, { composer: open('', ['/u/a.png']) }).press, { action: 'answer', body: { key: 'q:q1', choice: 'Keep', files: ['/u/a.png'] }, label: 'Keep' });
  assert.equal(primary(s, advised, { composer: open('note', [], true) }).disabled, true, 'an attachment still uploading');
  assert.equal(primary(s, advised, { composer: open('', ['/u/a.png'], true) }).disabled, true, 'one more still uploading');
  assert.equal(primary(s, advised, { composer: open('', [], true) }).disabled, true, 'the one attachment still uploading, which the accept would leave out');
  assert.equal(primary(s, advised, { composer: { ...closed, uploading: true } }).disabled, false, 'an upload in a closed composer goes nowhere');

  const changed = { ...s, advice: advice('q:q1', { choice: 'Merge', at: 8 }) };
  assert.deepEqual(primary(changed, advised, { composer: closed }), {
    label: 'Send “Keep”', disabled: false, press: { action: 'answer', body: { key: 'q:q1', choice: 'Keep' }, label: 'Keep' },
  }, 'the second opinion changed after the freeze: the frozen option goes as a plain choice');
  assert.deepEqual(primary(s, { via: 'recommended', label: 'Merge' }), {
    label: 'Send “Merge”', disabled: false, press: { action: 'answer', body: { key: 'q:q1', choice: 'Merge' }, label: 'Merge' },
  });
  assert.deepEqual(primary(s, { via: 'none', label: null }), { label: 'Pick an option', disabled: true, press: null });
  assert.deepEqual(primary(s, { via: 'none', label: null }, { composer: open('my own answer') }), { label: 'Pick an option', disabled: true, press: null },
    'the primary never sends the composer\'s text by itself');
  assert.deepEqual(primary(s, null), primary(s, freeze(s)), 'before the freeze is written, the render freezes it');
});

test('the primary on a decision without options: the free-text suggestion while it is the one frozen, else Reply', () => {
  const flag = session('s', {
    question: question('q1', []),
    advice: advice('q:q1', { choice: null, answer: 'Call it checkout.mergeGuestCart.', at: 7 }),
  });
  assert.deepEqual(primary(flag, { via: 'advice', label: null, adviceAt: 7 }), {
    label: 'Accept suggestion', disabled: false, press: { action: 'accept-advice', body: { key: 'q:q1', adviceAt: 7 }, label: 'Call it checkout.mergeGuestCart.' },
  });
  assert.deepEqual(primary(flag, { via: 'advice', label: null, adviceAt: 6 }), { label: 'Reply', disabled: false, press: { intent: 'compose' } });
  assert.deepEqual(primary({ ...flag, advice: null }, { via: 'none', label: null }), { label: 'Reply', disabled: false, press: { intent: 'compose' } });
});

test('the primary on an end-of-turn card answers with the decision\'s s: key', () => {
  const s = ended('s', { advice: advice('s:t1', { choice: 'Ship', at: 7 }) });
  assert.deepEqual(primary(s, freeze(s)).press, { action: 'accept-advice', body: { key: 's:t1', adviceAt: 7 }, label: 'Ship' });
  assert.deepEqual(primary(s, freeze(s), { composer: open('after lunch') }).press,
    { action: 'answer', body: { key: 's:t1', choice: 'Ship', text: 'after lunch' }, label: 'Ship' });
  assert.deepEqual(primary(ended('s'), freeze(ended('s'))), { label: 'Pick an option', disabled: true, press: null });
});

test('the primary on a menu sends the picks on screen once every question has one', () => {
  const answers = [{ labels: ['Linear'], other: '' }, { labels: ['Email', 'Log'], other: '' }];
  const s = session('m', { status: 'waiting', menu: menu('m1'), advice: advice('m:m1', { answers, at: 9 }) });
  const send = { action: 'answer-menu', body: { toolUseId: 'm1', answers }, label: 'Backoff: Linear · Give up: Email, Log' };
  assert.deepEqual(primary(s, freeze(s)), { label: 'Accept suggestion', disabled: false, press: send });
  assert.deepEqual(primary(s, freeze(s), { picks: [answers[0], { labels: ['Log', 'Email'], other: '' }] }).label, 'Accept suggestion');
  const mine = [{ labels: [], other: 'Every hour' }, { labels: ['Log'], other: '' }];
  assert.deepEqual(primary(s, freeze(s), { picks: mine }), {
    label: 'Send answer', disabled: false,
    press: { action: 'answer-menu', body: { toolUseId: 'm1', answers: mine }, label: 'Backoff: Every hour · Give up: Log' },
  });
  assert.deepEqual(primary(s, freeze(s), { picks: [answers[0], { labels: [], other: '' }] }), { label: 'Answer both questions', disabled: true, press: null });
  const lone = session('l', { status: 'waiting', menu: menu('m2', { question: 'Backoff?', header: 'Backoff', multiSelect: false, options: options('A', 'B') }) });
  assert.deepEqual(primary(lone, freeze(lone)), { label: 'Pick an option', disabled: true, press: null });
});

test('the primary on Needs focus opens the terminal, and on Your turn it is Reply, which focuses the composer', () => {
  assert.deepEqual(primary(session('s', { status: 'waiting' }), null), { label: 'Terminal', disabled: false, press: { intent: 'terminal' } });
  assert.deepEqual(primary(session('s'), null, { composer: open('Thanks') }), { label: 'Reply', disabled: false, press: { intent: 'compose' } });
});

test('the target ⏎ sends changes when the second opinion changes after the freeze, not when a note is typed', () => {
  const s = session('s', { question: question('q1'), advice: advice('q:q1', { choice: 'Keep', at: 7 }) });
  const frozen = freeze(s);
  assert.equal(targetOf(s, frozen), 'accept:7');
  assert.equal(targetOf({ ...s, advice: advice('q:q1', { choice: 'Merge', at: 8 }) }, frozen), 'choice:Keep');
  assert.equal(targetOf(s, { via: 'none', label: null }), 'none');
  assert.equal(targetOf(session('s', { status: 'waiting' }), null), 'terminal');
});

test('an option pressed: the second opinion\'s own option accepts it unless a note goes along; any other option answers', () => {
  const s = session('s', { question: question('q1'), advice: advice('q:q1', { choice: 'Merge', at: 7 }) });
  assert.deepEqual(choose(s, 'Merge', closed), { action: 'accept-advice', body: { key: 'q:q1', adviceAt: 7 }, label: 'Merge' });
  assert.deepEqual(choose(s, 'Merge', open('only if in stock')), { action: 'answer', body: { key: 'q:q1', choice: 'Merge', text: 'only if in stock' }, label: 'Merge' });
  assert.deepEqual(choose(s, 'Keep'), { action: 'answer', body: { key: 'q:q1', choice: 'Keep' }, label: 'Keep' });
  assert.deepEqual(choose({ ...s, advice: advice('q:q1', { state: 'thinking', choice: 'Merge' }) }, 'Merge')?.action, 'answer');
});

test('no option sends while an attachment in the open composer is still uploading, which the send would leave out', () => {
  const s = session('s', { question: question('q1'), advice: advice('q:q1', { choice: 'Merge', at: 7 }) });
  assert.equal(choose(s, 'Keep', open('see the screenshot', [], true)), null);
  assert.equal(choose(s, 'Merge', open('', [], true)), null);
  assert.equal(choose(s, 'Keep', open('see both', ['/u/a.png'], true)), null);
  assert.deepEqual(choose(s, 'Keep', { ...closed, uploading: true }), { action: 'answer', body: { key: 'q:q1', choice: 'Keep' }, label: 'Keep' });
});

test('a draft counts as a command only once the command list has loaded, and the way the server tells them', () => {
  const commands: Command[] = [{ name: 'compact', description: '' }, { name: 'plugin:review', description: '' }];
  assert.equal(isCommand('/compact', 0, null), false);
  assert.equal(isCommand('!git status', 0, null), false);
  assert.equal(isCommand('/compact', 0, commands), true);
  assert.equal(isCommand('/plugin:review 12', 0, commands), true);
  assert.equal(isCommand('!git status', 0, commands), true);
  assert.equal(isCommand('/etc/hosts is wrong', 0, commands), false);
  assert.equal(isCommand('/compact', 1, commands), false, 'with a file it is a message');
  assert.deepEqual(typed('q:q1', ' /compact ', [], commands), { action: 'answer', body: { key: 'q:q1', text: '/compact' }, label: '/compact', command: true });
  assert.deepEqual(typed('q:q1', '/compact', [], null), { action: 'answer', body: { key: 'q:q1', text: '/compact' }, label: '/compact' });
});

test('what Enter in a composer sends: an answer to the card\'s decision, or a plain message with an explicit null key', () => {
  assert.deepEqual(typed('q:q1', ' Use the cache ', ['/u/a.png'], []), { action: 'answer', body: { key: 'q:q1', text: 'Use the cache', files: ['/u/a.png'] }, label: 'Use the cache' });
  assert.deepEqual(typed(null, 'Thanks', [], []), { action: 'answer', body: { key: null, text: 'Thanks' }, label: 'Thanks' });
  assert.deepEqual(typed(null, '', ['/u/a.png', '/u/b.png'], []).label, '2 files');
  assert.deepEqual(dismissal(cart), { action: 'dismiss', body: { key: 'q:q-cart' }, label: 'Which cart wins?' });
});

test('the meter: one segment per card up to 20, then one bar per group with its count', () => {
  const crowd = (decide: number, focus: number, idle: number) => [
    ...Array.from({ length: decide }, (_, i) => ask(`d${i}`, { rank: i + 1 })),
    ...Array.from({ length: focus }, (_, i) => session(`f${i}`, { status: 'waiting', createdAt: i })),
    ...Array.from({ length: idle }, (_, i) => session(`i${i}`, { createdAt: i })),
  ];
  const twenty = crowd(12, 3, 5);
  const at20 = meter(twenty, 'd3', new Set(['f1']));
  assert.equal(METER_SEGMENTS, 20);
  assert.equal(at20.segments?.length, 20);
  assert.equal(at20.bars, null);
  assert.deepEqual(at20.segments?.filter((s) => s.current || s.arrived).map((s) => [s.id, s.current, s.arrived]), [['d3', true, false], ['f1', false, true]]);
  assert.deepEqual([at20.label, at20.position, at20.total], ['12 decisions · 3 terminal prompts · 5 finished turns', 4, 20]);

  const at21 = meter(crowd(13, 3, 5), 'f2');
  assert.equal(at21.segments, null);
  assert.deepEqual(at21.bars?.map((b) => [b.attention, b.count, b.current, b.target]), [['decide', 13, false, 'd0'], ['focus', 3, true, 'f0'], ['idle', 5, false, 'i0']]);

  const at45 = meter(crowd(30, 5, 10), 'd29', new Set(['i4']));
  assert.deepEqual(at45.bars?.map((b) => [b.count, b.current, b.arrived, b.target]), [[30, true, false, 'd0'], [5, false, false, 'f0'], [10, false, true, 'i0']]);
  assert.equal(meter(crowd(30, 5, 10), 'd4').bars?.[0].target, 'd5', 'within the front card\'s group, the next card');
  assert.deepEqual([meter(crowd(1, 0, 1), null).label, meter([], null).label], ['1 decision · 1 finished turn', '']);
});
