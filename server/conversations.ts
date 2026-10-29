import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { ARTIFACT_TOOL, ARTIFACT_TOOL_NAME, ASK_TOOL, ASK_TOOL_NAME, OLD_MCP_SERVER_NAMES } from './config.ts';
import type { PrFlow } from './db.ts';
import { tildeIn } from './home.ts';
import { linksIn, type Found } from './links.ts';

const run = promisify(execFile);
const CLAUDE_DIR = join(homedir(), '.claude');
const HEAD_BYTES = 128 << 10;
const TAIL_BYTES = 512 << 10;
const MAX_TAIL_BYTES = 8 << 20;
const MAX_LINE = 256 << 10;
const MAX_MESSAGE = 12_000;
const MAX_EXCHANGE_TEXT = 40_000;
const MAX_PROMPT = 4000;

export interface Conversation {
  id: string;
  title: string | null;
  firstPrompt: string | null;
  updatedAt: number;
  livePid: number | null;
}

export interface ToolCall {
  toolUseId: string;
  input: Record<string, unknown>;
  at: number;
}

interface Meta {
  mtime: number;
  title: string | null;
  firstPrompt: string | null;
  interactive: boolean;
  cleared: boolean;
  lastMessage: string | null;
  // The prompt that reply answers, when the part read holds it.
  lastPrompt: string | null;
  activity: Activity | null;
  // Id and description of each background task still running.
  background: [string, string][];
  toolResults: string[];
  ask: ToolCall | null;
  artifacts: ToolCall[];
  links: Found[];
  prs: (Omit<PrFlow, 'url' | 'repo'> & { dir: string | null; repository: string | null })[];
  // The background tasks of PR watchers that wait on checks already green, so nothing will come of them but a change.
  greenWatches: string[];
  turns: Turn[];
  model: string | null;
  effort: string | null;
}

export interface MenuQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

export interface Menu {
  toolUseId: string;
  questions: MenuQuestion[];
  at: number;
}

export interface Activity {
  step: string | null;
  since: number;
  // What Claude has running in the background; between turns it resumes as each one finishes.
  background?: string[];
  // Claude's turn has ended and only the background work runs.
  between?: true;
}

export interface Exchange {
  id: string;
  at: number;
  prompt: string;
  // How many pictures came with the prompt; each is served on its own, as they are stored inline in base64.
  images: number;
  reply: string | null;
  // The artifacts Claude made in answer to it, by tool call id.
  artifacts: string[];
}

export interface ConversationLog {
  id: string;
  exchanges: Exchange[];
}

export interface Turn {
  id: string;
  role: 'developer' | 'claude';
  text: string;
}

const metaCache = new Map<string, Meta>();
const MAX_CACHED = 300;
const MAX_DIR_NAME = 200;

// Claude cuts longer project folder names to 200 characters and appends a hash it does not document.
async function projectDir(cwd: string) {
  const name = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const projects = join(CLAUDE_DIR, 'projects');
  if (name.length <= MAX_DIR_NAME) return join(projects, name);
  const prefix = `${name.slice(0, MAX_DIR_NAME)}-`;
  const match = (await readdir(projects).catch(() => [])).find((d) => d.startsWith(prefix));
  return join(projects, match ?? name);
}

async function readSlice(file: string, from: 'head' | 'tail', bytes: number) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const length = Math.min(bytes, size);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, from === 'head' ? 0 : size - length);
    return { text: buf.toString('utf8'), whole: length === size };
  } finally {
    await fh.close();
  }
}

// Screenshots and other tool output are stored inline and can fill any fixed window, so the tail
// grows until it reaches the developer's last prompt, where the current turn starts.
async function readTail(file: string) {
  for (let bytes = TAIL_BYTES; ; bytes *= 4) {
    const { text, whole } = await readSlice(file, 'tail', bytes);
    const entries = jsonLines(text);
    if (whole || bytes >= MAX_TAIL_BYTES || entries.some((e) => promptText(e))) return entries;
  }
}

const jsonLines = (text: string) =>
  text.split('\n').flatMap((line) => {
    if (line.length > MAX_LINE) return [];
    try {
      return [JSON.parse(line) as Record<string, any>];
    } catch {
      return [];
    }
  });

