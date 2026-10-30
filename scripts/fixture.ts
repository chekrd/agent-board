// Captures what a Claude Code version writes, as server/fixtures/claude-<version>/, for the format tests. Text, tool
// input and output and paths are blanked; only the shape Pitwall reads stays.
//   node scripts/fixture.ts <transcript.jsonl> <sessions/pid.json>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [transcript, sessionFile] = process.argv.slice(2);
if (!transcript || !sessionFile) {
  console.error('usage: fixture.ts <transcript.jsonl> <sessions/pid.json>');
  process.exit(1);
}

const DROP = new Set(['bridgeSessionId', 'messagingSocketPath', 'tmux']);
const KEEP = new Set(['type', 'name', 'role', 'model', 'stop_reason', 'entrypoint', 'version', 'kind', 'status', 'querySource', 'effort', 'media_type', 'error']);
const KINDS = new Set(['user', 'assistant', 'ai-title', 'custom-title', 'api-request', 'queue-operation']);
const MAX_ENTRIES = 40;

const blank = (value: unknown, key = ''): unknown => {
  if (Array.isArray(value)) return value.map((v) => blank(v, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !DROP.has(k)).map(([k, v]) => [k, blank(v, k)]));
  if (typeof value !== 'string' || KEEP.has(key) || /(^|_)id$|Id$|uuid|Uuid|timestamp|At$/.test(key)) return value;
  if (key === 'cwd') return '/work/repo';
  return key === 'text' || key === 'content' || key === 'aiTitle' || key === 'customTitle' ? 'redacted' : '';
};

const slim = (e: Record<string, any>) => (e.type === 'api-request' ? { ...e, params: { model: e.params?.model, output_config: e.params?.output_config } } : e);

const entries = readFileSync(transcript, 'utf8').split('\n').flatMap((line) => {
  try {
    const e = JSON.parse(line);
    return KINDS.has(e.type) && !e.isSidechain ? [blank(slim(e)) as Record<string, any>] : [];
  } catch {
    return [];
  }
}).slice(0, MAX_ENTRIES);

const session = blank(JSON.parse(readFileSync(sessionFile, 'utf8'))) as Record<string, any>;
const version = session.version ?? entries.findLast((e) => e.version)?.version;
if (!version) throw new Error('no Claude Code version in either file');
const dir = join(import.meta.dirname, '..', 'server', 'fixtures', `claude-${version}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'transcript.jsonl'), `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
writeFileSync(join(dir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`);
console.log(`wrote ${dir}`);
