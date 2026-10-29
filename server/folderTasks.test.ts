import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { repos } from './db.ts';
import { folderArgs, folderDiff, makeTaskFolder, openWorktree, prWorktree } from './folderTasks.ts';
import { folders, placeOf, refreshWorkspace, taskFolderOf, taskWorktrees } from './workspace.ts';

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

function repoIn(folder: string, name: string) {
  const main = join(folder, name);
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'readme.txt'), `${name}\n`);
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  repos.add(main);
  return main;
}

async function folderOfTwo() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-folder-')));
  const web = repoIn(folder, 'web');
  const api = repoIn(folder, 'api');
  await refreshWorkspace();
  return { folder, web, api };
}

test('a folder with two repositories takes a task that opens a worktree only in the repositories it changes', async () => {
  const { folder, api } = await folderOfTwo();
  assert.deepEqual(folders().find((f) => f.path === folder)?.repos.length, 2);

  const task = await makeTaskFolder(folder, 'cross-cut');
  assert.equal(task, join(folder, 'worktrees', 'cross-cut'));
  assert.equal(taskFolderOf(task)?.name, 'cross-cut');
  await assert.rejects(makeTaskFolder(folder, 'cross-cut'), /already exists/);
  await assert.rejects(makeTaskFolder(folder, 'a b'), /cannot name a branch/);
  assert.deepEqual(taskWorktrees(task), []);
  assert.match(placeOf({ repoId: null, worktree: task }), /none yet/);

  const opened = await openWorktree({ repo: 'API', task_folder: `${task}/` });
  assert.deepEqual(opened, { path: join(task, 'api'), branch: 'cross-cut', base: 'main', setup: null });
  assert.equal(git(opened.path, 'branch', '--show-current'), 'cross-cut');
  assert.deepEqual(await openWorktree({ repo: 'api', task_folder: task }), opened);
  assert.deepEqual(taskWorktrees(task).map(({ repo }) => repo.path), [api]);

  await assert.rejects(openWorktree({ repo: 'docs', task_folder: task }), /pick one of web, api|pick one of api, web/);
  await assert.rejects(openWorktree({ repo: 'api', task_folder: folder }), /not a Pitwall task folder/);
});

test('the task folder diff puts each repository\'s changes under its folder', async () => {
  const { folder } = await folderOfTwo();
  const task = await makeTaskFolder(folder, 'both');
  const web = (await openWorktree({ repo: 'web', task_folder: task })).path;
  const api = (await openWorktree({ repo: 'api', task_folder: task })).path;
  writeFileSync(join(web, 'page.txt'), 'new page\n');
  git(api, 'mv', 'readme.txt', 'README.txt');

  const diff = await folderDiff(task);
  assert.deepEqual(diff.stat, { files: 2, insertions: 1, deletions: 0 });
  assert.match(diff.patch, /^diff --git a\/web\/page\.txt b\/web\/page\.txt$/m);
  assert.match(diff.patch, /^rename from api\/readme\.txt$/m);
  assert.match(diff.patch, /^rename to api\/README\.txt$/m);

  const one = await folderDiff(task, { paths: ['web/page.txt'] });
  assert.equal(one.stat.files, 1);
  assert.match(one.patch, /\+\+\+ b\/web\/page\.txt/);
});

test('a Claude in a task folder starts with the layout explained and the folder readable', async () => {
  const { folder } = await folderOfTwo();
  const task = await makeTaskFolder(folder, 'explained');
  const args = folderArgs(task);
  assert.equal(args[0], '--append-system-prompt');
  assert.match(args[1], /on the branch explained/);
  assert.ok(args.includes(`Read(/${folder}/**)`));
  assert.deepEqual(folderArgs(join(folder, 'web')), []);
  assert.ok(existsSync(task));
});

test('a PR of a task across repos belongs to the worktree its command ran in, else the repository az named, else the only one', async () => {
  const { folder } = await folderOfTwo();
  const task = { repoId: null, worktree: await makeTaskFolder(folder, 'prs') };
  const web = (await openWorktree({ repo: 'web', task_folder: task.worktree })).path;
  assert.deepEqual(prWorktree(task, null, null), { path: web, repo: 'web' });
  const api = (await openWorktree({ repo: 'api', task_folder: task.worktree })).path;
  assert.deepEqual(prWorktree(task, join(api, 'src'), 'web'), { path: api, repo: 'api' });
  assert.deepEqual(prWorktree(task, task.worktree, 'WEB'), { path: web, repo: 'web' });
  assert.equal(prWorktree(task, task.worktree, null), undefined);
  assert.deepEqual(prWorktree({ repoId: 1, worktree: '/w' }, '/elsewhere', 'web'), { path: '/w', repo: null });
});
