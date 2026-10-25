import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrivals, freeze, primary } from './deck.ts';
import { arrange, createQueue, FRESH_MS, GUARD_MS, UPDATED_MS, type Deal } from './queue.ts';
import { advice, options, question, session, turn } from './testing.ts';
import type { Session } from './types.ts';

const ask = (id: string, patch: Partial<Session> = {}) => session(id, { question: question(`q-${id}`), ...patch });
const ids = (list: readonly { id: string }[]) => list.map((s) => s.id);

// A queue on a clock, timers and storage the test drives, whose transitions apply at once and are recorded.
function world(storage = new Map<string, string>()) {
  let now = 1_000_000;
  let timers: { at: number; fn: () => void }[] = [];
  const deals: Deal[] = [];
  const store = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };
  const q = createQueue({
    now: () => now,
    storage: store,
    transition: (change, deal) => {
      deals.push(deal);
      change();
    },
    later: (fn, ms) => void timers.push({ at: now + ms, fn }),
  });
  const advance = (ms: number) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    for (const t of due) t.fn();
  };
  return { q, advance, deals, storage, now: () => now };
}

const a = ask('a', { rank: 2 });
const b = ask('b', { rank: 3 });
const c = ask('c', { rank: 4 });

test('the card being read is pinned by id: an arrival takes its place in the order behind it and is announced until shown', () => {
  const { q } = world();
  q.sync([a, b]);
  assert.equal(q.state().front, 'a');
  const urgent = ask('urgent', { rank: 1 });
  q.sync([urgent, a, b]);
  assert.equal(q.state().front, 'a');
  assert.deepEqual(q.state().order, ['a', 'b', 'urgent']);
  assert.deepEqual(ids(arrivals([urgent, a, b], q.state().seen!, 'a')), ['urgent']);
  q.jump('urgent');
  q.sync([urgent, a, b]);
  assert.deepEqual(ids(arrivals([urgent, a, b], q.state().seen!, 'urgent')), []);
  assert.deepEqual(ids(arrivals([urgent, a, b], q.state().seen!, null)), ['urgent'], 'at the front, but no view has drawn it yet');
  q.show(urgent);
  assert.deepEqual(ids(arrivals([urgent, a, b], q.state().seen!, null)), [], 'drawn once, it is no longer new');
});

test('the view draws what it can: a card drawn late, after typing held it back, is guarded from then and new until then; drawn with another decision it is updated', () => {
  const { q, advance } = world();
  q.sync([]);
  q.show(null);
  const arrival = ask('new');
  q.sync([arrival]);
  assert.equal(q.state().front, 'new', 'the first arrival into an empty deck comes to the front');
  assert.deepEqual(ids(arrivals([arrival], q.state().seen!, q.state().shown)), ['new'], 'while the view still shows nothing, it is an arrival');
  advance(GUARD_MS * 3);
  assert.equal(q.guarded(), false);
  q.show(arrival);
  assert.equal(q.state().shown, 'new');
  assert.equal(q.guarded(), true);
  assert.deepEqual(ids(arrivals([arrival], q.state().seen!, null)), []);
  assert.equal(q.state().updated.has('new'), false);

  advance(GUARD_MS);
  q.show(arrival);
  assert.equal(q.guarded(), false, 'drawn again as it was');
  q.show(ask('new', { question: question('q-new-2') }));
  assert.equal(q.guarded(), true);
  assert.equal(q.state().updated.get('new'), q.state().guardUntil - GUARD_MS + UPDATED_MS);
  q.show(null);
  assert.equal(q.state().shown, null);
});

test('when the card being read leaves for an outside reason the one after it comes up, with word that it no longer waits; the page\'s own send says nothing', () => {
  const { q, deals } = world();
  q.sync([a, b, c]);
  assert.deepEqual(q.sync([b, c]), [{ type: 'left', id: 'a' }]);
  assert.equal(q.state().front, 'b');
  q.deal('down', () => {});
  assert.deepEqual(q.sync([c]), []);
  assert.equal(q.state().front, 'c');
  assert.deepEqual(deals, ['down']);
  q.sync([]);
  assert.equal(q.state().front, null);
  q.sync([b]);
  assert.equal(q.state().front, 'b', 'the first arrival into an empty deck comes to the front');
});

