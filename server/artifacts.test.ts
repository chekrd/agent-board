import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { after, test } from 'node:test';
import { artifactFile, storeArtifacts } from './artifacts.ts';
import { SESSIONS_DIR } from './config.ts';
import type { Session } from './db.ts';

// The account's home from the system, not from HOME: the live board keeps its sessions there.
if (SESSIONS_DIR.startsWith(userInfo().homedir + sep)) {
  throw new Error(`refusing to write artifacts under ${SESSIONS_DIR}, in your own home folder: run the tests with pnpm test, which gives them a fresh HOME`);
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
