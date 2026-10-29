import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { handleAdvisorMcp, retryAdvice, stopAdvice } from './advisor.ts';
import { ARTIFACT_CSP, artifactFile } from './artifacts.ts';
import { HOST, PORT, USAGE_FILE, WEB_DIST } from './config.ts';
import { repos, roots, sessions, uxEvents } from './db.ts';
import { listCommands } from './commands.ts';
import { Refusal } from './decision.ts';
import { elaborate } from './explain.ts';
import { respond } from './findings.ts';
import { addWorktree, fullDiff, listBranches, repoRoot } from './git.ts';
import { handleMcp } from './mcp.ts';
import { ALIASES, EFFORTS, resolver, settingsFor } from './models.ts';
import * as S from './sessions.ts';
import { prepare, restartState } from './restart.ts';
import { readEntry, watchEntry } from './uiEntry.ts';
import { saveUpload } from './uploads.ts';
import { watchUsage } from './usage.ts';
import { cleanBatch, KEEP_DAYS } from './uxlog.ts';
import { folders, notify, onChange, refreshWorkspace, repoView, snapshot, taskFolderOf, workspace } from './workspace.ts';
import { folderDiff, makeTaskFolder } from './folderTasks.ts';

const run = promisify(execFile);
const app = new Hono();

const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`, '127.0.0.1:5173', 'localhost:5173']);
const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`, 'http://127.0.0.1:5173', 'http://localhost:5173']);

// Loopback alone does not stop a web page from reaching us; reject foreign hosts
// (DNS rebinding) and foreign origins (cross-site requests).
app.use(async (c, next) => {
  const host = c.req.header('host') ?? '';
  const origin = c.req.header('origin');
  if (!allowedHosts.has(host)) return c.text('forbidden host', 403);
  if (origin && !allowedOrigins.has(origin)) return c.text('forbidden origin', 403);
  await next();
});

// A refusal is the page acting on a decision that moved on, not a fault. Node's own errors carry a code too.
app.onError((err, c) => {
  if (!(err instanceof Refusal)) console.error(c.req.method, c.req.path, err);
  return c.json({ error: err instanceof Error ? err.message : String(err), ...(err instanceof Refusal && { code: err.code }) }, 400);
});

const usage = watchUsage(USAGE_FILE, notify);
const state = () => ({ ...snapshot(), usage: usage.current(), restart: restartState() });

app.get('/api/state', (c) => c.json(state()));

app.all('/mcp', (c) => handleMcp(c.req.raw));
app.all('/mcp/advisor/:token', (c) => handleAdvisorMcp(c.req.raw, c.req.param('token')));

app.post('/api/pick-folder', async (c) => {
  const { stdout } = await run('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a repository, or a folder to scan for repositories")']);
  return c.json({ path: stdout.trim().replace(/\/$/, '') });
});

app.post('/api/open', async (c) => {
  const url = URL.parse(String((await c.req.json()).url ?? ''));
  if (!url || !['http:', 'https:'].includes(url.protocol)) return c.text('not a web link', 400);
  await run('/usr/bin/open', [url.href]);
  return c.body(null, 204);
});

app.post('/api/repos', async (c) => {
  const path = (await c.req.json<{ path: string }>()).path.trim().replace(/(.)\/$/, '$1');
  // A dotfiles repo in ~ would otherwise swallow every folder picked under it.
  const found = await repoRoot(path).catch(() => null);
  const root = found === homedir() && path !== found ? null : found;
  if (root) repos.add(root);
  else if ((await stat(path).catch(() => null))?.isDirectory()) roots.add(path);
  else throw new Error(`not a folder: ${path}`);
  await refreshWorkspace({ scan: !root });
  return c.json({ scanned: !root });
});

app.delete('/api/roots', async (c) => {
  roots.remove((await c.req.json<{ path: string }>()).path);
  await refreshWorkspace();
  return c.body(null, 204);
});

app.post('/api/rescan', async (c) => {
  await refreshWorkspace({ scan: true });
  return c.body(null, 204);
});

