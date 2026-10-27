import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handOver, leftBy, taskOf } from './handover.ts';

const task = (id: string, o: { conversation?: string; history?: string[]; pid?: number | null; status?: 'idle' | 'exited' } = {}) => ({
  id, conversation: o.conversation ?? id, history: (o.history ?? []).map((h) => ({ id: h, lastMessage: null, until: 0 })),
  pid: o.pid ?? null, status: o.status ?? 'idle',
});

test('a conversation belongs to the task that runs it, or to one that ran it before a /clear', () => {
  const tasks = [task('a', { conversation: 'a2', history: ['a'] }), task('b')];
  assert.equal(taskOf(tasks, 'a2')?.id, 'a');
  assert.equal(taskOf(tasks, 'a')?.id, 'a');
  assert.equal(taskOf(tasks, 'b')?.id, 'b');
  assert.equal(taskOf(tasks, 'c'), undefined);
});

test('the task a Claude left is the live one on its pid whose conversation is no longer live', () => {
  const tasks = [task('a', { pid: 7 }), task('b', { pid: 8 }), task('old', { pid: 7, status: 'exited' })];
  assert.equal(leftBy(tasks, 7, new Set(['new']))?.id, 'a');
  assert.equal(leftBy(tasks, 7, new Set(['a', 'new'])), undefined);
  assert.equal(leftBy(tasks, 9, new Set(['new'])), undefined);
});

test('a hand-over keeps the old conversation as history and drops only what its transcript said', () => {
  const s = { conversation: 'a', history: [], lastMessage: 'Done with the parser.' };
  const patch = handOver(s, 'a2', 5);
  assert.deepEqual(patch.history, [{ id: 'a', lastMessage: 'Done with the parser.', until: 5 }]);
  assert.equal(patch.conversation, 'a2');
  assert.deepEqual([patch.lastMessage, patch.lastTurn, patch.question, patch.menu, patch.summary], [null, null, null, null, null]);
  for (const kept of ['title', 'firstPrompt', 'artifacts', 'findings', 'parent']) assert.ok(!(kept in patch), kept);
  const back = handOver({ conversation: 'a2', history: patch.history, lastMessage: null }, 'a', 9);
  assert.deepEqual(back.history, [{ id: 'a2', lastMessage: null, until: 9 }]);
});
