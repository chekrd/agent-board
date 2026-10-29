import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanBatch } from './uxlog.ts';

const NOW = 1_792_000_000_000;

test('a batch keeps its events with their data as JSON; a time far from the server clock becomes the time of arrival', () => {
  const batch = cleanBatch({
    page: 'a1b2-c3', events: [{ at: NOW - 5000, name: 'click', data: { control: 'Undo' } }, { at: 3, name: 'load' }],
  }, NOW);
  assert.deepEqual(batch, {
    page: 'a1b2-c3', events: [{ at: NOW - 5000, name: 'click', data: '{"control":"Undo"}' }, { at: NOW, name: 'load', data: null }],
  });
});

test('a batch without a page or a list of events is refused; an event with a bad name or oversized data is dropped', () => {
  assert.equal(cleanBatch(null, NOW), null);
  assert.equal(cleanBatch({ page: 'x y', events: [] }, NOW), null);
  assert.equal(cleanBatch({ page: 'p', events: {} }, NOW), null);
  const batch = cleanBatch({ page: 'p', events: [{ name: 'DROP TABLE' }, { name: 'ok', data: { big: 'x'.repeat(3000) } }, { name: 'key' }] }, NOW);
  assert.deepEqual(batch?.events.map((e) => e.name), ['key']);
});

test('a batch is cut to 500 events', () => {
  assert.equal(cleanBatch({ page: 'p', events: Array.from({ length: 600 }, () => ({ name: 'click' })) }, NOW)?.events.length, 500);
});
