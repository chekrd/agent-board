import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export interface UsageWindow {
  percent: number;
  resetsAt: number | null;
}

export interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  at: number;
}

// Claude Code gives the plan's limits only to the status line, as `rate_limits` with `resets_at` in epoch seconds;
// the status line script copies them to the file with the time it did.
function windowOf(raw: unknown): UsageWindow | null {
  const w = raw as { used_percentage?: unknown; resets_at?: unknown } | null;
  if (typeof w?.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null;
  const resetsAt = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null;
  return { percent: Math.max(0, w.used_percentage), resetsAt };
}

export function parseUsage(text: string, readAt = Date.now()): Usage | null {
  try {
    const { at, rate_limits: limits } = JSON.parse(text);
    const usage = { fiveHour: windowOf(limits?.five_hour), sevenDay: windowOf(limits?.seven_day), at: typeof at === 'number' ? at : readAt };
    return usage.fiveHour || usage.sevenDay ? usage : null;
  } catch {
    return null;
  }
}

// Polled, as the script replaces the file on every redraw of the status line. The first read is synchronous, so a page
// that reconnects right after a restart does not get a snapshot without the reading.
export function watchUsage(file: string, onChange: () => void, everyMs = 2000) {
  let text: string | null = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // no reading yet
  }
  let usage = text === null ? null : parseUsage(text);
  const poll = async () => {
    const next = await readFile(file, 'utf8').catch(() => null);
    if (next !== null && next !== text) {
      text = next;
      const parsed = parseUsage(next);
      if (parsed) {
        usage = parsed;
        onChange();
      }
    }
    setTimeout(poll, everyMs).unref();
  };
  setTimeout(poll, everyMs).unref();
  return { current: () => usage };
}
