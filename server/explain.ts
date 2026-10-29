import { sessions, type Explanation, type Session } from './db.ts';
import { openDecision, type OpenDecision } from './decision.ts';
import { headless } from './headless.ts';
import { clip } from './priority.ts';
import { notify, placeOf } from './workspace.ts';

const MODEL = 'sonnet';
const TIMEOUT_MS = 5 * 60_000;

function prompt(s: Session, d: OpenDecision) {
  const options = d.options.map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ''}`).join('\n');
  return `A developer runs a coding agent (Claude) in ${placeOf(s)}. The agent needs a decision from them, and they asked for a deeper explanation so they can understand the topic before deciding.

The task: ${clip(s.firstPrompt, 2000) || '(unknown)'}

The decision: ${d.title}
${clip(d.details, 6000)}

Choices:
${options || '(none; the developer answers in free text)'}

Claude's latest message:
${clip(s.lastMessage, 4000) || '(none)'}

Read the code involved (you may only read) and explain, in Markdown under 500 words, for someone who knows the codebase less well than the agent does:
- the background: what the relevant part of the system does today and why this decision comes up;
- what each choice would concretely mean: what changes, what it costs, what could go wrong later;
- what the agent assumed that the developer should double-check.
Name the files and functions you looked at. Do not recommend one choice unless the code clearly settles it; then say why. Start directly with the explanation, no preamble.`;
}

export function elaborate(id: string) {
  const s = sessions.get(id);
  if (!s) throw new Error('unknown session');
  const d = openDecision(s);
  if (!d) throw new Error('nothing to decide right now');
  const key = d.key;
  if (s.explanation?.key === key && s.explanation.state !== 'failed') return;
  sessions.update(id, { explanation: { key, state: 'thinking', text: '', at: Date.now() } });
  notify();
  void explain(s, d);
}

async function explain(s: Session, d: OpenDecision) {
  const key = d.key;
  const save = (patch: Partial<Explanation>) => {
    const current = sessions.get(s.id)?.explanation;
    if (current?.key !== key) return;
    sessions.update(s.id, { explanation: { ...current, ...patch, at: Date.now() } });
    notify();
  };
  try {
    const out = await headless(prompt(s, d), {
      cwd: s.worktree,
      timeoutMs: TIMEOUT_MS,
      args: ['--model', MODEL, '--setting-sources', '', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob'],
    });
    const text = String(out.result ?? '').trim();
    if (!text) throw new Error('empty explanation');
    save({ state: 'done', text });
  } catch (err) {
    save({ state: 'failed', error: (err as Error).message });
  }
}
