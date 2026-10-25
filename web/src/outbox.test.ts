import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { deckOf, kindOf } from './deck.ts';
import { createOutbox, NO_ANSWER, type Folded, type Outgoing, type Request } from './outbox.ts';
import { menu, question, session, turn } from './testing.ts';
import type { Session } from './types.ts';

const cart = session('cart', { question: question('q1') });
const group = session('group', { summary: turn('t1') });
const hooks = session('hooks', { status: 'waiting', menu: menu('m1') });
const reviews = session('reviews');

const answer = (key: string | null, fields: { choice?: string; text?: string; files?: string[] } = {}): Request =>
  ({ action: 'answer', body: { key, ...fields }, label: fields.choice ?? fields.text ?? '' });
const note = (text: string, files?: string[]) => answer(null, { text, ...(files && { files }) });
const command = (key: string | null, text: string): Request => ({ action: 'answer', body: { key, text }, label: text, command: true });
const picks = [{ labels: ['Linear'], other: '' }, { labels: ['Email'], other: '' }];
const menuAnswer: Request = { action: 'answer-menu', body: { toolUseId: 'm1', answers: picks }, label: 'Backoff: Linear · Give up: Email' };

// An outbox on mocked timers whose posts wait until the test settles them.
function outbox(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const posts: { out: Outgoing; ok: () => void; fail: (err: unknown) => void }[] = [];
  let changes = 0;
  const box = createOutbox<string>({
    post: (out) => new Promise((ok, fail) => posts.push({ out, ok: () => ok(undefined), fail })),
    onChange: () => void changes++,
  });
  const tick = (ms: number) => t.mock.timers.tick(ms);
  const states = () => box.items().map((i) => i.state);
  return { box, posts, tick, states, changes: () => changes };
}

const refusal = (error: string, code?: string) => Object.assign(new Error(error), { code, status: 400 });

test('nothing posts before 5 s, and then the body as it was at the press posts exactly once', async (t) => {
  const { box, posts, tick, states } = outbox(t);
  const request = answer('q:q1', { choice: 'Keep' });
  box.hold(cart, request, 'draft');
  request.body.choice = 'Merge';
  tick(4999);
  assert.equal(posts.length, 0);
  tick(1);
  assert.deepEqual(posts.map((p) => p.out), [{ sessionId: 'cart', action: 'answer', body: { key: 'q:q1', choice: 'Keep' } }]);
  assert.deepEqual(states(), ['sending']);
  posts[0].ok();
  await settle();
  assert.deepEqual(states(), ['sent']);
  tick(60_000);
  assert.equal(posts.length, 1);
});

test('a plain message sends "key":null, which JSON would drop if it were undefined', (t) => {
  const { box, posts, tick } = outbox(t);
  box.hold(reviews, note('Also bump the version'), '');
  tick(5000);
  assert.equal(JSON.stringify(posts[0].out.body), '{"key":null,"text":"Also bump the version"}');
});

test('undo before 5 s posts nothing and returns the item to restore; once the post started it returns null', (t) => {
  const { box, posts, tick } = outbox(t);
  const id = box.hold(cart, answer('q:q1', { choice: 'Keep' }), 'my draft');
  tick(3000);
  assert.equal(box.undo(id)?.restore, 'my draft');
  tick(10_000);
  assert.equal(posts.length, 0);
  assert.deepEqual(box.items(), []);
  const again = box.hold(cart, answer('q:q1', { choice: 'Keep' }), 'my draft');
  tick(5000);
  assert.equal(box.undo(again), null);
  assert.equal(box.undo(), null);
  assert.equal(posts.length, 1);
});

test('Z takes back only the newest held item, and the others still post on time', (t) => {
  const { box, posts, tick } = outbox(t);
  box.hold(cart, answer('q:q1', { choice: 'Keep' }), 'first');
  tick(1000);
  box.hold(group, answer('s:t1', { choice: 'Ship' }), 'second');
  tick(1000);
  assert.equal(box.undo()?.restore, 'second');
  tick(3000);
  assert.deepEqual(posts.map((p) => p.out.sessionId), ['cart']);
  tick(10_000);
  assert.equal(posts.length, 1);
});

