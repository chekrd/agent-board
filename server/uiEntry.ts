import { readFile } from 'node:fs/promises';

// The module script index.html loads; every build names it anew.
export const readEntry = async (file: string) =>
  (await readFile(file, 'utf8').catch(() => '')).match(/src="([^"]+\.js)"/)?.[1] ?? null;

// Polled: fs.watch stops firing once a build replaces the file. A build deletes and rewrites it, so after the entry
// found at the start, a new one counts only once two reads in a row agree, and a read that finds none never counts.
export function watchEntry(read: () => Promise<string | null>, onChange: (entry: string) => void, everyMs = 2000) {
  let reported: string | null = null;
  let last: string | null | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const poll = async () => {
    const entry = await read().catch(() => null);
    if (stopped) return;
    if (entry !== null && entry !== reported && (last === undefined || entry === last)) onChange((reported = entry));
    last = entry;
    timer = setTimeout(poll, everyMs);
  };
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
