import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { adviseOpen } from './advisor.ts';
import { answering } from './answering.ts';
import { listCommands } from './commands.ts';
import { alive, conversationMeta, exchanges, guessedTranscriptFile, hookedConversation, liveConversations, parseMenu, promptImage, transcriptFile, type ConversationLog } from './conversations.ts';
import { report } from './claudeFormat.ts';
import { SESSIONS_DIR } from './config.ts';
import { checkDecision } from './decision.ts';
import { handOver, taskOf } from './handover.ts';
import { sessions, type Parent, type Session } from './db.ts';
import { quote } from './env.ts';
import { isClean, listBranches, switchBranch } from './git.ts';
import { CLAUDE } from './headless.ts';
import * as ghostty from './ghostty.ts';
import * as terminal from './terminal.ts';
import { scheduleRerank, trackDecisions } from './priority.ts';
import { notify, type RepoView } from './workspace.ts';
import { folderArgs } from './folderTasks.ts';
import { sync } from './ingest.ts';
import { checkUploads } from './uploads.ts';

const run = promisify(execFile);

// A launch script keeps the prompt out of the user's shell, whose quoting rules may not be POSIX.
async function launch(id: string, cwd: string, args: string[], setup?: string | null) {
  const dir = join(SESSIONS_DIR, id);
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'start.sh');
  const lines = ['#!/bin/sh', `cd ${quote(cwd)} || exit`, setup ?? '', `exec ${[CLAUDE, ...folderArgs(cwd), ...args].map(quote).join(' ')}`].filter(Boolean);
  await writeFile(script, `${lines.join('\n')}\n`);
  await terminal.start(id, cwd, `/bin/sh ${quote(script)}`);
}

// With a prompt, Claude starts on it at once; until it registers, idle would show a finished turn that never was.
export async function startClaude(opts: { repoId: number | null; worktree: string; prompt?: string; title?: string; setup?: string | null; parent?: Parent; model?: string; effort?: string; running?: { model: string | null; effort: string | null } }) {
  const id = randomUUID();
  sessions.insert({
    id, repoId: opts.repoId, worktree: opts.worktree, cwd: opts.worktree, pid: null, tty: null,
    title: opts.title || null, firstPrompt: opts.prompt || null, status: opts.prompt ? 'working' : 'idle',
  });
  sessions.update(id, { parent: opts.parent ?? null, ...opts.running });
  const chosen = [...(opts.model ? ['--model', opts.model] : []), ...(opts.effort ? ['--effort', opts.effort] : [])];
  try {
    await launch(id, opts.worktree, [...chosen, '--session-id', id, ...(opts.prompt ? ['--', opts.prompt] : [])], opts.setup);
  } catch (err) {
    sessions.remove(id);
    throw err;
  }
  notify();
  return id;
}

// `continueId` names a conversation; a task that ran it, now or before a /clear, picks it up again.
export async function continueConversation(opts: { repoId: number | null; worktree: string; continueId: string; cwd?: string }) {
  const id = opts.continueId;
  const cwd = opts.cwd ?? opts.worktree;
  const existing = taskOf(sessions.all(), id);
  if (existing && existing.status !== 'exited') {
    await focus(existing.id);
    return existing.id;
  }
  if ((await liveConversations()).has(id)) throw new Error('this conversation is open in a terminal that is not a Ghostty tab');
  const meta = await conversationMeta(existing?.cwd ?? cwd, id);
  // Claude writes no transcript until the first prompt, so a task never prompted starts again as it first did.
  if (!meta && existing && existing.conversation === id && !existing.firstPrompt && !existing.lastPrompt && !existing.history.length) {
    sessions.update(existing.id, { pid: null, tty: null, status: 'idle', archived: false });
    await launch(existing.id, existing.cwd, ['--session-id', id]);
    notify();
    return existing.id;
  }
  if (!meta) throw new Error('conversation not found in this worktree');
  if (existing) {
    sessions.update(existing.id, {
      ...(existing.conversation !== id && handOver(existing, id, Date.now())),
      pid: null, tty: null, status: 'idle', archived: false,
    });
    await launch(existing.id, existing.cwd, ['--resume', id]);
    notify();
    return existing.id;
  }
  sessions.insert({
    id, repoId: opts.repoId, worktree: opts.worktree, cwd, pid: null, tty: null,
    title: meta.title, firstPrompt: meta.firstPrompt, status: 'idle',
  });
  await launch(id, cwd, ['--resume', id]);
  notify();
  return id;
}

