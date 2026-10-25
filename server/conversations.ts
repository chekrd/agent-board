import { execFile } from 'node:child_process';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ARTIFACT_TOOL_NAME, ASK_TOOL, ASK_TOOL_NAME, OLD_MCP_SERVER_NAMES } from './config.ts';
import type { PrFlow } from './db.ts';

const run = promisify(execFile);
const CLAUDE_DIR = join(homedir(), '.claude');
const HEAD_BYTES = 128 << 10;
const TAIL_BYTES = 512 << 10;
const MAX_TAIL_BYTES = 8 << 20;
const MAX_LINE = 256 << 10;
const MAX_MESSAGE = 12_000;

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
  lastMessage: string | null;
  activity: Activity | null;
  toolResults: string[];
  ask: ToolCall | null;
  artifacts: ToolCall[];
  pr: Omit<PrFlow, 'url'> | null;
  turns: Turn[];
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

const blocks = (entry: Record<string, any>): Record<string, any>[] =>
  entry.type === 'assistant' && !entry.isSidechain && Array.isArray(entry.message?.content) ? entry.message.content : [];

const ASK_TOOL_NAMES = new Set([ASK_TOOL_NAME, ...OLD_MCP_SERVER_NAMES.map((n) => `mcp__${n}__${ASK_TOOL}`)]);

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
  entries.flatMap((e) => blocks(e).filter((b) => b.type === 'tool_use' && b.name === ARTIFACT_TOOL_NAME)
    .map((b) => ({ toolUseId: b.id, input: b.input ?? {}, at: Date.parse(e.timestamp) || Date.now() })));

function turns(entries: Record<string, any>[]): Turn[] {
  return entries.flatMap((e): Turn[] => {
    const prompt = promptText(e, 4000);
    if (prompt) return [{ id: e.uuid, role: 'developer', text: prompt }];
    if (e.message?.model === '<synthetic>' || e.isApiErrorMessage) return [];
    const text = blocks(e).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return text ? [{ id: e.uuid, role: 'claude', text: text.slice(0, MAX_MESSAGE) }] : [];
  });
}

function lastMessage(entries: Record<string, any>[]) {
  const text = entries.map((e) => blocks(e).filter((b) => b.type === 'text').map((b) => b.text).join('\n')).findLast(Boolean);
  return text ? text.trim().slice(0, MAX_MESSAGE) : null;
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
  const step = !block ? null : block.type === 'tool_use' ? describeTool(block) : block.type === 'thinking' ? 'Thinking' : 'Writing';
  return { step: step && step.split('\n')[0].slice(0, 140), since: Date.parse(entries[start].timestamp) || Date.now() };
}

const ENV_PREFIX = String.raw`^\s*(?:\w+=\S*\s+)*`;
const WATCH_PR = new RegExp(`${ENV_PREFIX}\\S*pr-to-green/watch-pr\\.sh\\s+(\\d+)(?:\\s+"([^"]*)")?`);
const CREATE_PR = new RegExp(`${ENV_PREFIX}az repos pr create\\b`);
const RESULT_LINE = /^(RUNNING|PASSED|FAILED|CLOSED|ERROR)\b.*$/m;

const resultText = (entry: Record<string, any>, block: Record<string, any>) =>
  entry.toolUseResult?.stdout ?? (typeof block.content === 'string' ? block.content : block.content?.map?.((c: any) => c.text ?? '').join('\n') ?? '');

// Follows the pr-to-green skill: the PR it creates and the last result its watch-pr.sh reported.
async function prFlow(entries: Record<string, any>[]): Promise<Meta['pr']> {
  let flow = null as Meta['pr'];
  let watcher: string | null = null;
  let creator: string | null = null;
  let outputFile: string | null = null;
  const start = (at: string) => (flow ??= { id: null, result: null, watching: false, at: Date.parse(at) || Date.now() });
  for (const entry of entries) {
    for (const b of blocks(entry)) {
      if (b.type !== 'tool_use') continue;
      if (b.name === 'Skill' && String(b.input?.skill ?? '').endsWith('pr-to-green')) start(entry.timestamp);
      const command = b.name === 'Bash' ? String(b.input?.command ?? '') : '';
      const watch = command.match(WATCH_PR);
      if (watch) {
        const f = start(entry.timestamp);
        Object.assign(f, { id: Number(watch[1]), result: watch[2] ?? f.result, watching: true });
        watcher = b.id;
        outputFile = null;
      } else if (CREATE_PR.test(command)) {
        start(entry.timestamp);
        creator = b.id;
      }
    }
    if (!flow || entry.type !== 'user') continue;
    const content = entry.message?.content;
    if (typeof content === 'string' && content.startsWith('<task-notification>') && content.includes(`<tool-use-id>${watcher}</tool-use-id>`)) {
      flow.watching = false;
      outputFile = content.match(/<output-file>([^<]+)<\/output-file>/)?.[1] ?? null;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const text = resultText(entry, b);
      if (b.tool_use_id === creator) flow.id = Number(text.match(/"pullRequestId":\s*(\d+)/)?.[1]) || flow.id;
      if (b.tool_use_id === watcher && !text.includes('running in background')) {
        flow.watching = false;
        flow.result = text.match(RESULT_LINE)?.[0] ?? flow.result;
      }
    }
  }
  if (flow && outputFile) {
    const out = await readFile(outputFile, 'utf8').catch(() => '');
    flow.result = out.match(RESULT_LINE)?.[0] ?? flow.result;
  }
  return flow;
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
    lastMessage: lastMessage(tail),
    activity: activity(tail),
    toolResults: toolResults(tail),
    ask: latestAsk(tail),
    artifacts: artifactCalls(tail),
    pr: await prFlow(tail),
    turns: turns(tail),
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