test('a refusal fails the item with the server\'s message and code; "answered" counts as sent', async (t) => {
  const { box, posts, tick } = outbox(t);
  box.hold(cart, answer('q:q1', { choice: 'Keep' }), 'draft');
  box.hold(group, answer('s:t1', { choice: 'Ship' }), '');
  tick(5000);
  posts[0].fail(refusal('this question is no longer open', 'stale'));
  posts[1].fail(refusal('you already answered this', 'answered'));
  await settle();
  const [failed, done] = box.items();
  assert.deepEqual([failed.state, failed.error, failed.code, failed.restore], ['failed', 'this question is no longer open', 'stale', 'draft']);
  assert.equal(done.state, 'sent');
  assert.equal(box.take(failed.id)?.restore, 'draft');
  assert.equal(box.take(done.id), null, 'a sent item is not the page\'s to take');
  assert.deepEqual(box.items().map((i) => i.state), ['sent']);
});

test('a network error makes the item wait, reconnected() posts the same body again, and no answer in 30 s fails it for good', async (t) => {
  const { box, posts, tick, states } = outbox(t);
  box.hold(cart, answer('q:q1', { choice: 'Keep' }), '');
  tick(5000);
  posts[0].fail(new TypeError('Failed to fetch'));
  await settle();
  assert.deepEqual(states(), ['waiting']);
  tick(60_000);
  assert.equal(posts.length, 1, 'waiting is not retried on a timer');
  box.reconnected();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].out, posts[0].out);
  tick(29_999);
  assert.deepEqual(states(), ['sending']);
  tick(1);
  assert.deepEqual(box.items().map((i) => [i.state, i.error]), [['failed', NO_ANSWER]]);
  posts[1].ok();
  await settle();
  box.reconnected();
  tick(60_000);
  assert.deepEqual([posts.length, states()], [2, ['failed']], 'a late reply changes nothing, and nothing retries');
});

test('the early check: another decision fails a held item unposted, an answer from elsewhere drops it quietly, and a plain message may meet the end-of-turn decision it answers', async (t) => {
  const { box, posts, tick } = outbox(t);
  const moved = box.hold(cart, answer('q:q1', { choice: 'Keep' }), 'draft');
  const elsewhere = box.hold(hooks, menuAnswer, '');
  const reply = box.hold(group, note('Ship it after lunch'), '');
  const later = box.hold(reviews, answer(null, { text: 'Thanks' }), '');
  const out = box.reconcile([
    { ...cart, question: question('q2') },
    { ...hooks, answered: { key: 'm:m1', text: 'Backoff: Linear', at: 5 } },
    group,
    { ...reviews, summary: turn('t1') },
  ]);
  assert.deepEqual(out.map((i) => [i.id, i.state, i.code]), [[moved, 'failed', 'stale'], [elsewhere, 'answered', undefined]]);
  assert.equal(out[0].error, 'this question is no longer open');
  tick(5000);
  assert.deepEqual(posts.map((p) => p.out.sessionId).toSorted(), ['group', 'reviews'], `${reply} and ${later} still go out`);
  await settle();

  const waiting = createOutbox({ post: () => Promise.reject(new TypeError('Failed to fetch')) });
  waiting.hold(cart, answer('q:q1', { choice: 'Keep' }), '');
  tick(5000);
  await settle();
  assert.deepEqual(waiting.items().map((i) => i.state), ['waiting']);
  assert.deepEqual(waiting.reconcile([{ ...cart, answered: { key: 'q:q1', text: 'Keep', at: 5 } }]), []);
  assert.deepEqual(waiting.items().map((i) => i.state), ['sent'], 'it may have landed before the connection broke');
});

