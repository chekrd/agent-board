import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { OPEN_WORKTREE_TOOL_NAME } from './config.ts';
import { addWorktree, fullDiff, validBranch, type DiffStat, type FullDiff } from './git.ts';
import { folders, refreshWorkspace, taskFolderOf, taskWorktrees } from './workspace.ts';

export async function makeTaskFolder(folderPath: string, name: string) {
  const folder = folders().find((f) => f.path === folderPath);
  if (!folder) throw new Error('unknown folder');
  if (!name || name.includes('/') || name === '.' || name === '..' || !(await validBranch(name))) throw new Error(`${name} cannot name a branch`);
  const path = join(folder.path, 'worktrees', name);
  if (existsSync(path)) throw new Error(`${path} already exists; pick another name`);
  await mkdir(path, { recursive: true });
  return path;
}

// Added to every Claude that starts or resumes in a task folder, subtasks too.
export function folderArgs(cwd: string) {
  const task = taskFolderOf(cwd);
  if (!task) return [];
  const repos = task.repos.map((r) => `- ${r.name}: ${r.path}`).join('\n');
  const prompt = `You work on a task that can span several git repositories. Your working directory ${task.path} is the task's folder, not a repository. The repositories are these main checkouts in ${task.folder.path}:
${repos}
Read them freely, but never edit files, commit, switch branches or run anything that writes in a main checkout.
Before you change anything in a repository, call the ${OPEN_WORKTREE_TOOL_NAME} tool with its name and your working directory: it creates the worktree ${task.path}/<repository> on the branch ${task.name} (or returns the one that exists), and you make that repository's changes only there. Open worktrees only in the repositories the task needs to change, when you come to change them. When the tool returns a setup command, run it in that worktree before building or testing there.`;
  return ['--append-system-prompt', prompt, '--allowedTools', `Read(/${task.folder.path}/**)`, OPEN_WORKTREE_TOOL_NAME];
}

export async function openWorktree(input: { repo: string; task_folder: string }) {
  const task = taskFolderOf(resolve(input.task_folder));
  if (!task || !existsSync(task.path)) {
    throw new Error(`${input.task_folder} is not a Pitwall task folder (<folder>/worktrees/<task>, where the folder holds two or more repositories); only a task started across a folder of repositories opens worktrees this way`);
  }
  const wanted = input.repo.trim();
  const repo = task.repos.find((r) => r.name.toLowerCase() === wanted.toLowerCase() || r.path === wanted);
  if (!repo) throw new Error(`${task.folder.path} has no repository ${wanted}; pick one of ${task.repos.map((r) => r.name).join(', ')}`);
  const path = await addWorktree(repo.path, {
    branch: task.name, task: task.name, base: repo.base, root: join(task.folder.path, 'worktrees'), path: join(task.path, repo.name),
  });
  await refreshWorkspace();
  return { path, branch: task.name, base: repo.base, setup: repo.setupCommand };
}

const NO_CHANGES: DiffStat = { files: 0, insertions: 0, deletions: 0 };

// The task's worktrees as one diff, each file under its repository's folder. With `paths`, only the worktrees they
// fall in are read.
export async function folderDiff(taskFolder: string, opts: { statOnly?: boolean; paths?: string[] } = {}): Promise<FullDiff> {
  const parts = await Promise.all(taskWorktrees(taskFolder).map(async ({ repo, worktree }) => {
    const prefix = relative(taskFolder, worktree.path);
    const paths = opts.paths?.filter((p) => p.startsWith(`${prefix}/`)).map((p) => p.slice(prefix.length + 1));
    if (paths && !paths.length) return null;
    return { name: repo.name, diff: await fullDiff(worktree.path, repo.base, { ...opts, paths, prefix }) };
  }));
  const read = parts.filter((p) => p !== null);
  return {
    base: read.map((p) => `${p.name} ${p.diff.base}`).join(', ') || 'the base branches',
    mergeBase: '',
    patch: read.map((p) => p.diff.patch).filter(Boolean).map((p) => (p.endsWith('\n') ? p : `${p}\n`)).join(''),
    stat: read.reduce((sum, p) => ({
      files: sum.files + p.diff.stat.files, insertions: sum.insertions + p.diff.stat.insertions, deletions: sum.deletions + p.diff.stat.deletions,
    }), NO_CHANGES),
  };
}
