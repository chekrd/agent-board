import { readFile } from 'node:fs/promises';

// A script's start tag up to its end tag, so a tag written inside a script's text is not taken for one.
const SCRIPT = /<script(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/script[\s/>]/gi;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function attributes(tag: string) {
  const found = new Map<string, string>();
  for (const [, name, ...value] of tag.matchAll(ATTRIBUTE)) {
    if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), value.find((v) => v !== undefined) ?? '');
  }
  return found;
}

// The entry the page compares: the src of its first <script type="module" src>, which every build names anew. A
// script the file does not close yet, as while a build writes it, never counts.
export async function readEntry(file: string) {
  const html = (await readFile(file, 'utf8').catch(() => '')).replace(/<!--[\s\S]*?-->/g, '');
  for (const [, tag] of html.matchAll(SCRIPT)) {
    const script = attributes(tag);
    if (script.get('type')?.toLowerCase() === 'module' && script.has('src')) return script.get('src') || null;
  }
  return null;
}

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
