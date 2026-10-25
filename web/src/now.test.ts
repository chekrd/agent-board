import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { clock, snapshot, subscribe } from './now.ts';

const at = (h: number, m: number, s: number) => ((h * 60 + m) * 60 + s) * 1000;

test('a clock reads m:ss, and h:mm:ss from the first hour on', () => {
  assert.equal(clock(0, 0), '0:00');
  assert.equal(clock(0, at(0, 0, 9) + 999), '0:09');
  assert.equal(clock(0, at(0, 59, 59)), '59:59');
  assert.equal(clock(0, at(1, 0, 0)), '1:00:00');
  assert.equal(clock(0, at(1, 2, 5)), '1:02:05');
  assert.equal(clock(at(0, 1, 0), at(26, 1, 0)), '26:00:00');
});

test('a clock whose start lies ahead of the page reads 0:00', () => {
  assert.equal(clock(at(0, 0, 3), 0), '0:00');
});

test('the time ticks while a clock is mounted, and a snapshot taken after the ticker stopped is fresh', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: at(9, 0, 0) });
  const ticks = mock.fn();
  const unsubscribe = subscribe(ticks);
  t.mock.timers.tick(3000);
  assert.equal(ticks.mock.callCount(), 3);
  assert.equal(snapshot(), at(9, 0, 3));
  unsubscribe();
  t.mock.timers.tick(60_500);
  assert.equal(ticks.mock.callCount(), 3, 'no ticker runs once the last clock is gone');
  assert.equal(snapshot(), at(9, 1, 3) + 500);
  t.mock.timers.tick(400);
  assert.equal(snapshot(), at(9, 1, 3) + 500, 'reads within one second agree');
});