function promptText(entry: Record<string, any>, max = 500): string | null {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  const content = entry.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find((c) => c.type === 'text')?.text : null;
  if (!text || text.startsWith('<')) return null;
  return text.trim().slice(0, max);
}

// /clear writes itself into the conversation it starts, ahead of any prompt.
function startedByClear(head: Record<string, any>[]) {
  const content = head.find((e) => e.type === 'user' && !e.isMeta && !e.isSidechain)?.message?.content;
  return typeof content === 'string' && content.startsWith('<command-name>/clear</command-name>');
}

const blocks = (entry: Record<string, any>): Record<string, any>[] =>
  entry.type === 'assistant' && !entry.isSidechain && Array.isArray(entry.message?.content) ? entry.message.content : [];

const MENU_TOOL_NAME = 'AskUserQuestion';
const ASK_TOOL_NAMES = new Set([ASK_TOOL_NAME, ...OLD_MCP_SERVER_NAMES.map((n) => `mcp__${n}__${ASK_TOOL}`)]);
const ARTIFACT_TOOL_NAMES = new Set([ARTIFACT_TOOL_NAME, ...OLD_MCP_SERVER_NAMES.map((n) => `mcp__${n}__${ARTIFACT_TOOL}`)]);

// An ask_human call stays open until the user sends a prompt after it.
function latestAsk(entries: Record<string, any>[]): ToolCall | null {
  let ask: ToolCall | null = null;
  for (const entry of entries) {
    const call = blocks(entry).findLast((b) => b.type === 'tool_use' && ASK_TOOL_NAMES.has(b.name));
    if (call) ask = { toolUseId: call.id, input: call.input ?? {}, at: Date.parse(entry.timestamp) || Date.now() };
    else if (ask && promptText(entry)) ask = null;
  }
  return ask;
}

const artifactCalls = (entries: Record<string, any>[]): ToolCall[] =>
  entries.flatMap((e) => blocks(e).filter((b) => b.type === 'tool_use' && ARTIFACT_TOOL_NAMES.has(b.name))
    .map((b) => ({ toolUseId: b.id, input: b.input ?? {}, at: Date.parse(e.timestamp) || Date.now() })));

// The links in what Claude wrote: its messages and the questions it asked through ask_human.
const links = (entries: Record<string, any>[]): Found[] =>
  entries.flatMap((e) => blocks(e).flatMap((b) => {
    const at = Date.parse(e.timestamp) || Date.now();
    if (b.type === 'text') return linksIn(String(b.text ?? ''), at);
    if (b.type === 'tool_use' && ASK_TOOL_NAMES.has(b.name)) return linksIn(`${b.input?.title ?? ''}\n${b.input?.details ?? ''}`, at);
    return [];
  }));

function turns(entries: Record<string, any>[]): Turn[] {
  return entries.flatMap((e): Turn[] => {
    const prompt = promptText(e, 4000);
    if (prompt) return [{ id: e.uuid, role: 'developer', text: prompt }];
    if (e.message?.model === '<synthetic>' || e.isApiErrorMessage) return [];
    const text = blocks(e).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return text ? [{ id: e.uuid, role: 'claude', text: text.slice(0, MAX_MESSAGE) }] : [];
  });
}

// Claude logs each request it sends, so the model and effort show what it runs on now, after any /model or /effort.
function settings(entries: Record<string, any>[]) {
  const request = entries.findLast((e) => e.type === 'api-request' && String(e.querySource ?? '').startsWith('repl_main_thread'))?.params;
  const model = request?.model ?? entries.findLast((e) => e.type === 'assistant' && !e.isSidechain && e.message?.model && e.message.model !== '<synthetic>')?.message.model;
  return { model: model ?? null, effort: request?.output_config?.effort ?? null };
}

// Each prompt with what Claude wrote after its last tool call in answer to it, so the narration between tool calls
// stays out; a question or menu does not count as a tool call, as the text before it is for the developer. What comes
// before the first prompt has no prompt.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const promptImages = (entry: Record<string, any>): { media_type: string; data: string }[] =>
  entry.type === 'user' && !entry.isMeta && !entry.isSidechain && Array.isArray(entry.message?.content)
    ? entry.message.content.filter((b: any) => b.type === 'image' && b.source?.type === 'base64' && IMAGE_TYPES.has(b.source.media_type)).map((b: any) => b.source)
    : [];

