// Pitwall reads files Claude Code does not document: ~/.claude/sessions/<pid>.json and the JSONL transcripts. These
// checks notice when an update changes their shape, so the board says so instead of quietly showing stale tasks.

export interface Drift {
  problem: string;
  version: string | null;
  at: number;
}

const STATUSES = new Set(['busy', 'shell', 'idle', 'waiting']);

const found = new Map<string, Drift>();
let listener: () => void = () => {};

export const onDrift = (fn: () => void) => {
  listener = fn;
};

export function report(problems: string[], version: string | null) {
  let added = false;
  for (const problem of problems) {
    if (found.has(problem)) continue;
    found.set(problem, { problem, version, at: Date.now() });
    console.warn(`Claude Code ${version ?? '(unknown version)'} format drift: ${problem}`);
    added = true;
  }
  if (added) listener();
}

export const drift = () => [...found.values()];

export const resetDrift = () => found.clear();

export function sessionFileProblems(info: Record<string, any>): string[] {
  const problems: string[] = [];
  for (const key of ['pid', 'sessionId', 'cwd', 'kind']) {
    if (info[key] === undefined) problems.push(`session files no longer carry ${key}`);
  }
  if (info.pid !== undefined && typeof info.pid !== 'number') problems.push('the pid in session files is not a number');
  if (info.kind === 'interactive' && info.status !== undefined && !STATUSES.has(info.status)) problems.push(`session files report an unknown status "${String(info.status)}"`);
  if (info.kind === 'interactive' && info.procStart === undefined) problems.push('session files no longer carry procStart');
  return problems;
}

// Only what Pitwall relies on: prompts and replies with their content, ids and times.
export function transcriptProblems(entries: Record<string, any>[]): string[] {
  const problems = new Set<string>();
  for (const e of entries) {
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (typeof e.uuid !== 'string') problems.add(`transcript ${e.type} entries no longer carry a uuid`);
    if (Number.isNaN(Date.parse(e.timestamp))) problems.add(`transcript ${e.type} entries no longer carry a timestamp`);
    const content = e.message?.content;
    if (e.type === 'user' && typeof content !== 'string' && !Array.isArray(content)) problems.add('transcript prompts no longer hold message.content');
    if (e.type === 'assistant' && !Array.isArray(content)) problems.add('transcript replies no longer hold message.content blocks');
  }
  return [...problems];
}

export const versionOf = (entries: Record<string, any>[]): string | null => entries.findLast((e) => typeof e.version === 'string')?.version ?? null;
