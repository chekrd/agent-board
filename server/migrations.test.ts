import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate, migrations } from './migrations.ts';

const version = (db: DatabaseSync) => Number(db.prepare('PRAGMA user_version').get()!.user_version);
const columns = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => ({ name: String(c.name), notnull: !!c.notnull }));

test('a new database gets every step and the full schema', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  assert.equal(version(db), migrations.length);
  const sessions = columns(db, 'sessions');
  for (const name of ['conversation', 'turn_error', 'last_prompt', 'priority']) assert.ok(sessions.some((c) => c.name === name), name);
  assert.equal(sessions.find((c) => c.name === 'repo_id')!.notnull, false);
  assert.ok(columns(db, 'repos').some((c) => c.name === 'hidden'));
});

test('a database from before numbered steps keeps its rows and reaches the same schema', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT, setup_command TEXT, worktree_root TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, worktree TEXT NOT NULL,
      cwd TEXT NOT NULL, pid INTEGER, tty TEXT, title TEXT, first_prompt TEXT, status TEXT NOT NULL, question TEXT, rank INTEGER,
      rank_reason TEXT, diffstat TEXT, last_message TEXT, waiting_for TEXT, dismissed_ask TEXT, archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, advice TEXT);
    INSERT INTO repos (id, path) VALUES (1, '/r');
    INSERT INTO sessions (id, repo_id, worktree, cwd, status, created_at, updated_at, advice) VALUES ('s1', 1, '/r', '/r', 'idle', 1, 2, '{}');
  `);
  migrate(db);
  const fresh = new DatabaseSync(':memory:');
  migrate(fresh);
  const names = (d: DatabaseSync, t: string) => columns(d, t).map((c) => c.name).sort();
  assert.deepEqual(names(db, 'sessions'), names(fresh, 'sessions'));
  assert.deepEqual(names(db, 'repos'), names(fresh, 'repos'));
  assert.equal(columns(db, 'sessions').find((c) => c.name === 'repo_id')!.notnull, false);
  const row = db.prepare('SELECT * FROM sessions').get()!;
  assert.equal(row.conversation, 's1');
  assert.equal(row.advice, '{}');
  assert.equal(version(db), migrations.length);
});

test('steps already counted do not run again, and a failed step leaves the database as it was', () => {
  const db = new DatabaseSync(':memory:');
  const runs: number[] = [];
  const steps = [
    (d: DatabaseSync) => {
      runs.push(1);
      d.exec('CREATE TABLE a (x)');
    },
    (d: DatabaseSync) => {
      runs.push(2);
      d.exec('CREATE TABLE b (x)');
      throw new Error('boom');
    },
  ];
  assert.throws(() => migrate(db, steps), /boom/);
  assert.equal(version(db), 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'b'").get()!.n, 0);
  assert.throws(() => migrate(db, steps), /boom/);
  assert.deepEqual(runs, [1, 2, 2]);
  assert.throws(() => migrate(db, []), /more than the 0/);
});
