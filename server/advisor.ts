import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessions, type Advice, type Session } from './db.ts';
import { headless } from './headless.ts';
import { clip } from './priority.ts';
import { notify, repoView } from './workspace.ts';

const MAX_PARALLEL = 2;
const TIMEOUT_MS = 10 * 60_000;

const READ_ONLY_GIT = ['diff', 'log', 'show', 'status', 'blame'].map((cmd) => `Bash(git ${cmd}:*)`);

const schema = {
  type: 'object',
  properties: {
    choice: { type: 'string', description: 'Exact label of the chosen option, or "" when none fits or there are no options.' },
    answer: { type: 'string' },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
  },
  required: ['choice', 'answer', 'confidence', 'reasoning'],
};

const running = new Set<string>();

// Settings files are not loaded, so allow rules there cannot widen the read-only tools; the model has to be passed instead.
const defaultModel = async () =>
  JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8').catch(() => '{}')).model ?? 'opus';

function needsAdvice(s: Session) {
  const q = s.question;
  if (!q || s.archived || running.has(s.id)) return false;
  return !s.advice || s.advice.toolUseId !== q.toolUseId || s.advice.state === 'thinking';
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

function prompt(s: Session) {
  const q = s.question!;
  const repo = repoView(s.repoId);
  const options = q.options.length
    ? q.options.map((o) => `- ${o.label}${o.recommended ? ' (the agent recommends this)' : ''}${o.description ? `: ${o.description}` : ''}`).join('\n')
    : '(none; answer in free text)';
  return `A coding agent working in this git worktree stopped to ask its developer a question. You are an independent senior engineer giving the developer a second opinion. You have not seen the agent's conversation, so do not take its framing on trust: check the code yourself with Read, Grep, Glob and read-only git (diff against ${repo?.base ?? 'the base branch'}, log, show, status, blame) before deciding. Do not change anything.

Worktree: ${s.worktree}

The task the agent was given:
${clip(s.firstPrompt, 3000) || '(unknown)'}

The agent's last message before asking:
${clip(s.lastMessage, 3000) || '(none)'}

Question (${q.category}): ${q.title}

${q.details}

Options:
${options}

Reply with:
- choice: the exact label of the option you would pick, or "" when no option fits or there are none.
- answer: the reply to send the agent, written as the developer: short, concrete, ready to send as is. Do not repeat the option label; add only what the agent needs beyond it (constraints, the reason, next steps). May be "" when the choice says it all.
- confidence: 0-100, how likely the developer would decide the same. Score low when the decision hinges on product intent, priorities, people or facts outside the repository, or when the agent's question rests on something you could not verify.
- reasoning: one to three sentences for the developer on why, naming what you checked.`;
}

async function advise(s: Session) {
  const toolUseId = s.question!.toolUseId;
  running.add(s.id);
  const thinking: Advice = { toolUseId, state: 'thinking', choice: null, answer: '', confidence: 0, reasoning: '', at: Date.now() };
  sessions.update(s.id, { advice: thinking });
  notify();
  let advice: Advice;
  try {
    const out = await headless(prompt(s), {
      cwd: s.worktree,
      timeoutMs: TIMEOUT_MS,
      args: [
        '--setting-sources', '',
        '--model', await defaultModel(),
        '--tools', 'Read,Grep,Glob,Bash',
        '--allowedTools', ...READ_ONLY_GIT,
        '--disallowedTools', 'Bash(*--output*)', 'Bash(*--ext-diff*)', 'Bash(*--textconv*)',
        '--permission-mode', 'dontAsk',
        '--permission-prompts', 'none',
        '--json-schema', JSON.stringify(schema),
      ],
    });
    const r = out.structured_output;
    if (!r) throw new Error(String(out.result ?? 'no answer').slice(0, 500));
    const labels = s.question!.options.map((o) => o.label);
    advice = {
      ...thinking,
      state: 'done',
      choice: labels.includes(r.choice) ? r.choice : null,
      answer: String(r.answer ?? '').trim(),
      confidence: Math.max(0, Math.min(100, Math.round(Number(r.confidence) || 0))),
      reasoning: String(r.reasoning ?? '').trim(),
      at: Date.now(),
    };
    if (!advice.choice && !advice.answer) throw new Error('the advisor gave an empty answer');
  } catch (err) {
    advice = { ...thinking, state: 'failed', error: (err as Error).message, at: Date.now() };
  } finally {
    running.delete(s.id);
  }
  if (sessions.get(s.id)?.question?.toolUseId === toolUseId) {
    sessions.update(s.id, { advice });
    notify();
  }
  adviseOpen();
}