app.patch('/api/repos/:id', async (c) => {
  repos.update(Number(c.req.param('id')), await c.req.json());
  await refreshWorkspace();
  return c.body(null, 204);
});

app.delete('/api/repos/:id', async (c) => {
  const id = Number(c.req.param('id'));
  repos.hide(id);
  await refreshWorkspace();
  return c.body(null, 204);
});

app.get('/api/repos/:id/branches', async (c) => {
  const repo = repoView(Number(c.req.param('id')));
  if (!repo) throw new Error('unknown repo');
  const checkedOut = new Map(repo.worktrees.flatMap((w) => (w.branch ? [[w.branch, w.path]] : [])));
  return c.json((await listBranches(repo.path)).map((b) => ({ ...b, worktree: checkedOut.get(b.name) ?? null })));
});

const MODEL = /^[A-Za-z0-9._-]+(\[1m\])?$/;

const resolve = async (repoPath: string) =>
  resolver(await settingsFor(repoPath), sessions.all().toSorted((a, b) => b.updatedAt - a.updatedAt));

async function modelChoices(path: string) {
  const { model, real, effortOf } = await resolve(path);
  const models: Record<string, string | null> = Object.fromEntries([['', model], ...ALIASES.map((a) => [a, real(a)])]);
  return { models, efforts: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, effortOf(m)])) };
}

app.get('/api/repos/:id/models', async (c) => {
  const repo = repoView(Number(c.req.param('id')));
  if (!repo) throw new Error('unknown repo');
  return c.json(await modelChoices(repo.path));
});

app.get('/api/folders/models', async (c) => {
  const folder = folders().find((f) => f.path === c.req.query('path'));
  if (!folder) throw new Error('unknown folder');
  return c.json(await modelChoices(folder.path));
});

const chosenModel = (body: { model?: string; effort?: string }) => {
  const model = body.model?.trim() || undefined;
  const effort = body.effort || undefined;
  if (model && !MODEL.test(model)) throw new Error(`unknown model ${model}`);
  if (effort && !EFFORTS.includes(effort)) throw new Error(`unknown effort ${effort}`);
  return { model, effort };
};

// A task across a folder of repos starts in an empty task folder; Claude opens a worktree in each repo it changes.
app.post('/api/folder-tasks', async (c) => {
  const body = await c.req.json<{ folder: string; name: string; prompt?: string; model?: string; effort?: string }>();
  const { model, effort } = chosenModel(body);
  const name = body.name.trim();
  if (!name) throw new Error('name is required');
  const path = await makeTaskFolder(body.folder, name);
  const { model: fallback, real, effortOf } = await resolve(body.folder);
  const running = model ? real(model) : fallback;
  const sessionId = await S.startClaude({
    repoId: null, worktree: path, prompt: body.prompt, title: name, model, effort, running: { model: running, effort: effort ?? effortOf(running) },
  });
  return c.json({ path, sessionId });
});

app.post('/api/worktrees', async (c) => {
  const body = await c.req.json<{ repoId: number; name: string; branch?: string; path?: string; prompt?: string; existingBranch?: boolean; model?: string; effort?: string }>();
  const repo = repoView(body.repoId);
  if (!repo) throw new Error('unknown repo');
  const { model, effort } = chosenModel(body);
  const name = body.name.trim();
  const branch = body.branch?.trim();
  let path: string;
  if (body.existingBranch) {
    if (!branch) throw new Error('pick a branch');
    path = await S.checkoutExistingBranch(repo, branch);
  } else {
    if (!name) throw new Error('name is required');
    const wanted = body.path?.trim().replace(/^~(?=\/|$)/, homedir()) || undefined;
    if (wanted && !isAbsolute(wanted)) throw new Error('the worktree path must be absolute');
    path = await addWorktree(repo.path, {
      branch: branch || name, task: name, base: repo.base, root: repo.defaultWorktreeRoot, path: wanted,
    });
  }
  await refreshWorkspace();
  const setup = body.existingBranch ? null : repo.setupCommand;
  const { model: fallback, real, effortOf } = await resolve(repo.path);
  const running = model ? real(model) : fallback;
  const sessionId = await S.startClaude({
    repoId: repo.id, worktree: path, prompt: body.prompt, title: name, setup, model, effort, running: { model: running, effort: effort ?? effortOf(running) },
  });
  return c.json({ path, sessionId });
});

