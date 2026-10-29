import { sessions, type Finding, type Parent, type Session, type SubtaskKind } from './db.ts';
import { Refusal } from './decision.ts';
import { clip } from './priority.ts';
import { startClaude } from './sessions.ts';
import { notify, placeOf, repoView } from './workspace.ts';

export type Response = SubtaskKind | 'reject' | 'solve' | 'reopen';

const KINDS: Response[] = ['accept', 'elaborate', 'second-look', 'reply', 'reject', 'solve', 'reopen'];

const LABELS: Record<SubtaskKind, string> = { accept: 'Fix', elaborate: 'Explain', 'second-look': 'Second look', reply: 'Reply' };

const ASKS: Record<SubtaskKind, string> = {
  accept: `The developer accepted this finding. Check it against the code first. If it holds, fix it, add or update a test where the project has tests for that code, and run the checks that cover your change. If it turns out wrong, change nothing and say why.`,
  elaborate: `The developer wants to understand this finding before deciding on it. Read the code involved and explain, for someone who knows this part of the codebase less well than the reviewer: what the code does today, why this is or is not a problem, what a fix would change and what it could break. Name the files and functions you read. Do not change any files.`,
  'second-look': `The developer wants an independent second look at this finding before acting on it. Do not take it on trust: read the code, compare with the base branch, and try it out where you can without changing files here. End with a verdict, real, not real or unsure, and the evidence for it. Do not change any files.`,
  reply: `The developer answered this finding as below. Act on their answer.`,
};

const SHARED = `Other agents work on other findings in this same worktree (or task folder) at the same time. Change only what your finding needs; leave changes you did not make alone (do not revert, reformat, stage or commit them), and do not commit or push unless the developer asks.`;

export function subtaskPrompt(s: Session, n: number, f: Finding, kind: SubtaskKind, text: string) {
  const repo = repoView(s.repoId);
  const answer = text.trim();
  return `You take on one finding from a review of the work in ${s.repoId === null ? placeOf(s) : `this git worktree (${s.worktree}${repo ? `, repository ${repo.name}, base branch ${repo.base}` : ''})`}. The review ran in another session, which you have not seen; this message holds what you need.

The task the review was given: ${clip(s.firstPrompt, 2000) || '(unknown)'}

Finding ${n}: ${f.title}${f.location ? `\nWhere: ${f.location}` : ''}

${f.detail}

${ASKS[kind]}${answer ? `\n\nThe developer's ${kind === 'reply' ? 'answer' : 'note'}: ${answer}` : ''}

${SHARED}`;
}

const mark = (kind: 'reject' | 'solve' | 'reopen', reason: string) => ({
  rejected: kind === 'reject' ? { reason, at: Date.now() } : null,
  solved: kind === 'solve' ? { at: Date.now() } : null,
});

export const subtaskTitle = (n: number, f: Finding, kind: SubtaskKind) => clip(`#${n} ${LABELS[kind]} · ${f.title}`, 120);

// Reject, Solve and Reopen only mark the finding; every other response starts a subtask on it.
export async function respond(id: string, body: { basis?: unknown; finding?: unknown; kind?: unknown; text?: unknown }) {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session ${id}`);
  const kind = body.kind as Response;
  if (!KINDS.includes(kind)) throw new Error('unknown response');
  const index = Number(body.finding);
  const f = s.findings?.items[index];
  if (!s.findings || s.findings.basis !== body.basis || !f) throw new Refusal('these findings were replaced; read them again', 'stale');
  const text = String(body.text ?? '').trim().slice(0, 4000);
  if (kind === 'reject' || kind === 'solve' || kind === 'reopen') {
    const items = s.findings.items.map((x, i) => (i === index ? { ...x, ...mark(kind, text) } : x));
    sessions.update(id, { findings: { ...s.findings, items } });
    notify();
    return null;
  }
  if (kind === 'reply' && !text) throw new Error('write an answer first');
  const n = index + 1;
  const parent: Parent = { id, basis: s.findings.basis, finding: index, title: f.title, kind, text };
  return startClaude({ repoId: s.repoId, worktree: s.worktree, prompt: subtaskPrompt(s, n, f, kind, text), title: subtaskTitle(n, f, kind), parent });
}
