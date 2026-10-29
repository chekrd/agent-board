import type { DatabaseSync } from 'node:sqlite';
import type { Session } from './db.ts';
import { openDecision } from './decision.ts';
import type { MenuAnswer } from './menu.ts';

const MAX_EVENTS = 500;
const MAX_DATA = 2000;
const MAX_STRING = 160;
const DAY_MS = 86_400_000;
export const KEEP_DAYS = 180;

export interface UxEvent {
  at: number;
  name: string;
  task: string | null;
  decision: string | null;
  data: string | null;
}

export type Data = Record<string, unknown>;

// Fields that would carry what a task, a question or an answer says. Whatever an event names so is dropped before it
// is stored, from the page or the server alike, so the log keeps ids, kinds, counts and timings only.
export const CONTENT_FIELDS = new Set([
  'text', 'prompt', 'title', 'details', 'answer', 'answers', 'label', 'labels', 'choice', 'question', 'questions', 'reasoning',
  'body', 'description', 'summary', 'brief', 'context', 'problem', 'other', 'options', 'menu', 'message',
]);

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (Array.isArray(value)) return depth > 3 ? null : value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 3) return null;
    return Object.fromEntries(Object.entries(value).filter(([k]) => !CONTENT_FIELDS.has(k)).map(([k, v]) => [k, scrub(v, depth + 1)]));
  }
  return value;
}

const idOf = (v: unknown) => (typeof v === 'string' && /^[\w:.-]{1,128}$/.test(v) ? v : null);

// An event as it may be stored: content fields gone, strings cut short, and the task and decision it is about moved
// out of its data into their own columns, so the saved queries can join on them.
export function cleanEvent(name: string, data: unknown, at: number): UxEvent | null {
  if (!/^[a-z][\w-]{0,63}$/.test(name)) return null;
  const { task, decision, ...rest } = (scrub(data ?? {}) ?? {}) as Data;
  const json = Object.keys(rest).length ? JSON.stringify(rest) : null;
  if (json && json.length > MAX_DATA) return null;
  return { at, name, task: idOf(task), decision: idOf(decision), data: json };
}

// A page's batch: a known shape, bounded sizes, and times near the server's clock, so a page with a wrong clock or a
// bug cannot fill the table or skew the report.
export function cleanBatch(body: unknown, now = Date.now()): { page: string; events: UxEvent[] } | null {
  const { page, events } = (body ?? {}) as { page?: unknown; events?: unknown };
  if (typeof page !== 'string' || !/^[\w-]{1,64}$/.test(page) || !Array.isArray(events)) return null;
  const clean: UxEvent[] = [];
  for (const e of events.slice(0, MAX_EVENTS)) {
    const { at, name, data } = (e ?? {}) as { at?: unknown; name?: unknown; data?: unknown };
    const event = typeof name === 'string' ? cleanEvent(name, data, typeof at === 'number' && Math.abs(at - now) < DAY_MS ? Math.round(at) : now) : null;
    if (event) clean.push(event);
  }
  return { page, events: clean };
}

