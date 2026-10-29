import { readFile } from 'node:fs/promises';
import { DATA_DIR, RUBRIC_FILE } from './config.ts';
import { openDecision } from './decision.ts';
import { sessions } from './db.ts';
import { headless } from './headless.ts';
import { notify, repoView, taskRepoNames } from './workspace.ts';

export const clip = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? '');

const schema = {
  type: 'object',
  properties: {
    order: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
    },
  },
  required: ['order'],
};

let timer: NodeJS.Timeout | undefined;
let running = false;
let again = false;

const rankedFor = new Map<string, string | null>();

// A session whose open decision changed loses its rank until the next ranking.
export function trackDecisions() {
  let changed = false;
  for (const s of sessions.all()) {
    const key = openDecision(s)?.key ?? null;
    if (rankedFor.has(s.id) && rankedFor.get(s.id) === key) continue;
    if (rankedFor.has(s.id) && (s.rank !== null || s.rankReason !== null)) sessions.update(s.id, { rank: null, rankReason: null });
    rankedFor.set(s.id, key);
    changed = true;
  }
  if (!changed) return;
  notify();
  scheduleRerank();
}

export function scheduleRerank() {
  clearTimeout(timer);
  timer = setTimeout(rerank, 1500);
}

async function rerank() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    const open = sessions.all().flatMap((s) => {
      const d = openDecision(s);
      return d ? [{ s, d }] : [];
    });
    if (open.length < 2) {
      if (open[0] && open[0].s.rank !== 1) {
        sessions.update(open[0].s.id, { rank: 1, rankReason: 'The only open decision' });
        notify();
      }
      return;
    }
    const items = open.map(({ s, d }) => ({
      id: s.id,
      repo: s.repoId === null ? taskRepoNames(s.worktree) : repoView(s.repoId)?.name,
      worktree: s.worktree,
      task: clip(s.firstPrompt, 600),
      taskSummary: clip(s.summary?.text ?? null, 1200) || null,
      developerPriority: s.priority,
      title: d.title,
      category: d.category,
      details: clip(d.details, 2500),
      options: d.options.map((o) => o.label),
      waitingMinutes: Math.round((Date.now() - d.askedAt) / 60_000),
      secondOpinionConfidence: s.advice?.state === 'done' && s.advice.key === d.key ? s.advice.confidence : null,
    }));
    const rubric = await readFile(RUBRIC_FILE, 'utf8');
    const prompt = `You rank questions that coding agents are waiting on, so a single developer knows what to look at first.

Ranking rubric:
${rubric}

Open decisions (JSON); category "menu in the terminal" lists its questions and options in details, "end of turn" was read by a model from the agent's last message:
${JSON.stringify(items, null, 2)}

taskSummary is where the whole session stands, or null before one is written.

developerPriority is the priority the developer set on the task by hand: "high", "low", or null when they set none. It is their own judgement and weighs heavily: a high task usually comes before the others at its level and may rise above a higher level, a low one usually sits after them. It is not absolute: weigh it with the decision itself, the task's summary and the other open decisions, so a low task whose blocker holds up a lot of work, or a high one with nothing urgent to decide, can still move. When it changed where a decision sits, say so in the reason.

secondOpinionConfidence is how sure an independent model is that it knows the developer's answer (0-100), or null when it has not answered yet.

Reply with order: every decision, from highest to lowest priority, each with a reason of one short line why it sits there.`;
    const out = await headless(prompt, {
      cwd: DATA_DIR,
      args: ['--model', 'sonnet', '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--json-schema', JSON.stringify(schema)],
      timeoutMs: 180_000,
    });
    const ranked: { id: string; reason: string }[] = out.structured_output?.order ?? [];
    if (!ranked.length) throw new Error(`no ranking: ${String(out.result ?? '').slice(0, 300)}`);
    const keys = new Map(open.map(({ s, d }) => [s.id, d.key]));
    ranked.forEach(({ id, reason }, i) => {
      const current = sessions.get(id);
      if (current && openDecision(current)?.key === keys.get(id)) {
        sessions.update(id, { rank: i + 1, rankReason: reason });
      }
    });
    notify();
  } catch (err) {
    console.warn('priority rerank failed', err);
  } finally {
    running = false;
    if (again) {
      again = false;
      scheduleRerank();
    }
  }
}
