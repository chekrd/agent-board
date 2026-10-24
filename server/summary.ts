import { DATA_DIR } from './config.ts';
import { conversationMeta, type Turn } from './conversations.ts';
import { sessions, type Session } from './db.ts';
import { headless } from './headless.ts';
import { clip } from './priority.ts';
import { notify, repoView } from './workspace.ts';

const MODEL = 'sonnet';
const MAX_PARALLEL = 2;
const MAX_CONTEXT = 24_000;
const RETRY_AFTER_MS = 5 * 60_000;

const running = new Set<string>();
const failed = new Map<string, number>();

const schema = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
};

export async function summarizeStale() {
  for (const s of sessions.all()) {
    if (running.size >= MAX_PARALLEL) return;
    if (s.archived || s.status === 'working' || running.has(s.id)) continue;
    if (Date.now() - (failed.get(s.id) ?? 0) < RETRY_AFTER_MS) continue;
    const meta = await conversationMeta(s.cwd, s.id);
    const latest = meta?.turns.at(-1);
    if (!latest || latest.role !== 'claude' || latest.id === s.summary?.basis) continue;
    void summarize(s, meta!.turns);
  }
}

// Only the turns since the previous summary, so a long session costs the same as a short one.
function newTurns(turns: Turn[], basis: string | undefined) {
  const from = turns.findIndex((t) => t.id === basis) + 1;
  const picked: Turn[] = [];
  let size = 0;
  for (const t of turns.slice(from).toReversed()) {
    size += t.text.length;
    if (size > MAX_CONTEXT && picked.length) break;
    picked.unshift(t);
  }
  return picked;
}

function prompt(s: Session, turns: Turn[]) {
  const transcript = turns.map((t) => `[${t.role}]\n${t.text}`).join('\n\n');
  return `You keep a running summary of a coding task that a developer runs with a coding agent (Claude), so the developer can see at a glance where each of their parallel tasks stands.

Repository: ${repoView(s.repoId)?.name ?? s.worktree}
Task as first given: ${clip(s.firstPrompt, 2000) || '(unknown)'}

Summary so far: ${s.summary?.text ?? '(none yet)'}

Conversation since then (latest last; earlier parts may be cut):
${transcript}

Write the updated summary: 2 to 4 short sentences of plain text, no Markdown, under 400 characters. Cover what the task is, what has been done, and where it stands now: what Claude is waiting on or what comes next. Prefer concrete facts (files, decisions, results) over narration, and drop details that no longer matter.`;
}

async function summarize(s: Session, turns: Turn[]) {
  running.add(s.id);
  const basis = turns.at(-1)!.id;
  try {
    const out = await headless(prompt(s, newTurns(turns, s.summary?.basis)), {
      cwd: DATA_DIR,
      timeoutMs: 120_000,
      args: ['--model', MODEL, '--strict-mcp-config', '--tools', '', '--json-schema', JSON.stringify(schema)],
    });
    const text = String(out.structured_output?.summary ?? '').trim();
    if (!text) throw new Error('empty summary');
    if (!sessions.get(s.id)) return;
    sessions.update(s.id, { summary: { text, basis, at: Date.now() } });
    failed.delete(s.id);
    notify();
  } catch (err) {
    failed.set(s.id, Date.now());
    console.warn('summary failed', s.id, err);
  } finally {
    running.delete(s.id);
  }
  void summarizeStale();
}
