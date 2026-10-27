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
const WHILE_WORKING_EVERY_MS = 60_000;

const running = new Set<string>();
const failed = new Map<string, number>();

const schema = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    progress: { type: 'array', items: { type: 'string' } },
    learnings: { type: 'array', items: { type: 'string' } },
    decision: {
      type: 'object',
      properties: {
        problem: { type: 'string' },
        brief: { type: 'string' },
        context: { type: 'string' },
        options: {
          type: 'array',
          items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label', 'description'] },
        },
      },
      required: ['problem', 'brief', 'context', 'options'],
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, detail: { type: 'string' }, location: { type: 'string' } },
        required: ['title', 'detail', 'location'],
      },
    },
  },
  required: ['headline', 'progress', 'learnings', 'decision', 'findings'],
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
      const meta = await conversationMeta(s.cwd, s.conversation);
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
  !s.archived && !running.has(s.id) && Date.now() - (failed.get(s.id) ?? 0) >= RETRY_AFTER_MS &&
  (s.status !== 'working' || Date.now() - (s.summary?.at ?? 0) >= WHILE_WORKING_EVERY_MS);

const fresh = (s: Session, latest: string) =>
  s.summary?.basis === latest && s.summary.question === (s.question?.toolUseId ?? null) && !!s.summary.learnings &&
  (!s.summary.decision || s.summary.decision.context !== undefined) && (s.summary.findings !== undefined || s.status === 'exited');

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

const list = (items: string[] | undefined) => items?.map((i) => `- ${i}`).join('\n') || '(none)';

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

Previous headline: ${s.summary?.text ?? '(none yet)'}
Progress so far:
${list(s.summary?.progress)}
Worth knowing so far:
${list(s.summary?.learnings)}

Conversation since then (latest last; earlier parts may be cut):
${transcript}

${question}

Reply with:
- headline: 1 or 2 short sentences of plain text, under 200 characters: where the task stands right now.
- progress: up to 4 short plain-text points on what has been done and what comes next, carried over from the previous list and updated. Concrete (files, results, decisions), no narration, nothing the headline already says.
- learnings: what is worth knowing, carried over from the previous list. Most tasks have nothing here, so return [] unless something clears this bar: a finding the developer would want to hear even if they never looked at this task again, and that they could not have guessed from the task itself. For example: the real cause differs from what was assumed; the plan, ticket or a requirement turned out wrong; a hidden risk, side effect or affected area outside the task; a non-obvious gotcha in the codebase, tooling or environment worth remembering; a result that should change priorities. Never: what was done, routine results, passing tests, plans or next steps, or context that only matters for the open decision (that belongs in its brief). Each point is one or two plain sentences saying what was found and why it matters. Drop a point that turned out wrong or does not clear this bar.
- decision: ${q
    ? 'restate the open question. problem: one plain sentence naming what has to be decided. brief: 2 to 4 sentences of plain text with the context needed to decide and the trade-off, and which way Claude leans. context: "" (Claude\'s own details are shown next to it). options: [].'
    : `if Claude's latest message ends by asking the developer to decide, approve or provide something, fill it in; otherwise leave every field empty. The developer decides from this card alone, without reading the conversation, so it must hold everything they need: never refer to a number, name or item from the conversation without saying what it is.
  - problem: one plain sentence naming what has to be decided.
  - brief: 2 to 4 sentences of plain text: the situation, the trade-off, and which way Claude leans.
  - context: Markdown with the rest of what the decision needs. When the choice is among items, proposals, files or findings in Claude's message, list every one of them with its number if it has one, what it is and why it matters, one tight line each. "" when the brief already says it all.
  - options: each concrete choice Claude offered. label: short button text. description: one plain sentence saying exactly what happens if it is chosen, naming the items it covers rather than only their numbers. [] when Claude needs free text.`}
- findings: when Claude's latest message lists separate findings the developer can act on one by one (the issues a code review found, bugs, risks or problems it reports), one entry per finding, in Claude's order; otherwise []. Never a plan's steps, changes Claude made, or options of a decision. Each finding gets acted on alone by an agent that has not seen the conversation, so each must stand on its own:
  - title: a short plain-text name for it, under 80 characters, without its number.
  - detail: Markdown with everything Claude said about it: what is wrong, why it matters, the scenario and the suggested fix, keeping names of files, functions and symbols in code spans.
  - location: the file and line it points at, as Claude gave it (e.g. "src/a.ts:26"), several separated by ", "; "" when it names none.`;
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
    const options = (Array.isArray(r.decision?.options) ? r.decision.options : [])
      .map((o: any) => ({ label: String(o?.label ?? '').trim(), description: String(o?.description ?? '').trim() || undefined }))
      .filter((o: { label: string }) => o.label);
    const decision = problem || s.question
      ? {
        problem: problem || s.question!.title,
        brief: String(r.decision?.brief ?? '').trim(),
        context: s.question ? '' : String(r.decision?.context ?? '').trim(),
        options: s.question ? [] : options,
      }
      : null;
    const findings = (Array.isArray(r.findings) ? r.findings : [])
      .map((f: any) => ({ title: String(f?.title ?? '').trim(), detail: String(f?.detail ?? '').trim(), location: String(f?.location ?? '').trim() }))
      .filter((f: { title: string }) => f.title);
    // A summary rewritten from the same message keeps what the developer did with its findings.
    if (findings.length && s.findings?.basis !== basis) sessions.update(s.id, { findings: { basis, items: findings } });
    const strings = (v: unknown) => (Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean) : []);
    sessions.update(s.id, { summary: { text, progress: strings(r.progress), learnings: strings(r.learnings), decision, findings: findings.length, question: s.question?.toolUseId ?? null, basis, at: Date.now() } });
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
