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
  properties: {
    headline: { type: 'string' },
    know: { type: 'array', items: { type: 'string' } },
    decision: {
      type: 'object',
      properties: { problem: { type: 'string' }, brief: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
      required: ['problem', 'brief', 'options'],
    },
  },
  required: ['headline', 'know', 'decision'],
};

let looping = false;
let again = false;

export async function summarizeStale() {
  if (looping) return void (again = true);
  looping = true;
  try {
    for (const { id } of sessions.all()) {
      if (running.size >= MAX_PARALLEL) return;
      const s = sessions.get(id);
      if (!s || !due(s)) continue;
      const meta = await conversationMeta(s.cwd, s.id);
      const latest = meta?.turns.at(-1);
      const current = sessions.get(id);
      if (!latest || latest.role !== 'claude' || !current || !due(current) || fresh(current, latest.id)) continue;
      void summarize(current, meta!.turns);
    }
  } finally {
    looping = false;
    if (again) {
      again = false;
      void summarizeStale();
    }
  }
}

const due = (s: Session) =>
  !s.archived && s.status !== 'working' && s.status !== 'waiting' && !running.has(s.id) && Date.now() - (failed.get(s.id) ?? 0) >= RETRY_AFTER_MS;

const fresh = (s: Session, latest: string) => s.summary?.basis === latest && s.summary.question === (s.question?.toolUseId ?? null);

// Only the turns since the previous summary, so a long session costs the same as a short one. Claude's
// latest message always goes in: it is what any open decision is read from.
function newTurns(turns: Turn[], basis: string | undefined) {
  const from = Math.min(turns.findIndex((t) => t.id === basis) + 1, turns.findLastIndex((t) => t.role === 'claude'));
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
  const q = s.question;
  const question = q
    ? `Claude has formally asked the developer this, and waits for the answer:
Title: ${q.title}
Options: ${q.options.map((o) => o.label).join(' | ') || '(none, free text)'}
Details:
${clip(q.details, 6000)}`
    : 'Claude has no formal question open.';
  return `You brief a developer on a coding task they run with a coding agent (Claude). They run several tasks in parallel and read your briefing instead of the conversation, so it must stand on its own.

Repository: ${repoView(s.repoId)?.name ?? s.worktree}
Task as first given: ${clip(s.firstPrompt, 2000) || '(unknown)'}

Previous briefing: ${s.summary?.text ?? '(none yet)'}
Things to know so far:
${s.summary?.know?.map((k) => `- ${k}`).join('\n') || '(none yet)'}

Conversation since then (latest last; earlier parts may be cut):
${transcript}

${question}

Reply with:
- headline: 1 or 2 short sentences of plain text, under 200 characters: where the task stands right now.
- know: 2 to 5 short plain-text points the developer should know, carried over from the previous list and updated: outcomes, what changed, test or CI results, risks, blockers, surprises. Concrete facts (files, numbers, decisions), no narration, nothing the headline already says.
- decision: ${q
    ? 'restate the open question. problem: one plain sentence naming what has to be decided. brief: 2 to 4 sentences of plain text with the context needed to decide and the trade-off, and which way Claude leans. options: [].'
    : 'if Claude\'s latest message ends by asking the developer to decide, approve or provide something, fill problem (one plain sentence), brief (2 to 4 sentences: context, trade-off, what Claude leans to) and options (the short labels of the concrete choices it offered, or [] when it needs free text). Otherwise all three empty.'}`;
}

async function summarize(s: Session, turns: Turn[]) {
  running.add(s.id);
  const basis = turns.at(-1)!.id;
  try {
    const out = await headless(prompt(s, newTurns(turns, s.summary?.basis)), {
      cwd: DATA_DIR,
      timeoutMs: 120_000,
      args: ['--model', MODEL, '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--json-schema', JSON.stringify(schema)],
    });
    const r = out.structured_output ?? {};
    const text = String(r.headline ?? '').trim();
    if (!text) throw new Error('empty summary');
    if (!sessions.get(s.id)) return;
    const problem = String(r.decision?.problem ?? '').trim();
    const decision = problem || s.question
      ? { problem: problem || s.question!.title, brief: String(r.decision?.brief ?? '').trim(), options: s.question ? [] : (r.decision?.options ?? []).map(String).filter(Boolean) }
      : null;
    const know = (r.know ?? []).map(String).filter(Boolean);
    sessions.update(s.id, { summary: { text, know, decision, question: s.question?.toolUseId ?? null, basis, at: Date.now() } });
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
