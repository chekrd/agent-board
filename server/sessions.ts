import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { adviseOpen, stopAdvice } from './advisor.ts';
import { conversationMeta, liveConversations, type LiveProcess } from './conversations.ts';
import { SESSIONS_DIR } from './config.ts';
import { repos, sessions, type Session, type SessionStatus } from './db.ts';
import { quote, which } from './env.ts';
import { fullDiff, pullRequestUrl, repoRoot } from './git.ts';
import * as ghostty from './ghostty.ts';
import { askInput } from './mcp.ts';
import { scheduleRerank } from './priority.ts';
import { notify, refreshWorkspace, repoView, workspace } from './workspace.ts';

const run = promisify(execFile);

export const CLAUDE = await which('claude');

const STARTUP_GRACE_MS = 60_000;
const IGNORE_RETRY_MS = 30_000;

// A launch script keeps the prompt out of the user's shell, whose quoting rules may not be POSIX.
async function launch(id: string, worktree: string, args: string[], setup?: string | null) {
  const dir = join(SESSIONS_DIR, id);
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'start.sh');
  const lines = ['#!/bin/sh', setup ?? '', `exec ${[CLAUDE, ...args].map(quote).join(' ')}`].filter(Boolean);
  await writeFile(script, `${lines.join('\n')}\n`);
  await ghostty.newTab(worktree, `/bin/sh ${quote(script)}`);
}

export async function startClaude(opts: { repoId: number; worktree: string; prompt?: string; title?: string; setup?: string | null }) {
  const id = randomUUID();
  sessions.insert({
    id, repoId: opts.repoId, worktree: opts.worktree, cwd: opts.worktree, pid: null, tty: null,
    title: opts.title || null, firstPrompt: opts.prompt || null, status: 'idle',
  });
  try {
    await launch(id, opts.worktree, ['--session-id', id, ...(opts.prompt ? ['--', opts.prompt] : [])], opts.setup);
  } catch (err) {
    sessions.remove(id);
    throw err;
  }
  notify();
  return id;
}

export async function continueConversation(opts: { repoId: number; worktree: string; continueId: string }) {
  const id = opts.continueId;
  const existing = sessions.get(id);
  if (existing && existing.status !== 'exited') {
    await focus(id);
    return id;
  }
  if ((await liveConversations()).has(id)) throw new Error('this conversation is open in a terminal that is not a Ghostty tab');
  const meta = await conversationMeta(opts.worktree, id);
  if (!meta) throw new Error('conversation not found in this worktree');
  sessions.insert({
    id, repoId: opts.repoId, worktree: opts.worktree, cwd: opts.worktree, pid: null, tty: null,
    title: meta.title, firstPrompt: meta.firstPrompt, status: 'idle',
  });
  await launch(id, opts.worktree, ['--resume', id]);
  notify();
  return id;
}

export async function openShell(worktree: string, command?: string | null) {
  await ghostty.newTab(worktree, command ?? '');
}

