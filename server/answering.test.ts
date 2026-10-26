import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { answering } from './answering.ts';
import type { Advice, Session } from './db.ts';
import { claim, decisionKey } from './decision.ts';
import { PartlyTyped, type Keystroke } from './ghostty.ts';

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

// A session behind a fake terminal. With `hold`, each send waits until the test lets it finish or fail; with
// `pressFails`, every press of keys fails with it.
function world(s: Session, { hold = false, pressFails }: { hold?: boolean; pressFails?: Error } = {}) {
  let row = s;
  let notified = 0;
  const typed: string[] = [];
  const pressed: Keystroke[][] = [];
  const decided: string[] = [];
  const sends: { done: () => void; fail: (err: Error) => void }[] = [];
  const store = { get: (id: string) => (id === row.id ? row : undefined), update: (_: string, patch: Partial<Session>) => void (row = { ...row, ...patch }) };
  const answers = answering({
    store,
    send: (_tty, text) => {
      typed.push(text);
      return hold ? new Promise((done, fail) => sends.push({ done: () => done(), fail })) : Promise.resolve();
    },
    keys: async (_tty, strokes) => {
      pressed.push(strokes);
      if (pressFails) throw pressFails;
    },
    notify: () => void notified++,
    decided: (id) => void decided.push(id),
    isCommand: async (_s, text) => text.startsWith('!') || text.split(' ')[0] === '/review',
    checkUploads: async (files) => (files as string[] | undefined) ?? [],
  });
  return { answers, store, row: () => row, notified: () => notified, typed, pressed, decided, sends };
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

test('a message sent while an answer to a question types goes out after it, as a message and not as a reply to the question', async () => {
  const w = world(session({ question }), { hold: true });
  const answer = w.answers.answer('s', { key: 'q:q1', choice: 'A' });
  const note = w.answers.answer('s', { key: null, text: 'Also bump the version' });
  await flush();
  assert.deepEqual(w.typed, ['Re: "Which way?" — My decision: A.'], 'one send at a time');
  w.sends[0].done();
  await answer;
  await flush();
  assert.equal(w.typed.at(-1), 'Also bump the version');
  w.sends[1].done();
  await note;
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text, w.decided], ['q:q1', 'Also bump the version', ['s', 's']]);
});

test('a message never closes a question: one sent while the answer types is refused once the answer fails, and the question stays open', async () => {
  const w = world(session({ question }), { hold: true });
  const answer = w.answers.answer('s', { key: 'q:q1', choice: 'A' });
  const note = assert.rejects(w.answers.answer('s', { key: null, text: 'Also bump the version' }), { message: /asked something meanwhile/, code: 'stale' });
  await flush();
  w.sends[0].fail(new Error('can\'t find pane'));
  await assert.rejects(answer, /can't find pane/);
  await flush();
  assert.deepEqual(w.typed, ['Re: "Which way?" — My decision: A.']);
  await note;
  assert.deepEqual([w.row().answered, decisionKey(w.row()), w.decided], [null, 'q:q1', []]);
});

test('an answer that fails while a message waits gives the decision back first: the message claims it, and once that fails too a retry types', async () => {
  const w = world(session({ summary }), { hold: true });
  const answer = w.answers.answer('s', { key: 's:t2', choice: 'Ship' });
  const note = w.answers.answer('s', { key: null, text: 'Also bump the version' });
  await flush();
  assert.deepEqual(w.typed, ['My decision: Ship.']);
  w.sends[0].fail(new Error('the pane is gone'));
  await assert.rejects(answer, /the pane is gone/);
  await flush();
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text], ['s:t2', 'Also bump the version']);
  w.sends[1].fail(new Error('the pane is gone'));
  await assert.rejects(note, /the pane is gone/);
  assert.deepEqual([w.row().answered, decisionKey(w.row())], [null, 's:t2']);
  const retry = w.answers.answer('s', { key: 's:t2', choice: 'Ship' });
  await flush();
  w.sends[2].done();
  await retry;
  assert.deepEqual([w.typed.at(-1), w.row().answered?.text, w.decided], ['My decision: Ship.', 'Ship', ['s']]);
});

test('a send that fails gives back only its own claim: a record written while it typed stays', async () => {
  const w = world(session({}), { hold: true });
  const first = w.answers.answer('s', { key: null, text: 'one' });
  await flush();
  claim(w.store, 's', null, true, 'two');
  w.sends[0].fail(new Error('the pane is gone'));
  await assert.rejects(first, /the pane is gone/);
  assert.equal(w.row().answered?.text, 'two');
});

test('a command waits for the send that is typing and goes out after it', async () => {
  const w = world(session({ summary }), { hold: true });
  const answer = w.answers.answer('s', { key: 's:t2', choice: 'Ship' });
  const command = w.answers.answer('s', { key: null, text: '/review' });
  await flush();
  assert.deepEqual(w.typed, ['My decision: Ship.']);
  w.sends[0].done();
  await answer;
  await flush();
  w.sends[1].done();
  await command;
  assert.deepEqual([w.typed, w.row().answered?.text], [['My decision: Ship.', '/review'], 'Ship']);
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
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text, w.typed], ['s:t2', '/nope is my reply', ['My reply: /nope is my reply']]);
  await assert.rejects(w.answers.answer('s', { key: undefined, text: '/review', files: ['/u/a.png'] }), { code: 'out-of-date' });
});

