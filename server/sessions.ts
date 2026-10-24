import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { adviseOpen, stopAdvice } from './advisor.ts';
import { listCommands } from './commands.ts';
import { alive, conversationMeta, liveConversations, parseMenu, transcriptFile, type LiveProcess } from './conversations.ts';
import { SESSIONS_DIR } from './config.ts';
import { openDecision } from './decision.ts';
import { repos, sessions, type Session, type SessionStatus } from './db.ts';
import { quote } from './env.ts';
import { changedFiles, fullDiff, isClean, listBranches, pullRequestUrl, removeWorktree, repoRoot, switchBranch, unsharedCommits } from './git.ts';
import { CLAUDE } from './headless.ts';
import * as ghostty from './ghostty.ts';
import { menuKeystrokes, type MenuAnswer } from './menu.ts';
import { askInput } from './mcp.ts';
import { scheduleRerank, trackDecisions } from './priority.ts';
import { summarizeStale } from './summary.ts';
import { notify, refreshWorkspace, repoView, workspace, type RepoView } from './workspace.ts';
import { checkUploads } from './uploads.ts';

const run = promisify(execFile);

const STARTUP_GRACE_MS = 60_000;
const IGNORE_RETRY_MS = 30_000;

// A launch script keeps the prompt out of the user's shell, whose quoting rules may not be POSIX.
async function launch(id: string, cwd: string, args: string[], setup?: string | null) {
  const dir = join(SESSIONS_DIR, id);
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'start.sh');
  const lines = ['#!/bin/sh', `cd ${quote(cwd)} || exit`, setup ?? '', `exec ${[CLAUDE, ...args].map(quote).join(' ')}`].filter(Boolean);
  await writeFile(script, `${lines.join('\n')}\n`);
  await ghostty.newTab(cwd, `/bin/sh ${quote(script)}`);
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

export async function continueConversation(opts: { repoId: number; worktree: string; continueId: string; cwd?: string }) {
  const id = opts.continueId;
  const cwd = opts.cwd ?? opts.worktree;
  const existing = sessions.get(id);
  if (existing && existing.status !== 'exited') {
    await focus(id);
    return id;
  }
  if ((await liveConversations()).has(id)) throw new Error('this conversation is open in a terminal that is not a Ghostty tab');
  const meta = await conversationMeta(cwd, id);
  if (!meta) throw new Error('conversation not found in this worktree');
  sessions.insert({
    id, repoId: opts.repoId, worktree: opts.worktree, cwd, pid: null, tty: null,
    title: meta.title, firstPrompt: meta.firstPrompt, status: 'idle',
  });
  await launch(id, cwd, ['--resume', id]);
  notify();
  return id;
}

