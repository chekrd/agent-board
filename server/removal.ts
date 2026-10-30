import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { stopAdvice } from './advisor.ts';
import { alive, liveConversations } from './conversations.ts';
import { SESSIONS_DIR } from './config.ts';
import { sessions, type Session } from './db.ts';
import { changedFiles, isClean, removeWorktree, unpushedCommits } from './git.ts';
import * as ghostty from './ghostty.ts';
import * as terminal from './terminal.ts';
import { ttyOf, withoutAdopting } from './ingest.ts';
import { scheduleRerank } from './priority.ts';
import { must } from './sessions.ts';
import { notify, refreshWorkspace, repoView, taskWorktrees, workspace, type RepoView } from './workspace.ts';

export async function stopWorktree(worktree: string) {
  const gone = sessions.all().filter((s) => s.worktree === worktree);
  for (const s of gone) if (s.pid && alive(s.pid)) process.kill(s.pid, 'SIGTERM');
  sessions.removeByWorktree(worktree);
  await Promise.all(gone.map((s) => rm(join(SESSIONS_DIR, s.id), { recursive: true, force: true })));
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
  try {
    await withoutAdopting(path, work);
  } finally {
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
    await stopWorktree(path);
  });
}

const longLived = (repo: RepoView, branch: string) =>
  ['master', 'main', 'develop', 'trunk', repo.base, repo.base.replace(/^[^/]+\//, '')].includes(branch) || branch.startsWith('release/');

const subtasksOf = (id: string): Session[] => sessions.all().filter((o) => o.parent?.id === id).flatMap((o) => [o, ...subtasksOf(o.id)]);

// What Clear task would throw away or leave unpushed, for its confirmation. A task in the main checkout keeps it, and its branch.
export async function deleteWorktreeLoss(id: string) {
  const s = must(id);
  if (s.parent) throw new Error(NOT_A_SUBTASK);
  const subtasks = subtasksOf(id).length;
  if (s.repoId === null) return taskFolderLoss(s.worktree, subtasks);
  const worktree = repoView(s.repoId)?.worktrees.find((w) => w.path === s.worktree);
  if (!worktree) return { branch: null, deletesBranch: false, files: 0, commits: 0, checkout: true, gone: true, subtasks };
  if (worktree.isMain) return { branch: worktree.branch, deletesBranch: false, files: 0, commits: 0, checkout: true, subtasks };
  const repo = repoView(s.repoId)!;
  const deletesBranch = !!worktree.branch && !longLived(repo, worktree.branch);
  const [files, commits] = await Promise.all([changedFiles(s.worktree), unpushedCommits(s.worktree)]);
  return { branch: worktree.branch, deletesBranch, files, commits, subtasks };
}

async function taskFolderLoss(folder: string, subtasks: number) {
  const repos = await Promise.all(taskWorktrees(folder).map(async ({ repo, worktree }) => {
    const deletesBranch = !!worktree.branch && !longLived(repo, worktree.branch);
    const [files, commits] = await Promise.all([changedFiles(worktree.path), unpushedCommits(worktree.path)]);
    return { name: repo.name, branch: worktree.branch, deletesBranch, files, commits };
  }));
  return {
    branch: basename(folder),
    deletesBranch: repos.some((r) => r.deletesBranch),
    files: repos.reduce((n, r) => n + r.files, 0),
    commits: repos.reduce((n, r) => n + r.commits, 0),
    gone: !existsSync(folder),
    subtasks,
    repos,
  };
}

// A task folder goes with every worktree in it, each with its branch, and then the folder itself, unless something
// other than those worktrees left a repository in it.
async function removeTaskFolder(folder: string) {
  const inside = (path: string) => path === folder || path.startsWith(`${folder}/`);
  try {
    await withoutAdopting(folder, async () => {
      const claudes = [...(await liveConversations()).values()].filter((p) => inside(p.cwd));
      const ttys = (await Promise.all(claudes.map((p) => ttyOf(p.pid)))).filter((t) => t !== null);
      const gone = sessions.all().filter((o) => inside(o.worktree));
      for (const o of gone) stopAdvice(o.id);
      for (const p of claudes) if (alive(p.pid)) process.kill(p.pid, 'SIGTERM');
      await waitForExit(claudes.map((p) => p.pid), 10_000);
      await ghostty.closeTerminalsIn(folder, ttys);
      await Promise.all(gone.map((o) => terminal.stop(o.id)));
      for (const { repo, worktree } of taskWorktrees(folder)) {
        await withoutAdopting(worktree.path, async () => {
          await removeWorktree(repo.path, worktree.path, { force: true, deleteBranch: !!worktree.branch && !longLived(repo, worktree.branch) });
          await stopWorktree(worktree.path);
        });
      }
      const left = await readdir(folder).catch(() => []);
      if (left.some((e) => existsSync(join(folder, e, '.git')))) console.warn(`kept ${folder}: a repository is still in it`);
      else await rm(folder, { recursive: true, force: true });
      await stopWorktree(folder);
    });
  } finally {
    await refreshWorkspace();
  }
}

const NOT_A_SUBTASK = "a subtask works in its task's worktree; Quit Claude or Archive it instead";

// Clear task: in a worktree of its own, everything in it goes, the worktree and its branch too, subtasks with it. In
// the main checkout, which other Claudes may share, or in a worktree already removed, only the Claudes and terminals
// of the task and its subtasks go, with them. A hidden terminal goes by its name: the Claude in it may have moved on
// to another conversation, which leaves the task without its pid. A subtask is not cleared on its own: it shares its
// task's worktree.
export async function deleteWorktree(id: string) {
  const s = must(id);
  if (s.parent) throw new Error(NOT_A_SUBTASK);
  if (s.repoId === null) return removeTaskFolder(s.worktree);
  const repo = repoView(s.repoId);
  const worktree = repo?.worktrees.find((w) => w.path === s.worktree);
  if (repo && worktree && !worktree.isMain) return removeWorktreeAndSessions(repo, s.worktree, { force: true, deleteBranch: true });
  const gone = [s, ...subtasksOf(id)];
  for (const o of gone) stopAdvice(o.id);
  const pids = gone.flatMap((o) => (o.pid && alive(o.pid) ? [o.pid] : []));
  const ttys = (await Promise.all(gone.map((o) => (o.pid && alive(o.pid) ? (o.tty ?? ttyOf(o.pid)) : null)))).filter((t) => t !== null);
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  await waitForExit(pids, 10_000);
  if (ttys.length) await ghostty.closeTerminalsIn(null, ttys);
  await Promise.all(gone.map((o) => terminal.stop(o.id)));
  for (const o of gone) sessions.remove(o.id);
  await Promise.all(gone.map((o) => rm(join(SESSIONS_DIR, o.id), { recursive: true, force: true })));
  scheduleRerank();
  notify();
}
