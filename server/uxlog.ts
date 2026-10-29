const MAX_EVENTS = 500;
const MAX_DATA = 2000;
const DAY_MS = 86_400_000;
export const KEEP_DAYS = 180;

export interface UxEvent {
  at: number;
  name: string;
  data: string | null;
}

// A page's batch as it may be stored: a known shape, bounded sizes, and times near the server's clock, so a page
// with a wrong clock or a bug cannot fill the table or skew the report.
export function cleanBatch(body: unknown, now = Date.now()): { page: string; events: UxEvent[] } | null {
  const { page, events } = (body ?? {}) as { page?: unknown; events?: unknown };
  if (typeof page !== 'string' || !/^[\w-]{1,64}$/.test(page) || !Array.isArray(events)) return null;
  const clean: UxEvent[] = [];
  for (const e of events.slice(0, MAX_EVENTS)) {
    const { at, name, data } = (e ?? {}) as { at?: unknown; name?: unknown; data?: unknown };
    if (typeof name !== 'string' || !/^[a-z][\w-]{0,63}$/.test(name)) continue;
    const json = data === undefined || data === null ? null : JSON.stringify(data);
    if (json && json.length > MAX_DATA) continue;
    clean.push({ at: typeof at === 'number' && Math.abs(at - now) < DAY_MS ? Math.round(at) : now, name, data: json });
  }
  return { page, events: clean };
}
