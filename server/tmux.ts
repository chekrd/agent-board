import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './config.ts';
import { loginEnv, quote, which } from './env.ts';
import type { Keystroke } from './ghostty.ts';
import * as input from './tmuxInput.ts';

const run = promisify(execFile);

export const TMUX = await which('tmux').catch(() => '');
// An own socket and config, so the user's tmux and ~/.tmux.conf never mix in.
const ARGS = ['-u', '-L', 'agent-board', '-f', join(ROOT, 'config', 'tmux.conf')];

async function tmux(args: string[], stdin?: string) {
  const running = run(TMUX, [...ARGS, ...args], { env: loginEnv });
  // A tmux that fails before it reads its input closes the pipe; its exit says why.
  running.child.stdin?.on('error', () => {});
  if (stdin !== undefined) running.child.stdin?.end(stdin);
  return (await running).stdout;
}

// The tmux server keeps the environment of whoever started it, which may predate a locale fix.
const localeArgs = ['LANG', 'LC_ALL', 'LC_CTYPE'].flatMap((k) => (loginEnv[k] ? ['-e', `${k}=${loginEnv[k]}`] : []));

export async function start(name: string, cwd: string, command: string) {
  await tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...localeArgs, command]);
}

// tty → tmux session name, for every pane on Agent Board's socket.
export async function panes() {
  const byTty = new Map<string, string>();
  if (!TMUX) return byTty;
  let out = '';
  try {
    out = await tmux(['list-panes', '-a', '-F', '#{pane_tty}\t#{session_name}']);
  } catch (err) {
    if (/no server running|error connecting/.test(String((err as { stderr?: string }).stderr))) return byTty;
    throw err;
  }
  for (const line of out.split('\n').filter(Boolean)) {
    const [tty, name] = line.split('\t');
    byTty.set(tty, name);
  }
  return byTty;
}

export async function clients(name: string) {
  return (await tmux(['list-clients', '-t', `=${name}`, '-F', '#{client_tty}'])).split('\n').filter(Boolean);
}

export const paste = (name: string, text: string) => input.paste(tmux, name, text);

export const keys = (name: string, strokes: Keystroke[]) => input.keys(tmux, name, strokes);

// `exec`, so the tab closes when the session ends; closing the tab only detaches.
export const attachCommand = (name: string) => `exec ${[TMUX, ...ARGS, 'attach-session', '-t', `=${name}`].map(quote).join(' ')}`;
