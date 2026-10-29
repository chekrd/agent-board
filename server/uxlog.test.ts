import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runQueries } from '../scripts/ux.ts';
import type { Session } from './db.ts';
import { boardAnswer, boardTracker, cleanBatch, cleanEvent, CONTENT_FIELDS, migrateUx, uxStore, type Data } from './uxlog.ts';

const NOW = 1_792_000_000_000;

const session = (patch: Partial<Session>) => ({
  id: 's1', conversation: 's1', history: [], repoId: 1, worktree: '/w', cwd: '/w', pid: 1, tty: null, title: null, firstPrompt: null, status: 'idle',
  question: null, rank: null, rankReason: null, priority: null, diffstat: null, lastMessage: null, lastPrompt: null, lastTurn: 't2', waitingFor: null,
  dismissedAsk: null, advice: null, prs: [], summary: null, explanation: null, activity: null, menu: null, answered: null, artifacts: [], links: [], findings: null, parent: null, resolution: null, model: null, effort: null, interrupted: null, turnError: null,
  archived: false, createdAt: 0, updatedAt: 0, ...patch,
}) as Session;

const question = (askedAt: number) => ({
  toolUseId: 'toolu_1', title: 'Secret plan for Zephyr', details: 'Zephyr details', category: 'plan-problem', askedAt,
  options: [{ label: 'Ship Zephyr', description: 'Merge the Zephyr branch' }, { label: 'Wait for Zephyr' }],
});

// The server's recording path over a fresh table, with a clock the test moves.
function recorder() {
  const db = new DatabaseSync(':memory:');
  migrateUx(db);
  const store = uxStore(db);
  let now = 0;
  const record = (name: string, data: Data) => {
    const e = cleanEvent(name, data, now);
    if (e) store.add('server', 'server', [e]);
  };
  return { db, store, record, tracker: boardTracker(record, () => now), at: (t: number) => void (now = t) };
}

test('a page batch keeps its events, the task and decision in their own fields; a time far from the server clock becomes the time of arrival', () => {
  const batch = cleanBatch({
    page: 'a1b2-c3', events: [{ at: NOW - 5000, name: 'card-shown', data: { task: 's1', decision: 'q:toolu_1', kind: 'ask' } }, { at: 3, name: 'load' }],
  }, NOW);
  assert.deepEqual(batch, {
    page: 'a1b2-c3', events: [
      { at: NOW - 5000, name: 'card-shown', task: 's1', decision: 'q:toolu_1', data: '{"kind":"ask"}' },
      { at: NOW, name: 'load', task: null, decision: null, data: null },
    ],
  });
});

test('a batch without a page or a list of events is refused; an event with a bad name or oversized data is dropped; at most 500 are kept', () => {
  assert.equal(cleanBatch(null, NOW), null);
  assert.equal(cleanBatch({ page: 'x y', events: [] }, NOW), null);
  assert.equal(cleanBatch({ page: 'p', events: {} }, NOW), null);
  const batch = cleanBatch({ page: 'p', events: [{ name: 'DROP TABLE' }, { name: 'ok', data: { big: Array.from({ length: 20 }, () => 'x'.repeat(150)) } }, { name: 'key' }] }, NOW);
  assert.deepEqual(batch?.events.map((e) => e.name), ['key']);
  assert.equal(cleanBatch({ page: 'p', events: Array.from({ length: 600 }, () => ({ name: 'click' })) }, NOW)?.events.length, 500);
});

