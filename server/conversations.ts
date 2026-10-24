import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ASK_TOOL_NAME } from './config.ts';
import type { PrFlow } from './db.ts';

const CLAUDE_DIR = join(homedir(), '.claude');
const HEAD_BYTES = 128 << 10;
const TAIL_BYTES = 512 << 10;

export interface Conversation {
  id: string;
  title: string | null;
  firstPrompt: string | null;
  updatedAt: number;
  livePid: number | null;
}

export interface Ask {
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
  ask: Ask | null;
  pr: Omit<PrFlow, 'url'> | null;
  turns: Turn[];
}

export interface Turn {
  id: string;
  role: 'developer' | 'claude';
  text: string;
}

const metaCache = new Map<string, Meta>();

const projectDir = (cwd: string) => join(CLAUDE_DIR, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

async function readSlice(file: string, from: 'head' | 'tail') {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const length = Math.min(from === 'head' ? HEAD_BYTES : TAIL_BYTES, size);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, from === 'head' ? 0 : size - length);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

const jsonLines = (text: string) =>
  text.split('\n').flatMap((line) => {
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

// An ask_human call stays open until the user sends a prompt after it.
function latestAsk(entries: Record<string, any>[]): Ask | null {
  let ask: Ask | null = null;
  for (const entry of entries) {
    const call = blocks(entry).findLast((b) => b.type === 'tool_use' && b.name === ASK_TOOL_NAME);
    if (call) ask = { toolUseId: call.id, input: call.input ?? {}, at: Date.parse(entry.timestamp) || Date.now() };
    else if (ask && promptText(entry)) ask = null;
  }
  return ask;
}

function turns(entries: Record<string, any>[]): Turn[] {
  return entries.flatMap((e): Turn[] => {
    const prompt = promptText(e, 4000);
    if (prompt) return [{ id: e.uuid, role: 'developer', text: prompt }];
    if (e.message?.model === '<synthetic>' || e.isApiErrorMessage) return [];
    const text = blocks(e).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return text ? [{ id: e.uuid, role: 'claude', text: text.slice(0, 4000) }] : [];
  });
}

function lastMessage(entries: Record<string, any>[]) {
  const text = entries.map((e) => blocks(e).filter((b) => b.type === 'text').map((b) => b.text).join('\n')).findLast(Boolean);
  return text ? text.trim().slice(0, 4000) : null;
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
  if (cached?.mtime === mtime) return cached;
  const head = jsonLines(await readSlice(file, 'head'));
  const tail = jsonLines(await readSlice(file, 'tail'));
  const titled = [...head, ...tail].findLast((e) => e.type === 'custom-title' || e.type === 'ai-title');
  const meta = {
    mtime,
    title: titled?.customTitle ?? titled?.aiTitle ?? null,
    firstPrompt: head.map(promptText).find(Boolean) ?? null,
    interactive: (head.find((e) => e.entrypoint)?.entrypoint ?? 'cli') === 'cli',
    lastMessage: lastMessage(tail),
    ask: latestAsk(tail),
    pr: await prFlow(tail),
    turns: turns(tail),
  };
  metaCache.set(file, meta);
  return meta;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface LiveProcess {
  pid: number;
  cwd: string;
  status: 'busy' | 'idle' | 'waiting' | undefined;
  waitingFor: string | null;
}

// Claude Code keeps one ~/.claude/sessions/<pid>.json per running process, with its live status.
export async function liveConversations(): Promise<Map<string, LiveProcess>> {
  const live = new Map<string, LiveProcess>();
  const dir = join(CLAUDE_DIR, 'sessions');
  const files = await readdir(dir).catch(() => []);
  await Promise.all(files.filter((f) => /^\d+\.json$/.test(f)).map(async (f) => {
    try {
      const info = JSON.parse(await readFile(join(dir, f), 'utf8'));
      const interactive = info.kind === 'interactive' && (info.entrypoint ?? 'cli') === 'cli';
      if (!info.sessionId || !info.cwd || !interactive || !alive(info.pid)) return;
      live.set(info.sessionId, { pid: info.pid, cwd: info.cwd, status: info.status, waitingFor: info.waitingFor ?? null });
    } catch {
      // being rewritten
    }
  }));
  return live;
}

export async function listConversations(cwd: string, live: Map<string, LiveProcess>, limit = 15): Promise<Conversation[]> {
  const dir = projectDir(cwd);
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

export async function conversationMeta(cwd: string, id: string) {
  const file = join(projectDir(cwd), `${id}.jsonl`);
  const s = await stat(file).catch(() => null);
  return s ? readMeta(file, s.mtimeMs) : null;
}