app.delete('/api/worktrees', async (c) => {
  const body = await c.req.json<{ repoId: number; path: string; force?: boolean; deleteBranch?: boolean }>();
  const repo = repoView(body.repoId);
  if (!repo) throw new Error('unknown repo');
  await S.removeWorktreeAndSessions(repo, body.path, { force: !!body.force, deleteBranch: !!body.deleteBranch });
  return c.body(null, 204);
});

app.post('/api/sessions', async (c) => {
  const body = await c.req.json<{ repoId: number; worktree: string; prompt?: string; continueId?: string }>();
  const id = body.continueId ? await S.continueConversation({ ...body, continueId: body.continueId }) : await S.startClaude(body);
  await refreshWorkspace();
  return c.json({ id });
});

app.post('/api/shell', async (c) => {
  await S.openShell((await c.req.json<{ worktree: string }>()).worktree);
  return c.body(null, 204);
});

app.get('/api/sessions/:id/artifacts/:artifact', async (c) => {
  const html = await readFile(artifactFile(c.req.param('id'), c.req.param('artifact')), 'utf8').catch(() => null);
  if (html === null) return c.text('artifact not found', 404);
  c.header('content-security-policy', ARTIFACT_CSP);
  return c.html(html);
});

app.get('/api/sessions/:id/conversation', async (c) => c.json(await S.conversation(c.req.param('id'))));
app.get('/api/sessions/:id/conversation/:conversation/:entry/:n', async (c) => {
  const image = await S.conversationImage(c.req.param('id'), c.req.param('conversation'), c.req.param('entry'), Number(c.req.param('n')));
  if (!image) return c.text('image not found', 404);
  return c.body(new Uint8Array(image.data), 200, { 'content-type': image.type, 'cache-control': 'private, max-age=31536000, immutable' });
});
app.get('/api/sessions/:id/delete-worktree', async (c) => c.json(await S.deleteWorktreeLoss(c.req.param('id'))));

// These act on the decision the page showed and name it in `key`; answer and answer-menu check their own.
const onDecision = new Set(['dismiss', 'accept-advice', 'retry-advice', 'stop-advice', 'elaborate']);

app.post('/api/sessions/:id/:action', async (c) => {
  const id = c.req.param('id');
  const action = c.req.param('action');
  const body = await c.req.json().catch(() => ({}));
  if (onDecision.has(action)) S.expectDecision(id, body.key);
  switch (action) {
    case 'answer': await S.answer(id, body); break;
    case 'dismiss': S.dismiss(id, body.key); break;
    case 'rename': await S.rename(id, body.title); break;
    case 'answer-menu': await S.answerMenu(id, body); break;
    case 'accept-advice': await S.acceptAdvice(id, typeof body.adviceAt === 'number' ? body.adviceAt : undefined); break;
    case 'retry-advice': retryAdvice(id); break;
    case 'stop-advice': stopAdvice(id); break;
    case 'elaborate': elaborate(id); break;
    case 'focus': await S.focus(id); break;
    case 'finder': await S.openIn(id, 'finder'); break;
    case 'vscode': await S.openIn(id, 'vscode'); break;
    case 'quit': S.quit(id); break;
    case 'forget': await S.forget(id); break;
    case 'archive': S.archive(id, body.archived ?? true); break;
    case 'priority': S.setPriority(id, body.priority ?? null); break;
    case 'resolve': S.resolve(id, body.state ?? null); break;
    case 'delete-worktree': await S.deleteWorktree(id); break;
    case 'finding': return c.json({ id: await respond(id, body) });
    default: return c.text('unknown action', 404);
  }
  return c.body(null, 204);
});

