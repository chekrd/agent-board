import { DATA_DIR } from './config.ts';
import { sessions, type Link, type Session } from './db.ts';
import { headless } from './headless.ts';
import { notify } from './workspace.ts';

const MODEL = 'haiku';
const MAX_ABOUT = 80;
const PER_RUN = 20;
const RETRY_AFTER_MS = 5 * 60_000;

const schema = {
  type: 'object',
  properties: {
    links: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, about: { type: 'string' } }, required: ['url', 'about'] } },
  },
  required: ['links'],
};

const prompt = (links: Link[]) => `A coding agent gave a developer these links in its messages. For each, write what it is in 3 to 8 plain words, from the URL and the line it appeared on, so the developer can tell the links apart in a list. Name the kind and the subject, e.g. "PR #4512: guard the double load", "GitHub issue on the hydration warning", "React docs on Suspense". No ending period.

${links.map((l) => `URL: ${l.url}${l.text ? `\nLink text: ${l.text}` : ''}\nLine: ${l.context}`).join('\n\n')}`;

let running = false;
const failed = new Map<string, number>();

const undescribed = (s: Session) => !s.archived && Date.now() - (failed.get(s.id) ?? 0) >= RETRY_AFTER_MS && s.links.some((l) => l.about === null);

// One run at a time, a session's undescribed links at once: they are few and the model is the cheapest.
export async function describeLinks() {
  if (running) return;
  const s = sessions.all().find(undescribed);
  if (!s) return;
  running = true;
  const batch = s.links.filter((l) => l.about === null).slice(0, PER_RUN);
  try {
    const out = await headless(prompt(batch), {
      cwd: DATA_DIR,
      timeoutMs: 60_000,
      args: ['--model', MODEL, '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--json-schema', JSON.stringify(schema)],
    });
    const about = new Map<string, string>();
    for (const l of out.structured_output?.links ?? []) about.set(String(l?.url), String(l?.about ?? '').trim().slice(0, MAX_ABOUT));
    const current = sessions.get(s.id);
    if (!current) return;
    // A link the model skipped gets an empty description, so it is not asked about again.
    const done = new Set(batch.map((l) => l.url));
    sessions.update(s.id, { links: current.links.map((l) => (done.has(l.url) && l.about === null ? { ...l, about: about.get(l.url) ?? '' } : l)) });
    failed.delete(s.id);
    notify();
  } catch (err) {
    failed.set(s.id, Date.now());
    console.warn('link descriptions failed', s.id, err);
  } finally {
    running = false;
  }
  void describeLinks();
}