function replies(entries: Record<string, any>[], max?: number) {
  const out: { entry: Record<string, any> | null; prompt: string | null; reply: string[]; artifacts: string[] }[] = [{ entry: null, prompt: null, reply: [], artifacts: [] }];
  for (const e of entries) {
    const prompt = e.isCompactSummary ? null : promptText(e, max) ?? (promptImages(e).length ? '' : null);
    if (prompt !== null) out.push({ entry: e, prompt, reply: [], artifacts: [] });
    else if (e.message?.model !== '<synthetic>' && !e.isApiErrorMessage) {
      for (const b of blocks(e)) {
        if (b.type === 'text' && String(b.text ?? '').trim()) out.at(-1)!.reply.push(String(b.text).trim());
        else if (b.type === 'tool_use' && ARTIFACT_TOOL_NAMES.has(b.name)) out.at(-1)!.artifacts.push(String(b.id));
        if (b.type === 'tool_use' && !ASK_TOOL_NAMES.has(b.name) && b.name !== MENU_TOOL_NAME) out.at(-1)!.reply.length = 0;
      }
    }
  }
  return out;
}

const transcriptLines = (file: string) => createInterface({ input: createReadStream(file), crlfDelay: Infinity });

const lastChars = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);

// The latest turn's reply, or the turn before while the current one has none, with the prompt it answers.
function lastReply(entries: Record<string, any>[]) {
  const last = replies(entries, MAX_PROMPT).findLast((r) => r.reply.length);
  if (!last) return { lastMessage: null, lastPrompt: null };
  return { lastMessage: lastChars(last.reply.join('\n\n'), MAX_MESSAGE), lastPrompt: last.prompt || null };
}

// The whole conversation, read only when asked for, as it can run to many megabytes.
export async function exchanges(file: string): Promise<Exchange[]> {
  if (!(await stat(file).catch(() => null))) return [];
  const entries: Record<string, any>[] = [];
  for await (const line of transcriptLines(file)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // a partly written last line
    }
  }
  return replies(entries, MAX_EXCHANGE_TEXT).flatMap(({ entry, prompt, reply, artifacts }) => entry && prompt !== null ? [{
    id: String(entry.uuid),
    at: Date.parse(entry.timestamp) || 0,
    prompt,
    images: promptImages(entry).length,
    reply: reply.length ? lastChars(reply.join('\n\n'), MAX_EXCHANGE_TEXT) : null,
    artifacts,
  }] : []);
}