test('the early check fails a held item whose session is gone or has ended', (t) => {
  const { box } = outbox(t);
  box.hold(cart, answer('q:q1', { choice: 'Keep' }), '');
  box.hold(group, answer('s:t1', { choice: 'Ship' }), '');
  const out = box.reconcile([{ ...group, status: 'exited' }]);
  assert.deepEqual(out.map((i) => [i.sessionId, i.code, i.error]), [
    ['cart', 'gone', 'the task is gone'],
    ['group', 'ended', 'this session has ended; continue it first'],
  ]);
});

test('commands skip the early check: a held /compact goes out although its card\'s decision moved on, and is gone on its 204', async (t) => {
  const { box, posts, tick } = outbox(t);
  box.hold(cart, command('q:q1', '/compact'), '');
  box.hold(cart, command('q:q1', '!git status'), '');
  assert.deepEqual(box.reconcile([{ ...cart, question: question('q2') }]), []);
  tick(5000);
  assert.deepEqual(posts.map((p) => p.out.body.text), ['/compact']);
  posts[0].ok();
  await settle();
  assert.deepEqual(posts.map((p) => p.out.body.text), ['/compact', '!git status']);
  posts[1].ok();
  await settle();
  assert.deepEqual(box.items(), []);
});

test('a sent item stays until the snapshot shows the session moved on, and at most 15 s', async (t) => {
  const { box, posts, tick, states } = outbox(t);
  box.hold(cart, answer('q:q1', { choice: 'Keep' }), '');
  tick(5000);
  posts[0].ok();
  await settle();
  const sentAt = box.items()[0].sentAt!;
  const closed = { ...cart, answered: { key: 'q:q1', text: 'Keep', at: sentAt } };
  box.confirm([closed]);
  assert.deepEqual(states(), ['sent'], 'answered lands before Claude starts; dropping it then would bring the card back as Your turn');
  box.confirm([{ ...closed, status: 'working' }]);
  assert.deepEqual(states(), []);

  const moves: [string, Request, Session, Session][] = [
    ['a new turn', answer('q:q1', { choice: 'Keep' }), cart, { ...cart, question: null, lastTurn: 't2' }],
    ['another decision', answer('q:q1', { choice: 'Keep' }), cart, { ...cart, question: question('q2') }],
    ['the menu closing', menuAnswer, hooks, { ...hooks, menu: null }],
    ['a permission prompt', note('Go on'), reviews, { ...reviews, status: 'waiting' }],
    ['the end of the session', note('Go on'), reviews, { ...reviews, status: 'exited' }],
    ['the dismissed question closing', { action: 'dismiss', body: { key: 'q:q1' }, label: 'Which cart wins?' }, cart, { ...cart, question: null, dismissedAsk: 'q1' }],
  ];
  for (const [what, request, before, after] of moves) {
    box.hold(before, request, '');
    tick(5000);
    posts.at(-1)!.ok();
    await settle();
    box.confirm([before]);
    assert.deepEqual(states(), ['sent'], `${what}: nothing moved yet`);
    box.confirm([after]);
    assert.deepEqual(states(), [], what);
  }

  box.hold(hooks, menuAnswer, '');
  tick(5000);
  posts.at(-1)!.ok();
  await settle();
  box.confirm([hooks]);
  assert.deepEqual(states(), ['sent'], 'a menu is open while Claude waits, so waiting alone proves nothing');
  tick(14_999);
  assert.deepEqual(states(), ['sent']);
  tick(1);
  assert.deepEqual(states(), []);
});

test('a menu still open 10 s after the board answered it counts as taken, so its card comes back as Needs focus then and not 5 s later', async (t) => {
  const { box, posts, tick, states } = outbox(t);
  box.hold(hooks, menuAnswer, '');
  tick(5000);
  const stuck = { ...hooks, answered: { key: 'm:m1', text: 'Backoff: Linear · Give up: Email', at: Date.now() } };
  tick(1500);
  posts[0].ok();
  await settle();
  box.confirm([stuck]);
  tick(8499);
  box.confirm([stuck]);
  assert.deepEqual([states(), deckOf([stuck], box.busy())], [['sent'], []]);
  tick(1);
  box.confirm([stuck]);
  assert.deepEqual(states(), []);
  assert.deepEqual(deckOf([stuck], box.busy()).map((s) => [s.id, kindOf(s)]), [['hooks', 'prompt']]);
});

