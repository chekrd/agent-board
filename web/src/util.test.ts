import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menu, options, question, session, turn } from './testing.ts';
import type { RepoView } from './types.ts';
import { ancestorsOf, attentionChangesAt, attentionOf, clock, decisionOf, descendantsOf, findingPath, menuStuck, modelName, openSubtasks, settledAs, tilde, tildeIn, untilde, worktreeName } from './util.ts';

test('a decision is the open question or end-of-turn choice, and one the board answered is closed at once', () => {
  const asked = session('s', { question: question('q1') });
  assert.deepEqual(decisionOf(asked), { key: 'q:q1', problem: 'Which cart wins?', brief: '', context: 'd', options: options('Keep', 'Merge') });
  assert.equal(decisionOf({ ...asked, answered: { key: 'q:q1', text: 'Keep', at: 5 } }), null);
  const ended = session('s', { summary: turn('t1') });
  assert.equal(decisionOf(ended)?.key, 's:t1');
  assert.equal(decisionOf(ended)?.context, '', 'no last message, no context');
  assert.equal(decisionOf({ ...ended, lastMessage: 'All green. Ship it?' })?.context, 'All green. Ship it?', "Claude's whole last message, not the summarizer's");
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

test('clock shows a time on the 24-hour clock, with the weekday when asked', () => {
  const at = new Date(2026, 9, 26, 14, 5).getTime();
  assert.equal(clock(at), '14:05');
  assert.equal(clock(new Date(2026, 9, 26, 0, 7).getTime()), '00:07');
  assert.match(clock(at, true), /^Mon,? 14:05$/);
});

test('a path under the home folder starts with ~, any other stays whole', () => {
  assert.equal(tilde('/Users/me/git/board', '/Users/me'), '~/git/board');
  assert.equal(tilde('/Users/me', '/Users/me'), '~');
  assert.equal(tilde('/Users/meg/git', '/Users/me'), '/Users/meg/git');
  assert.equal(tilde('/opt/x', ''), '/opt/x');
});

test('a typed path starting with ~ means the home folder', () => {
  assert.equal(untilde('~/code/x', '/Users/me'), '/Users/me/code/x');
  assert.equal(untilde('~', '/Users/me'), '/Users/me');
  assert.equal(untilde('~me/x', '/Users/me'), '~me/x');
  assert.equal(untilde('/opt/x', '/Users/me'), '/opt/x');
});

test('text names the home folder as ~ wherever a path starts there', () => {
  assert.equal(tildeIn('Read /Users/me/git/a.ts and /Users/me', '/Users/me'), 'Read ~/git/a.ts and ~');
  assert.equal(tildeIn('cd "/Users/me/x" && ls /Users/meg /Data/Users/me/y', '/Users/me'), 'cd "~/x" && ls /Users/meg /Data/Users/me/y');
  assert.equal(tildeIn('/Users/me/x', ''), '/Users/me/x');
});

test('a worktree is named by its folder, without the repository folder git-wt puts in it; the main checkout and a removed worktree are none', () => {
  const repo = { path: '/g/board', name: 'board', worktrees: [{ path: '/g/board' }, { path: '/g/worktrees/review/board' }, { path: '/g/worktrees/spike' }] } as RepoView;
  assert.equal(worktreeName('/g/worktrees/review/board', repo), 'review');
  assert.equal(worktreeName('/g/worktrees/spike', repo), 'spike');
  assert.equal(worktreeName('/g/board', repo), 'None');
  assert.equal(worktreeName('/g/worktrees/gone/board', repo), 'None');
  assert.equal(worktreeName('/g/worktrees/x/board', undefined), 'board');
});

test('subtasks nest: the chain up to the root task, the tree under a task, and the finding numbers down to a subtask', () => {
  const sub = (id: string, of: string, finding: number) => session(id, { parent: { id: of, basis: 't1', finding, title: 'f', kind: 'accept', text: '' } });
  const all = [session('review'), sub('a', 'review', 0), sub('a2', 'a', 1), sub('b', 'review', 2), sub('lost', 'gone', 0)];
  assert.deepEqual(ancestorsOf(all, all[2]).map((s) => s.id), ['review', 'a']);
  assert.deepEqual(ancestorsOf(all, all[4]), []);
  assert.deepEqual(descendantsOf(all, 'review').map((d) => `${d.session.id}:${d.depth}`), ['a:1', 'a2:2', 'b:1']);
  assert.equal(findingPath(all, all[2]), '1.2');
  assert.equal(findingPath(all, all[3]), '3');
});

test('a task counts its subtasks still open: a solved or dropped one and everything under it are settled', () => {
  const sub = (id: string, of: string, resolution: 'solved' | 'dropped' | null = null) =>
    session(id, { parent: { id: of, basis: 't1', finding: 0, title: 'f', kind: 'accept', text: '' }, resolution: resolution && { state: resolution, at: 1 } });
  const all = [session('review'), sub('a', 'review', 'solved'), sub('a1', 'a'), sub('b', 'review'), sub('b1', 'b', 'dropped'), sub('b2', 'b')];
  const { open, total } = openSubtasks(all, 'review');
  assert.deepEqual([open.map((s) => s.id), total], [['b', 'b2'], 5]);
  assert.deepEqual(openSubtasks(all, 'b').open.map((s) => s.id), ['b2']);
});

test('a finding settles once rejected or marked solved, or once all its subtasks are solved or dropped, solved if any one was', () => {
  const sub = (resolution: 'solved' | 'dropped' | null) => session('x', { resolution: resolution && { state: resolution, at: 1 } });
  const finding = { title: 'f', detail: '', location: '' };
  assert.equal(settledAs(finding, []), null, 'nothing started on it');
  assert.equal(settledAs(finding, [sub('solved'), sub(null)]), null, 'one still open');
  assert.equal(settledAs(finding, [sub('dropped'), sub('solved')]), 'solved');
  assert.equal(settledAs(finding, [sub('dropped')]), 'dropped');
  assert.equal(settledAs({ ...finding, rejected: { reason: '', at: 1 } }, [sub(null)]), 'rejected');
  assert.equal(settledAs({ ...finding, solved: { at: 1 } }, []), 'solved', 'fixed without a subtask');
});

test('a model id reads as its family and version', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-5-5[1m]'), 'Sonnet 5.5 (1M context)');
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelName('claude-fable-5'), 'Fable 5');
  assert.equal(modelName('opus'), 'opus');
});