// Picture `n` of the prompt `entry`, found by its id without parsing the lines around it.
export async function promptImage(file: string, entry: string, n: number) {
  if (!(await stat(file).catch(() => null))) return null;
  for await (const line of transcriptLines(file)) {
    if (!line.includes(`"uuid":"${entry}"`)) continue;
    try {
      const e = JSON.parse(line);
      if (e.uuid !== entry) continue;
      const image = promptImages(e)[n];
      return image ? { type: image.media_type, data: Buffer.from(image.data, 'base64') } : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function describeTool(tool: Record<string, any>) {
  const input = tool.input ?? {};
  const name = String(tool.name).replace(/^mcp__(.+?)__/, '$1: ');
  const detail = String(input.description ?? input.file_path?.split('/').at(-1) ?? input.pattern ?? input.url ?? input.skill ?? input.command ?? '');
  return detail ? `${name} · ${detail}` : name;
}

export function parseMenu(toolUseId: string, input: any): Menu | null {
  if (!toolUseId || !Array.isArray(input?.questions)) return null;
  return {
    toolUseId,
    questions: input.questions.map((q: any) => ({
      question: String(q.question ?? ''),
      header: String(q.header ?? ''),
      multiSelect: !!q.multiSelect,
      options: Array.isArray(q.options) ? q.options.map((o: any) => ({ label: String(o.label ?? ''), description: o.description })) : [],
    })),
    at: Date.now(),
  };
}

const toolResults = (entries: Record<string, any>[]) =>
  entries.flatMap((e) => (e.type === 'user' && Array.isArray(e.message?.content) ? e.message.content : [])
    .filter((b: Record<string, any>) => b.type === 'tool_result').map((b: Record<string, any>) => String(b.tool_use_id)));

// The current turn started at the developer's last prompt; its step is Claude's latest block since then, null until
// Claude has written one.
function activity(entries: Record<string, any>[]): Activity | null {
  const start = entries.findLastIndex((e) => promptText(e));
  if (start < 0) return null;
  const block = entries.slice(start + 1).map((e) => blocks(e).at(-1)).findLast(Boolean);
  const step = !block ? null : block.type === 'tool_use' ? tildeIn(describeTool(block), homedir()) : block.type === 'thinking' ? 'Thinking' : 'Writing';
  return { step: step && step.split('\n')[0].slice(0, 140), since: Date.parse(entries[start].timestamp) || Date.now() };
}

// Background commands and agents Claude started and has not been told have ended, by what each was started to do. A
// long wait can push the start out of the tail, so the tasks still open at the last read carry over.
function background(entries: Record<string, any>[], carried: readonly [string, string][] = []): [string, string][] {
  const calls = new Map<string, string>();
  const open = new Map(carried);
  for (const entry of entries) {
    for (const b of blocks(entry)) if (b.type === 'tool_use') calls.set(b.id, tildeIn(describeTool(b), homedir()));
    const r = entry.type === 'user' && !entry.isSidechain ? entry.toolUseResult : null;
    if (r && typeof r === 'object') {
      const id = r.backgroundTaskId ?? (r.status === 'async_launched' ? r.agentId : null);
      const use = Array.isArray(entry.message?.content) ? entry.message.content.find((b: any) => b.type === 'tool_result')?.tool_use_id : null;
      if (id) open.set(String(id), calls.get(use) ?? 'a task');
      if (r.task_id) open.delete(String(r.task_id));
    }
    if (entry.type !== 'user' && entry.type !== 'queue-operation') continue;
    const content = entry.message?.content ?? entry.content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => String(c.text)) : [];
    for (const t of texts) {
      if (t.startsWith('<task-notification>')) open.delete(t.match(/<task-id>([^<]+)<\/task-id>/)?.[1] ?? '');
    }
  }
  return [...open];
}

// A command may first change into the repository it is for: `cd <dir> && …` or `cd <dir>; …`.
const ENV_PREFIX = String.raw`^\s*(?:cd\s+("[^"]+"|'[^']+'|[^\s;&]+)\s*(?:&&|;)\s*)?(?:\w+=\S*\s+)*`;
const WATCH_PR = new RegExp(`${ENV_PREFIX}\\S*pr-to-green/watch-pr\\.sh\\s+(\\d+)(?:\\s+"([^"]*)")?`);
const CREATE_PR = new RegExp(`${ENV_PREFIX}az repos pr create\\b`);
const REPOSITORY_ARG = /\s(?:--repository|-r)\s+("[^"]+"|'[^']+'|\S+)/;
const RESULT_LINE = /^(RUNNING|PASSED|FAILED|CLOSED|ERROR)\b.*$/m;

const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, '$2');

// Where the command ran: the folder it changed into, else the session's working directory then.
const dirOf = (entry: Record<string, any>, cd: string | undefined) => {
  const cwd = typeof entry.cwd === 'string' ? entry.cwd : null;
  if (!cd) return cwd;
  return cwd ? resolve(cwd, unquote(cd)) : isAbsolute(unquote(cd)) ? unquote(cd) : null;
};

const resultText = (entry: Record<string, any>, block: Record<string, any>) =>
  entry.toolUseResult?.stdout ?? (typeof block.content === 'string' ? block.content : block.content?.map?.((c: any) => c.text ?? '').join('\n') ?? '');

export type PrRead = Meta['prs'][number];

// Follows the pr-to-green skill: each PR it creates or watches, by id, with the last result its watch-pr.sh reported,
// where the command ran and the repository az named, so the PR can be told to its repository.
async function prFlows(entries: Record<string, any>[]): Promise<{ flows: PrRead[]; greenWatches: string[] }> {
  const flows: PrRead[] = [];
  // The PR being opened, until az says its id.
  let opening: PrRead | null = null;
  const creators = new Map<string, PrRead>();
  // The watcher of each PR: its tool call, its background task and the file it wrote when it ended.
  const watchers = new Map<PrRead, { call: string; task: string | null; output: string | null }>();
  const open = (at: string) => {
    if (!opening) flows.push(opening = { id: null, result: null, watching: false, at: Date.parse(at) || Date.now(), dir: null, repository: null });
    return opening;
  };
  const withId = (id: number, at: string) => {
    const known = flows.find((f) => f.id === id);
    if (known) return known;
    const f = open(at);
    f.id = id;
    opening = null;
    return f;
  };
  for (const entry of entries) {
    for (const b of blocks(entry)) {
      if (b.type !== 'tool_use') continue;
      if (b.name === 'Skill' && String(b.input?.skill ?? '').endsWith('pr-to-green') && !flows.length) open(entry.timestamp);
      const command = b.name === 'Bash' ? String(b.input?.command ?? '') : '';
      const watch = command.match(WATCH_PR);
      if (watch) {
        const f = withId(Number(watch[2]), entry.timestamp);
        Object.assign(f, { result: watch[3] ?? f.result, watching: true, dir: dirOf(entry, watch[1]) ?? f.dir });
        watchers.set(f, { call: b.id, task: null, output: null });
        continue;
      }
      const create = command.match(CREATE_PR);
      if (create) {
        const f = open(entry.timestamp);
        f.dir = dirOf(entry, create[1]) ?? f.dir;
        const repository = command.match(REPOSITORY_ARG)?.[1];
        if (repository) f.repository = unquote(repository);
        creators.set(b.id, f);
      }
    }
    if (!flows.length || entry.type !== 'user') continue;
    const content = entry.message?.content;
    if (typeof content === 'string' && content.startsWith('<task-notification>')) {
      for (const [f, w] of watchers) {
        if (!content.includes(`<tool-use-id>${w.call}</tool-use-id>`)) continue;
        f.watching = false;
        w.output = content.match(/<output-file>([^<]+)<\/output-file>/)?.[1] ?? null;
      }
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const text = resultText(entry, b);
      const created = creators.get(b.tool_use_id);
      const id = created && Number(text.match(/"pullRequestId":\s*(\d+)/)?.[1]);
      if (created && id) {
        const repository = created.repository ?? text.match(/"repository":\s*\{[^{}]*?"name":\s*"([^"]+)"/)?.[1] ?? null;
        const f = created.id === null && !flows.some((o) => o.id === id) ? created : withId(id, entry.timestamp);
        if (f !== created && created.id === null) flows.splice(flows.indexOf(created), 1);
        if (opening === created) opening = null;
        Object.assign(f, { id, dir: f.dir ?? created.dir, repository: f.repository ?? repository });
      }
      for (const [f, w] of watchers) {
        if (b.tool_use_id !== w.call) continue;
        const task = entry.toolUseResult?.backgroundTaskId ?? (text.includes('running in background') ? text.match(/with ID: (\S+)/)?.[1] : null);
        if (task) {
          w.task = String(task);
        } else if (!text.includes('running in background')) {
          f.watching = false;
          f.result = text.match(RESULT_LINE)?.[0] ?? f.result;
        }
      }
    }
  }
  for (const [f, w] of watchers) {
    if (!w.output) continue;
    const out = await readFile(w.output, 'utf8').catch(() => '');
    f.result = out.match(RESULT_LINE)?.[0] ?? f.result;
  }
  const greenWatches = [...watchers].flatMap(([f, w]) => (f.watching && w.task && /^PASSED\b/.test(f.result ?? '') ? [w.task] : []));
  return { flows, greenWatches };
}

async function prMeta(tail: Record<string, any>[], cached: Meta | undefined) {
  const { flows, greenWatches } = await prFlows(tail);
  return { prs: flows, greenWatches: flows.length ? greenWatches : cached?.greenWatches ?? [] };
}

async function readMeta(file: string, mtime: number): Promise<Meta> {
  const cached = metaCache.get(file);
  if (cached?.mtime === mtime) {
    metaCache.delete(file);
    metaCache.set(file, cached);
    return cached;
  }
  const head = jsonLines((await readSlice(file, 'head', HEAD_BYTES)).text);
  const tail = await readTail(file);
  const entries = [...head, ...tail];
  const meta = {
    mtime,
    title: entries.findLast((e) => e.type === 'custom-title')?.customTitle ?? entries.findLast((e) => e.type === 'ai-title')?.aiTitle ?? null,
    firstPrompt: head.map((e) => promptText(e)).find(Boolean) ?? null,
    interactive: (head.find((e) => e.entrypoint)?.entrypoint ?? 'cli') === 'cli',
    cleared: startedByClear(head),
    ...lastReply(tail),
    activity: activity(tail),
    background: background(tail, cached?.background),
    toolResults: toolResults(tail),
    ask: latestAsk(tail),
    artifacts: artifactCalls(tail),
    links: links(tail),
    ...await prMeta(tail, cached),
    turns: turns(tail),
    ...settings(tail),
  };
  metaCache.delete(file);
  metaCache.set(file, meta);
  if (metaCache.size > MAX_CACHED) metaCache.delete(metaCache.keys().next().value!);
  return meta;
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const words = (s: string) => s.trim().split(/\s+/).join(' ');

// A crashed Claude leaves its file behind and macOS reuses pids, so the process must also
// have started when the file says. procStart is written in UTC.
async function startTimes(pids: number[]) {
  if (!pids.length) return new Map<number, string>();
  const { stdout } = await run('/bin/ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { env: { ...process.env, TZ: 'UTC' } })
    .catch((err) => ({ stdout: String(err.stdout ?? '') }));
  return new Map(stdout.split('\n').filter((l) => l.trim()).map((l) => {
    const [pid, ...start] = l.trim().split(/\s+/);
    return [Number(pid), start.join(' ')];
  }));
}

export interface LiveProcess {
  pid: number;
  cwd: string;
  status: 'busy' | 'idle' | 'waiting' | undefined;
  waitingFor: string | null;
}

// Claude Code keeps one ~/.claude/sessions/<pid>.json per running process, with its live status.
export async function liveConversations(): Promise<Map<string, LiveProcess>> {
  const dir = join(CLAUDE_DIR, 'sessions');
  const files = await readdir(dir).catch(() => []);
  const infos = (await Promise.all(files.filter((f) => /^\d+\.json$/.test(f)).map(async (f) => {
    try {
      const info = JSON.parse(await readFile(join(dir, f), 'utf8'));
      const interactive = info.kind === 'interactive' && (info.entrypoint ?? 'cli') === 'cli';
      return info.sessionId && info.cwd && interactive && alive(info.pid) ? [info] : [];
    } catch {
      return []; // being rewritten
    }
  }))).flat();
  const started = await startTimes(infos.map((i) => i.pid));
  const live = new Map<string, LiveProcess>();
  for (const info of infos) {
    if (!started.has(info.pid) || (info.procStart && words(info.procStart) !== started.get(info.pid))) continue;
    live.set(info.sessionId, { pid: info.pid, cwd: info.cwd, status: info.status, waitingFor: info.waitingFor ?? null });
  }
  return live;
}

export async function listConversations(cwd: string, live: Map<string, LiveProcess>, limit = 15): Promise<Conversation[]> {
  const dir = await projectDir(cwd);
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.jsonl'));
  const stats = await Promise.all(files.map(async (f) => {
    const s = await stat(join(dir, f)).catch(() => null);
    return s && s.size > 0 ? { file: join(dir, f), id: f.slice(0, -'.jsonl'.length), mtime: s.mtimeMs } : null;
  }));
  const newest = stats.filter((s) => !!s).sort((a, b) => b.mtime - a.mtime);
  const conversations: Conversation[] = [];
  for (const s of newest) {
    if (conversations.length >= limit) break;
    const meta = await readMeta(s.file, s.mtime);
    if (!meta.interactive || !(meta.firstPrompt || meta.title)) continue;
    conversations.push({ id: s.id, title: meta.title, firstPrompt: meta.firstPrompt, updatedAt: Math.round(s.mtime), livePid: live.get(s.id)?.pid ?? null });
  }
  return conversations;
}

export const transcriptFile = async (cwd: string, id: string) => join(await projectDir(cwd), `${id}.jsonl`);

export async function fileMeta(file: string) {
  const s = await stat(file).catch(() => null);
  return s ? readMeta(file, s.mtimeMs) : null;
}

export const conversationMeta = async (cwd: string, id: string) => fileMeta(await transcriptFile(cwd, id));