test('the guard holds the answer keys for 900 ms when the front card changes, when its decision changes, and when what ⏎ sends changes', () => {
  const { q, advance } = world();
  q.sync([a, b]);
  assert.equal(q.guarded(), true, 'the first card shown is guarded too');
  advance(GUARD_MS);
  assert.equal(q.guarded(), false);
  q.sync([a, b]);
  assert.equal(q.guarded(), false, 'a snapshot that changes nothing on the card');

  const updated = ask('a', { rank: 2, question: question('q-a2') });
  q.sync([updated, b]);
  assert.equal(q.state().front, 'a');
  assert.equal(q.guarded(), true);
  assert.equal(q.state().updated.get('a'), q.state().guardUntil - GUARD_MS + UPDATED_MS);
  advance(UPDATED_MS);
  assert.deepEqual([...q.state().updated], [], '"Updated just now" ends after 10 s');

  const advised = { ...updated, advice: advice('q:q-a2', { choice: 'Keep', at: 7 }) };
  q.sync([advised, b]);
  q.freeze('q:q-a2', freeze(advised)!);
  advance(GUARD_MS);
  q.sync([advised, b]);
  assert.equal(q.guarded(), false);
  q.sync([{ ...advised, advice: advice('q:q-a2', { choice: 'Merge', at: 8 }) }, b]);
  assert.equal(q.guarded(), true, 'the primary turned from Accept suggestion to Send “Keep”');
});

test('a second opinion that finishes while ⏎ has nothing to send becomes what it sends, restarts the guard and shows as late; no later one replaces it', () => {
  const { q, advance } = world();
  const s = ask('s');
  const key = 'q:q-s';
  q.sync([s]);
  q.freeze(key, freeze(s)!);
  advance(GUARD_MS);
  assert.deepEqual(primary(s, q.state().frozen.get(key)!), { label: 'Pick an option', disabled: true, press: null });

  const done = { ...s, advice: advice(key, { choice: 'Merge', at: 9 }) };
  q.sync([done]);
  assert.deepEqual(q.state().frozen.get(key), { via: 'advice', label: 'Merge', adviceAt: 9, late: true });
  assert.equal(q.guarded(), true);
  assert.deepEqual(primary(done, q.state().frozen.get(key)!).press, { action: 'accept-advice', body: { key, adviceAt: 9 }, label: 'Merge' });

  advance(GUARD_MS);
  const newer = { ...s, advice: advice(key, { choice: 'Keep', at: 12 }) };
  q.sync([newer]);
  assert.deepEqual(q.state().frozen.get(key), { via: 'advice', label: 'Merge', adviceAt: 9, late: true });
  assert.deepEqual(primary(newer, q.state().frozen.get(key)!), {
    label: 'Send “Merge”', disabled: false, press: { action: 'answer', body: { key, choice: 'Merge' }, label: 'Merge' },
  }, '⏎ never switches to the newer suggestion');
  assert.equal(q.guarded(), true, 'the relabel restarts the guard');
});

test('a rewrite of the decision that drops the frozen option freezes it again, as an update', () => {
  const { q, advance } = world();
  const s = session('t', { summary: turn('t1'), advice: advice('s:t1', { choice: 'Ship', at: 7 }) });
  q.sync([s]);
  q.freeze('s:t1', freeze(s)!);
  advance(GUARD_MS);
  q.sync([{ ...s, summary: turn('t1', options('Ship now', 'Wait')) }]);
  assert.deepEqual(q.state().frozen.get('s:t1'), { via: 'advice', label: null, adviceAt: 7 }, 'the advice matches no option now');
  assert.equal(q.guarded(), true);
  assert.ok(q.state().updated.has('t'));
});

test('skip, previous and jump move the front, each in a transition of its own', () => {
  const { q, deals } = world();
  q.sync([a, b, c]);
  q.skip();
  assert.equal(q.state().front, 'b');
  q.sync([a, b, c]);
  assert.deepEqual(q.state().order, ['b', 'c', 'a']);
  q.previous();
  assert.equal(q.state().front, 'a');
  q.sync([a, b, c]);
  q.jump('c');
  q.jump('c');
  assert.equal(q.state().front, 'c');
  assert.deepEqual(deals, ['back', 'enter-back', 'enter']);
});

