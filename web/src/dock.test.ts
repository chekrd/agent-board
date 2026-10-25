import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { answeredOf, confirmed, dockOf, lineOf } from './dock.ts';
import { createOutbox, type Request } from './outbox.ts';
import { question, session, turn } from './testing.ts';

const HOLD_MS = 5000;
const NOW = 1_000_000;

const working = (id: string, createdAt: number, step: string | null = 'Edit a.ts') =>
  session(id, { status: 'working', createdAt, activity: { step, since: NOW - 60_000 } });

const cart = session('cart', { question: question('q1'), createdAt: 1 });
const group = session('group', { summary: turn('t1'), createdAt: 2 });
const reviews = session('reviews', { createdAt: 3 });
const invoice = working('invoice', 30);
const search = working('search', 10);
const thumbs = working('thumbs', 20, null);
const ended = session('ended', { status: 'exited', createdAt: 4 });
const shelved = session('shelved', { status: 'exited', archived: true, createdAt: 5 });
const parked = { ...working('parked', 6), archived: true };
const sessions = [cart, group, reviews, invoice, search, thumbs, ended, shelved, parked];

const answer = (key: string, choice: string): Request => ({ action: 'answer', body: { key, choice }, label: choice });
const note = (text: string): Request => ({ action: 'answer', body: { key: null, text }, label: text });
const command = (text: string): Request => ({ action: 'answer', body: { key: null, text }, label: text, command: true });
const dismiss: Request = { action: 'dismiss', body: { key: 's:t1' }, label: 'Ship it?' };

// An outbox on mocked timers whose posts wait until the test settles them.
function outbox(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const posts: { ok: () => void; fail: (err: unknown) => void }[] = [];
  const box = createOutbox({ holdMs: HOLD_MS, post: () => new Promise((ok, fail) => posts.push({ ok: () => ok(undefined), fail })) });
  return { box, posts, tick: (ms: number) => t.mock.timers.tick(ms) };
}

const shown = (dock: ReturnType<typeof dockOf>) => dock.capsules.map((c) => `${c.session.id} ${c.state}`);

test('the dock has the working agents in board order, and the deck, the ended and the archived stay out of it', () => {
  const dock = dockOf(sessions, [], NOW);
  assert.deepEqual(shown(dock), ['search working', 'thumbs working', 'invoice working']);
  assert.equal(dock.working, 3);
  assert.deepEqual(dock.ended.map((s) => s.id), ['ended']);
  assert.deepEqual(dockOf([cart, ended], [], NOW).capsules, []);
});

test('a send puts its session first, newest first, through held, sending, waiting and sent; a command or a failed send has no capsule', async (t) => {
  const { box, posts, tick } = outbox(t);
  box.hold(cart, answer('q:q1', 'Keep'), null);
  tick(1000);
  box.hold(group, answer('s:t1', 'Ship'), null);
  box.hold(reviews, command('/compact'), null);
  assert.deepEqual(shown(dockOf(sessions, box.items(), NOW)), ['group held', 'cart held', 'search working', 'thumbs working', 'invoice working']);

  tick(4000);
  assert.deepEqual(shown(dockOf(sessions, box.items(), NOW)).slice(0, 2), ['group held', 'cart sending']);
  posts[0].fail(new TypeError('Failed to fetch'));
  await settle();
  assert.deepEqual(shown(dockOf(sessions, box.items(), NOW)).slice(0, 2), ['group held', 'cart waiting']);
  box.reconnected();
  posts[1].ok();
  await settle();
  assert.deepEqual(shown(dockOf(sessions, box.items(), NOW)).slice(0, 2), ['group held', 'cart sent']);

  tick(1000);
  posts[2].fail(Object.assign(new Error('this question is no longer open'), { code: 'stale' }));
  await settle();
  assert.deepEqual(box.items().map((i) => `${i.sessionId} ${i.state}`), ['cart sent', 'group failed', 'reviews sending']);
  assert.deepEqual(shown(dockOf(sessions, box.items(), NOW)), ['cart sent', 'search working', 'thumbs working', 'invoice working']);
});

test('a session with two sends shows the newer one, and a working session that is sent a message shows the send instead', (t) => {
  const { box, tick } = outbox(t);
  box.hold(invoice, note('Also bump the version'), null);
  tick(5000);
  box.hold(invoice, note('And the changelog'), null);
  const dock = dockOf(sessions, box.items(), NOW);
  assert.deepEqual(shown(dock), ['invoice held', 'search working', 'thumbs working']);
  assert.equal(dock.capsules[0].send?.label, 'And the changelog');
  assert.equal(dock.working, 2);
});

