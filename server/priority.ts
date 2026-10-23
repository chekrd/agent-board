import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { DATA_DIR, RUBRIC_FILE } from './config.ts';
import { sessions } from './db.ts';
import { loginEnv, which } from './env.ts';
import { notify, repoView } from './workspace.ts';

const CLAUDE = await which('claude');
const clip = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? '');

let timer: NodeJS.Timeout | undefined;
let running = false;
let again = false;

export function scheduleRerank() {
  clearTimeout(timer);
  timer = setTimeout(rerank, 1500);
}

function headless(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, ['-p', '--model', 'sonnet', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'], {
      cwd: DATA_DIR,
      env: loginEnv,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`claude -p exited ${code}: ${err}`))));
    child.stdin.end(prompt);
  });
}

async function rerank() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    const open = sessions.all().filter((s) => s.question && !s.archived);
    if (!open.length) return;
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
    }));
    const rubric = await readFile(RUBRIC_FILE, 'utf8');
    const prompt = `You rank questions that coding agents are waiting on, so a single developer knows what to look at first.

Ranking rubric:
${rubric}

Open questions (JSON):
${JSON.stringify(items, null, 2)}

Reply with ONLY a JSON array ordered from highest to lowest priority, one entry per question:
[{"id": "<id>", "reason": "<one short line why it sits here>"}]`;
    const out = JSON.parse(await headless(prompt));
    const text: string = out.result ?? '';
    const ranked: { id: string; reason: string }[] = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
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
