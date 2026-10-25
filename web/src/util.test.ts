import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menu, options, question, session, turn } from './testing.ts';
import { attentionChangesAt, attentionOf, decisionOf, menuStuck } from './util.ts';

test('a decision is the open question or end-of-turn choice, and one the board answered is closed at once', () => {
  const asked = session('s', { question: question('q1') });
  assert.deepEqual(decisionOf(asked), { key: 'q:q1', problem: 'Which cart wins?', brief: '', context: 'd', options: options('Keep', 'Merge') });
  assert.equal(decisionOf({ ...asked, answered: { key: 'q:q1', text: 'Keep', at: 5 } }), null);
  const ended = session('s', { summary: turn('t1') });
  assert.equal(decisionOf(ended)?.key, 's:t1');
  assert.equal(decisionOf({ ...ended, answered: { key: 's:t1', text: 'Ship', at: 5 } }), null);
  assert.equal(decisionOf({ ...ended, lastTurn: 't2' }), null, 'read from an older turn');
  assert.equal(decisionOf(session('s', { status: 'waiting', menu: menu('m1') })), null, 'a menu has its own view');
});

test('an ended session with an open question has ended; it is not a decision any more', () => {
  assert.equal(attentionOf(session('s', { status: 'exited', question: question('q1') })), 'exited');
  assert.equal(attentionOf(session('s', { question: question('q1') })), 'decide');
});

test('a menu answered from the board counts as working for 10 s, then needs focus: Claude still shows it', () => {
  const answered = session('s', { status: 'waiting', menu: menu('m1'), answered: { key: 'm:m1', text: 'Backoff: Linear', at: 100_000 } });
  assert.equal(attentionOf(answered, 100_000), 'working');
  assert.equal(attentionOf(answered, 109_999), 'working');
  assert.equal(menuStuck(answered, 109_999), false);
  assert.equal(attentionOf(answered, 110_000), 'focus');
  assert.equal(menuStuck(answered, 110_000), true);
  assert.equal(attentionChangesAt(answered), 110_000);
  const going = { ...answered, status: 'working' as const };
  assert.equal(attentionOf(going, 200_000), 'working', 'Claude went on, so the menu is closed; the transcript lags');
  assert.equal(menuStuck(going, 200_000), false);
  const unanswered = { ...answered, answered: { key: 'q:other', text: 'x', at: 100_000 } };
  assert.equal(attentionOf(unanswered, 100_000), 'decide');
  assert.equal(attentionChangesAt(unanswered), null);
});
