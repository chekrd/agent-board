import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ASK_TOOL_NAME, SCRATCH_DIR } from './config.ts';
import { sessions, type Advice, type Session } from './db.ts';
import { addScratchCopy, removeScratchCopy } from './git.ts';
import { headless } from './headless.ts';
import { clip } from './priority.ts';
import { notify, repoView } from './workspace.ts';

const MAX_PARALLEL = 2;
const TIMEOUT_MS = 20 * 60_000;
const ACTIVITY_EVERY_MS = 1000;

const schema = (labels: string[]) => ({
  type: 'object',
  properties: {
    choice: { type: 'string', enum: [...labels, ''], description: 'Label of the chosen option, or "" when none fits.' },
    answer: { type: 'string' },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
  },
  required: ['choice', 'answer', 'confidence', 'reasoning'],
});

const running = new Map<string, AbortController>();

await mkdir(SCRATCH_DIR, { recursive: true });
for (const leftover of await readdir(SCRATCH_DIR)) void removeScratchCopy(join(SCRATCH_DIR, leftover));

function needsAdvice(s: Session) {
  const q = s.question;
  if (!q || s.archived || running.has(s.id)) return false;
  return !s.advice || s.advice.toolUseId !== q.toolUseId || s.advice.state === 'preparing' || s.advice.state === 'thinking';
}

export function adviseOpen() {
  for (const s of sessions.all().filter(needsAdvice)) {
    if (running.size >= MAX_PARALLEL) return;
    void advise(s);
  }
}

export function retryAdvice(id: string) {
  const s = sessions.get(id);
  if (!s?.question) throw new Error('no open question');
  if (running.has(id)) return;
  sessions.update(id, { advice: null });
  adviseOpen();
}

export function stopAdvice(id: string) {
  running.get(id)?.abort();
}

function describe(tool: Record<string, any>, scratch: string) {
  const input = tool.input ?? {};
  const name = String(tool.name).replace(/^mcp__(.+?)__/, '$1: ');
  const detail = input.description ?? input.file_path?.split('/').at(-1) ?? input.pattern ?? input.url ?? input.skill ?? input.command;
  const short = String(detail ?? '').replaceAll(`"${scratch}"`, '.').replaceAll(scratch, '.').replace(/^cd \.\s*&&\s*/, '');
  return clip(short ? `${name} · ${short}` : name, 140);
}

function prompt(s: Session, scratch: string) {
  const q = s.question!;
  const repo = repoView(s.repoId);
  const options = q.options.length
    ? q.options.map((o) => `- ${o.label}${o.recommended ? ' (the agent recommends this)' : ''}${o.description ? `: ${o.description}` : ''}`).join('\n')
    : '(none; answer in free text)';
  return `A coding agent working in this git worktree stopped to ask its developer a question. You are an independent senior engineer giving the developer a second opinion. You have not seen the agent's conversation, so do not take its framing on trust: verify it yourself before deciding: read the code, compare with ${repo?.base ?? 'the base branch'}, and where it helps, try things out.

You are in a scratch copy of the agent's worktree: ${scratch}
It is an APFS clone of ${s.worktree} including uncommitted and ignored files (dependencies, build output), on a detached HEAD. Experiment freely there: change code, run tests, builds, scripts and the app, use the browser and your skills. It is deleted when you finish, so you need not undo your changes there; keep temporary files inside it too, not in /tmp. Stop any server or background process you start. The developer may already run servers, so pick free ports.

Never touch the original worktree ${s.worktree}, and do nothing outward-facing: no pushing, no PRs, no comments or messages to anyone, no changes to shared services or data.

The task the agent was given:
${clip(s.firstPrompt, 3000) || '(unknown)'}

The agent's last message before asking:
${clip(s.lastMessage, 3000) || '(none)'}

Question (${q.category}): ${q.title}

${q.details}

Options:
${options}

Reply with:
- choice: the label of the option you would pick, copied exactly from the list above, or "" when no option fits or there are none.
- answer: the reply to send the agent, written as the developer: short, concrete, ready to send as is. Do not repeat the option label; add only what the agent needs beyond it (constraints, the reason, next steps). May be "" when the choice says it all.
- confidence: 0-100, how likely the developer would decide the same. Score low when the decision hinges on product intent, priorities, people or facts outside the repository, or when the agent's question rests on something you could not verify.
- reasoning: one to three sentences for the developer on why, naming what you checked or tried.`;
}

async function advise(s: Session) {
  const toolUseId = s.question!.toolUseId;
  const controller = new AbortController();
  running.set(s.id, controller);
  const scratch = join(SCRATCH_DIR, `${s.id}-${Date.now()}`);
  let advice: Advice = {
    toolUseId, state: 'preparing', startedAt: Date.now(), activity: 'Cloning the worktree', choice: null, answer: '', confidence: 0, reasoning: '', at: Date.now(),
  };
  const save = (patch: Partial<Advice>) => {
    advice = { ...advice, ...patch };
    if (sessions.get(s.id)?.question?.toolUseId !== toolUseId) return;
    sessions.update(s.id, { advice });
    notify();
  };
  save({});
  let lastActivity = 0;
  try {
    await addScratchCopy(s.worktree, scratch);
    if (controller.signal.aborted) throw new Error('stopped');
    save({ state: 'thinking', activity: 'Starting' });
    const out = await headless(prompt(s, scratch), {
      cwd: scratch,
      timeoutMs: TIMEOUT_MS,
      signal: controller.signal,
      args: [
        '--disallowedTools', ASK_TOOL_NAME, `Edit(/${s.worktree}/**)`, `Write(/${s.worktree}/**)`, 'Bash(git push:*)',
        '--permission-prompts', 'none',
        '--json-schema', JSON.stringify(schema(s.question!.options.map((o) => o.label))),
      ],
      onEvent: (event) => {
        const tool = event.type === 'assistant' && event.message?.content?.findLast?.((b: any) => b.type === 'tool_use');
        if (!tool || Date.now() - lastActivity < ACTIVITY_EVERY_MS) return;
        lastActivity = Date.now();
        save({ activity: describe(tool, scratch) });
      },
    });
    const r = out.structured_output;
    if (!r) throw new Error(String(out.result ?? 'no answer').slice(0, 500));
    const choice = s.question!.options.some((o) => o.label === r.choice) ? r.choice : null;
    const done = {
      state: 'done' as const,
      activity: null,
      choice,
      answer: String(r.answer ?? '').trim(),
      confidence: Math.max(0, Math.min(100, Math.round(Number(r.confidence) || 0))),
      reasoning: String(r.reasoning ?? '').trim(),
      at: Date.now(),
    };
    if (!done.choice && !done.answer) throw new Error('the advisor gave an empty answer');
    save(done);
  } catch (err) {
    save({ state: 'failed', activity: null, error: (err as Error).message, at: Date.now() });
  } finally {
    running.delete(s.id);
    void removeScratchCopy(scratch);
  }
  adviseOpen();
}
