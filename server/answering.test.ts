import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { answering } from './answering.ts';
import type { Advice, Session } from './db.ts';
import { decisionKey } from './decision.ts';
import type { Keystroke } from './ghostty.ts';

const session = (patch: Partial<Session>): Session => ({
  id: 's', repoId: 1, worktree: '/w', cwd: '/w', pid: 1, tty: '/dev/ttys001', title: null, firstPrompt: null, status: 'idle',
  question: null, rank: null, rankReason: null, diffstat: null, lastMessage: null, lastTurn: 't2', waitingFor: null,
  dismissedAsk: null, advice: null, pr: null, summary: null, explanation: null, activity: null, menu: null, answered: null, artifacts: [],
  archived: false, createdAt: 0, updatedAt: 0, ...patch,
});

const summary = {
  text: 'h', basis: 't2', at: 5, question: null,
  decision: { problem: 'Ship it?', brief: 'Tests pass.', options: [{ label: 'Ship' }, { label: 'Wait' }] },
};
const question = { toolUseId: 'q1', title: 'Which way?', details: 'd', options: [{ label: 'A' }, { label: 'B' }], category: 'plan-problem', askedAt: 1 };
const menu = { toolUseId: 'm1', at: 2, questions: [{ question: 'Colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] };
const advice: Advice = { key: 'q:q1', state: 'done', startedAt: 1, activity: null, choice: 'A', answer: 'A, because it is smaller.', confidence: 80, reasoning: 'r', at: 7 };

// A session behind a fake terminal. With `hold`, each send waits until the test lets it finish or fail.
function world(s: Session, { hold = false } = {}) {
  let row = s;
  let notified = 0;
  const typed: string[] = [];
  const pressed: Keystroke[][] = [];
  const decided: string[] = [];
  const sends: { done: () => void; fail: (err: Error) => void }[] = [];
  const answers = answering({
    store: { get: (id) => (id === row.id ? row : undefined), update: (_, patch) => void (row = { ...row, ...patch }) },
    send: (_tty, text) => {
      typed.push(text);
      return hold ? new Promise((done, fail) => sends.push({ done: () => done(), fail })) : Promise.resolve();
    },
    keys: async (_tty, strokes) => void pressed.push(strokes),
    notify: () => void notified++,
    decided: (id) => void decided.push(id),
    isCommand: async (_s, text) => text.startsWith('!') || text.split(' ')[0] === '/review',
    checkUploads: async (files) => (files as string[] | undefined) ?? [],
  });
  return { answers, row: () => row, notified: () => notified, typed, pressed, decided, sends };
}

test('two answers to one decision at once type once: the second is refused while the first still types', async () => {
  const w = world(session({ summary }), { hold: true });
  const first = w.answers.answer('s', { key: 's:t2', choice: 'Ship' });
  const second = w.answers.answer('s', { key: 's:t2', choice: 'Ship' });
  await assert.rejects(second, { code: 'answered' });
  assert.deepEqual(w.typed, ['My decision: Ship.']);
  assert.equal(decisionKey(w.row()), null, 'closed before the keys went out');
  assert.equal(w.notified(), 1);
  assert.deepEqual(w.decided, []);
  w.sends[0].done();
  await first;
  assert.deepEqual(w.decided, ['s']);
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text], ['s:t2', 'Ship']);
});

test('a send that fails gives the decision back and rethrows', async () => {
  const w = world(session({ question }), { hold: true });
  const answer = w.answers.answer('s', { key: 'q:q1', choice: 'A', text: 'after lunch' });
  await flush();
  assert.deepEqual(w.typed, ['Re: "Which way?" — My decision: A. — after lunch']);
  w.sends[0].fail(new Error('can\'t find pane'));
  await assert.rejects(answer, /can't find pane/);
  assert.equal(w.row().answered, null);
  assert.equal(decisionKey(w.row()), 'q:q1');
  assert.equal(w.notified(), 2);
  assert.deepEqual(w.decided, []);
});

test('a send that fails after a later one went out leaves the later claim in place', async () => {
  const w = world(session({ summary }), { hold: true });
  const answer = w.answers.answer('s', { key: 's:t2', choice: 'Ship' });
  await flush();
  const note = w.answers.answer('s', { key: null, text: 'Also bump the version' });
  await flush();
  assert.equal(w.sends.length, 2);
  w.sends[1].done();
  await note;
  w.sends[0].fail(new Error('the pane is gone'));
  await assert.rejects(answer, /the pane is gone/);
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text], ['s:t2', 'Also bump the version']);
  assert.equal(decisionKey(w.row()), null);
});

