import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact, screenOf } from './ux.ts';

test('a path reads as the screen it shows: the queue, the Wall, or a task on one of its tabs', () => {
  assert.equal(screenOf('/'), 'queue');
  assert.equal(screenOf('/wall'), 'wall');
  assert.equal(screenOf('/s/abc'), 'task/overview');
  assert.equal(screenOf('/s/abc/diff/web/src/App.tsx'), 'task/diff');
});

test('task names in what the board records read as task, the longest name first so one inside another does not leave a part', () => {
  assert.equal(redact('Not sent to cart-api-v2: gone', ['cart-api', 'cart-api-v2']), 'Not sent to task: gone');
  assert.equal(redact('Open cart-api', ['cart-api-v2', 'cart-api']), 'Open task');
});
