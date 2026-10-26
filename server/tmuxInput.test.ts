import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { PartlyTyped } from './ghostty.ts';
import { keys, paste, type Tmux } from './tmuxInput.ts';

const run = promisify(execFile);

const missing = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return false;
  } catch {
    return 'tmux is not installed';
  }
})();

// Turns on bracketed paste, as Claude Code does, and keeps every byte the pane receives.
const READER = `const fs = require('node:fs');
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h');
process.stdin.on('data', (d) => fs.appendFileSync(process.argv[2], d));`;

async function until<T>(what: string, poll: () => Promise<T | null>) {
  for (const started = Date.now(); Date.now() - started < 5000; await sleep(50)) {
    const value = await poll();
    if (value !== null) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A tmux server of the test's own, on a socket in its temporary folder, never Agent Board's or the default one.
async function pane(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-'));
  const reader = join(dir, 'reader.cjs');
  const log = join(dir, 'log');
  writeFileSync(reader, READER);
  writeFileSync(log, '');
  const tmux: Tmux = async (args, input) => {
    const running = run('tmux', ['-S', join(dir, 's'), '-f', '/dev/null', ...args]);
    running.child.stdin?.on('error', () => {});
    if (input !== undefined) running.child.stdin?.end(input);
    return (await running).stdout;
  };
  t.after(async () => {
    await tmux(['kill-server']).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await tmux(['new-session', '-d', '-s', 'T', '-x', '200', '-y', '50', process.execPath, reader, log]);
  await until('the pane to ask for bracketed paste', async () =>
    String(await tmux(['display-message', '-p', '-t', '=T:', '#{bracket_paste_flag}'])).trim() === '1' || null);
  const received = (expected: string) =>
    until(`${Buffer.byteLength(expected)} bytes in the pane`, async () => {
      const got = readFileSync(log);
      return got.length >= Buffer.byteLength(expected) ? got.toString('utf8') : null;
    });
  return { tmux, received };
}

test('a paste reaches the pane whole, inside its markers: a leading -, a trailing ; and 36 KB of text in Czech', { skip: missing }, async (t) => {
  const { tmux, received } = await pane(t);
  const long = `${'ž'.repeat(18_000)};`;
  await paste(tmux, 'T', '--force is fine;');
  await paste(tmux, 'T', long);
  const expected = `\x1b[200~--force is fine;\x1b[201~\x1b[200~${long}\x1b[201~`;
  assert.ok((await received(expected)) === expected, 'the pane got the pastes as written');
});

test('text among keys is typed as written, without paste markers: a leading - and a trailing ;', { skip: missing }, async (t) => {
  const { tmux, received } = await pane(t);
  await keys(tmux, 'T', [{ key: 'arrow_down' }, { text: '-1 week is fine;' }, { key: 'enter' }, { text: '-> keep the cache' }]);
  const expected = '\x1b[B-1 week is fine;\r-> keep the cache';
  assert.equal(await received(expected), expected);
});

test('keys that fail once one has gone in are PartlyTyped; a failure at the first key is the error itself', async () => {
  const failingAt = (call: number): Tmux => {
    let calls = 0;
    return async () => {
      if (calls++ === call) throw new Error('can\'t find pane: T');
    };
  };
  const strokes = [{ key: 'arrow_down' }, { text: 'Purple' }, { key: 'enter' }];
  await assert.rejects(keys(failingAt(0), 'T', strokes), (err) => !(err instanceof PartlyTyped) && /can't find pane/.test(String(err)));
  await assert.rejects(keys(failingAt(1), 'T', strokes), (err) => err instanceof PartlyTyped && /after 1 of 3 keys/.test(err.message));
});
