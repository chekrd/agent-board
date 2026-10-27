import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderTiles } from './order.ts';
import type { Session } from './types.ts';

const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, repoId: 1, worktree: `/w/${id}`, cwd: `/w/${id}`, pid: 1, tty: '/dev/ttys001', title: id, firstPrompt: null, status: 'idle',
  question: null, rank: null, rankReason: null, diffstat: null, lastMessage: null, lastTurn: 't1', waitingFor: null,
  dismissedAsk: null, advice: null, pr: null, summary: null, explanation: null, activity: null, menu: null, answered: null, artifacts: [], findings: null, parent: null, archived: false,
  createdAt: 0, updatedAt: 0, ...patch,
});

const question = (toolUseId: string) => ({ toolUseId, title: 'Which way?', details: 'd', options: [], category: 'plan-problem', askedAt: 1 });
const endOfTurn = { text: 'h', basis: 't1', at: 1, question: null, decision: { problem: 'Ship it?', brief: 'Tests pass.', options: [{ label: 'Ship' }] } };
const menu = { toolUseId: 'm1', at: 1, questions: [{ question: 'Colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }] }] };

const ids = (list: Session[]) => list.map((s) => s.id);

test('decisions come first by rank, unranked ones last, then Needs focus, Your turn, working and ended', () => {
  const { active } = orderTiles([
    session('ended', { status: 'exited' }),
    session('working', { status: 'working' }),
    session('your-turn'),
    session('needs-focus', { status: 'waiting', waitingFor: 'a permission prompt' }),
    session('unranked', { question: question('q3') }),
    session('second', { rank: 2, summary: endOfTurn }),
    session('first', { rank: 1, status: 'waiting', menu }),
  ]);
  assert.deepEqual(ids(active), ['first', 'second', 'unranked', 'needs-focus', 'your-turn', 'working', 'ended']);
});

test('a decision read from an older turn is not one', () => {
  const { active } = orderTiles([
    session('stale', { rank: 1, summary: endOfTurn, lastTurn: 't2' }),
    session('needs-focus', { status: 'waiting' }),
    session('decision', { question: question('q1'), createdAt: 5 }),
  ]);
  assert.deepEqual(ids(active), ['decision', 'needs-focus', 'stale']);
});

test('the older task comes first among equals', () => {
  const { active } = orderTiles([
    session('newer', { createdAt: 2 }),
    session('older', { createdAt: 1 }),
    session('later-decision', { rank: 1, question: question('q2'), createdAt: 4 }),
    session('earlier-decision', { rank: 1, question: question('q1'), createdAt: 3 }),
  ]);
  assert.deepEqual(ids(active), ['earlier-decision', 'later-decision', 'older', 'newer']);
});

test('archived tasks are listed apart, the most recently changed first', () => {
  const { active, archived } = orderTiles([
    session('old', { archived: true, updatedAt: 1, rank: 1, question: question('q1') }),
    session('live'),
    session('recent', { archived: true, updatedAt: 2, status: 'exited' }),
  ]);
  assert.deepEqual(ids(active), ['live']);
  assert.deepEqual(ids(archived), ['recent', 'old']);
});

test('subtasks leave the Wall to their task, which stands where its most urgent subtask would', () => {
  const parent = (id: string) => ({ id, basis: 't1', finding: 0, title: 'f', kind: 'accept' as const, text: '' });
  const { active, archived } = orderTiles([
    session('review'),
    session('fix', { status: 'working', parent: parent('review') }),
    session('other', { status: 'waiting' }),
    session('ask', { question: question('q1'), parent: parent('review') }),
    session('orphan', { status: 'working', parent: parent('gone') }),
    session('old', { parent: parent('review'), archived: true }),
    session('shelved', { archived: true }),
    session('left', { status: 'working', parent: parent('shelved') }),
  ]);
  assert.deepEqual(ids(active), ['review', 'other', 'orphan', 'left']);
  assert.deepEqual(ids(archived), ['shelved']);
});
