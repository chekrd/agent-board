import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, sep } from 'node:path';
import { after, test } from 'node:test';
import { artifactFile, storeArtifacts } from './artifacts.ts';
import { SESSIONS_DIR } from './config.ts';
import type { Session } from './db.ts';

// Only under a HOME that scripts/isolate.ts made: a real folder named by mkdtemp, with TMPDIR inside it. Comparing
// paths with the account's home would let it through under another name, such as /System/Volumes/Data/Users/<name>,
// and an empty HOME leaves every state path relative to the working folder.
const home = process.env.HOME ?? '';
const isolated = isAbsolute(home) && /^pitwall-home-[A-Za-z0-9]{6}$/.test(basename(home)) && process.env.TMPDIR === join(home, 'tmp') &&
  !!lstatSync(home, { throwIfNoEntry: false })?.isDirectory() && SESSIONS_DIR.startsWith(home + sep);
if (!isolated) {
  throw new Error(`refusing to write artifacts under ${SESSIONS_DIR}: HOME (${JSON.stringify(home)}) is not a folder scripts/isolate.ts made; run the tests with pnpm test`);
}

const id = `test-${randomUUID()}`;
after(() => rm(join(SESSIONS_DIR, id), { recursive: true, force: true }));

const session = (artifacts: Session['artifacts']) => ({ id, artifacts }) as Session;
const call = (toolUseId: string, title: string, at: number, html = `<p>${toolUseId}</p>`) => ({ toolUseId, input: { title, html }, at });

test('an artifact is saved once, and a later one with the same title replaces it for good', async () => {
  const first = await storeArtifacts(session([]), [call('a1', 'Flow', 1), call('b1', 'States', 2)]);
  assert.deepEqual(first?.map((a) => a.id), ['a1', 'b1']);
  assert.equal(await readFile(artifactFile(id, 'a1'), 'utf8'), '<p>a1</p>');
  assert.equal(await storeArtifacts(session(first!), [call('a1', 'Flow', 1), call('b1', 'States', 2)]), null);

  const replaced = await storeArtifacts(session(first!), [call('a1', 'Flow', 1), call('b1', 'States', 2), call('a2', 'Flow', 3)]);
  assert.deepEqual(replaced?.map((a) => a.id), ['b1', 'a2']);
  await assert.rejects(readFile(artifactFile(id, 'a1')));
  assert.equal(await storeArtifacts(session(replaced!), [call('a1', 'Flow', 1), call('a2', 'Flow', 3)]), null);
});

test('a call the MCP server would reject is not stored', async () => {
  assert.equal(await storeArtifacts(session([]), [{ toolUseId: 'bad', input: { title: 'No html' }, at: 1 }]), null);
  assert.throws(() => artifactFile(id, '../state'));
});
