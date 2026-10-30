import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { adviseOpen } from './advisor.ts';
import { storeArtifacts } from './artifacts.ts';
import { conversationMeta, liveConversations, startSource, type Activity, type LiveProcess } from './conversations.ts';
import { repos, sessions, type Session, type SessionStatus } from './db.ts';
import { handOver, leftBy, taskOf } from './handover.ts';
import { fullDiff, pullRequestUrl, repoRoot } from './git.ts';
import * as terminal from './terminal.ts';
import { askInput } from './mcp.ts';
import { trackDecisions } from './priority.ts';
import { bootTime, interruption, pickedUp, watch } from './restart.ts';
import { summarizeStale } from './summary.ts';
import { describeLinks } from './linkAbout.ts';
import { mergeLinks } from './links.ts';
import { notify, refreshWorkspace, repoView, taskFolderOf, workspace } from './workspace.ts';
import { folderDiff, prWorktree } from './folderTasks.ts';

const run = promisify(execFile);

const STARTUP_GRACE_MS = 60_000;
const STARTUP_PROMPT_MS = 8000;
const IGNORE_RETRY_MS = 30_000;

export async function ttyOf(pid: number) {
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

// Claude between turns with work still running in the background will resume by itself, so it counts as working.
const statusOf = (p: LiveProcess, background = 0): SessionStatus =>
  p.status === 'busy' || (p.status !== 'waiting' && background > 0) ? 'working' : p.status === 'waiting' ? 'waiting' : 'idle';

function activityOf(p: LiveProcess | undefined, activity: Activity | null, background: string[]): Activity | null {
  if (!background.length) return activity;
  if (p?.status === 'busy') return { step: activity?.step ?? null, since: activity?.since ?? Date.now(), background };
  const step = `In the background · ${background[0]}${background.length > 1 ? ` and ${background.length - 1} more` : ''}`;
  return { step, since: activity?.since ?? Date.now(), background, between: true };
}

// Only a conversation that /clear started takes over the task its Claude left; one that /resume opened does not, nor a
// new one without its transcript yet, which /resume never opens.
const startedByClear = async (cwd: string, conversation: string) => {
  const source = startSource(conversation);
  if (source) return source === 'clear';
  const meta = await conversationMeta(cwd, conversation);
  return !meta || meta.cleared;
};

const ignored = new Map<string, number>();
const deleting = new Set<string>();

// A sync that started before a worktree was deleted must not bring its sessions back.
export async function withoutAdopting<T>(path: string, work: () => Promise<T>) {
  deleting.add(path);
  try {
    return await work();
  } finally {
    deleting.delete(path);
  }
}

async function adopt(id: string, p: LiveProcess) {
  const at = ignored.get(id);
  if (at && Date.now() - at < IGNORE_RETRY_MS) return false;
  const task = taskFolderOf(p.cwd);
  const worktree = task ? { repoId: null, path: task.path } : await locateWorktree(p.cwd);
  if (!worktree) {
    ignored.set(id, Date.now());
    return false;
  }
  ignored.delete(id);
  const meta = await conversationMeta(p.cwd, id);
  const tty = await ttyOf(p.pid);
  if (deleting.has(worktree.path) || !existsSync(p.cwd)) return false;
  sessions.insert({
    id, repoId: worktree.repoId, worktree: worktree.path, cwd: p.cwd, pid: p.pid, tty,
    title: meta?.title ?? null, firstPrompt: meta?.firstPrompt ?? null, status: statusOf(p),
  });
  void refreshDiffstat(id);
  return true;
}

async function readTranscript(s: Session, p?: LiveProcess) {
  const meta = await conversationMeta(s.cwd, s.conversation);
  if (!meta) return false;
  const patch: Parameters<typeof sessions.update>[1] = {};
  if (meta.title && meta.title !== s.title) patch.title = meta.title;
  if (meta.firstPrompt && !s.firstPrompt) patch.firstPrompt = meta.firstPrompt;
  if (meta.lastMessage !== s.lastMessage) patch.lastMessage = meta.lastMessage;
  // A reply whose prompt has left the part read keeps the prompt read with it before.
  const lastPrompt = meta.lastPrompt ?? (meta.lastMessage === s.lastMessage ? s.lastPrompt : null);
  if (lastPrompt !== s.lastPrompt) patch.lastPrompt = lastPrompt;
  // A request names the model without the [1m] of a 1M context, which the model picked keeps.
  if (meta.model && meta.model !== s.model?.replace('[1m]', '')) patch.model = meta.model;
  if (meta.effort && meta.effort !== s.effort) patch.effort = meta.effort;
  const lastTurn = meta.turns.at(-1)?.id ?? null;
  if (lastTurn !== s.lastTurn) patch.lastTurn = lastTurn;
  if (JSON.stringify(meta.turnError) !== JSON.stringify(s.turnError)) patch.turnError = meta.turnError;
  const background = meta.background.filter(([id]) => !meta.greenWatches.includes(id)).map(([, what]) => what);
  const activity = activityOf(p, meta.activity, background);
  if (JSON.stringify(activity) !== JSON.stringify(s.activity)) patch.activity = activity;
  const status = p && statusOf(p, background.length);
  if (status && status !== s.status) patch.status = status;
  if (s.menu && meta.toolResults.includes(s.menu.toolUseId)) patch.menu = null;
  const artifacts = await storeArtifacts(s, meta.artifacts);
  if (artifacts) patch.artifacts = artifacts;
  const links = mergeLinks(s.links, meta.links);
  if (links) patch.links = links;
  const prs = await Promise.all(meta.prs.map(async ({ dir, repository, ...pr }) => {
    const worktree = prWorktree(s, dir, repository);
    return { ...pr, url: pr.id && worktree ? await pullRequestUrl(worktree.path, pr.id) : null, repo: s.repoId === null ? worktree?.repo ?? null : null };
  }));
  if (JSON.stringify(prs) !== JSON.stringify(s.prs)) patch.prs = prs;
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
let again = false;

export async function sync() {
  if (syncing) {
    again = true;
    return;
  }
  syncing = true;
  try {
    do {
      again = false;
      await syncLive();
    } while (again);
  } finally {
    syncing = false;
  }
}

async function syncLive() {
  const live = await liveConversations();
  const livePids = new Set([...live.values()].map((p) => p.pid));
  let changed = false;
  for (const [conversation, p] of live) {
    let s = taskOf(sessions.all(), conversation);
    if (!s) {
      const left = leftBy(sessions.all(), p.pid, new Set(live.keys()));
      if (!left || !(await startedByClear(p.cwd, conversation))) {
        changed = (await adopt(conversation, p)) || changed;
        continue;
      }
      sessions.update(left.id, handOver(left, conversation, Date.now()));
      s = sessions.get(left.id)!;
      changed = true;
    } else if (s.conversation !== conversation) {
      sessions.update(s.id, handOver(s, conversation, Date.now()));
      changed = true;
    }
    // A conversation that left its task by /resume and came back brings the task back.
    if (s.status === 'exited' && s.archived && !s.resolution) {
      sessions.update(s.id, { archived: false });
      changed = true;
    }
    const status = statusOf(p, s.activity?.background?.length);
    if (s.interrupted && pickedUp(s.interrupted, status)) {
      sessions.update(s.id, { interrupted: null });
      changed = true;
    }
    if (s.pid !== p.pid || s.status !== status || s.waitingFor !== p.waitingFor) {
      sessions.update(s.id, { pid: p.pid, tty: s.pid === p.pid ? s.tty : await ttyOf(p.pid), status, waitingFor: p.waitingFor, ...(status === 'idle' && { menu: null }) });
      if (s.status === 'working' && status !== 'working') void refreshDiffstat(s.id);
      changed = true;
    }
  }
  let starting: Set<string> | undefined;
  for (const s of sessions.all()) {
    if (s.status === 'exited' || live.has(s.conversation)) {
      if (s.status !== 'exited') changed = (await readTranscript(s, live.get(s.conversation))) || changed;
      continue;
    }
    // Claude registers itself only once past prompts such as trusting a new folder, which a
    // hidden terminal would keep out of sight.
    starting ??= s.pid === null ? await terminal.tmuxSessions() : undefined;
    if (s.pid === null && starting?.has(s.id)) {
      if (s.status !== 'waiting' && Date.now() - s.updatedAt > STARTUP_PROMPT_MS) {
        sessions.update(s.id, { status: 'waiting', waitingFor: 'its start-up prompt' });
        changed = true;
      }
      continue;
    }
    if (s.pid === null && Date.now() - s.updatedAt < STARTUP_GRACE_MS) continue;
    // The process lives on in another conversation after a /resume; this task is done. A /clear took the task with it.
    // After a restart the pid may be another process's.
    const interrupted = interruption(s, await bootTime());
    const replaced = !interrupted && s.pid !== null && livePids.has(s.pid);
    sessions.update(s.id, { status: 'exited', pid: null, waitingFor: null, menu: null, ...(interrupted && { interrupted }), ...(replaced && { archived: true }) });
    await readTranscript(s);
    void refreshDiffstat(s.id);
    changed = true;
  }
  trackDecisions();
  if (watch(sessions.all())) changed = true;
  if (changed) notify();
  adviseOpen();
  void summarizeStale();
  void describeLinks();
}

const diffInFlight = new Set<string>();

export async function refreshDiffstat(id: string) {
  const s = sessions.get(id);
  const repo = s && repoView(s.repoId);
  if (!s || (!repo && s.repoId !== null) || diffInFlight.has(s.worktree)) return;
  diffInFlight.add(s.worktree);
  try {
    const { stat } = repo ? await fullDiff(s.worktree, repo.base, { statOnly: true }) : await folderDiff(s.worktree, { statOnly: true });
    for (const other of sessions.all().filter((o) => o.worktree === s.worktree)) sessions.update(other.id, { diffstat: stat });
    notify();
  } catch (err) {
    console.warn('diffstat failed', s.worktree, err);
  } finally {
    diffInFlight.delete(s.worktree);
  }
}
