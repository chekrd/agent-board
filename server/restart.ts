import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Interrupted, Session } from './db.ts';

const run = promisify(execFile);

// `{ sec = 1793086205, usec = 497711 } Tue Oct 27 08:30:05 2026`
export function parseBootTime(out: string) {
  const sec = out.match(/\bsec = (\d+)/)?.[1];
  return sec ? Number(sec) * 1000 : null;
}

let boot: Promise<number | null> | undefined;

export const bootTime = () =>
  (boot ??= run('/usr/sbin/sysctl', ['-n', 'kern.boottime']).then(({ stdout }) => parseBootTime(stdout), () => null));

// The board writes a task's row only while it runs, and its first sync after a boot finds the dead Claudes before
// anything else touches their rows: one it last wrote before the boot was alive until the restart killed it.
export function interruption(s: Pick<Session, 'status' | 'updatedAt' | 'waitingFor' | 'menu'>, boot: number | null): Interrupted | null {
  if (s.status === 'exited' || boot === null || s.updatedAt >= boot) return null;
  return { at: boot, status: s.status, waitingFor: s.waitingFor, menu: s.menu };
}

// Resumed, a task that was only waiting for you is as it was; one cut short mid-turn, or at a prompt the restart took
// away, stays marked until Claude works again.
export const pickedUp = (i: Interrupted, status: Session['status']) => status === 'working' || i.status === 'idle';

// Safe means no Claude is in the middle of a turn, archived ones included, as they would be cut short all the same.
export const busy = (all: Pick<Session, 'status'>[]) => all.filter((s) => s.status === 'working');

export interface Preparing {
  since: number;
  safeAt: number | null;
}

let preparing: Preparing | null = null;

export const restartState = () => ({ preparing });

function notifyMac() {
  const script = 'display notification "No Claude is in the middle of a turn." with title "Pitwall" subtitle "Safe to restart"';
  run('/usr/bin/osascript', ['-e', script]).catch((err) => console.warn('restart notification failed', err));
}

export function prepare(on: boolean, all: Pick<Session, 'status'>[], say = notifyMac) {
  preparing = on ? { since: Date.now(), safeAt: null } : null;
  if (preparing) watch(all, say);
}

// Says so each time the last turn ends, in a notification, as the board may be out of sight.
export function watch(all: Pick<Session, 'status'>[], say = notifyMac) {
  if (!preparing) return false;
  const safe = busy(all).length === 0;
  if (safe === (preparing.safeAt !== null)) return false;
  preparing = { ...preparing, safeAt: safe ? Date.now() : null };
  if (safe) say();
  return true;
}