app.post('/api/restart/prepare', async (c) => {
  const { on } = await c.req.json().catch(() => ({}));
  prepare(on !== false, sessions.all());
  notify();
  return c.body(null, 204);
});

app.post('/api/restart/resume', async (c) => c.json(await S.resumeInterrupted()));

app.post('/api/restart/dismiss', (c) => {
  S.dismissInterrupted();
  return c.body(null, 204);
});

app.post('/api/uploads', async (c) => {
  const path = await saveUpload(decodeURIComponent(c.req.header('x-filename') ?? 'file'), await c.req.arrayBuffer());
  return c.json({ path });
});

const pruneUx = () => uxEvents.prune(Date.now() - KEEP_DAYS * 86_400_000);
pruneUx();
setInterval(pruneUx, 86_400_000).unref();

app.post('/api/ux', async (c) => {
  const batch = cleanBatch(await c.req.json().catch(() => null));
  if (!batch) return c.text('bad batch', 400);
  if (batch.events.length) uxEvents.add(batch.page, batch.events);
  return c.body(null, 204);
});

app.post('/api/hooks/ask-user-question', async (c) => {
  S.menuOpened(await c.req.json());
  return c.body(null, 204);
});

app.get('/api/commands', async (c) => c.json(await listCommands(c.req.query('worktree') ?? '')));

const repoOfWorktree = (worktree: string) => {
  const repo = workspace().find((r) => r.worktrees.some((w) => w.path === worktree));
  if (!repo) throw new Error('unknown worktree');
  return repo;
};

const diffOf = (worktree: string, opts: { paths?: string[] } = {}) =>
  taskFolderOf(worktree) ? folderDiff(worktree, opts)
    : fullDiff(worktree, repoOfWorktree(worktree).base, opts);

app.get('/api/diff/file', async (c) => {
  const worktree = c.req.query('worktree') ?? '';
  const paths = c.req.queries('path') ?? [];
  if (!paths.length || paths.some((p) => isAbsolute(p) || p.split('/').includes('..'))) throw new Error('bad path');
  return c.json(await diffOf(worktree, { paths }));
});

app.get('/api/diff', async (c) => {
  const worktree = c.req.query('worktree') ?? '';
  const diff = await diffOf(worktree);
  for (const s of sessions.all().filter((s) => s.worktree === worktree)) sessions.update(s.id, { diffstat: diff.stat });
  notify();
  return c.json(diff);
});

// Every snapshot names the UI build, so a page from an older one reloads, also after a `pnpm build` alone.
const index = join(WEB_DIST, 'index.html');
const ui = watchEntry(() => readEntry(index), notify);

const message = () => JSON.stringify({ ...state(), uiEntry: ui.settled() });

app.get('/ws/events', upgradeWebSocket(() => {
  let off: (() => void) | undefined;
  let closed = false;
  return {
    // The page may run a build the polls have not taken yet: a read now that finds another entry empties settled(),
    // so it is told none rather than the older one. The read itself is never named, as the build may still be writing.
    async onOpen(_evt, ws) {
      await ui.fresh();
      if (closed) return;
      off = onChange(() => ws.send(message()));
      ws.send(message());
    },
    onClose() {
      closed = true;
      off?.();
    },
  };
}));

app.use('/*', serveStatic({ root: WEB_DIST }));
app.get('*', async (c) => {
  const html = await readFile(index, 'utf8').catch(() => null);
  return html ? c.html(html) : c.text('UI not built: run `pnpm build`', 503);
});

await refreshWorkspace({ scan: true });
await S.sync();
setInterval(() => void S.sync().catch((err) => console.warn('session sync failed', err)), 1500);
setInterval(() => void refreshWorkspace({ scan: true }).catch((err) => console.warn('workspace refresh failed', err)), 30_000);

serve({ fetch: app.fetch, hostname: HOST, port: PORT, websocket: { server: new WebSocketServer({ noServer: true }) } }, () => {
  console.log(`pitwall listening on http://${HOST}:${PORT}`);
});
