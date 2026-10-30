import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, SESSIONS_DIR } from './config.ts';
import type { Activity, Menu, TurnError } from './conversations.ts';
import type { DiffStat } from './git.ts';
import type { MenuAnswer } from './menu.ts';
import { migrate } from './migrations.ts';
import { migrateUx, uxStore } from './uxlog.ts';

mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
migrate(db);
mkdirSync(SESSIONS_DIR, { recursive: true });

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
  // The repository's folder name, in a task across a folder of repos; null in a task in one repository.
  repo: string | null;
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
  // How many findings the summary read from its message; absent in summaries written before findings were read.
  findings?: number;
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

// A web link Claude gave in a message: its Markdown text if it had one, the line it stood on, and a few words on what
// it is, written later by a small model ('' when it had none to give). The whole message is kept only until then.
export interface Link {
  url: string;
  text: string | null;
  context: string;
  message?: string;
  about: string | null;
  at: number;
}

// The board's last send to the session; `key` is the decision it closed (a plain message keeps the one before).
export interface Answered {
  key: string | null;
  text: string;
  at: number;
}

export interface Finding {
  title: string;
  detail: string;
  location: string;
  rejected?: { reason: string; at: number } | null;
  solved?: { at: number } | null;
}

// The findings Claude listed in one message, its turn id in `basis`, kept until a later message lists others.
export interface Findings {
  basis: string;
  items: Finding[];
}

export type SubtaskKind = 'accept' | 'elaborate' | 'second-look' | 'reply';

// A subtask's task and the finding it was started from.
// What became of a subtask: solved, or dropped (ignored, rejected, not worth going on with). A resolved subtask leaves
// the queue and stops counting as open on its task.
export interface Resolution {
  state: 'solved' | 'dropped';
  at: number;
}

export interface Parent {
  id: string;
  basis: string;
  finding: number;
  title: string;
  kind: SubtaskKind;
  text: string;
}

// A conversation the task had before a /clear started the one it has now.
export interface EarlierConversation {
  id: string;
  lastMessage: string | null;
  until: number;
}

// What a task was doing when a restart of the Mac killed its Claude. Kept after it is resumed until there is nothing
// left to pick up: a turn cut short stays until Claude works again.
export interface Interrupted {
  at: number;
  status: Exclude<SessionStatus, 'exited'>;
  waitingFor: string | null;
  menu: Menu | null;
}

// A task keeps its id for good; `conversation` is the Claude Code conversation it runs now, which /clear replaces.
export type Priority = 'high' | 'low';

