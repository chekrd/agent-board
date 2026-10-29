import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenOf } from './ux.ts';

test('a path reads as the screen it shows: the queue, the Wall, or a task on one of its tabs', () => {
  assert.equal(screenOf('/'), 'queue');
  assert.equal(screenOf('/wall'), 'wall');
  assert.equal(screenOf('/s/abc'), 'task/overview');
  assert.equal(screenOf('/s/abc/diff/web/src/App.tsx'), 'task/diff');
});
