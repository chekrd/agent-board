import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { readEntry, watchEntry } from './uiEntry.ts';

// A read per call, in order; the last one repeats.
function reads(...values: (string | null | Error)[]) {
  let n = 0;
  const read = async () => {
    const value = values[Math.min(n++, values.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  };
  return { read, count: () => n };
}

function watch(t: TestContext, read: () => Promise<string | null>) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reported: string[] = [];
  const ui = watchEntry(read, (entry) => void reported.push(entry), 2000);
  t.after(ui.stop);
  const poll = async () => {
    t.mock.timers.tick(2000);
    await flush();
  };
  return { reported, ui, poll };
}

test('the entry found at the start is reported at once; a new one once two reads in a row agree, and only once', async (t) => {
  const r = reads('a.js', 'a.js', 'b.js', 'b.js', 'b.js', 'b.js');
  const w = watch(t, r.read);
  await flush();
  assert.deepEqual(w.reported, ['a.js']);
  await w.poll();
  await w.poll();
  assert.deepEqual(w.reported, ['a.js'], 'one read of b.js is not enough');
  await w.poll();
  assert.deepEqual(w.reported, ['a.js', 'b.js']);
  await w.poll();
  await w.poll();
  assert.deepEqual([w.reported, r.count()], [['a.js', 'b.js'], 6]);
});

test('a read that finds no entry, or fails, is never reported, and neither is an entry that flaps', async (t) => {
  const w = watch(t, reads(null, null, new Error('EBUSY'), 'a.js', null, 'a.js', 'b.js', 'a.js', 'b.js', 'b.js').read);
  await flush();
  for (let i = 0; i < 8; i++) await w.poll();
  assert.deepEqual(w.reported, [], 'no two reads in a row agreed yet');
  await w.poll();
  assert.deepEqual(w.reported, ['b.js']);
});

test('a build that leaves the entry as it was reports nothing new; stop ends the polling', async (t) => {
  const r = reads('a.js', null, null, 'a.js', 'a.js');
  const w = watch(t, r.read);
  await flush();
  for (let i = 0; i < 4; i++) await w.poll();
  assert.deepEqual(w.reported, ['a.js']);
  w.ui.stop();
  await w.poll();
  assert.equal(r.count(), 5);
});

test('settled() names the entry reported only while the polls still find it', async (t) => {
  const w = watch(t, reads(null, 'a.js', 'a.js', 'b.js', 'a.js', null, 'b.js', 'b.js').read);
  const settled: (string | null)[] = [];
  await flush();
  settled.push(w.ui.settled());
  for (let i = 0; i < 7; i++) {
    await w.poll();
    settled.push(w.ui.settled());
  }
  assert.deepEqual(settled, [null, null, 'a.js', null, 'a.js', null, null, 'b.js']);
  assert.deepEqual(w.reported, ['a.js', 'b.js']);
});

test('a fresh read that finds another entry, or none, empties settled() until the polls agree again, and never counts as a poll', async (t) => {
  let disk: string | null = 'a.js';
  const w = watch(t, async () => disk);
  await flush();
  disk = 'b.js';
  assert.equal(await w.ui.fresh(), 'b.js');
  assert.equal(w.ui.settled(), null);
  await w.poll();
  assert.deepEqual([w.reported, w.ui.settled()], [['a.js'], null], 'a fresh read and one poll are not two polls');
  await w.poll();
  assert.deepEqual([w.reported, w.ui.settled()], [['a.js', 'b.js'], 'b.js']);

  disk = null;
  assert.equal(await w.ui.fresh(), null);
  assert.equal(w.ui.settled(), null, 'the file is gone, as while a build writes it');
  disk = 'b.js';
  await w.poll();
  assert.equal(w.ui.settled(), 'b.js');

  disk = 'c.js';
  await w.poll();
  disk = 'b.js';
  assert.equal(await w.ui.fresh(), 'b.js');
  assert.equal(w.ui.settled(), null, 'a fresh read of the entry taken does not overrule a poll that found another');
  await w.poll();
  assert.deepEqual([w.reported, w.ui.settled()], [['a.js', 'b.js'], 'b.js']);
});

function indexFile(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'index.html');
}

test('readEntry names the module script of a built index.html, and nothing for a missing or half-written one', async (t) => {
  const file = indexFile(t);
  assert.equal(await readEntry(file), null);
  writeFileSync(file, '<script type="module" crossorigin src="/assets/index-BJD80D25.js"></script>\n<link rel="modulepreload" href="/assets/rolldown-runtime-4tVxZq34.js">');
  assert.equal(await readEntry(file), '/assets/index-BJD80D25.js');
  writeFileSync(file, '<script type="module" crossorigin src="/assets/index-BJ');
  assert.equal(await readEntry(file), null);
  writeFileSync(file, '<script type="module" crossorigin src="/assets/index-BJD80D25.js">');
  assert.equal(await readEntry(file), null, 'its end tag is not written yet');
});

test('readEntry names the first module script with a src, as the page does, whatever comes before it', async (t) => {
  const file = indexFile(t);
  const entry = '<script type="module" crossorigin src="/assets/index-BJD80D25.js"></script>';
  for (const [before, what] of [
    ['<script src="/assets/legacy-polyfills-C1x2.js"></script>', 'a classic script with a src'],
    ['<script type="text/javascript" src="/assets/analytics-E5f6.js"></script>', 'a script of another type with a src'],
    [`<script>window.started = Date.now()</script><script type="module">import '/assets/boot-D3v4.js'</script>`, 'scripts with no src'],
    ['<!-- <script type="module" src="/assets/index-old.js"></script> -->', 'a module script in a comment'],
    [`<script>document.write('<script type="module" src="/assets/fake.js"><\\/script>')</script>`, 'a module script in the text of another'],
  ]) {
    writeFileSync(file, `${before}\n${entry}`);
    assert.equal(await readEntry(file), '/assets/index-BJD80D25.js', what);
  }
  writeFileSync(file, `<SCRIPT TYPE=Module data-note="src=x.js" SRC='/assets/index-BJD80D25.js'></SCRIPT>`);
  assert.equal(await readEntry(file), '/assets/index-BJD80D25.js', 'names in any case, values quoted or not');
});
