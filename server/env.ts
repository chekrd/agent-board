import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { delimiter, dirname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const STRIPPED = /^(CLAUDECODE|CLAUDE_CODE_.*|DOCKET_.*)$/;

// The server may be started by launchd with a bare PATH, so take the environment
// the user's login shell would produce.
async function resolveLoginEnv(): Promise<NodeJS.ProcessEnv> {
  const shell = userInfo().shell || process.env.SHELL || '/bin/zsh';
  let base: NodeJS.ProcessEnv = { ...process.env };
  try {
    const { stdout } = await run(shell, ['-l', '-c', 'env -0'], { timeout: 15_000, maxBuffer: 4 << 20 });
    base = Object.fromEntries(
      stdout.split('\0').filter(Boolean).map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)];
      }),
    );
  } catch (err) {
    console.warn('login env resolution failed, using process env', err);
  }
  for (const key of Object.keys(base)) if (STRIPPED.test(key)) delete base[key];
  base.SHELL = shell;
  // Version managers such as nvm.fish put node on PATH only in interactive shells.
  const nodeDir = dirname(process.execPath);
  const path = (base.PATH ?? '').split(delimiter);
  if (!path.includes(nodeDir)) base.PATH = [...path, nodeDir].filter(Boolean).join(delimiter);
  return base;
}

export const loginEnv = await resolveLoginEnv();

export async function which(cmd: string): Promise<string> {
  const { stdout } = await run('/usr/bin/which', [cmd], { env: loginEnv });
  return stdout.trim();
}

export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