export interface Session {
  id: string;
  conversation: string;
  history: EarlierConversation[];
  // null for a task across a folder of repos, whose `worktree` is its task folder.
  repoId: number | null;
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
  // The developer's own priority for the task, which the ranking weighs with everything else.
  priority: Priority | null;
  diffstat: DiffStat | null;
  lastMessage: string | null;
  lastPrompt: string | null;
  lastTurn: string | null;
  waitingFor: string | null;
  dismissedAsk: string | null;
  advice: Advice | null;
  // Every PR the latest turns opened or watched, oldest first.
  prs: PrFlow[];
  summary: Summary | null;
  explanation: Explanation | null;
  activity: Activity | null;
  menu: Menu | null;
  answered: Answered | null;
  artifacts: Artifact[];
  links: Link[];
  findings: Findings | null;
  parent: Parent | null;
  resolution: Resolution | null;
  model: string | null;
  effort: string | null;
  interrupted: Interrupted | null;
  turnError: TurnError | null;
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
  conversation: r.conversation ?? r.id,
  history: r.history ? JSON.parse(r.history) : [],
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
  priority: r.priority === 'high' || r.priority === 'low' ? r.priority : null,
  diffstat: r.diffstat ? JSON.parse(r.diffstat) : null,
  lastMessage: r.last_message,
  lastPrompt: r.last_prompt ?? null,
  lastTurn: r.last_turn,
  waitingFor: r.waiting_for,
  dismissedAsk: r.dismissed_ask,
  advice: r.advice ? toAdvice(JSON.parse(r.advice)) : null,
  // Stored as one PR before a task could have several.
  prs: r.pr ? [JSON.parse(r.pr)].flat().map((p: PrFlow) => ({ ...p, repo: p.repo ?? null })) : [],
  summary: r.summary ? JSON.parse(r.summary) : null,
  explanation: r.explanation ? JSON.parse(r.explanation) : null,
  activity: r.activity ? JSON.parse(r.activity) : null,
  menu: r.menu ? JSON.parse(r.menu) : null,
  answered: r.answered ? JSON.parse(r.answered) : null,
  artifacts: r.artifacts ? JSON.parse(r.artifacts) : [],
  links: r.links ? JSON.parse(r.links) : [],
  findings: r.findings ? JSON.parse(r.findings) : null,
  parent: r.parent ? JSON.parse(r.parent) : null,
  resolution: r.resolution ? JSON.parse(r.resolution) : null,
  model: r.model,
  effort: r.effort,
  interrupted: r.interrupted ? JSON.parse(r.interrupted) : null,
  turnError: r.turn_error ? JSON.parse(r.turn_error) : null,
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
  priority: 'priority',
  diffstat: 'diffstat',
  lastMessage: 'last_message',
  lastPrompt: 'last_prompt',
  lastTurn: 'last_turn',
  waitingFor: 'waiting_for',
  dismissedAsk: 'dismissed_ask',
  advice: 'advice',
  prs: 'pr',
  summary: 'summary',
  explanation: 'explanation',
  activity: 'activity',
  menu: 'menu',
  answered: 'answered',
  artifacts: 'artifacts',
  links: 'links',
  findings: 'findings',
  parent: 'parent',
  resolution: 'resolution',
  model: 'model',
  effort: 'effort',
  interrupted: 'interrupted',
  turnError: 'turn_error',
  archived: 'archived',
  conversation: 'conversation',
  history: 'history',
  pid: 'pid',
  tty: 'tty',
};

export const sessions = {
  all: () => db.prepare('SELECT * FROM sessions ORDER BY created_at').all().map(toSession),
  get: (id: string) => {
    const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return r ? toSession(r) : undefined;
  },
  byConversation: (conversation: string) => {
    const r = db.prepare('SELECT * FROM sessions WHERE conversation = ?').get(conversation);
    return r ? toSession(r) : undefined;
  },
  insert: (s: Pick<Session, 'id' | 'repoId' | 'worktree' | 'cwd' | 'pid' | 'tty' | 'title' | 'firstPrompt' | 'status'>) => {
    const now = Date.now();
    db.prepare(`INSERT INTO sessions (id, conversation, repo_id, worktree, cwd, pid, tty, title, first_prompt, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, tty = excluded.tty, status = excluded.status, archived = 0, updated_at = excluded.updated_at`)
      .run(s.id, s.id, s.repoId, s.worktree, s.cwd, s.pid, s.tty, s.title, s.firstPrompt, s.status, now, now);
  },
  update: (id: string, patch: Partial<Pick<Session, 'title' | 'firstPrompt' | 'status' | 'question' | 'rank' | 'rankReason' | 'priority' | 'diffstat' | 'lastMessage' | 'lastPrompt' | 'lastTurn' | 'waitingFor' | 'dismissedAsk' | 'advice' | 'prs' | 'summary' | 'explanation' | 'activity' | 'menu' | 'answered' | 'artifacts' | 'links' | 'findings' | 'parent' | 'resolution' | 'model' | 'effort' | 'interrupted' | 'turnError' | 'archived' | 'conversation' | 'history' | 'pid' | 'tty'>>) => {
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

migrateUx(db);

export const uxEvents = uxStore(db);
