import { mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, SESSIONS_DIR } from './config.ts';
import type { Activity, Menu } from './conversations.ts';
import type { DiffStat } from './git.ts';
import type { MenuAnswer } from './menu.ts';

mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Sessions used to be tmux panes; their rows and launch files cannot carry over to Ghostty tabs.
const oldSessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
if (oldSessionColumns.includes('tmux')) {
  db.exec('DROP TABLE sessions');
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
}
mkdirSync(SESSIONS_DIR, { recursive: true });

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
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
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
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS roots (
    path TEXT PRIMARY KEY
  );
`);

const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
for (const column of ['advice', 'pr', 'summary', 'explanation', 'activity', 'menu', 'last_turn', 'artifacts']) if (!sessionColumns.includes(column)) db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);

const repoColumns = db.prepare('PRAGMA table_info(repos)').all().map((c) => c.name);
if (!repoColumns.includes('hidden')) db.exec('ALTER TABLE repos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');

export interface Repo {
  id: number;
  path: string;
  baseBranch: string | null;
  setupCommand: string | null;
  worktreeRoot: string | null;
}

export type SessionStatus = 'working' | 'idle' | 'waiting' | 'exited';

export interface QuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface Question {
  toolUseId: string;
  title: string;
  details: string;
  options: QuestionOption[];
  category: string;
  askedAt: number;
}

export interface Advice {
  key: string;
  state: 'thinking' | 'done' | 'failed';
  startedAt: number;
  activity: string | null;
  choice: string | null;
  answer: string;
  confidence: number;
  reasoning: string;
  answers?: MenuAnswer[];
  error?: string;
  at: number;
}

export interface PrFlow {
  id: number | null;
  url: string | null;
  result: string | null;
  watching: boolean;
  at: number;
}

export interface Decision {
  problem: string;
  brief: string;
  context?: string;
  options: QuestionOption[];
}

export interface Summary {
  text: string;
  progress?: string[];
  learnings?: string[];
  decision?: Decision | null;
  question?: string | null;
  basis: string;
  at: number;
}

export interface Explanation {
  key: string;
  state: 'thinking' | 'done' | 'failed';
  text: string;
  error?: string;
  at: number;
}

export interface Artifact {
  id: string;
  title: string;
  at: number;
}

export interface Session {
  id: string;
  repoId: number;
  worktree: string;
  cwd: string;
  pid: number | null;
  tty: string | null;
  title: string | null;
  firstPrompt: string | null;
  status: SessionStatus;
  question: Question | null;
  rank: number | null;
  rankReason: string | null;
  diffstat: DiffStat | null;
  lastMessage: string | null;
  lastTurn: string | null;
  waitingFor: string | null;
  dismissedAsk: string | null;
  advice: Advice | null;
  pr: PrFlow | null;
  summary: Summary | null;
  explanation: Explanation | null;
  activity: Activity | null;
  menu: Menu | null;
  artifacts: Artifact[];
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

// Advice stored before menus and end-of-turn decisions got one was keyed by the ask_human call.
const toAdvice = (a: Row): Advice => (a.key ? a : { ...a, key: `q:${a.toolUseId}` }) as Advice;

const toSession = (r: Row): Session => ({
  id: r.id,
  repoId: r.repo_id,
  worktree: r.worktree,
  cwd: r.cwd,
  pid: r.pid,
  tty: r.tty,
  title: r.title,
  firstPrompt: r.first_prompt,
  status: r.status,
  question: r.question ? JSON.parse(r.question) : null,
  rank: r.rank,
  rankReason: r.rank_reason,
  diffstat: r.diffstat ? JSON.parse(r.diffstat) : null,
  lastMessage: r.last_message,
  lastTurn: r.last_turn,
  waitingFor: r.waiting_for,
  dismissedAsk: r.dismissed_ask,
  advice: r.advice ? toAdvice(JSON.parse(r.advice)) : null,
  pr: r.pr ? JSON.parse(r.pr) : null,
  summary: r.summary ? JSON.parse(r.summary) : null,
  explanation: r.explanation ? JSON.parse(r.explanation) : null,
  activity: r.activity ? JSON.parse(r.activity) : null,
  menu: r.menu ? JSON.parse(r.menu) : null,
  artifacts: r.artifacts ? JSON.parse(r.artifacts) : [],
  archived: !!r.archived,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const roots = {
  all: () => db.prepare('SELECT path FROM roots ORDER BY path').all().map((r) => String(r.path)),
  add: (path: string) => db.prepare('INSERT OR IGNORE INTO roots (path) VALUES (?)').run(path),
  remove: (path: string) => db.prepare('DELETE FROM roots WHERE path = ?').run(path),
};

export const repos = {
  all: () => db.prepare('SELECT * FROM repos WHERE hidden = 0 ORDER BY path').all().map(toRepo),
  get: (id: number) => {
    const r = db.prepare('SELECT * FROM repos WHERE id = ?').get(id);
    return r ? toRepo(r) : undefined;
  },
  add: (path: string) =>
    Number(db.prepare('INSERT INTO repos (path) VALUES (?) ON CONFLICT(path) DO UPDATE SET hidden = 0 RETURNING id').get(path)!.id),
  addFound: (path: string) => db.prepare('INSERT OR IGNORE INTO repos (path) VALUES (?)').run(path).changes > 0,
  update: (id: number, patch: Partial<Pick<Repo, 'baseBranch' | 'setupCommand' | 'worktreeRoot'>>) => {
    const cur = repos.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    db.prepare('UPDATE repos SET base_branch = ?, setup_command = ?, worktree_root = ? WHERE id = ?')
      .run(next.baseBranch || null, next.setupCommand || null, next.worktreeRoot || null, id);
  },
  // Hidden rather than deleted so a rescan of its root does not bring it back.
  hide: (id: number) => {
    db.prepare('DELETE FROM sessions WHERE repo_id = ?').run(id);
    db.prepare('UPDATE repos SET hidden = 1 WHERE id = ?').run(id);
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
  lastMessage: 'last_message',
  lastTurn: 'last_turn',
  waitingFor: 'waiting_for',
  dismissedAsk: 'dismissed_ask',
  advice: 'advice',
  pr: 'pr',
  summary: 'summary',
  explanation: 'explanation',
  activity: 'activity',
  menu: 'menu',
  artifacts: 'artifacts',
  archived: 'archived',
  pid: 'pid',
  tty: 'tty',
};

export const sessions = {
  all: () => db.prepare('SELECT * FROM sessions ORDER BY created_at').all().map(toSession),
  get: (id: string) => {
    const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return r ? toSession(r) : undefined;
  },
  insert: (s: Pick<Session, 'id' | 'repoId' | 'worktree' | 'cwd' | 'pid' | 'tty' | 'title' | 'firstPrompt' | 'status'>) => {
    const now = Date.now();
    db.prepare(`INSERT INTO sessions (id, repo_id, worktree, cwd, pid, tty, title, first_prompt, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, tty = excluded.tty, status = excluded.status, archived = 0, updated_at = excluded.updated_at`)
      .run(s.id, s.repoId, s.worktree, s.cwd, s.pid, s.tty, s.title, s.firstPrompt, s.status, now, now);
  },
  update: (id: string, patch: Partial<Pick<Session, 'title' | 'firstPrompt' | 'status' | 'question' | 'rank' | 'rankReason' | 'diffstat' | 'lastMessage' | 'lastTurn' | 'waitingFor' | 'dismissedAsk' | 'advice' | 'pr' | 'summary' | 'explanation' | 'activity' | 'menu' | 'artifacts' | 'archived' | 'pid' | 'tty'>>) => {
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
