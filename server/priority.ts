import { readFile } from 'node:fs/promises';
import { DATA_DIR, RUBRIC_FILE } from './config.ts';
import { sessions } from './db.ts';
import { headless } from './headless.ts';
import { notify, repoView } from './workspace.ts';

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
    const open = sessions.all().filter((s) => s.question && !s.archived);
    if (open.length < 2) {
      if (open[0] && open[0].rank !== 1) {
        sessions.update(open[0].id, { rank: 1, rankReason: 'The only open question' });
        notify();
      }
      return;
    }
    const items = open.map((s) => ({
      id: s.id,
      repo: repoView(s.repoId)?.name,
      worktree: s.worktree,
      task: clip(s.firstPrompt, 600),
      title: s.question!.title,
      category: s.question!.category,
      details: clip(s.question!.details, 2500),
      options: s.question!.options.map((o) => o.label),
      waitingMinutes: Math.round((Date.now() - s.question!.askedAt) / 60_000),
      secondOpinionConfidence: s.advice?.state === 'done' && s.advice.toolUseId === s.question!.toolUseId ? s.advice.confidence : null,
    }));
    const rubric = await readFile(RUBRIC_FILE, 'utf8');
    const prompt = `You rank questions that coding agents are waiting on, so a single developer knows what to look at first.

Ranking rubric:
${rubric}

Open questions (JSON):
${JSON.stringify(items, null, 2)}

secondOpinionConfidence is how sure an independent model is that it knows the developer's answer (0-100), or null when it has not answered yet.

Reply with order: every question, from highest to lowest priority, each with a reason of one short line why it sits there.`;
    const out = await headless(prompt, {
      cwd: DATA_DIR,
      args: ['--model', 'sonnet', '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--json-schema', JSON.stringify(schema)],
      timeoutMs: 180_000,
    });
    const ranked: { id: string; reason: string }[] = out.structured_output?.order ?? [];
    if (!ranked.length) throw new Error(`no ranking: ${String(out.result ?? '').slice(0, 300)}`);
    const asked = new Map(open.map((s) => [s.id, s.question!.askedAt]));
    ranked.forEach(({ id, reason }, i) => {
      const current = sessions.get(id);
      if (current?.question && current.question.askedAt === asked.get(id)) {
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
