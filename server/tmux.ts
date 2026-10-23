import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TMUX_CONF, TMUX_SOCKET } from './config.ts';
import { loginEnv, which } from './env.ts';

const run = promisify(execFile);

export const TMUX = await which('tmux');
export const TMUX_ARGS = ['-L', TMUX_SOCKET, '-f', TMUX_CONF];

async function tmux(...args: string[]) {
  const { stdout } = await run(TMUX, [...TMUX_ARGS, ...args], { env: loginEnv });
  return stdout;
}

const target = (name: string) => `=${name}:`;

export async function newSession(name: string, cwd: string, command: string) {
  await tmux('new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', command);
}

export async function respawn(name: string, cwd: string, command: string) {
  await tmux('respawn-pane', '-k', '-c', cwd, '-t', target(name), command);
}

export async function kill(name: string) {
  await tmux('kill-session', '-t', `=${name}`).catch(() => {});
}

export interface PaneState {
  dead: boolean;
  exitStatus: number | null;
}

export async function listPanes(): Promise<Map<string, PaneState>> {
  const panes = new Map<string, PaneState>();
  let out = '';
  try {
    out = await tmux('list-panes', '-a', '-F', '#{session_name}\t#{pane_dead}\t#{pane_dead_status}');
  } catch {
    return panes; // no tmux server running yet
  }
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, dead, status] = line.split('\t');
    panes.set(name, { dead: dead === '1', exitStatus: status ? Number(status) : null });
  }
  return panes;
}

// Bracketed paste keeps multi-line answers as one prompt; Enter goes separately
// so the TUI has finished ingesting the paste before submit.
export async function sendPrompt(name: string, text: string) {
  const buffer = `answer-${name}`;
  await tmux('set-buffer', '-b', buffer, '--', text);
  await tmux('paste-buffer', '-p', '-d', '-b', buffer, '-t', target(name));
  await new Promise((r) => setTimeout(r, 200));
  await tmux('send-keys', '-t', target(name), 'Enter');
}