test('the second line: the step or Starting, a countdown that never reads more than the hold, then sending, waiting and sent', async (t) => {
  const { box, posts, tick } = outbox(t);
  const [first, second] = dockOf(sessions, [], NOW).capsules;
  assert.equal(lineOf(first, NOW, HOLD_MS), 'Edit a.ts');
  assert.equal(lineOf(second, NOW, HOLD_MS), 'Starting');

  box.hold(cart, answer('q:q1', 'Keep'), null);
  box.hold(group, dismiss, null);
  const [dismissing, sending] = dockOf(sessions, box.items(), NOW).capsules;
  assert.equal(lineOf(sending, NOW, HOLD_MS), 'Sending in 5 s');
  assert.equal(lineOf(sending, NOW - 900, HOLD_MS), 'Sending in 5 s');
  assert.equal(lineOf(sending, NOW + 1001, HOLD_MS), 'Sending in 4 s');
  assert.equal(lineOf(sending, NOW + 4999, HOLD_MS), 'Sending in 1 s');
  assert.equal(lineOf(sending, NOW + 5400, HOLD_MS), 'Sending in 1 s');
  assert.equal(lineOf(dismissing, NOW + 2500, HOLD_MS), 'Dismissing in 3 s');

  const lines = () => dockOf(sessions, box.items(), NOW).capsules.slice(0, 2).map((c) => lineOf(c, NOW, HOLD_MS));
  tick(5000);
  assert.deepEqual(lines(), ['Dismissing…', 'Sending…']);
  posts[0].fail(new TypeError('Failed to fetch'));
  await settle();
  assert.deepEqual(lines(), ['Dismissing…', 'Waiting for Agent Board']);
  box.reconnected();
  posts[1].ok();
  posts[2].ok();
  await settle();
  assert.deepEqual(lines(), ['Dismissed', 'Sent']);
});

test('a sent item the snapshot confirms, or that 15 s drop, turns back into its session; an undone or failed one does not', async (t) => {
  const { box, posts, tick } = outbox(t);
  box.hold(cart, answer('q:q1', 'Keep'), null);
  box.hold(group, answer('s:t1', 'Ship'), null);
  const held = box.items();
  box.undo();
  assert.deepEqual(confirmed(held, box.items()), []);

  tick(5000);
  posts[0].ok();
  await settle();
  const sent = box.items();
  box.confirm([{ ...cart, status: 'working', question: null }]);
  assert.deepEqual(confirmed(sent, box.items()), ['cart']);

  box.hold(group, answer('s:t1', 'Ship'), null);
  tick(5000);
  posts[1].ok();
  await settle();
  const unconfirmed = box.items();
  tick(15_000);
  assert.deepEqual(confirmed(unconfirmed, box.items()), ['group']);

  box.hold(reviews, note('Also bump the version'), null);
  tick(5000);
  posts[2].fail(Object.assign(new Error('this session has ended'), { code: 'ended' }));
  await settle();
  const failed = box.items();
  box.take(failed[0].id);
  assert.deepEqual(confirmed(failed, box.items()), []);
});

test('"You answered" is the send\'s label until a snapshot confirms it, then the server\'s record while the turn it started runs', (t) => {
  const { box } = outbox(t);
  box.hold(cart, answer('q:q1', 'Keep'), null);
  box.hold(group, dismiss, null);
  const [dismissed, answered] = dockOf(sessions, box.items(), NOW).capsules;
  assert.equal(answeredOf(answered), 'You answered: Keep');
  assert.equal(answeredOf(dismissed), 'You dismissed: Ship it?');

  const record = { key: 'q:q1', text: 'Keep — only if stock allows', at: NOW };
  const started = { ...cart, status: 'working' as const, question: null, answered: record, activity: { step: null, since: NOW + 2000 } };
  assert.equal(answeredOf(dockOf([started], [], NOW).capsules[0]), 'You answered: Keep — only if stock allows');
  const later = { ...started, activity: { step: 'Edit a.ts', since: NOW + 120_000 } };
  assert.equal(answeredOf(dockOf([later], [], NOW).capsules[0]), null);
  assert.equal(answeredOf(dockOf([search], [], NOW).capsules[0]), null);
});
