import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The always-on board (the launchd service). On it one key answers a real session.
export const LIVE_PORT = 7420;

export function refuseLive(target: string | number) {
  const port = typeof target === 'number' ? target : Number(new URL(target).port);
  if (port === LIVE_PORT) throw new Error(`refusing ${target}: port ${LIVE_PORT} is the live Agent Board`);
}

// Every state path the server uses derives from homedir() (config.ts, conversations.ts, commands.ts),
// so a fresh HOME keeps tests and the mock away from the live state.db, sessions folder and Claude config.
export function isolateHome() {
  const home = mkdtempSync(join(tmpdir(), 'agent-board-home-'));
  process.env.HOME = home;
  process.on('exit', () => rmSync(home, { recursive: true, force: true }));
  return home;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('usage: node scripts/isolate.ts <command> [args…]   runs it with HOME set to a fresh temporary folder');
    process.exit(2);
  }
  isolateHome();
  const child = spawn(command, args, { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', (err) => {
    console.error(err.message);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
