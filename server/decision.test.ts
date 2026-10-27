import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Advice, Session } from './db.ts';
import { adviceToSend, answeredLine, answerText, checkDecision, claim, decisionKey, menuAnswerText, openDecision } from './decision.ts';

const session = (patch: Partial<Session>): Session => ({
  id: 's', repoId: 1, worktree: '/w', cwd: '/w', pid: 1, tty: null, title: null, firstPrompt: null, status: 'idle',
  question: null, rank: null, rankReason: null, diffstat: null, lastMessage: null, lastTurn: 't2', waitingFor: null,
  dismissedAsk: null, advice: null, pr: null, summary: null, explanation: null, activity: null, menu: null, answered: null, artifacts: [], findings: null, parent: null, resolution: null,
  archived: false, createdAt: 0, updatedAt: 0, ...patch,
});

const summary = (basis: string) => ({
  text: 'h', basis, at: 5, question: null,
  decision: { problem: 'Ship it?', brief: 'Tests pass.', context: '- PR 7', options: [{ label: 'Ship', description: 'Merges PR 7' }] },
});

const question = { toolUseId: 'q1', title: 'Which way?', details: 'd', options: [], category: 'plan-problem', askedAt: 1 };
const menu = { toolUseId: 'm1', at: 2, questions: [{ question: 'Colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }] }] };

const answered = (key: string | null, text = 'Ship', at = 100) => ({ key, text, at });

// Like the database: every update makes a new row.
const store = (s: Session) => {
  let row = s;
  return { get: () => row, update: (_: string, patch: Partial<Session>) => void (row = { ...row, ...patch }) };
};

test('a question at the end of the latest turn is a decision', () => {
  const d = openDecision(session({ summary: summary('t2') }));
  assert.equal(d?.key, 's:t2');
  assert.equal(d?.title, 'Ship it?');
  assert.equal(d?.details, 'Tests pass.\n\n- PR 7');
  assert.equal(d?.options[0].description, 'Merges PR 7');
});

test('a decision read from an older turn, or while Claude works, is not', () => {
  assert.equal(openDecision(session({ summary: summary('t1') })), null);
  assert.equal(openDecision(session({ summary: summary('t2'), status: 'working' })), null);
  assert.equal(openDecision(session({ summary: summary('t2'), archived: true })), null);
});

test('a menu comes before an ask_human call, which comes before the end of the turn', () => {
  assert.equal(openDecision(session({ summary: summary('t2'), question, menu }))?.key, 'm:m1');
  assert.equal(openDecision(session({ summary: summary('t2'), question }))?.key, 'q:q1');
  assert.match(openDecision(session({ menu }))!.details, /1\. \[Colour\] Colour\? \(pick one, or write an own answer\)\n {3}- Red/);
});

test('an ended session waits on nothing', () => {
  assert.equal(openDecision(session({ question, status: 'exited' })), null);
});

test('the decision the page shows, archived and ended sessions included', () => {
  assert.equal(decisionKey(session({ question, archived: true })), 'q:q1');
  assert.equal(decisionKey(session({ question, status: 'exited' })), 'q:q1');
  assert.equal(decisionKey(session({ summary: summary('t2'), question, menu })), 'm:m1');
  assert.equal(decisionKey(session({ summary: summary('t2') })), 's:t2');
  assert.equal(decisionKey(session({ summary: summary('t1') })), null);
});

test('acting on the decision the page showed goes through while it is still open', () => {
  for (const s of [session({ menu }), session({ question }), session({ summary: summary('t2') }), session({})]) {
    assert.doesNotThrow(() => checkDecision(s, decisionKey(s)));
    assert.doesNotThrow(() => checkDecision(s, decisionKey(s), true));
  }
});

test('a decision that was replaced, answered in the terminal or moved on from is no longer open', () => {
  const stale = { message: /no longer open/, code: 'stale' };
  assert.throws(() => checkDecision(session({ question }), 'q:q0'), stale);
  assert.throws(() => checkDecision(session({ status: 'working' }), 'q:q1', true), stale);
  assert.throws(() => checkDecision(session({ summary: summary('t2'), status: 'working' }), 's:t2'), stale);
  assert.throws(() => checkDecision(session({ summary: summary('t3'), lastTurn: 't3' }), 's:t2'), stale);
  assert.throws(() => checkDecision(session({ question, menu }), 'q:q1'), stale);
});

test('with no decision on the page, only a typed reply may meet one read from the end of the turn', () => {
  const asked = { message: /asked something meanwhile/, code: 'stale' };
  assert.doesNotThrow(() => checkDecision(session({ summary: summary('t2') }), null, true));
  assert.throws(() => checkDecision(session({ question }), null, true), asked);
  assert.throws(() => checkDecision(session({ menu }), null, true), asked);
  assert.throws(() => checkDecision(session({ summary: summary('t2') }), null), asked);
});

test('a page from before decision keys is told to reload', () => {
  assert.throws(() => checkDecision(session({}), undefined, true), { message: /out of date/, code: 'out-of-date' });
});

test('an answered decision is closed at once, before the terminal or the transcript catch up', () => {
  for (const [s, key] of [[session({ menu }), 'm:m1'], [session({ question }), 'q:q1'], [session({ summary: summary('t2') }), 's:t2']] as const) {
    assert.equal(decisionKey(s), key);
    const done = { ...s, answered: answered(key) };
    assert.equal(decisionKey(done), null);
    assert.equal(openDecision(done), null);
    assert.throws(() => checkDecision(done, key), { message: /already answered/, code: 'answered' });
  }
});

test('an answer closes only its own decision', () => {
  assert.equal(decisionKey(session({ summary: summary('t3'), lastTurn: 't3', answered: answered('s:t2') })), 's:t3');
  assert.equal(decisionKey(session({ question, answered: answered(null) })), 'q:q1');
});

test('a message typed after an answered end-of-turn decision goes through as a plain message', () => {
  assert.doesNotThrow(() => checkDecision(session({ summary: summary('t2'), answered: answered('s:t2') }), null, true));
});

test('a claim checks and closes in one step, and reopen() gives the decision back', () => {
  const st = store(session({ summary: summary('t2') }));
  const { reopen } = claim(st, 's', 's:t2', false, 'Ship');
  assert.equal(decisionKey(st.get()), null);
  assert.equal(st.get().answered?.text, 'Ship');
  assert.throws(() => claim(st, 's', 's:t2', false, 'Ship'), { code: 'answered' });
  reopen();
  assert.equal(decisionKey(st.get()), 's:t2');
  assert.throws(() => claim(st, 's', 'q:q1', false, 'Ship'), { code: 'stale' });
  assert.throws(() => claim({ get: () => undefined, update: () => {} }, 'gone', null, true, 'Hi'), /unknown session gone/);
});

test('a typed reply claims the end-of-turn decision it meets', () => {
  const st = store(session({ summary: summary('t2') }));
  claim(st, 's', null, true, 'x'.repeat(600));
  assert.equal(st.get().answered?.key, 's:t2');
  assert.equal(st.get().answered?.text.length, 500);
});

test('a plain message after an answer keeps that decision closed', () => {
  const st = store(session({ summary: summary('t2') }));
  claim(st, 's', 's:t2', false, 'Ship');
  claim(st, 's', null, true, 'And add a changelog entry');
  assert.equal(decisionKey(st.get()), null);
  assert.deepEqual([st.get().answered?.key, st.get().answered?.text], ['s:t2', 'And add a changelog entry']);
  assert.throws(() => claim(st, 's', 's:t2', false, 'Ship'), { code: 'answered' });
});

test('a stale reopen() leaves a later claim in place', (t) => {
  const st = store(session({}));
  const one = claim(st, 's', null, true, 'one');
  claim(st, 's', null, true, 'two');
  one.reopen();
  assert.equal(st.get().answered?.text, 'two');

  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const again = store(session({}));
  const first = claim(again, 's', null, true, 'again');
  claim(again, 's', null, true, 'again');
  const later = again.get().answered;
  first.reopen();
  assert.equal(again.get().answered, later, 'the same text in the same millisecond');
});

test('reopen() restores the record from before the claim, also in a store that updates rows in place', () => {
  const row = session({ question, answered: answered(null, 'earlier', 50) });
  const st = { get: () => row, update: (_: string, patch: Partial<Session>) => void Object.assign(row, patch) };
  const { reopen } = claim(st, 's', 'q:q1', false, 'A');
  assert.equal(decisionKey(row), null);
  reopen();
  assert.deepEqual(row.answered, answered(null, 'earlier', 50));
  assert.equal(decisionKey(row), 'q:q1');
});

test('the answer text names the choice once, then the note and the files', () => {
  assert.equal(answerText('Ship', '', 0), 'Ship');
  assert.equal(answerText('Ship', 'after lunch', 0), 'Ship — after lunch');
  assert.equal(answerText('Merge both carts', 'Merge both carts. Cap each line at stock.', 0), 'Merge both carts. Cap each line at stock.');
  assert.equal(answerText(undefined, 'Use the cache', 2), 'Use the cache (+2 files)');
  assert.equal(answerText(undefined, '', 1), '(+1 file)');
});

test('a menu answer reads one part per question, an own answer instead of the options', () => {
  const two = {
    toolUseId: 'm2', at: 2, questions: [
      { question: 'Colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] },
      { question: 'Which sizes?', header: '', multiSelect: true, options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }] },
    ],
  };
  assert.equal(menuAnswerText(two, [{ labels: [], other: ' Teal ' }, { labels: ['S', 'L'], other: '' }]), 'Colour: Teal · Which sizes?: S, L');
});

test('"You answered" shows until Claude starts a turn the answer did not start', () => {
  const a = answered('q:q1', 'Ship', 100_000);
  assert.equal(answeredLine(session({ answered: a, activity: { step: null, since: 101_000 } })), 'Ship');
  assert.equal(answeredLine(session({ answered: a, activity: { step: 'Edit a.ts', since: 40_000 } })), 'Ship');
  assert.equal(answeredLine(session({ answered: a })), 'Ship');
  assert.equal(answeredLine(session({ answered: a, activity: { step: 'Edit a.ts', since: 200_000 } })), null);
  assert.equal(answeredLine(session({ activity: { step: null, since: 101_000 } })), null);
});

test('accepting a second opinion needs the one the page showed, still done and still open', () => {
  const advice: Advice = { key: 'q:q1', state: 'done', startedAt: 1, activity: null, choice: 'A', answer: 'A, because.', confidence: 80, reasoning: 'r', at: 7 };
  const s = session({ question, advice });
  assert.equal(adviceToSend(s, 7).advice, advice);
  assert.equal(adviceToSend(s).decision.key, 'q:q1');
  assert.throws(() => adviceToSend(s, 6), { message: /changed/, code: 'advice-changed' });
  assert.throws(() => adviceToSend(session({ question, advice: { ...advice, state: 'thinking' } })), { message: /no advice/, code: 'stale' });
  assert.throws(() => adviceToSend(session({ question, advice, answered: answered('q:q1') })), { code: 'stale' });
});