test('busy: a held, sending, waiting or unconfirmed send keeps its session out of the deck; a failed one and a command do not', async (t) => {
  const { box, posts, tick } = outbox(t);
  box.hold(cart, answer('q:q1', { choice: 'Keep' }), '');
  box.hold(reviews, command(null, '/compact'), '');
  assert.deepEqual([...box.busy()], ['cart']);
  const before = box.busy();
  assert.equal(box.busy(), before, 'the same set until something changes');
  tick(5000);
  assert.deepEqual([...box.busy()], ['cart']);
  posts[0].fail(new TypeError('Failed to fetch'));
  await settle();
  assert.deepEqual([...box.busy()], ['cart']);
  box.reconnected();
  posts.at(-1)!.ok();
  await settle();
  assert.equal(box.items()[0].state, 'sent');
  assert.deepEqual([...box.busy()], ['cart']);
  box.hold(group, answer('s:t1', { choice: 'Ship' }), '');
  tick(5000);
  posts.at(-1)!.fail(refusal('this question is no longer open', 'stale'));
  await settle();
  assert.deepEqual([...box.busy()].toSorted(), ['cart']);
});

test('flush hands every held and waiting item over exactly once, and none of them posts again', async (t) => {
  const { box, posts, tick } = outbox(t);
  const waiting = box.hold(cart, answer('q:q1', { choice: 'Keep' }), '');
  tick(5000);
  posts[0].fail(new TypeError('Failed to fetch'));
  await settle();
  const held = [box.hold(group, answer('s:t1', { choice: 'Ship' }), ''), box.hold(hooks, menuAnswer, ''), box.hold(reviews, command(null, '/compact'), '')];
  const flushed: Folded[] = [];
  box.flush((out) => flushed.push(out));
  assert.deepEqual(flushed.flatMap((f) => f.ids).toSorted(), [waiting, ...held].toSorted());
  assert.deepEqual(box.items().map((i) => i.state), ['sent', 'sent', 'sent'], 'the command is gone, the rest await their snapshot');
  box.flush((out) => flushed.push(out));
  box.reconnected();
  tick(60_000);
  assert.equal(flushed.length, 4);
  assert.equal(posts.length, 1);
});

test('flush takes a send still queued behind its session\'s post under way, once, and that send never posts after', async (t) => {
  const { box, posts, tick, states } = outbox(t);
  box.hold(cart, answer('q:q1', { choice: 'Keep' }), '');
  tick(1000);
  const queued = box.hold(cart, note('And log it'), '');
  tick(5000);
  assert.deepEqual([posts.length, states()], [1, ['sending', 'sending']], 'the answer is still being typed');
  const flushed: Folded[] = [];
  box.flush((out) => flushed.push(out));
  box.flush((out) => flushed.push(out));
  assert.deepEqual(flushed.map((f) => [f.ids, f.body]), [[[queued], { key: null, text: 'And log it' }]]);
  assert.deepEqual(states(), ['sending', 'sent']);
  posts[0].ok();
  await settle();
  tick(60_000);
  assert.equal(posts.length, 1);
});