// Keeps the rows recorded before the server logged its own events: they came from the page.
export function migrateUx(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ux_events (
      at INTEGER NOT NULL,
      page TEXT NOT NULL,
      name TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS ux_events_at ON ux_events(at);
  `);
  const columns = db.prepare('PRAGMA table_info(ux_events)').all().map((c) => c.name);
  if (!columns.includes('source')) db.exec("ALTER TABLE ux_events ADD COLUMN source TEXT NOT NULL DEFAULT 'page'");
  if (!columns.includes('task_id')) db.exec('ALTER TABLE ux_events ADD COLUMN task_id TEXT');
  if (!columns.includes('decision_id')) db.exec('ALTER TABLE ux_events ADD COLUMN decision_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS ux_events_decision ON ux_events(decision_id) WHERE decision_id IS NOT NULL');
}

export function uxStore(db: DatabaseSync) {
  return {
    add: (source: 'page' | 'server', page: string, events: UxEvent[]) => {
      const insert = db.prepare('INSERT INTO ux_events (at, page, name, data, source, task_id, decision_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      db.exec('BEGIN');
      try {
        for (const e of events) insert.run(e.at, page, e.name, e.data, source, e.task, e.decision);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    prune: (before: number) => db.prepare('DELETE FROM ux_events WHERE at < ?').run(before),
  };
}

const kindOf = (key: string) => (key.startsWith('m:') ? 'menu' : key.startsWith('q:') ? 'ask' : 'turn');

const loadOf = (all: Session[]) => ({
  open: all.filter((s) => openDecision(s)).length,
  working: all.filter((s) => s.status === 'working' && !s.archived).length,
});

// How a board answer answered: the option's index, not its label; whether the reply was the second opinion as it
// came, edited from it, or the developer's own; the opinion's confidence.
export function boardAnswer(s: Session, action: string, body: Data, now = Date.now()): Data | null {
  const d = openDecision(s);
  if (!d) return null;
  const advice = s.advice?.state === 'done' && s.advice.key === d.key ? s.advice : null;
  const base = { task: s.id, decision: d.key, kind: kindOf(d.key), waitMs: now - d.askedAt, confidence: advice?.confidence ?? null };
  const indexOf = (label: unknown) => (typeof label === 'string' ? d.options.findIndex((o) => o.label === label) : null);
  if (action === 'dismiss') return { ...base, how: 'dismiss' };
  if (action === 'accept-advice') return { ...base, how: 'advice', option: indexOf(advice?.choice), followed: 'as-is' };
  if (action === 'answer-menu') {
    const picks = ((body.answers ?? []) as MenuAnswer[]).map((a, i) => ({
      picked: a.labels.map((l) => d.menu?.questions[i]?.options.findIndex((o) => o.label === l) ?? -1),
      own: !!a.other?.trim(),
    }));
    return { ...base, how: 'menu', picks };
  }
  if (action !== 'answer') return null;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const files = Array.isArray(body.files) ? body.files.length : 0;
  const how = body.choice ? (text ? 'option-and-text' : 'option') : 'own-text';
  const said = advice ? advice.answer.trim() : '';
  const followed = !advice ? null : text && text === said ? 'as-is' : text && said && text.startsWith(said.slice(0, 40)) ? 'edited' : 'ignored';
  return { ...base, how, option: indexOf(body.choice), files, followed };
}

// Watches the board's sessions for decisions opening and closing and tasks starting and ending. A decision that
// closes after a board answer closed it counts as answered on the board; any other close that leaves the task open
// was answered in its terminal.
export function boardTracker(record: (name: string, data: Data) => void, now = () => Date.now()) {
  const open = new Map<string, { task: string; askedAt: number }>();
  const onBoard = new Set<string>();
  const tasks = new Map<string, Session>();
  let primed = false;

  return {
    // Marked before the answer goes out, as the decision closes on the board before its keys are typed.
    answeredOnBoard: (decision: string) => void onBoard.add(decision),
    unmark: (decision: string) => void onBoard.delete(decision),
    observe(all: Session[]) {
      const load = loadOf(all);
      const byId = new Map(all.map((s) => [s.id, s]));
      const current = new Map<string, Session>();
      for (const s of all) {
        const d = openDecision(s);
        if (!d) continue;
        current.set(d.key, s);
        if (open.has(d.key)) continue;
        open.set(d.key, { task: s.id, askedAt: d.askedAt });
        record('decision-open', { task: s.id, decision: d.key, kind: kindOf(d.key), optionCount: d.menu ? d.menu.questions.length : d.options.length, askedAt: d.askedAt, load });
      }
      for (const [key, o] of open) {
        if (current.has(key)) continue;
        open.delete(key);
        const s = byId.get(o.task);
        const via = onBoard.delete(key) ? 'board' : !s ? 'removed' : s.archived ? 'archived' : s.status === 'exited' ? 'exited' : 'terminal';
        record('decision-close', { task: o.task, decision: key, kind: kindOf(key), via, waitMs: now() - o.askedAt, load });
      }
      for (const s of all) {
        const was = tasks.get(s.id);
        if (!was && primed) record('task-start', { task: s.id, parent: !!s.parent, load });
        if (was && !was.archived && s.archived) record('task-end', { task: s.id, how: 'archived', lifeMs: now() - s.createdAt, prs: s.prs?.length ?? 0 });
        tasks.set(s.id, s);
      }
      for (const [id, s] of tasks) {
        if (byId.has(id)) continue;
        tasks.delete(id);
        if (!s.archived) record('task-end', { task: id, how: 'removed', lifeMs: now() - s.createdAt, prs: s.prs?.length ?? 0 });
      }
      primed = true;
    },
  };
}