test('skip and previous go by the order as the last move left it, with no new deck in between; a jump needs a card the deck has', () => {
  const { q, deals } = world();
  const d = ask('d', { rank: 5 });
  q.sync([a, b, c, d]);
  q.skip();
  q.previous();
  assert.equal(q.state().front, 'a');
  q.skip();
  q.skip();
  assert.equal(q.state().front, 'c');
  assert.deepEqual(q.state().order, ['c', 'd', 'a', 'b']);
  q.previous();
  q.previous();
  q.previous();
  assert.equal(q.state().front, 'd');
  q.jump('elsewhere');
  assert.equal(q.state().front, 'd');
  assert.deepEqual(deals, ['back', 'enter-back', 'back', 'back', 'enter-back', 'enter-back', 'enter-back']);
});

test('a send that failed waits right after the card being read until it has been at the front, which shows its message once', () => {
  const { q } = world();
  q.sync([a, b, c]);
  q.notSent('c', 'this question is no longer open');
  q.sync([a, b, c]);
  assert.deepEqual(ids(arrange([a, b, c], q.state())), ['a', 'c', 'b']);
  q.skip();
  q.sync([a, b, c]);
  assert.equal(q.state().front, 'c');
  assert.deepEqual(q.state().notSent.get('c'), { message: 'this question is no longer open', shown: true });
  q.skip();
  q.sync([a, b, c]);
  assert.equal(q.state().notSent.has('c'), false);
  assert.deepEqual(q.state().order, ['a', 'b', 'c'], 'back in its own place');
});

test('a failed send whose session left the deck leaves no mark for a later decision of it', () => {
  const { q } = world();
  q.sync([a, b]);
  q.notSent('c', 'this question is no longer open');
  q.sync([a, b]);
  assert.equal(q.state().notSent.has('c'), false);
  q.sync([a, b, c]);
  assert.deepEqual(q.state().order, ['a', 'b', 'c']);
});

test('a deal taken back brings its card to the front again once the deck has it, with the guard', () => {
  const { q, deals, advance } = world();
  q.sync([a, b, c]);
  q.deal('down', () => {});
  q.sync([b, c]);
  assert.equal(q.state().front, 'b');
  advance(GUARD_MS);
  q.restore('a', () => true);
  q.sync([a, b, c]);
  assert.equal(q.state().front, 'a');
  assert.equal(q.guarded(), true);
  q.restore('b', () => false);
  assert.equal(q.state().front, 'a', 'nothing came back');
  assert.deepEqual(deals, ['down', 'enter-back', 'enter-back']);
});

test('a menu\'s picks are kept by decision, a reload too, so its card comes back with them', () => {
  const first = world();
  const picks = [{ labels: ['Linear'], other: '' }, { labels: [], other: 'Page the on-call' }];
  first.q.pick('m:m1', picks);
  picks[0].labels.push('changed after');
  assert.deepEqual(first.q.picksOf('m:m1'), [{ labels: ['Linear'], other: '' }, { labels: [], other: 'Page the on-call' }]);
  assert.equal(first.q.picksOf('m:m2'), null);
  assert.deepEqual(world(first.storage).q.picksOf('m:m1'), first.q.picksOf('m:m1'));
});

test('the pin and the frozen choices live in sessionStorage too, so a reload restores both', () => {
  const first = world();
  first.q.sync([a, b]);
  first.q.jump('b');
  first.q.freeze('q:q-b', { via: 'recommended', label: 'Keep' });
  const reloaded = world(first.storage);
  assert.equal(reloaded.q.state().front, 'b');
  assert.deepEqual([...reloaded.q.state().frozen], [['q:q-b', { via: 'recommended', label: 'Keep' }]]);
  reloaded.q.sync([a, b]);
  assert.equal(reloaded.q.state().front, 'b');
  assert.equal(reloaded.q.guarded(), true);
  assert.equal(world(new Map([['agent-board:frozen', '{not json']])).q.state().frozen.size, 0);
});

test('a fresh ring lasts 2.6 s', () => {
  const { q, advance } = world();
  q.fresh('a');
  assert.ok(q.state().fresh.has('a'));
  advance(FRESH_MS - 1);
  assert.ok(q.state().fresh.has('a'));
  advance(1);
  assert.equal(q.state().fresh.has('a'), false);
});
