import { rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { SESSIONS_DIR } from './config.ts';

type Migration = (db: DatabaseSync) => void;

const columnsOf = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));

// Each step runs once, in order, and `PRAGMA user_version` counts the steps a database has had. Add new steps at the
// end; never edit or reorder one that has shipped.
export const migrations: Migration[] = [
  // 1: the schema as it stood when steps were first numbered. A database from before then may be at any earlier shape,
  // so this one step finds out which from its columns; no later step needs to.
  (db) => {
    // Sessions used to be tmux panes; their rows and launch files cannot carry over to Ghostty tabs.
    if (columnsOf(db, 'sessions').includes('tmux')) {
      db.exec('DROP TABLE sessions');
      rmSync(SESSIONS_DIR, { recursive: true, force: true });
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        base_branch TEXT,
        setup_command TEXT,
        worktree_root TEXT,
        hidden INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
        worktree TEXT NOT NULL,
        cwd TEXT NOT NULL,
        pid INTEGER,
        tty TEXT,
        title TEXT,
        first_prompt TEXT,
        status TEXT NOT NULL,
        question TEXT,
        rank INTEGER,
        rank_reason TEXT,
        diffstat TEXT,
        last_message TEXT,
        waiting_for TEXT,
        dismissed_ask TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        advice TEXT, pr TEXT, summary TEXT, explanation TEXT, activity TEXT, menu TEXT, last_turn TEXT, artifacts TEXT,
        answered TEXT, findings TEXT, parent TEXT, resolution TEXT, conversation TEXT, history TEXT, model TEXT,
        effort TEXT, links TEXT, priority TEXT, last_prompt TEXT, interrupted TEXT, turn_error TEXT
      );
      CREATE TABLE IF NOT EXISTS roots (
        path TEXT PRIMARY KEY
      );
    `);
    const sessionColumns = columnsOf(db, 'sessions');
    for (const column of ['advice', 'pr', 'summary', 'explanation', 'activity', 'menu', 'last_turn', 'artifacts', 'answered', 'findings', 'parent', 'resolution', 'conversation', 'history', 'model', 'effort', 'links', 'priority', 'last_prompt', 'interrupted', 'turn_error']) {
      if (!sessionColumns.includes(column)) db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
    }
    db.exec('UPDATE sessions SET conversation = id WHERE conversation IS NULL');
    // A task across a folder of repos has no repository of its own, which the first sessions table did not allow.
    if (db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'repo_id' && c.notnull)) {
      const create = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()!.sql);
      db.exec(`
        ${create.replace(/CREATE TABLE "?sessions"?/, 'CREATE TABLE sessions_nullable').replace(/repo_id INTEGER NOT NULL/, 'repo_id INTEGER')};
        INSERT INTO sessions_nullable SELECT * FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_nullable RENAME TO sessions;
      `);
    }
    if (!columnsOf(db, 'repos').includes('hidden')) db.exec('ALTER TABLE repos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  },
];

export function migrate(db: DatabaseSync, steps = migrations) {
  const done = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (done > steps.length) throw new Error(`the database has had ${done} migrations, more than the ${steps.length} this Pitwall knows`);
  for (let i = done; i < steps.length; i++) {
    db.exec('BEGIN');
    try {
      steps[i](db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
