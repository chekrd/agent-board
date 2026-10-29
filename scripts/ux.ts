import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { DB_PATH } from '../server/config.ts';
import { KEYS } from '../web/src/keys.ts';

export interface Row {
  at: number;
  page: string;
  name: string;
  data: Record<string, any>;
}

const count = <T>(rows: T[], key: (r: T) => string | null) => {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
};

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)} %` : '–');
const minutes = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);

function table(title: string, entries: [string, number | string][], limit = 15) {
  if (!entries.length) return `${title}\n  (none)\n`;
  const shown = entries.slice(0, limit);
  const width = Math.max(...shown.map(([k]) => k.length));
  const more = entries.length > limit ? `\n  … ${entries.length - limit} more` : '';
  return `${title}\n${shown.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n')}${more}\n`;
}

// What the recorded use says, section by section; each one is a question about the board worth asking.
export function report(rows: Row[]) {
  const of = (name: string) => rows.filter((r) => r.name === name);
  const pages = new Set(rows.map((r) => r.page)).size;
  const screens = of('screen');
  const inSight = screens.reduce((sum, r) => sum + (r.data.ms ?? 0), 0);
  const perScreen = new Map<string, { ms: number; visits: number }>();
  for (const r of screens) {
    const s = perScreen.get(r.data.screen) ?? { ms: 0, visits: 0 };
    s.ms += r.data.ms ?? 0;
    s.visits++;
    perScreen.set(r.data.screen, s);
  }
  const keys = of('key');
  const clicks = of('click');
  const sends = of('send');
  const undos = of('undo');
  const usedKeys = new Set([...keys.map((r) => r.data.keys), ...of('key-noop').map((r) => r.data.keys)]);

  const from = rows.length ? new Date(rows[0].at).toLocaleString() : '–';
  const to = rows.length ? new Date(rows.at(-1)!.at).toLocaleString() : '–';
  return [
    `Pitwall use from ${from} to ${to}: ${rows.length} events, ${pages} page loads, ${minutes(inSight)} in sight\n`,
    table('Screens (time in sight, visits)', [...perScreen].sort((a, b) => b[1].ms - a[1].ms)
      .map(([s, v]) => [s, `${minutes(v.ms).padStart(8)}  ${pct(v.ms, inSight).padStart(5)}  ${v.visits} visits`])),
    `How actions were taken: ${keys.length} keys, ${clicks.length} clicks (${clicks.filter((r) => r.data.via === 'keyboard').length} of them from the keyboard)\n`,
    table('Keys used', count(keys, (r) => `${r.data.action} on ${r.data.screen}${r.data.card ? `/${r.data.card}` : ''}`)),
    table('Board keys never pressed', KEYS.filter((k) => !usedKeys.has(k.keys)).map((k) => [k.keys, k.help])),
    table('Board keys that did nothing where pressed (guarded: just after the card changed)', count(of('key-noop'), (r) => `${r.data.keys} on ${r.data.screen}${r.data.guarded ? ' (guarded)' : ''}`)),
    table('Keys the board has no use for (what someone expected a key to do)', count(of('key-miss'), (r) => `${r.data.key} on ${r.data.screen}${r.data.more ? ' (burst)' : ''}`)),
    table('Clicks', count(clicks, (r) => `${r.data.area} › ${r.data.control}`), 30),
    table('Sends', count(sends, (r) => `${r.data.action}${r.data.command ? ' (command)' : r.data.choice ? ' (option)' : r.data.text ? ' (own text)' : ''}${r.data.files ? ' +files' : ''}`)),
    `Taken back with Undo: ${undos.length} of ${sends.length} sends (${pct(undos.length, sends.length)}), median ${median(undos.map((r) => r.data.afterMs))} ms into the hold; ${of('send-failed').length} failed\n`,
    table('Requests the page made (everything but reads)', count(of('api'), (r) => `${r.data.method} ${r.data.path}`)),
    table('Errors shown', count(of('error'), (r) => r.data.message)),
    table('Window sizes', count(of('load'), (r) => `${Math.round(r.data.width / 100) * 100} × ${Math.round(r.data.height / 100) * 100}`), 5),
  ].join('\n');
}

function median(values: number[]) {
  if (!values.length) return '–';
  const sorted = [...values].sort((a, b) => a - b);
  return String(Math.round(sorted[Math.floor(sorted.length / 2)]));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { days: { type: 'string', default: '30' }, json: { type: 'boolean', default: false } } });
  if (!existsSync(DB_PATH)) {
    console.error(`no ${DB_PATH}; is Pitwall installed?`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const since = Date.now() - Number(values.days) * 86_400_000;
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ux_events'").get();
  if (!hasTable) {
    console.error('nothing recorded yet: the running server predates the recorder; run pnpm service:restart');
    process.exit(1);
  }
  const rows = db.prepare('SELECT at, page, name, data FROM ux_events WHERE at >= ? ORDER BY at').all(since)
    .map((r) => ({ at: Number(r.at), page: String(r.page), name: String(r.name), data: r.data ? JSON.parse(String(r.data)) : {} }));
  console.log(values.json ? JSON.stringify(rows) : report(rows));
}
