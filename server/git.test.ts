import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedFiles, fullDiff, pullRequestUrlOf, unsharedCommits } from './git.ts';

const GIT_WT = join(import.meta.dirname, '..', 'scripts', 'git-wt');
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const wt = (cwd: string, ...args: string[]) => execFileSync(GIT_WT, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir: string, file: string, content: string) => writeFileSync(join(dir, file), content);

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-board-git-')));
  const main = join(root, 'app');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'master');
  write(main, 'a.txt', 'one\ntwo\nthree\n');
  write(main, '.gitignore', '*.log\n.env\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  return { root, main };
}

test('the diff merges committed, staged, unstaged and untracked changes and leaves the index alone', async () => {
  const { main } = repo();
  git(main, 'switch', '-qc', 'feature');
  write(main, 'b.txt', 'committed\n');
  git(main, 'add', 'b.txt');
  git(main, 'commit', '-qm', 'b');
  write(main, 'c.txt', 'staged\n');
  git(main, 'add', 'c.txt');
  write(main, 'a.txt', 'one\nTWO\nthree\n');
  write(main, 'd.txt', 'untracked\n');
  write(main, 'e.log', 'ignored\n');
  const indexBefore = git(main, 'diff', '--cached', '--name-only');

  const diff = await fullDiff(main, 'master');
  assert.deepEqual(diff.stat, { files: 4, insertions: 4, deletions: 1 });
  for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) assert.match(diff.patch, new RegExp(`b/${file}`));
  assert.doesNotMatch(diff.patch, /e\.log/);
  assert.equal(git(main, 'diff', '--cached', '--name-only'), indexBefore);

  const one = await fullDiff(main, 'master', { paths: ['a.txt'] });
  assert.equal(one.stat.files, 1);
  assert.match(one.patch, / one\n-two\n\+TWO\n three/);
});

// The edit keeps the size and the mtime of a.txt, and the index looks written in that same second, so only a
// re-read of the file shows the change.
test('a same-size edit made in the second the index was written is in the diff', async () => {
  const { main } = repo();
  const then = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
  utimesSync(join(main, 'a.txt'), then, then);
  git(main, 'update-index', '--refresh');
  write(main, 'a.txt', 'one\nTWO\nthree\n');
  utimesSync(join(main, 'a.txt'), then, then);
  utimesSync(join(main, '.git', 'index'), then, then);

  const diff = await fullDiff(main, 'master');
  assert.match(diff.patch, / one\n-two\n\+TWO\n three/);
});

test('git wt lays out task folders, copies .worktreeinclude files and removes cleanly', async () => {
  const { root, main } = repo();
  write(main, '.env', 'SECRET=1\n');
  write(main, '.worktreeinclude', '.env\n');

  const path = wt(main, 'add', 'feat/x', '--task', 'task-1');
  assert.equal(path, join(root, 'worktrees', 'task-1', 'app'));
  assert.equal(git(path, 'branch', '--show-current'), 'feat/x');
  assert.equal(readFileSync(join(path, '.env'), 'utf8'), 'SECRET=1\n');
  assert.equal(wt(main, 'add', 'feat/x', '--task', 'task-1'), path, 'adding again reuses the worktree');
  assert.throws(() => wt(main, 'add', 'other', '--path', path), /already exists on branch feat\/x/);

  write(path, 'new.txt', 'x\n');
  git(path, 'add', 'new.txt');
  git(path, 'commit', '-qm', 'one');
  write(path, 'new.txt', 'y\n');
  git(path, 'commit', '-qam', 'two');
  write(path, 'dirty.txt', 'x\n');
  assert.equal(await unsharedCommits(path, 'feat/x'), 2);
  assert.equal(await changedFiles(path), 1);

  wt(main, 'rm', path, '--force', '--delete-branch');
  assert.equal(existsSync(join(root, 'worktrees', 'task-1')), false, 'the empty task folder goes too');
  assert.equal(git(main, 'branch', '--list', 'feat/x'), '');
});

test('commits another branch also has are not counted as lost', async () => {
  const { main } = repo();
  git(main, 'switch', '-qc', 'feature');
  write(main, 'f.txt', 'x\n');
  git(main, 'add', 'f.txt');
  git(main, 'commit', '-qm', 'f');
  assert.equal(await unsharedCommits(main, 'feature'), 1);
  git(main, 'branch', 'backup');
  assert.equal(await unsharedCommits(main, 'feature'), 0);
});

test('pull request links for Azure DevOps and GitHub remotes', () => {
  assert.equal(pullRequestUrlOf('git@ssh.dev.azure.com:v3/org/Proj/repo', 7), 'https://dev.azure.com/org/Proj/_git/repo/pullrequest/7');
  assert.equal(pullRequestUrlOf('https://org@dev.azure.com/org/Proj/_git/repo', 7), 'https://dev.azure.com/org/Proj/_git/repo/pullrequest/7');
  assert.equal(pullRequestUrlOf('git@github.com:chekrd/agent-board.git', 3), 'https://github.com/chekrd/agent-board/pull/3');
  assert.equal(pullRequestUrlOf('ssh://git@github.com:22/chekrd/agent-board.git', 3), 'https://github.com/chekrd/agent-board/pull/3');
  assert.equal(pullRequestUrlOf('https://gitlab.com/a/b.git', 3), null);
  assert.equal(pullRequestUrlOf('', 3), null);
});
