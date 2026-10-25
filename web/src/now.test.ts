import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock } from './now.ts';

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