test('an answer never reaches Claude Code starting with ! or /, which would run in its shell or as a command', async () => {
  const bang = { ...advice, key: 's:t2', choice: null, answer: '!pnpm install && pnpm test' };
  const w = world(session({ summary: { ...summary, decision: { ...summary.decision, options: [] } }, advice: bang }));
  await w.answers.acceptAdvice('s', 7);
  assert.deepEqual([w.typed, w.row().answered?.key, w.row().answered?.text], [['My reply: !pnpm install && pnpm test'], 's:t2', '!pnpm install && pnpm test']);
  const files = world(session({ summary }));
  await files.answers.answer('s', { key: 's:t2', text: '!important: the log', files: ['/u/log.txt'] });
  assert.deepEqual(files.typed, ['My reply: !important: the log']);
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

test('a menu answer whose keys stopped part way stays answered, since the same keys again would pick from the wrong place; one that typed none is given back', async () => {
  const blue = { toolUseId: 'm1', answers: [{ labels: ['Blue'], other: '' }] };
  const w = world(session({ menu, status: 'waiting' }), { pressFails: new PartlyTyped('tmux failed after 1 of 2 keys') });
  await assert.rejects(w.answers.answerMenu('s', blue), /^Error: the keys stopped part way through Claude's menu; finish it in the terminal$/);
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text, decisionKey(w.row()), w.decided], ['m:m1', 'Colour: Blue', null, ['s']]);
  await assert.rejects(w.answers.answerMenu('s', blue), { code: 'answered' });
  assert.equal(w.pressed.length, 1, 'the keys went out once');
  const none = world(session({ menu, status: 'waiting' }), { pressFails: new Error('can\'t find pane: s') });
  await assert.rejects(none.answers.answerMenu('s', blue), /can't find pane/);
  assert.deepEqual([none.row().answered, decisionKey(none.row()), none.decided], [null, 'm:m1', []]);
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

test('a rename sent while an answer types goes out after it, and claims nothing', async () => {
  const w = world(session({ summary }), { hold: true });
  const answer = w.answers.answer('s', { key: 's:t2', choice: 'Ship' });
  await flush();
  const rename = w.answers.type('s', '/rename Cart merge');
  await flush();
  assert.deepEqual(w.typed, ['My decision: Ship.'], 'not inside the answer\'s paste');
  w.sends[0].done();
  await answer;
  await flush();
  assert.deepEqual(w.typed, ['My decision: Ship.', '/rename Cart merge']);
  w.sends[1].done();
  await rename;
  assert.deepEqual([w.row().answered?.key, w.row().answered?.text, w.decided, w.notified()], ['s:t2', 'Ship', ['s'], 1]);
});

test('typing that answers nothing is checked when its turn comes: a prompt Claude showed meanwhile, or an ended session, refuses it', async () => {
  const w = world(session({ summary }), { hold: true });
  const answer = w.answers.answer('s', { key: 's:t2', choice: 'Ship' });
  await flush();
  const rename = assert.rejects(w.answers.type('s', '/rename Cart merge'), /Claude is showing a permission prompt in its terminal/);
  await flush();
  w.store.update('s', { status: 'waiting', waitingFor: 'a permission prompt' });
  w.sends[0].done();
  await answer;
  await rename;
  assert.deepEqual(w.typed, ['My decision: Ship.']);
  const ended = world(session({ status: 'exited' }));
  await assert.rejects(ended.answers.type('s', '/rename Cart merge'), /this session has ended/);
  assert.deepEqual(ended.typed, []);
});

test('dismiss closes the decision through decided and types nothing', () => {
  const w = world(session({ question }));
  w.answers.dismiss('s', 'q:q1');
  assert.deepEqual([w.decided, w.typed, w.row().answered, w.row().question, w.row().dismissedAsk], [['s'], [], null, null, 'q1']);
  assert.throws(() => w.answers.dismiss('gone', 'q:q1'), /unknown session gone/);
});

test('an answered question is put aside for good; a menu answered while it is open too leaves it, to come up once the menu closes', async () => {
  const w = world(session({ question }));
  await w.answers.answer('s', { key: 'q:q1', choice: 'A' });
  assert.deepEqual([w.row().question, w.row().dismissedAsk], [null, 'q1']);
  const both = world(session({ question, menu, status: 'waiting' }));
  assert.equal(decisionKey(both.row()), 'm:m1');
  await both.answers.answerMenu('s', { toolUseId: 'm1', answers: [{ labels: ['Blue'], other: '' }] });
  both.answers.dismiss('s', 'm:m1');
  assert.deepEqual([both.row().question?.toolUseId, both.row().dismissedAsk, both.decided], ['q1', null, ['s', 's']]);
  both.store.update('s', { menu: null, status: 'idle' });
  assert.equal(decisionKey(both.row()), 'q:q1');
});