test('a command is typed as is and never claims, whatever the page showed', async () => {
  const w = world(session({ question }));
  await w.answers.answer('s', { key: undefined, text: '/review the cart code' });
  await w.answers.answer('s', { key: 'q:q0', text: '!git status' });
  assert.deepEqual(w.typed, ['/review the cart code', '!git status']);
  assert.equal(w.row().answered, null);
  assert.equal(w.notified(), 0);
  assert.deepEqual(w.decided, []);
});

test('a slash word that is no command, or a command with files, is an answer', async () => {
  const w = world(session({ summary }));
  await w.answers.answer('s', { key: null, text: '/nope is my reply' });
  assert.deepEqual([w.row().answered?.key, w.typed], ['s:t2', ['/nope is my reply']]);
  await assert.rejects(w.answers.answer('s', { key: undefined, text: '/review', files: ['/u/a.png'] }), { code: 'out-of-date' });
});

test('nothing is claimed while Claude shows something in its terminal, or when the session ended', async () => {
  const w = world(session({ summary, status: 'waiting', waitingFor: 'a permission prompt' }));
  await assert.rejects(w.answers.answer('s', { key: null, text: 'Hi' }), /Claude is showing a permission prompt in its terminal/);
  const ended = world(session({ question, status: 'exited' }));
  await assert.rejects(ended.answers.answer('s', { key: 'q:q1', choice: 'A' }), /this session has ended/);
  await assert.rejects(ended.answers.answer('s', {}), /empty answer/);
  assert.deepEqual([w.row().answered, ended.row().answered, w.typed, ended.typed], [null, null, [], []]);
});

test('a menu answer is checked before it is claimed, and two at once press the keys once', async () => {
  const w = world(session({ menu, status: 'waiting' }));
  await assert.rejects(w.answers.answerMenu('s', { toolUseId: 'm0', answers: [{ labels: ['Red'], other: '' }] }), { code: 'stale' });
  await assert.rejects(w.answers.answerMenu('s', { toolUseId: 'm1', answers: [{ labels: ['Green'], other: '' }] }), /unknown option/);
  assert.equal(w.row().answered, null);
  const results = await Promise.allSettled([
    w.answers.answerMenu('s', { toolUseId: 'm1', answers: [{ labels: ['Blue'], other: '' }] }),
    w.answers.answerMenu('s', { toolUseId: 'm1', answers: [{ labels: ['Blue'], other: '' }] }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.deepEqual(w.pressed, [[{ key: 'arrow_down' }, { key: 'enter' }]]);
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text], ['m:m1', 'Colour: Blue']);
  assert.deepEqual(w.decided, ['s']);
});

test('accepting the second opinion is claimed like an answer: a second accept is refused while the first types', async () => {
  const w = world(session({ question, advice }), { hold: true });
  const first = w.answers.acceptAdvice('s', 7);
  const second = w.answers.acceptAdvice('s', 7);
  await assert.rejects(second, { code: 'answered' });
  w.sends[0].done();
  await first;
  assert.deepEqual(w.typed, ['Re: "Which way?" — My decision: A. — A, because it is smaller.']);
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text], ['q:q1', 'A, because it is smaller.']);
  await assert.rejects(w.answers.acceptAdvice('s', 7), { code: 'stale' });
});

test('a second opinion that changed since the page showed it is refused before anything is typed', async () => {
  const w = world(session({ question, advice }));
  await assert.rejects(w.answers.acceptAdvice('s', 6), { code: 'advice-changed' });
  assert.deepEqual([w.typed, w.row().answered], [[], null]);
  await w.answers.acceptAdvice('s');
  assert.equal(w.typed.length, 1, 'a page that names no second opinion sends the current one');
});

test('accepting the second opinion on a menu drives it with the suggested answers', async () => {
  const w = world(session({ menu, status: 'waiting', advice: { ...advice, key: 'm:m1', choice: null, answer: '', answers: [{ labels: ['Red'], other: '' }] } }));
  await w.answers.acceptAdvice('s', 7);
  assert.deepEqual(w.pressed, [[{ key: 'enter' }]]);
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text], ['m:m1', 'Colour: Red']);
});

test('dismiss closes the decision through decided and types nothing', () => {
  const w = world(session({ question }));
  w.answers.dismiss('s');
  assert.deepEqual([w.decided, w.typed, w.row().answered], [['s'], [], null]);
  assert.throws(() => w.answers.dismiss('gone'), /unknown session gone/);
});