async function ttyOf(pid: number) {
  const { stdout } = await run('/bin/ps', ['-o', 'tty=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
  const tty = stdout.trim();
  return tty && tty !== '??' ? `/dev/${tty}` : null;
}

async function locateWorktree(cwd: string) {
  const find = () => workspace()
    .flatMap((r) => r.worktrees.map((w) => ({ repoId: r.id, path: w.path })))
    .filter((w) => cwd === w.path || cwd.startsWith(`${w.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const found = find();
  if (found) return found;
  const root = await repoRoot(cwd).catch(() => null);
  if (!root) return undefined;
  if (!repos.all().some((r) => r.path === root) && !repos.addFound(root)) return undefined;
  await refreshWorkspace();
  return find();
}

const statusOf = (p: LiveProcess): SessionStatus => (p.status === 'busy' ? 'working' : p.status === 'waiting' ? 'waiting' : 'idle');

const ignored = new Map<string, number>();

async function adopt(id: string, p: LiveProcess) {
  const at = ignored.get(id);
  if (at && Date.now() - at < IGNORE_RETRY_MS) return false;
  const worktree = await locateWorktree(p.cwd);
  if (!worktree) {
    ignored.set(id, Date.now());
    return false;
  }
  ignored.delete(id);
  const meta = await conversationMeta(p.cwd, id);
  sessions.insert({
    id, repoId: worktree.repoId, worktree: worktree.path, cwd: p.cwd, pid: p.pid, tty: await ttyOf(p.pid),
    title: meta?.title ?? null, firstPrompt: meta?.firstPrompt ?? null, status: statusOf(p),
  });
  void refreshDiffstat(id);
  return true;
}

async function readTranscript(s: Session) {
  const meta = await conversationMeta(s.cwd, s.id);
  if (!meta) return false;
  const patch: Parameters<typeof sessions.update>[1] = {};
  if (meta.title && meta.title !== s.title) patch.title = meta.title;
  if (meta.firstPrompt && !s.firstPrompt) patch.firstPrompt = meta.firstPrompt;
  if (meta.lastMessage !== s.lastMessage) patch.lastMessage = meta.lastMessage;
  const pr = meta.pr && { ...meta.pr, url: meta.pr.id ? await pullRequestUrl(s.worktree, meta.pr.id) : null };
  if (JSON.stringify(pr) !== JSON.stringify(s.pr)) patch.pr = pr;
  const ask = meta.ask && meta.ask.toolUseId !== s.dismissedAsk ? meta.ask : null;
  if (ask?.toolUseId !== s.question?.toolUseId) {
    const input = ask && askInput.safeParse(ask.input);
    patch.question = input?.success
      ? { toolUseId: ask!.toolUseId, ...input.data, options: input.data.options ?? [], askedAt: ask!.at }
      : null;
    patch.rank = null;
    patch.rankReason = null;
    patch.advice = null;
    stopAdvice(s.id);
    scheduleRerank();
  }
  sessions.update(s.id, patch);
  return Object.keys(patch).length > 0;
}

let syncing = false;

export async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    await syncLive();
  } finally {
    syncing = false;
  }
}

async function syncLive() {
  const live = await liveConversations();
  const livePids = new Set([...live.values()].map((p) => p.pid));
  let changed = false;
  for (const [id, p] of live) {
    const s = sessions.get(id);
    if (!s) {
      changed = (await adopt(id, p)) || changed;
      continue;
    }
    const status = statusOf(p);
    if (s.pid !== p.pid || s.status !== status || s.waitingFor !== p.waitingFor) {
      sessions.update(id, { pid: p.pid, tty: s.pid === p.pid ? s.tty : await ttyOf(p.pid), status, waitingFor: p.waitingFor });
      if (s.status === 'working' && status !== 'working') void refreshDiffstat(id);
      changed = true;
    }
  }
  for (const s of sessions.all()) {
    if (s.status === 'exited' || live.has(s.id)) {
      if (s.status !== 'exited') changed = (await readTranscript(s)) || changed;
      continue;
    }
    if (s.pid === null && Date.now() - s.updatedAt < STARTUP_GRACE_MS) continue;
    // The process lives on in another conversation after /clear or /resume; this one is done.
    const replaced = s.pid !== null && livePids.has(s.pid);
    sessions.update(s.id, { status: 'exited', pid: null, waitingFor: null, ...(replaced && { archived: true }) });
    await readTranscript(s);
    void refreshDiffstat(s.id);
    changed = true;
  }
  if (changed) notify();
  adviseOpen();
}

function liveTty(s: Session) {
  if (s.status === 'exited') throw new Error('this session has ended; continue it first');
  if (!s.tty) throw new Error('this session has no terminal yet');
  return s.tty;
}

export async function focus(id: string) {
  const s = must(id);
  if (s.status === 'exited') await continueConversation({ repoId: s.repoId, worktree: s.worktree, continueId: id });
  else await ghostty.focus(liveTty(s));
}

export async function answer(id: string, reply: { choice?: string; text?: string }) {
  const s = must(id);
  const tty = liveTty(s);
  if (!reply.choice && !reply.text?.trim()) throw new Error('empty answer');
  const parts = [s.question ? `Re: "${s.question.title}"` : '', reply.choice ? `My decision: ${reply.choice}.` : '', reply.text?.trim() ?? '']
    .filter(Boolean);
  await ghostty.send(tty, parts.join(' — '));
  clearQuestion(id);
  notify();
}

export async function acceptAdvice(id: string) {
  const a = must(id).advice;
  if (a?.state !== 'done') throw new Error('no advice to accept');
  await answer(id, { choice: a.choice ?? undefined, text: a.answer });
}

export function quit(id: string) {
  const s = must(id);
  if (s.pid) process.kill(s.pid, 'SIGTERM');
}

export async function forget(id: string) {
  const s = must(id);
  if (s.status !== 'exited') throw new Error('quit this session first, or archive it');
  sessions.remove(id);
  await rm(join(SESSIONS_DIR, id), { recursive: true, force: true });
  scheduleRerank();
  notify();
}

export function archive(id: string, archived: boolean) {
  must(id);
  sessions.update(id, { archived });
  notify();
}

export function stopWorktree(worktree: string) {
  for (const s of sessions.all().filter((s) => s.worktree === worktree)) if (s.pid) process.kill(s.pid, 'SIGTERM');
  sessions.removeByWorktree(worktree);
  scheduleRerank();
  notify();
}

function clearQuestion(id: string) {
  const s = sessions.get(id);
  if (!s?.question) return;
  sessions.update(id, { question: null, dismissedAsk: s.question.toolUseId, rank: null, rankReason: null, advice: null });
  stopAdvice(id);
  scheduleRerank();
}

export function dismiss(id: string) {
  must(id);
  clearQuestion(id);
  notify();
}

const diffInFlight = new Set<string>();

export async function refreshDiffstat(id: string) {
  const s = sessions.get(id);
  const repo = s && repoView(s.repoId);
  if (!s || !repo || diffInFlight.has(s.worktree)) return;
  diffInFlight.add(s.worktree);
  try {
    const { stat } = await fullDiff(s.worktree, repo.base, true);
    for (const other of sessions.all().filter((o) => o.worktree === s.worktree)) sessions.update(other.id, { diffstat: stat });
    notify();
  } catch (err) {
    console.warn('diffstat failed', s.worktree, err);
  } finally {
    diffInFlight.delete(s.worktree);
  }
}

function must(id: string) {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session ${id}`);
  return s;
}