export async function openShell(worktree: string, setup?: string | null) {
  await ghostty.newTab(worktree, setup ? `/bin/sh -c ${quote(setup)}` : '');
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
const deleting = new Set<string>();

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
  const tty = await ttyOf(p.pid);
  // A sync that started before a worktree was deleted must not bring its sessions back.
  if (deleting.has(worktree.path) || !existsSync(p.cwd)) return false;
  sessions.insert({
    id, repoId: worktree.repoId, worktree: worktree.path, cwd: p.cwd, pid: p.pid, tty,
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
  const lastTurn = meta.turns.at(-1)?.id ?? null;
  if (lastTurn !== s.lastTurn) patch.lastTurn = lastTurn;
  if (JSON.stringify(meta.activity) !== JSON.stringify(s.activity)) patch.activity = meta.activity;
  if (s.menu && meta.toolResults.includes(s.menu.toolUseId)) patch.menu = null;
  const pr = meta.pr && { ...meta.pr, url: meta.pr.id ? await pullRequestUrl(s.worktree, meta.pr.id) : null };
  if (JSON.stringify(pr) !== JSON.stringify(s.pr)) patch.pr = pr;
  const ask = meta.ask && meta.ask.toolUseId !== s.dismissedAsk ? meta.ask : null;
  if (ask?.toolUseId !== s.question?.toolUseId) {
    const input = ask && askInput.safeParse(ask.input);
    patch.question = input?.success
      ? { toolUseId: ask!.toolUseId, ...input.data, options: input.data.options ?? [], askedAt: ask!.at }
      : null;
    // The MCP server rejected this call, so Claude never saw it as a question either.
    if (ask && !input?.success) patch.dismissedAsk = ask.toolUseId;
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
      sessions.update(id, { pid: p.pid, tty: s.pid === p.pid ? s.tty : await ttyOf(p.pid), status, waitingFor: p.waitingFor, ...(status === 'idle' && { menu: null }) });
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
    sessions.update(s.id, { status: 'exited', pid: null, waitingFor: null, menu: null, ...(replaced && { archived: true }) });
    await readTranscript(s);
    void refreshDiffstat(s.id);
    changed = true;
  }
  trackDecisions();
  if (changed) notify();
  adviseOpen();
  void summarizeStale();
}

function liveTty(s: Session) {
  if (s.status === 'exited') throw new Error('this session has ended; continue it first');
  if (!s.tty) throw new Error('this session has no terminal yet');
  return s.tty;
}

export async function focus(id: string) {
  const s = must(id);
  if (s.status === 'exited') await continueConversation({ repoId: s.repoId, worktree: s.worktree, cwd: s.cwd, continueId: id });
  else await ghostty.focus(liveTty(s));
}

async function isCommand(s: Session, text: string) {
  if (text.startsWith('!')) return true;
  const name = text.match(/^\/(\S+)/)?.[1];
  return !!name && (await listCommands(s.worktree)).some((c) => c.name === name);
}

export async function answer(id: string, reply: { choice?: string; text?: string; files?: string[] }, commands = true) {
  const s = must(id);
  const tty = liveTty(s);
  if (s.status === 'waiting' || s.menu) throw new Error(`Claude is showing ${s.waitingFor ?? 'a question'} in its terminal; answer that first`);
  const text = reply.text?.trim() ?? '';
  const files = await checkUploads(reply.files);
  if (!reply.choice && !text && !files.length) throw new Error('empty answer');
  // Slash commands and `!` shell commands go in verbatim and are not an answer to the question.
  if (commands && !reply.choice && !files.length && (await isCommand(s, text))) {
    await ghostty.send(tty, text);
    return;
  }
  const parts = [s.question ? `Re: "${s.question.title}"` : '', reply.choice ? `My decision: ${reply.choice}.` : '', reply.text?.trim() ?? '']
    .filter(Boolean);
  await ghostty.send(tty, parts.join(' — '), files);
  clearQuestion(id);
  notify();
}

// A running Claude keeps its name in memory and writes it back to the transcript, so a live
// session is renamed with its own /rename (it runs even mid-turn); an ended one in the file.
export async function rename(id: string, title: string) {
  const s = must(id);
  const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new Error('the name is empty');
  if (s.status === 'exited') {
    const file = await transcriptFile(s.cwd, s.id);
    if (await stat(file).catch(() => null)) await appendFile(file, `${JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: s.id })}\n`);
  } else {
    if (s.status === 'waiting' || s.menu) throw new Error(`Claude is showing ${s.waitingFor ?? 'a question'} in its terminal; answer that first`);
    await ghostty.send(liveTty(s), `/rename ${name}`);
  }
  sessions.update(id, { title: name });
  notify();
}

export async function answerMenu(id: string, body: { toolUseId: string; answers: MenuAnswer[] }) {
  const s = must(id);
  const tty = liveTty(s);
  const menu = s.menu;
  if (!menu || menu.toolUseId !== body.toolUseId) throw new Error('this question is no longer open');
  await ghostty.keys(tty, menuKeystrokes(menu, body.answers));
}

// Posted by the PreToolUse hook that `pnpm claude:connect` installs, just before the dialog opens.
export function menuOpened(hook: { session_id?: string; tool_use_id?: string; tool_input?: unknown }) {
  const menu = parseMenu(String(hook.tool_use_id ?? ''), hook.tool_input);
  if (!menu || !hook.session_id || !sessions.get(hook.session_id)) return;
  sessions.update(hook.session_id, { menu });
  notify();
}

export async function acceptAdvice(id: string) {
  const s = must(id);
  const a = s.advice;
  const decision = openDecision(s);
  if (a?.state !== 'done' || a.key !== decision?.key) throw new Error('no advice to accept');
  if (decision.menu) await answerMenu(id, { toolUseId: decision.menu.toolUseId, answers: a.answers ?? [] });
  else await answer(id, { choice: a.choice ?? undefined, text: a.answer }, false);
}

export async function openIn(id: string, app: 'finder' | 'vscode') {
  const s = must(id);
  if (!existsSync(s.worktree)) throw new Error(`${s.worktree} no longer exists`);
  await run('/usr/bin/open', [...(app === 'vscode' ? ['-b', 'com.microsoft.VSCode'] : []), s.worktree]);
}

export function quit(id: string) {
  const s = must(id);
  if (s.pid && alive(s.pid)) process.kill(s.pid, 'SIGTERM');
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
  for (const s of sessions.all().filter((s) => s.worktree === worktree)) if (s.pid && alive(s.pid)) process.kill(s.pid, 'SIGTERM');
  sessions.removeByWorktree(worktree);
  scheduleRerank();
  notify();
}

async function waitForExit(pids: number[], timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (pids.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  if (pids.some(alive)) throw new Error('Claude did not quit; nothing was deleted');
}

// git removes the whole directory, so a worktree inside it would lose its files.
function refuseNested(path: string) {
  const nested = workspace().flatMap((r) => r.worktrees.map((w) => w.path)).filter((p) => p.startsWith(`${path}/`));
  if (nested.length) throw new Error(`${nested.join(', ')} is a worktree inside this one; remove it first`);
}

async function removing(path: string, work: () => Promise<void>) {
  refuseNested(path);
  deleting.add(path);
  try {
    await work();
  } finally {
    deleting.delete(path);
    await refreshWorkspace();
  }
}

// Claudes go first: one still running would write into the deleted tree and recreate parts of it.
export async function removeWorktreeAndSessions(repo: RepoView, path: string, opts: { force: boolean; deleteBranch: boolean }) {
  const worktree = repo.worktrees.find((w) => w.path === path);
  if (!worktree) throw new Error('worktree not found');
  if (worktree.isMain) throw new Error('this is the repository itself, not a worktree');
  await removing(path, async () => {
    if (!opts.force && !(await isClean(path))) {
      throw new Error('the worktree has uncommitted or untracked changes; tick Force to discard them');
    }
    const claudes = [...(await liveConversations()).values()].filter((p) => p.cwd === path || p.cwd.startsWith(`${path}/`));
    const ttys = (await Promise.all(claudes.map((p) => ttyOf(p.pid)))).filter((t) => t !== null);
    for (const o of sessions.all().filter((o) => o.worktree === path)) stopAdvice(o.id);
    for (const p of claudes) if (alive(p.pid)) process.kill(p.pid, 'SIGTERM');
    await waitForExit(claudes.map((p) => p.pid), 10_000);
    await ghostty.closeTerminalsIn(path, ttys);
    const keepBranch = !worktree.branch || longLived(repo, worktree.branch);
    await removeWorktree(repo.path, path, { force: opts.force, deleteBranch: opts.deleteBranch && !keepBranch });
    stopWorktree(path);
  });
}

// Works where the branch is already checked out, else switches the main checkout to it.
export async function checkoutExistingBranch(repo: RepoView, branch: string) {
  const checkedOut = repo.worktrees.find((w) => w.branch === branch);
  if (checkedOut) return checkedOut.path;
  if (!(await listBranches(repo.path)).includes(branch)) throw new Error(`no branch named ${branch}`);
  const main = repo.worktrees.find((w) => w.isMain);
  if (!main) throw new Error('the main checkout is missing');
  const claudes = [...(await liveConversations()).values()].filter((p) => p.cwd === main.path || p.cwd.startsWith(`${main.path}/`));
  if (claudes.length) throw new Error(`Claude is running in ${main.path} on ${main.branch ?? 'a detached HEAD'}; switching it to ${branch} would change its files`);
  if (!(await isClean(main.path, { untracked: false }))) throw new Error(`${main.path} has uncommitted changes; commit or stash them first`);
  await switchBranch(main.path, branch);
  return main.path;
}

const longLived = (repo: RepoView, branch: string) =>
  ['master', 'main', 'develop', 'trunk', repo.base, repo.base.replace(/^[^/]+\//, '')].includes(branch) || branch.startsWith('release/');

// What Delete worktree would throw away, for its confirmation.
export async function deleteWorktreeLoss(id: string) {
  const s = must(id);
  const worktree = repoView(s.repoId)?.worktrees.find((w) => w.path === s.worktree);
  if (!worktree) throw new Error('worktree not found');
  const repo = repoView(s.repoId)!;
  const deletesBranch = !!worktree.branch && !longLived(repo, worktree.branch);
  const [files, commits] = await Promise.all([changedFiles(s.worktree), unsharedCommits(s.worktree, worktree.branch)]);
  return { branch: worktree.branch, deletesBranch, files, commits: deletesBranch || !worktree.branch ? commits : 0 };
}

export async function deleteWorktree(id: string) {
  const s = must(id);
  const repo = repoView(s.repoId);
  if (!repo) throw new Error('worktree not found');
  await removeWorktreeAndSessions(repo, s.worktree, { force: true, deleteBranch: true });
}

function clearQuestion(id: string) {
  const s = sessions.get(id);
  if (!s?.question) return;
  sessions.update(id, { question: null, dismissedAsk: s.question.toolUseId });
  trackDecisions();
  adviseOpen();
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
    const { stat } = await fullDiff(s.worktree, repo.base, { statOnly: true });
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
