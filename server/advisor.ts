import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ASK_TOOL_NAME, OPEN_WORKTREE_TOOL_NAME, ORIGIN, SCRATCH_DIR } from './config.ts';
import { sessions, type Advice, type Session } from './db.ts';
import { describeTool } from './conversations.ts';
import { openDecision, type OpenDecision } from './decision.ts';
import { quote } from './env.ts';
import { addScratchCopies, addScratchCopy, removeScratchCopy } from './git.ts';
import { headless } from './headless.ts';
import { menuKeystrokes } from './menu.ts';
import { clip, scheduleRerank } from './priority.ts';
import { notify, placeOf, repoView, taskWorktrees } from './workspace.ts';

const MODEL = 'opus';
const MAX_PARALLEL = 2;
const TIMEOUT_MS = 20 * 60_000;
const ACTIVITY_EVERY_MS = 1000;

const MCP_NAME = 'pitwall-advisor';
const SCRATCH_TOOL = 'scratch_copy';

const guard = {
  hooks: {
    PreToolUse: [{ matcher: 'mcp__.*', hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(join(import.meta.dirname, 'mcpGuard.ts'))}` }] }],
  },
};

const confidence = {
  confidence: { type: 'integer', minimum: 0, maximum: 100 },
  reasoning: { type: 'string' },
};

const schema = (d: OpenDecision) => d.menu
  ? {
    type: 'object',
    properties: {
      answers: {
        type: 'array',
        description: 'One answer per question, in order.',
        items: {
          type: 'object',
          properties: {
            labels: { type: 'array', items: { type: 'string' }, description: 'Labels of the chosen options, copied exactly.' },
            other: { type: 'string', description: 'An own answer instead of the options, single-choice questions only; else "".' },
          },
          required: ['labels', 'other'],
        },
      },
      ...confidence,
    },
    required: ['answers', 'confidence', 'reasoning'],
  }
  : {
    type: 'object',
    properties: {
      choice: { type: 'string', enum: [...d.options.map((o) => o.label), ''], description: 'Label of the chosen option, or "" when none fits.' },
      answer: { type: 'string' },
      ...confidence,
    },
    required: ['choice', 'answer', 'confidence', 'reasoning'],
  };

interface Run {
  session: Session;
  key: string;
  controller: AbortController;
  scratch: string | null;
  copying: Promise<string> | null;
  save: (patch: Partial<Advice>) => void;
}

const running = new Map<string, Run>();
const byToken = new Map<string, Run>();

await mkdir(SCRATCH_DIR, { recursive: true });
for (const leftover of await readdir(SCRATCH_DIR)) void removeScratchCopy(join(SCRATCH_DIR, leftover));

const needsAdvice = (s: Session, d: OpenDecision) =>
  !running.has(s.id) && (!s.advice || s.advice.key !== d.key || s.advice.state === 'thinking');

export function adviseOpen() {
  for (const [id, run] of running) {
    const s = sessions.get(id);
    if (!s || openDecision(s)?.key !== run.key) run.controller.abort();
  }
  for (const s of sessions.all()) {
    const d = openDecision(s);
    if (!d || !needsAdvice(s, d)) continue;
    if (running.size >= MAX_PARALLEL) return;
    void advise(s, d);
  }
}

export function retryAdvice(id: string) {
  const s = sessions.get(id);
  if (!s || !openDecision(s)) throw new Error('nothing to decide right now');
  if (running.has(id)) return;
  sessions.update(id, { advice: null });
  adviseOpen();
}

export function stopAdvice(id: string) {
  running.get(id)?.controller.abort();
}

function scratchCopy(run: Run) {
  if (!run.copying) {
    const dir = join(SCRATCH_DIR, `${run.session.id}-${Date.now()}`);
    run.scratch = dir;
    run.save({ activity: 'Making a scratch copy of the worktree' });
    const { session } = run;
    run.copying = (session.repoId === null
      ? addScratchCopies(taskWorktrees(session.worktree).map(({ worktree }) => ({ path: worktree.path, name: basename(worktree.path) })), dir)
      : addScratchCopy(session.worktree, dir)).then(() => dir);
  }
  return run.copying;
}

// Served per run at a secret path, so only that advisor gets the tool.
export async function handleAdvisorMcp(request: Request, token: string) {
  const mcp = new McpServer({ name: MCP_NAME, version: '1.0.0' });
  mcp.registerTool(SCRATCH_TOOL, {
    title: 'Scratch copy',
    description:
      'Creates (once per run) a disposable copy of the worktree and returns its path: a detached git worktree whose files are ' +
      'clones of the original, uncommitted changes, dependencies and build output included (for a task folder, a folder ' +
      'holding such a copy of each of its worktrees, under the same names). Call it before changing code or ' +
      'running anything that writes (tests, builds, scripts, servers), then do that work only inside the returned path. ' +
      'Creating it can take a minute. It is deleted when you finish.',
    inputSchema: {},
  }, async () => {
    const run = byToken.get(token);
    if (!run) throw new Error('this advisor run has ended');
    const dir = await scratchCopy(run);
    return { content: [{ type: 'text', text: `Scratch copy ready: ${dir}\nWork only there from now on; keep temporary files inside it too.` }] };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  return transport.handleRequest(request);
}

function describe(tool: Record<string, any>, run: Run) {
  let text = describeTool(tool);
  for (const dir of [run.scratch, run.session.worktree]) {
    if (dir) text = text.replaceAll(`"${dir}"`, '.').replaceAll(dir, '.');
  }
  return clip(text.replace(/· cd \.\s*(&&|;)\s*/, '· '), 140);
}

const asked: Record<string, string> = {
  q: 'stopped to ask its developer a question',
  s: "ended its turn asking its developer to decide; a model read the decision below from the agent's last message",
  m: 'opened a multiple-choice menu in its terminal for its developer',
};

function prompt(s: Session, d: OpenDecision) {
  const repo = repoView(s.repoId);
  const options = d.options.length
    ? d.options.map((o) => `- ${o.label}${o.recommended ? ' (the agent recommends this)' : ''}${o.description ? `: ${o.description}` : ''}`).join('\n')
    : '(none; answer in free text)';
  const decision = d.menu
    ? `Questions:\n${d.details}`
    : `Question (${d.category}): ${d.title}\n\n${d.details}\n\nOptions:\n${options}`;
  const reply = d.menu
    ? '- answers: one per question, in order: the labels you would pick, copied exactly from its options (one for a pick-one question, any number for a pick-any one), or for a pick-one question no labels and your own answer in other.'
    : `- choice: the label of the option you would pick, copied exactly from the list above, or "" when no option fits or there are none.
- answer: the reply to send the agent, written as the developer: short, concrete, ready to send as is. Do not repeat the option label; add only what the agent needs beyond it (constraints, the reason, next steps). May be "" when the choice says it all.`;
  return `A coding agent working in ${placeOf(s)} ${asked[d.key[0]]}. You are an independent senior engineer giving the developer a second opinion. You have not seen the agent's conversation, so do not take its framing on trust: verify it yourself before deciding: read the code, compare with ${repo?.base ?? 'the base branch'}, and where it helps, try things out with your tools, skills and the browser.

The worktree belongs to the agent and the developer: read it, but never change it. When you want to change code or run anything that writes (tests, builds, scripts, servers), first call the ${SCRATCH_TOOL} tool and do that work only inside the copy it returns; it is deleted afterwards, so you need not undo changes there. Stop any server or background process you start; the developer may already run servers, so pick free ports. Do nothing outward-facing: no pushing, no PRs, no comments or messages to anyone, no changes to shared services or data.

The task the agent was given:
${clip(s.firstPrompt, 3000) || '(unknown)'}

The agent's last message before asking:
${clip(s.lastMessage, 12_000) || '(none)'}

${decision}

Reply with:
${reply}
- confidence: 0-100, how likely the developer would decide the same. Score low when the decision hinges on product intent, priorities, people or facts outside the repository, or when the agent's question rests on something you could not verify.
- reasoning: one to three sentences for the developer on why, naming what you checked or tried.`;
}

async function advise(s: Session, d: OpenDecision) {
  const token = randomUUID();
  let advice: Advice = {
    key: d.key, state: 'thinking', startedAt: Date.now(), activity: 'Starting', choice: null, answer: '', confidence: 0, reasoning: '', at: Date.now(),
  };
  const run: Run = {
    session: s,
    key: d.key,
    controller: new AbortController(),
    scratch: null,
    copying: null,
    save: (patch) => {
      advice = { ...advice, ...patch };
      const current = sessions.get(s.id);
      if (!current || openDecision(current)?.key !== d.key) return;
      sessions.update(s.id, { advice });
      notify();
    },
  };
  running.set(s.id, run);
  byToken.set(token, run);
  run.save({});
  let lastActivity = 0;
  try {
    const mcpConfig = { mcpServers: { [MCP_NAME]: { type: 'http', url: `${ORIGIN}/mcp/advisor/${token}` } } };
    const out = await headless(prompt(s, d), {
      cwd: s.worktree,
      timeoutMs: TIMEOUT_MS,
      signal: run.controller.signal,
      args: [
        '--model', MODEL,
        '--mcp-config', JSON.stringify(mcpConfig),
        '--settings', JSON.stringify(guard),
        '--add-dir', SCRATCH_DIR,
        '--allowedTools', `mcp__${MCP_NAME}__${SCRATCH_TOOL}`,
        '--disallowedTools', ASK_TOOL_NAME, OPEN_WORKTREE_TOOL_NAME, `Edit(/${s.worktree}/**)`, `Write(/${s.worktree}/**)`, `NotebookEdit(/${s.worktree}/**)`, 'Bash(git push:*)',
        '--permission-prompts', 'none',
        '--json-schema', JSON.stringify(schema(d)),
      ],
      onEvent: (event) => {
        const tool = event.type === 'assistant' && event.message?.content?.findLast?.((b: any) => b.type === 'tool_use');
        if (!tool || Date.now() - lastActivity < ACTIVITY_EVERY_MS) return;
        lastActivity = Date.now();
        run.save({ activity: describe(tool, run) });
      },
    });
    const r = out.structured_output;
    if (!r) throw new Error(String(out.result ?? 'no answer').slice(0, 500));
    const answers = d.menu && Array.isArray(r.answers)
      ? r.answers.map((a: any) => ({ labels: Array.isArray(a?.labels) ? a.labels.map(String) : [], other: String(a?.other ?? '').trim() }))
      : undefined;
    if (d.menu) {
      try {
        menuKeystrokes(d.menu, answers ?? []);
      } catch (err) {
        throw new Error(`the advisor's answers do not fit the menu: ${(err as Error).message}`);
      }
    }
    const done = {
      state: 'done' as const,
      activity: null,
      choice: d.options.some((o) => o.label === r.choice) ? r.choice : null,
      answer: String(r.answer ?? '').trim(),
      answers,
      confidence: Math.max(0, Math.min(100, Math.round(Number(r.confidence) || 0))),
      reasoning: String(r.reasoning ?? '').trim(),
      at: Date.now(),
    };
    if (!d.menu && !done.choice && !done.answer) throw new Error('the advisor gave an empty answer');
    run.save(done);
    scheduleRerank();
  } catch (err) {
    run.save({ state: 'failed', activity: null, error: (err as Error).message, at: Date.now() });
  } finally {
    running.delete(s.id);
    byToken.delete(token);
    if (run.copying) void run.copying.catch(() => {}).then(() => removeScratchCopy(run.scratch!));
  }
  adviseOpen();
}
