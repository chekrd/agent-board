import { readFile } from 'node:fs/promises';

// The module script index.html loads; every build names it anew.
export const readEntry = async (file: string) =>
  (await readFile(file, 'utf8').catch(() => '')).match(/src="([^"]+\.js)"/)?.[1] ?? null;

// Polled: fs.watch stops firing once a build replaces the file. A build deletes and rewrites it, so after the entry
// found at the start, a new one counts only once two polls in a row agree, and a read that finds none never counts.
// Pages get the file as it is, so one may already run a build not taken yet. settled() therefore names no entry while
// the latest read disagrees with the one taken, which would reload such a page again and again.
export function watchEntry(read: () => Promise<string | null>, onChange: (entry: string) => void, everyMs = 2000) {
  let reported: string | null = null;
  let polled: string | null | undefined;
  let latest: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const poll = async () => {
    const entry = await read().catch(() => null);
    if (stopped) return;
    const settles = entry !== null && entry !== reported && (polled === undefined || entry === polled);
    polled = latest = entry;
    if (settles) onChange((reported = entry));
    timer = setTimeout(poll, everyMs);
  };
  void poll();
  return {
    settled: () => (latest === reported ? reported : null),
    // A read between the polls, for a socket that just opened: it can only cast doubt on the entry taken.
    async fresh() {
      const entry = await read().catch(() => null);
      if (entry !== reported) latest = entry;
      return entry;
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
