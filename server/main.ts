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
import { HOST, PORT, WEB_DIST } from './config.ts';
import { repos, roots, sessions } from './db.ts';
import { listCommands } from './commands.ts';
import { Refusal } from './decision.ts';
import { elaborate } from './explain.ts';
import { addWorktree, fullDiff, listBranches, repoRoot } from './git.ts';
import { handleMcp } from './mcp.ts';
import * as S from './sessions.ts';
import { readEntry, watchEntry } from './uiEntry.ts';
import { saveUpload } from './uploads.ts';
import { notify, onChange, refreshWorkspace, repoView, snapshot, workspace } from './workspace.ts';

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

app.get('/api/state', (c) => c.json(snapshot()));

app.all('/mcp', (c) => handleMcp(c.req.raw));
app.all('/mcp/advisor/:token', (c) => handleAdvisorMcp(c.req.raw, c.req.param('token')));

app.post('/api/pick-folder', async (c) => {
  const { stdout } = await run('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a repository, or a folder to scan for repositories")']);
  return c.json({ path: stdout.trim().replace(/\/$/, '') });
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
  return c.json((await listBranches(repo.path)).map((name) => ({ name, worktree: checkedOut.get(name) ?? null })));
});

app.post('/api/worktrees', async (c) => {
  const body = await c.req.json<{ repoId: number; name: string; branch?: string; path?: string; prompt?: string; startClaude?: boolean; existingBranch?: boolean }>();
  const repo = repoView(body.repoId);
  if (!repo) throw new Error('unknown repo');
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
  if (body.startClaude === false) {
    if (setup) await S.openShell(path, setup);
    return c.json({ path, sessionId: null });
  }
  const sessionId = await S.startClaude({ repoId: repo.id, worktree: path, prompt: body.prompt, title: name, setup });
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
    case 'dismiss': S.dismiss(id); break;
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
    case 'delete-worktree': await S.deleteWorktree(id); break;
    default: return c.text('unknown action', 404);
  }
  return c.body(null, 204);
});

app.post('/api/uploads', async (c) => {
  const path = await saveUpload(decodeURIComponent(c.req.header('x-filename') ?? 'file'), await c.req.arrayBuffer());
  return c.json({ path });
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

app.get('/api/diff/file', async (c) => {
  const worktree = c.req.query('worktree') ?? '';
  const paths = c.req.queries('path') ?? [];
  if (!paths.length || paths.some((p) => isAbsolute(p) || p.split('/').includes('..'))) throw new Error('bad path');
  return c.json(await fullDiff(worktree, repoOfWorktree(worktree).base, { paths }));
});

app.get('/api/diff', async (c) => {
  const worktree = c.req.query('worktree') ?? '';
  const diff = await fullDiff(worktree, repoOfWorktree(worktree).base);
  for (const s of sessions.all().filter((s) => s.worktree === worktree)) sessions.update(s.id, { diffstat: diff.stat });
  notify();
  return c.json(diff);
});

// Every snapshot names the UI build, so a page from an older one reloads, also after a `pnpm build` alone.
const index = join(WEB_DIST, 'index.html');
const ui = watchEntry(() => readEntry(index), notify);

const message = (uiEntry: string | null) => JSON.stringify({ ...snapshot(), uiEntry });

app.get('/ws/events', upgradeWebSocket(() => {
  let off: (() => void) | undefined;
  let closed = false;
  return {
    // Read now: the page may come from a build the polls have not taken yet.
    async onOpen(_evt, ws) {
      const uiEntry = await ui.fresh();
      if (closed) return;
      off = onChange(() => ws.send(message(ui.settled())));
      ws.send(message(uiEntry));
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
  console.log(`agent-board listening on http://${HOST}:${PORT}`);
});
