import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, SESSIONS_DIR } from './config.ts';
import type { DiffStat } from './git.ts';

mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    base_branch TEXT,
    setup_command TEXT,
    worktree_root TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    worktree TEXT NOT NULL,
    tmux TEXT NOT NULL,
    title TEXT,
    first_prompt TEXT,
    status TEXT NOT NULL,
    question TEXT,
    rank INTEGER,
    rank_reason TEXT,
    diffstat TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export interface Repo {
  id: number;
  path: string;
  baseBranch: string | null;
  setupCommand: string | null;
  worktreeRoot: string | null;
}

export type SessionKind = 'claude' | 'shell';
export type SessionStatus = 'working' | 'idle' | 'permission' | 'exited';

export interface QuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface Question {
  title: string;
  details: string;
  options: QuestionOption[];
  category: string;
  askedAt: number;
}

export interface Session {
  id: string;
  kind: SessionKind;
  repoId: number;
  worktree: string;
  tmux: string;
  title: string | null;
  firstPrompt: string | null;
  status: SessionStatus;
  question: Question | null;
  rank: number | null;
  rankReason: string | null;
  diffstat: DiffStat | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, any>;

const toRepo = (r: Row): Repo => ({
  id: r.id,
  path: r.path,
  baseBranch: r.base_branch,
  setupCommand: r.setup_command,
  worktreeRoot: r.worktree_root,
});

const toSession = (r: Row): Session => ({
  id: r.id,
  kind: r.kind,
  repoId: r.repo_id,
  worktree: r.worktree,
  tmux: r.tmux,
  title: r.title,
  firstPrompt: r.first_prompt,
  status: r.status,
  question: r.question ? JSON.parse(r.question) : null,
  rank: r.rank,
  rankReason: r.rank_reason,
  diffstat: r.diffstat ? JSON.parse(r.diffstat) : null,
  archived: !!r.archived,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const repos = {
  all: () => db.prepare('SELECT * FROM repos ORDER BY path').all().map(toRepo),
  get: (id: number) => {
    const r = db.prepare('SELECT * FROM repos WHERE id = ?').get(id);
    return r ? toRepo(r) : undefined;
  },
  add: (path: string) =>
    Number(db.prepare('INSERT INTO repos (path) VALUES (?) ON CONFLICT(path) DO UPDATE SET path = path RETURNING id').get(path)!.id),
  update: (id: number, patch: Partial<Pick<Repo, 'baseBranch' | 'setupCommand' | 'worktreeRoot'>>) => {
    const cur = repos.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    db.prepare('UPDATE repos SET base_branch = ?, setup_command = ?, worktree_root = ? WHERE id = ?')
      .run(next.baseBranch || null, next.setupCommand || null, next.worktreeRoot || null, id);
  },
  remove: (id: number) => {
    db.prepare('DELETE FROM sessions WHERE repo_id = ?').run(id);
    db.prepare('DELETE FROM repos WHERE id = ?').run(id);
  },
};

const columns: Record<string, string> = {
  title: 'title',
  firstPrompt: 'first_prompt',
  status: 'status',
  question: 'question',
  rank: 'rank',
  rankReason: 'rank_reason',
  diffstat: 'diffstat',
  archived: 'archived',
};

export const sessions = {
  all: () => db.prepare('SELECT * FROM sessions ORDER BY created_at').all().map(toSession),
  get: (id: string) => {
    const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return r ? toSession(r) : undefined;
  },
  insert: (s: Pick<Session, 'id' | 'kind' | 'repoId' | 'worktree' | 'tmux' | 'title' | 'firstPrompt' | 'status'>) => {
    const now = Date.now();
    db.prepare(`INSERT INTO sessions (id, kind, repo_id, worktree, tmux, title, first_prompt, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, s.kind, s.repoId, s.worktree, s.tmux, s.title, s.firstPrompt, s.status, now, now);
  },
  update: (id: string, patch: Partial<Pick<Session, 'title' | 'firstPrompt' | 'status' | 'question' | 'rank' | 'rankReason' | 'diffstat' | 'archived'>>) => {
    const entries = Object.entries(patch);
    if (!entries.length) return;
    const sets = entries.map(([k]) => `${columns[k]} = ?`).join(', ');
    const values = entries.map(([, v]) =>
      v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v);
    db.prepare(`UPDATE sessions SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
  },
  remove: (id: string) => db.prepare('DELETE FROM sessions WHERE id = ?').run(id),
  removeByWorktree: (worktree: string) => db.prepare('DELETE FROM sessions WHERE worktree = ?').run(worktree),
};
