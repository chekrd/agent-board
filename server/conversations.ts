import { access, open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

interface Meta {
  mtime: number;
  title: string | null;
  firstPrompt: string | null;
  interactive: boolean;
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

function promptText(entry: Record<string, any>): string | null {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  const content = entry.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find((c) => c.type === 'text')?.text : null;
  if (!text || text.startsWith('<')) return null;
  return text.trim().slice(0, 500);
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

// Claude Code keeps one ~/.claude/sessions/<pid>.json per running interactive process.
export async function liveConversations(): Promise<Map<string, number>> {
  const live = new Map<string, number>();
  const dir = join(CLAUDE_DIR, 'sessions');
  const files = await readdir(dir).catch(() => []);
  await Promise.all(files.filter((f) => /^\d+\.json$/.test(f)).map(async (f) => {
    try {
      const info = JSON.parse(await readFile(join(dir, f), 'utf8'));
      if (info.sessionId && alive(info.pid)) live.set(info.sessionId, info.pid);
    } catch {
      // being rewritten
    }
  }));
  return live;
}

export async function listConversations(cwd: string, live: Map<string, number>, limit = 15): Promise<Conversation[]> {
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
    conversations.push({ id: s.id, title: meta.title, firstPrompt: meta.firstPrompt, updatedAt: Math.round(s.mtime), livePid: live.get(s.id) ?? null });
  }
  return conversations;
}

export const hasTranscript = (cwd: string, id: string) =>
  access(join(projectDir(cwd), `${id}.jsonl`)).then(() => true, () => false);

export async function conversation(cwd: string, id: string) {
  return (await listConversations(cwd, await liveConversations(), Infinity)).find((c) => c.id === id);
}
