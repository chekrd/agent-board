import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ASK_TOOL_NAME, ORIGIN, SCRATCH_DIR } from './config.ts';
import { sessions, type Advice, type Session } from './db.ts';
import { addScratchCopy, removeScratchCopy } from './git.ts';
import { headless } from './headless.ts';
import { clip } from './priority.ts';
import { notify, repoView } from './workspace.ts';

const MODEL = 'opus';
const MAX_PARALLEL = 2;
const TIMEOUT_MS = 20 * 60_000;
const ACTIVITY_EVERY_MS = 1000;

const MCP_NAME = 'agent-ide-advisor';
const SCRATCH_TOOL = 'scratch_copy';

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

interface Run {
  session: Session;
  controller: AbortController;
  scratch: string | null;
  copying: Promise<string> | null;
  save: (patch: Partial<Advice>) => void;
}

const running = new Map<string, Run>();
const byToken = new Map<string, Run>();

await mkdir(SCRATCH_DIR, { recursive: true });
for (const leftover of await readdir(SCRATCH_DIR)) void removeScratchCopy(join(SCRATCH_DIR, leftover));

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

export function stopAdvice(id: string) {
  running.get(id)?.controller.abort();
}

function scratchCopy(run: Run) {
  if (!run.copying) {
    const dir = join(SCRATCH_DIR, `${run.session.id}-${Date.now()}`);
    run.scratch = dir;
    run.save({ activity: 'Making a scratch copy of the worktree' });
    run.copying = addScratchCopy(run.session.worktree, dir).then(() => dir);
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
      'clones of the original, uncommitted changes, dependencies and build output included. Call it before changing code or ' +
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
  const input = tool.input ?? {};
  const name = String(tool.name).replace(/^mcp__(.+?)__/, '$1: ');
  let detail = String(input.description ?? input.file_path?.split('/').at(-1) ?? input.pattern ?? input.url ?? input.skill ?? input.command ?? '');
  for (const dir of [run.scratch, run.session.worktree]) {
    if (dir) detail = detail.replaceAll(`"${dir}"`, '.').replaceAll(dir, '.');
  }
  detail = detail.replace(/^cd \.\s*(&&|;)\s*/, '');
  return clip(detail ? `${name} · ${detail}` : name, 140);
}

function prompt(s: Session) {
  const q = s.question!;
  const repo = repoView(s.repoId);
  const options = q.options.length
    ? q.options.map((o) => `- ${o.label}${o.recommended ? ' (the agent recommends this)' : ''}${o.description ? `: ${o.description}` : ''}`).join('\n')
    : '(none; answer in free text)';
  return `A coding agent working in the git worktree ${s.worktree} stopped to ask its developer a question. You are an independent senior engineer giving the developer a second opinion. You have not seen the agent's conversation, so do not take its framing on trust: verify it yourself before deciding: read the code, compare with ${repo?.base ?? 'the base branch'}, and where it helps, try things out with your tools, skills and the browser.

The worktree belongs to the agent and the developer: read it, but never change it. When you want to change code or run anything that writes (tests, builds, scripts, servers), first call the ${SCRATCH_TOOL} tool and do that work only inside the copy it returns; it is deleted afterwards, so you need not undo changes there. Stop any server or background process you start; the developer may already run servers, so pick free ports. Do nothing outward-facing: no pushing, no PRs, no comments or messages to anyone, no changes to shared services or data.

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
  const token = randomUUID();
  let advice: Advice = {
    toolUseId, state: 'thinking', startedAt: Date.now(), activity: 'Starting', choice: null, answer: '', confidence: 0, reasoning: '', at: Date.now(),
  };
  const run: Run = {
    session: s,
    controller: new AbortController(),
    scratch: null,
    copying: null,
    save: (patch) => {
      advice = { ...advice, ...patch };
      if (sessions.get(s.id)?.question?.toolUseId !== toolUseId) return;
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
    const out = await headless(prompt(s), {
      cwd: s.worktree,
      timeoutMs: TIMEOUT_MS,
      signal: run.controller.signal,
      args: [
        '--model', MODEL,
        '--mcp-config', JSON.stringify(mcpConfig),
        '--allowedTools', `mcp__${MCP_NAME}__${SCRATCH_TOOL}`,
        '--disallowedTools', ASK_TOOL_NAME, `Edit(/${s.worktree}/**)`, `Write(/${s.worktree}/**)`, `NotebookEdit(/${s.worktree}/**)`, 'Bash(git push:*)',
        '--permission-prompts', 'none',
        '--json-schema', JSON.stringify(schema(s.question!.options.map((o) => o.label))),
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
    const done = {
      state: 'done' as const,
      activity: null,
      choice: s.question!.options.some((o) => o.label === r.choice) ? r.choice : null,
      answer: String(r.answer ?? '').trim(),
      confidence: Math.max(0, Math.min(100, Math.round(Number(r.confidence) || 0))),
      reasoning: String(r.reasoning ?? '').trim(),
      at: Date.now(),
    };
    if (!done.choice && !done.answer) throw new Error('the advisor gave an empty answer');
    run.save(done);
  } catch (err) {
    run.save({ state: 'failed', activity: null, error: (err as Error).message, at: Date.now() });
  } finally {
    running.delete(s.id);
    byToken.delete(token);
    if (run.copying) void run.copying.catch(() => {}).then(() => removeScratchCopy(run.scratch!));
  }
  adviseOpen();
}