// After a restart of the Mac, every task it cut short comes back in a hidden terminal, as Continue would bring it.
export async function resumeInterrupted() {
  const failed: { id: string; error: string }[] = [];
  const tasks = sessions.all().filter((s) => s.status === 'exited' && s.interrupted && !s.archived);
  for (const s of tasks) {
    try {
      await continueConversation({ repoId: s.repoId, worktree: s.worktree, cwd: s.cwd, continueId: s.conversation });
    } catch (err) {
      failed.push({ id: s.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { resumed: tasks.length - failed.length, failed };
}

// Ended ones stay ended as any other, and resumed ones wait for you as any other.
export function dismissInterrupted() {
  for (const s of sessions.all()) if (s.interrupted) sessions.update(s.id, { interrupted: null });
  notify();
}

export async function openShell(worktree: string) {
  await ghostty.newTab(worktree, '');
}

export async function focus(id: string) {
  await answers.settled(id);
  const s = must(id);
  if (s.status === 'exited') await continueConversation({ repoId: s.repoId, worktree: s.worktree, cwd: s.cwd, continueId: s.conversation });
  else await terminal.show(s.tty, s.id, s.cwd);
}

async function isCommand(s: Session, text: string) {
  if (text.startsWith('!')) return true;
  const name = text.match(/^\/(\S+)/)?.[1];
  return !!name && (await listCommands(s.worktree)).some((c) => c.name === name);
}

export function expectDecision(id: string, seen: string | null | undefined) {
  checkDecision(must(id), seen);
}

function decided() {
  trackDecisions();
  adviseOpen();
  notify();
}

const answers = answering({ store: sessions, send: terminal.send, keys: terminal.keys, notify, decided, isCommand, checkUploads });

export const { answer, answerMenu, acceptAdvice, dismiss } = answers;

// A running Claude keeps its name in memory and writes it back to the transcript, so a live
// session is renamed with its own /rename (it runs even mid-turn); an ended one in the file.
export async function rename(id: string, title: string) {
  const s = must(id);
  const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new Error('the name is empty');
  if (s.status === 'exited') {
    const file = await transcriptFile(s.cwd, s.conversation);
    if (await stat(file).catch(() => null)) await appendFile(file, `${JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: s.id })}\n`);
  } else {
    await answers.type(id, `/rename ${name}`);
  }
  sessions.update(id, { title: name });
  notify();
}

// The task's prompts and Claude's replies, oldest first, through every conversation it had before a /clear too.
export async function conversation(id: string): Promise<ConversationLog[]> {
  const s = must(id);
  return Promise.all([...s.history.map((h) => h.id), s.conversation].map(async (c) => ({ id: c, exchanges: await exchanges(await transcriptFile(s.cwd, c)) })));
}

export async function conversationImage(id: string, conversation: string, entry: string, n: number) {
  const s = must(id);
  if (![...s.history.map((h) => h.id), s.conversation].includes(conversation) || !/^[\w-]+$/.test(entry)) return null;
  return promptImage(await transcriptFile(s.cwd, conversation), entry, n);
}

// Posted by the PreToolUse hook that `pnpm claude:connect` installs, just before the dialog opens.
export function menuOpened(hook: { session_id?: string; tool_use_id?: string; tool_input?: unknown }) {
  const menu = parseMenu(String(hook.tool_use_id ?? ''), hook.tool_input);
  const s = hook.session_id ? sessions.byConversation(hook.session_id) : undefined;
  if (!menu || !s) return;
  sessions.update(s.id, { menu });
  notify();
}

// Posted by the SessionStart, UserPromptSubmit, Stop and Notification hooks that `pnpm claude:connect` installs. Each
// one syncs at once; the poll stays to reconcile what a hook missed, such as a Claude that crashed.
export async function hookEvent(hook: { session_id?: unknown; transcript_path?: unknown; cwd?: unknown; hook_event_name?: unknown; source?: unknown }) {
  const id = typeof hook.session_id === 'string' ? hook.session_id : null;
  if (!id) return;
  const transcript = typeof hook.transcript_path === 'string' && hook.transcript_path ? hook.transcript_path : null;
  const start = hook.hook_event_name === 'SessionStart';
  hookedConversation(id, { transcript, source: start && typeof hook.source === 'string' ? hook.source : null });
  // Only at the start is the hook's cwd the folder the transcript is filed under; Claude may cd away later. Before the
  // folder exists a long path's hashed name cannot be found.
  if (start && transcript && typeof hook.cwd === 'string' && existsSync(dirname(transcript)) && (await guessedTranscriptFile(hook.cwd, id)) !== transcript) {
    report(['transcripts are no longer where Pitwall looks for them without a hook'], null);
  }
  await sync();
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
  const s = must(id);
  sessions.update(id, { archived, ...(!archived && s.resolution && { resolution: null }) });
  notify();
}

export function setPriority(id: string, priority: unknown) {
  must(id);
  if (priority !== null && priority !== 'high' && priority !== 'low') throw new Error(`unknown priority ${String(priority)}`);
  sessions.update(id, { priority });
  notify();
  scheduleRerank();
}

// Solved and Dropped also archive the subtask, so it leaves the queue; Reopen brings it back.
export function resolve(id: string, state: unknown) {
  const s = must(id);
  if (!s.parent) throw new Error('only a subtask is marked solved or dropped');
  if (state !== null && state !== 'solved' && state !== 'dropped') throw new Error('unknown resolution');
  sessions.update(id, { resolution: state ? { state, at: Date.now() } : null, archived: !!state });
  notify();
}

// Works where the branch is already checked out, else switches the main checkout to it.
export async function checkoutExistingBranch(repo: RepoView, branch: string) {
  const checkedOut = repo.worktrees.find((w) => w.branch === branch);
  if (checkedOut) return checkedOut.path;
  if (!(await listBranches(repo.path)).some((b) => b.name === branch)) throw new Error(`no branch named ${branch}`);
  const main = repo.worktrees.find((w) => w.isMain);
  if (!main) throw new Error('the main checkout is missing');
  const claudes = [...(await liveConversations()).values()].filter((p) => p.cwd === main.path || p.cwd.startsWith(`${main.path}/`));
  if (claudes.length) throw new Error(`Claude is running in ${main.path} on ${main.branch ?? 'a detached HEAD'}; switching it to ${branch} would change its files`);
  if (!(await isClean(main.path, { untracked: false }))) throw new Error(`${main.path} has uncommitted changes; commit or stash them first`);
  await switchBranch(main.path, branch);
  return main.path;
}

export function must(id: string) {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session ${id}`);
  return s;
}
