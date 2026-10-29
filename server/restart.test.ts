import assert from 'node:assert/strict';
import { test } from 'node:test';
import { busy, interruption, parseBootTime, pickedUp, prepare, restartState, watch } from './restart.ts';

test('the boot time is read from sysctl kern.boottime, in milliseconds', () => {
  assert.equal(parseBootTime('{ sec = 1793086205, usec = 497711 } Tue Oct 27 08:30:05 2026\n'), 1_793_086_205_000);
  assert.equal(parseBootTime(''), null);
});

test('a task last seen alive before the boot was cut short by the restart, with what it was doing', () => {
  const menu = { toolUseId: 'm1', questions: [], at: 50 };
  const before = { status: 'waiting' as const, updatedAt: 100, waitingFor: 'permission to run Bash', menu };
  assert.deepEqual(interruption(before, 200), { at: 200, status: 'waiting', waitingFor: 'permission to run Bash', menu });
  assert.equal(interruption({ ...before, updatedAt: 300 }, 200), null, 'it ran after the boot, so it ended on its own');
  assert.equal(interruption({ ...before, status: 'exited' }, 200), null, 'it had ended before the restart');
  assert.equal(interruption(before, null), null, 'no boot time, no guess');
});

test('a resumed task is picked up at once when it only waited for you, and once Claude works again otherwise', () => {
  const at = (status: 'working' | 'idle' | 'waiting') => ({ at: 1, status, waitingFor: null, menu: null });
  assert.equal(pickedUp(at('idle'), 'idle'), true);
  assert.equal(pickedUp(at('working'), 'idle'), false);
  assert.equal(pickedUp(at('waiting'), 'idle'), false);
  assert.equal(pickedUp(at('working'), 'working'), true);
});

test('getting ready to restart waits for every turn to end, says so once, and again after a new turn ends', () => {
  const said: number[] = [];
  const say = () => said.push(Date.now());
  const tasks = [{ status: 'working' as const }, { status: 'idle' as const }, { status: 'exited' as const }];
  assert.equal(busy(tasks).length, 1);
  prepare(true, tasks, say);
  assert.equal(restartState().preparing?.safeAt, null);
  assert.equal(watch(tasks, say), false);
  const done = tasks.map(() => ({ status: 'idle' as const }));
  assert.equal(watch(done, say), true);
  assert.equal(said.length, 1);
  assert.equal(watch(done, say), false);
  assert.equal(watch(tasks, say), true, 'a reply you sent started a turn');
  assert.equal(restartState().preparing?.safeAt, null);
  watch(done, say);
  assert.equal(said.length, 2);
  prepare(false, done, say);
  assert.equal(restartState().preparing, null);
  assert.equal(watch(tasks, say), false);
});

test('starting while nothing works is safe at once', () => {
  const said: number[] = [];
  prepare(true, [{ status: 'idle' }], () => said.push(1));
  assert.notEqual(restartState().preparing?.safeAt, null);
  assert.equal(said.length, 1);
  prepare(false, []);
});
