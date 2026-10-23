import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './git.ts';

const MAX_DEPTH = 5;
const SKIP = new Set(['node_modules', 'Library', 'vendor', 'dist', 'build', 'target', 'Pods', 'DerivedData']);

// Finds main repos below `root`. Worktrees (a `.git` file) resolve to their main
// repo, so a worktree folder whose repo lives elsewhere still finds that repo.
export async function findRepos(root: string, known: Set<string>): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const git = entries.find((e) => e.name === '.git');
    if (git) {
      if (git.isDirectory()) found.add(dir);
      else if (!known.has(dir)) {
        const main = await repoRoot(dir).catch(() => null);
        if (main) found.add(main);
      }
      return;
    }
    if (depth >= MAX_DEPTH) return;
    await Promise.all(entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
      .map((e) => walk(join(dir, e.name), depth + 1)));
  };
  await walk(root, 0);
  return found;
}
