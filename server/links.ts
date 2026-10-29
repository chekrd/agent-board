import type { Link } from './db.ts';

const MAX_CONTEXT = 300;

export type Found = Omit<Link, 'about'>;

const MARKDOWN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
// Parentheses, brackets and quotes end a bare URL, so one in prose or a Markdown link's target ends where it should.
const BARE = /https?:\/\/[^\s<>"'`()[\]{}|\\^]+/g;
const TRAILING = /[.,;:!?*_~]+$/;

const lineAround = (text: string, at: number) => {
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at);
  return text.slice(start, end < 0 ? undefined : end).trim().slice(0, MAX_CONTEXT);
};

// Every web link in one of Claude's messages, with a Markdown link's text and the line it stands on.
export function linksIn(text: string, at: number): Found[] {
  const found = new Map<string, Found>();
  for (const m of text.matchAll(MARKDOWN)) {
    if (!found.has(m[2])) found.set(m[2], { url: m[2], text: m[1].trim(), context: lineAround(text, m.index), at });
  }
  for (const m of text.matchAll(BARE)) {
    const url = m[0].replace(TRAILING, '');
    if (!found.has(url) && URL.canParse(url)) found.set(url, { url, text: null, context: lineAround(text, m.index), at });
  }
  return [...found.values()];
}

// The transcript is read from its tail, so links are kept once seen and an older message does not bring one back
// changed.
export function mergeLinks(kept: Link[], found: Found[]): Link[] | null {
  const known = new Set(kept.map((l) => l.url));
  const added = found.filter((f) => !known.has(f.url) && known.add(f.url));
  return added.length ? [...kept, ...added.map((f) => ({ ...f, about: null }))] : null;
}