test('flush folds a session\'s notes into its decision answer, or into its first note, in press order; a menu answer and a note stay two posts', (t) => {
  const { box } = outbox(t);
  box.hold(group, answer('s:t1', { choice: 'Ship' }), '');
  box.hold(group, note('Tag it too', ['/u/a.png']), '');
  box.hold(reviews, note('First'), '');
  box.hold(reviews, command(null, '/compact'), '');
  box.hold(reviews, note('Second', ['/u/b.txt']), '');
  box.hold(hooks, menuAnswer, '');
  box.hold(hooks, note('Then rerun the tests'), '');
  const flushed: Folded[] = [];
  box.flush((out) => flushed.push(out));
  assert.deepEqual(flushed.map(({ sessionId, action, body }) => ({ sessionId, action, body })), [
    { sessionId: 'group', action: 'answer', body: { key: 's:t1', choice: 'Ship', text: 'Tag it too', files: ['/u/a.png'] } },
    { sessionId: 'reviews', action: 'answer', body: { key: null, text: 'First\n\nSecond', files: ['/u/b.txt'] } },
    { sessionId: 'reviews', action: 'answer', body: { key: null, text: '/compact' } },
    { sessionId: 'hooks', action: 'answer-menu', body: { toolUseId: 'm1', answers: picks } },
    { sessionId: 'hooks', action: 'answer', body: { key: null, text: 'Then rerun the tests' } },
  ]);
  assert.deepEqual(flushed.map((f) => f.ids.length), [2, 2, 1, 1, 1]);
});

test('a typed answer to a decision takes the notes after it, its own text first', (t) => {
  const { box } = outbox(t);
  box.hold(cart, answer('q:q1', { text: 'Keep the account cart', files: ['/u/a.png'] }), '');
  box.hold(cart, note('And log it'), '');
  const flushed: Folded[] = [];
  box.flush((out) => flushed.push(out));
  assert.deepEqual(flushed.map((f) => f.body), [{ key: 'q:q1', text: 'Keep the account cart\n\nAnd log it', files: ['/u/a.png'] }]);
});

test('idle() resolves only once nothing is held, sending or waiting', async (t) => {
  const { box, posts, tick } = outbox(t);
  await box.idle();
  box.hold(cart, answer('q:q1', { choice: 'Keep' }), '');
  let idle = false;
  void box.idle().then(() => (idle = true));
  tick(5000);
  await settle();
  assert.equal(idle, false, 'sending');
  posts[0].fail(new TypeError('Failed to fetch'));
  await settle();
  assert.equal(idle, false, 'waiting');
  box.reconnected();
  posts[1].ok();
  await settle();
  assert.equal(idle, true, 'a sent item no longer holds a reload');
});

test('sendNow posts a session\'s held items at once, one after the other in press order, and leaves the rest held', async (t) => {
  const { box, posts, tick, states } = outbox(t);
  box.hold(group, answer('s:t1', { choice: 'Ship' }), '');
  box.hold(cart, answer('q:q1', { choice: 'Keep' }), '');
  box.hold(group, note('Tag it too'), '');
  box.sendNow('group');
  assert.deepEqual(posts.map((p) => p.out.body.choice ?? p.out.body.text), ['Ship']);
  assert.deepEqual(states(), ['sending', 'held', 'sending']);
  posts[0].ok();
  await settle();
  assert.deepEqual(posts.map((p) => p.out.body.choice ?? p.out.body.text), ['Ship', 'Tag it too']);
  tick(5000);
  assert.equal(posts.length, 3);
});

test('sendNow resolves once every post of the session has an answer, a refusal too, and at once when it holds nothing', async (t) => {
  const { box, posts } = outbox(t);
  let typed = false;
  await box.sendNow('group');
  box.hold(group, answer('s:t1', { choice: 'Ship' }), '');
  box.hold(group, note('Tag it too'), '');
  void box.sendNow('group').then(() => (typed = true));
  posts[0].ok();
  await settle();
  assert.equal(typed, false, 'the note is still out');
  posts[1].fail(refusal('this question is no longer open', 'stale'));
  await settle();
  assert.equal(typed, true);
});

test('every change is reported, so a view of the items can re-render', (t) => {
  const { box, changes } = outbox(t);
  box.hold(cart, answer('q:q1', { choice: 'Keep' }), '');
  box.undo();
  assert.equal(changes(), 2);
});