test('a decision asked at 1 s and answered on the board at 61 s waited 60 s; its card showed at 31 s, so the decision took 30 s', () => {
  const { db, store, tracker, record, at } = recorder();
  const asked = session({ question: question(1000) });
  at(1000);
  tracker.observe([asked]);
  store.add('page', 'p1', [cleanEvent('card-shown', { task: 's1', decision: 'q:toolu_1', kind: 'ask' }, 31_000)!]);
  at(61_000);
  const answer = boardAnswer(asked, 'answer', { key: 'q:toolu_1', choice: 'Ship Zephyr', text: '' }, 61_000)!;
  tracker.answeredOnBoard('q:toolu_1');
  tracker.observe([session({ question: question(1000), answered: { key: 'q:toolu_1', text: 'Ship Zephyr', at: 61_000 } })]);
  at(63_000);
  record('decision-answer', answer);

  const results = Object.fromEntries(runQueries(db, 0).map((q) => [q.file, q.rows]));
  assert.deepEqual({ ...results['01-wait-time.sql'][0] }, { kind: 'ask', via: 'board', decisions: 1, median_wait_s: 60, p90_wait_s: 60, median_decide_s: 30 });
  assert.deepEqual({ ...results['02-decision-endings.sql'][0] }, { kind: 'ask', via: 'board', how: 'option', decisions: 1, pct_of_kind: 100 });
});

test('a decision that closes without a board answer was answered in the terminal', () => {
  const { db, tracker, at } = recorder();
  at(0);
  tracker.observe([session({ question: question(0) })]);
  at(5000);
  tracker.observe([session({ question: null, status: 'working' })]);
  const [wait] = runQueries(db, 0).find((q) => q.file === '01-wait-time.sql')!.rows;
  assert.equal(wait.via, 'terminal');
  assert.equal(wait.median_wait_s, 5);
});

test('no content reaches the table: question, options, advice and answer text stay out, and so does any content field a page sends', () => {
  const { db, store, tracker, record, at } = recorder();
  const advice = {
    key: 'q:toolu_1', state: 'done' as const, startedAt: 0, activity: null, choice: 'Ship Zephyr', answer: 'Ship Zephyr now, it is ready',
    confidence: 85, reasoning: 'Zephyr tests pass', at: 1,
  };
  const asked = session({ title: 'Zephyr task', question: question(0), advice });
  at(0);
  tracker.observe([]);
  tracker.observe([asked]);
  const answer = boardAnswer(asked, 'answer', { key: 'q:toolu_1', choice: 'Ship Zephyr', text: 'Ship Zephyr now, it is ready, said Zephyr', files: ['/z'] }, 0)!;
  tracker.answeredOnBoard('q:toolu_1');
  at(9000);
  tracker.observe([{ ...asked, answered: { key: 'q:toolu_1', text: 'Ship Zephyr', at: 9000 } }]);
  record('decision-answer', answer);
  tracker.observe([{ ...asked, archived: true }]);
  const batch = cleanBatch({ page: 'p', events: [{ name: 'send', data: { task: 's1', text: 'Zephyr reply', title: 'Zephyr', nested: { prompt: 'Zephyr', ok: 1 }, ownText: true } }] }, NOW)!;
  store.add('page', batch.page, batch.events);

  const rows = db.prepare('SELECT * FROM ux_events').all();
  assert.deepEqual(rows.map((r) => r.name), ['decision-open', 'task-start', 'decision-close', 'decision-answer', 'task-end', 'send']);
  const stored = JSON.stringify(rows);
  assert.ok(!/Zephyr/.test(stored), stored);
  const keys = (v: unknown): string[] => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
  for (const r of rows) for (const k of keys(r.data ? JSON.parse(String(r.data)) : {})) assert.ok(!CONTENT_FIELDS.has(k), `${r.name} carries ${k}`);
  assert.deepEqual(JSON.parse(String(rows[3].data)), { kind: 'ask', waitMs: 0, confidence: 85, how: 'option-and-text', option: 0, files: 1, followed: 'edited' });
});

test('a migration keeps the rows recorded before it, as from the page', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE ux_events (at INTEGER NOT NULL, page TEXT NOT NULL, name TEXT NOT NULL, data TEXT)');
  db.exec(`INSERT INTO ux_events VALUES (1, 'p', 'click', '{"control":"Undo"}')`);
  migrateUx(db);
  migrateUx(db);
  assert.deepEqual({ ...db.prepare('SELECT * FROM ux_events').get() }, { at: 1, page: 'p', name: 'click', data: '{"control":"Undo"}', source: 'page', task_id: null, decision_id: null });
});
