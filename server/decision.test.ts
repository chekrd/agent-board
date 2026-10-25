import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from './db.ts';
import { checkDecision, decisionKey, openDecision } from './decision.ts';

const session = (patch: Partial<Session>): Session => ({
  id: 's', repoId: 1, worktree: '/w', cwd: '/w', pid: 1, tty: null, title: null, firstPrompt: null, status: 'idle',
  question: null, rank: null, rankReason: null, diffstat: null, lastMessage: null, lastTurn: 't2', waitingFor: null,
  dismissedAsk: null, advice: null, pr: null, summary: null, explanation: null, activity: null, menu: null, artifacts: [], archived: false,
  createdAt: 0, updatedAt: 0, ...patch,
});

const summary = (basis: string) => ({
  text: 'h', basis, at: 5, question: null,
  decision: { problem: 'Ship it?', brief: 'Tests pass.', context: '- PR 7', options: [{ label: 'Ship', description: 'Merges PR 7' }] },
});

const question = { toolUseId: 'q1', title: 'Which way?', details: 'd', options: [], category: 'plan-problem', askedAt: 1 };
const menu = { toolUseId: 'm1', at: 2, questions: [{ question: 'Colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }] }] };

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
  assert.throws(() => checkDecision(session({ question }), 'q:q0'), /no longer open/);
  assert.throws(() => checkDecision(session({ status: 'working' }), 'q:q1', true), /no longer open/);
  assert.throws(() => checkDecision(session({ summary: summary('t2'), status: 'working' }), 's:t2'), /no longer open/);
  assert.throws(() => checkDecision(session({ summary: summary('t3'), lastTurn: 't3' }), 's:t2'), /no longer open/);
  assert.throws(() => checkDecision(session({ question, menu }), 'q:q1'), /no longer open/);
});

test('with no decision on the page, only a typed reply may meet one read from the end of the turn', () => {
  assert.doesNotThrow(() => checkDecision(session({ summary: summary('t2') }), null, true));
  assert.throws(() => checkDecision(session({ question }), null, true), /asked something meanwhile/);
  assert.throws(() => checkDecision(session({ menu }), null, true), /asked something meanwhile/);
  assert.throws(() => checkDecision(session({ summary: summary('t2') }), null), /asked something meanwhile/);
});

test('a page from before decision keys is told to reload', () => {
  assert.throws(() => checkDecision(session({}), undefined, true), /out of date/);
});
