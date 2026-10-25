import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { readEntry, watchEntry } from './uiEntry.ts';

// A read per poll, in order; the last one repeats.
function reads(...values: (string | null | Error)[]) {
  let n = 0;
  const read = async () => {
    const value = values[Math.min(n++, values.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  };
  return { read, count: () => n };
}

function watch(t: TestContext, ...values: (string | null | Error)[]) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { read, count } = reads(...values);
  const reported: string[] = [];
  const stop = watchEntry(read, (entry) => void reported.push(entry), 2000);
  t.after(stop);
  const poll = async () => {
    t.mock.timers.tick(2000);
    await flush();
  };
  return { reported, count, stop, poll };
}

test('the entry found at the start is reported at once; a new one once two reads in a row agree, and only once', async (t) => {
  const w = watch(t, 'a.js', 'a.js', 'b.js', 'b.js', 'b.js', 'b.js');
  await flush();
  assert.deepEqual(w.reported, ['a.js']);
  await w.poll();
  await w.poll();
  assert.deepEqual(w.reported, ['a.js'], 'one read of b.js is not enough');
  await w.poll();
  assert.deepEqual(w.reported, ['a.js', 'b.js']);
  await w.poll();
  await w.poll();
  assert.deepEqual([w.reported, w.count()], [['a.js', 'b.js'], 6]);
});

test('a read that finds no entry, or fails, is never reported, and neither is an entry that flaps', async (t) => {
  const w = watch(t, null, null, new Error('EBUSY'), 'a.js', null, 'a.js', 'b.js', 'a.js', 'b.js', 'b.js');
  await flush();
  for (let i = 0; i < 8; i++) await w.poll();
  assert.deepEqual(w.reported, [], 'no two reads in a row agreed yet');
  await w.poll();
  assert.deepEqual(w.reported, ['b.js']);
});

test('a build that leaves the entry as it was reports nothing new; stop ends the polling', async (t) => {
  const w = watch(t, 'a.js', null, null, 'a.js', 'a.js');
  await flush();
  for (let i = 0; i < 4; i++) await w.poll();
  assert.deepEqual(w.reported, ['a.js']);
  w.stop();
  await w.poll();
  assert.equal(w.count(), 5);
});

test('readEntry names the module script of a built index.html, and nothing for a missing or half-written one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-test-'));
  const file = join(dir, 'index.html');
  assert.equal(await readEntry(file), null);
  writeFileSync(file, '<script type="module" crossorigin src="/assets/index-BJD80D25.js"></script>\n<link rel="modulepreload" href="/assets/rolldown-runtime-4tVxZq34.js">');
  assert.equal(await readEntry(file), '/assets/index-BJD80D25.js');
  writeFileSync(file, '<script type="module" crossorigin src="/assets/index-BJ');
  assert.equal(await readEntry(file), null);
});
