import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { handleAdvisorMcp, retryAdvice, stopAdvice } from './advisor.ts';
import { HOST, PORT, WEB_DIST } from './config.ts';
import { repos, roots, sessions } from './db.ts';
import { addWorktree, fullDiff, removeWorktree, repoRoot } from './git.ts';
import { handleMcp } from './mcp.ts';
import * as S from './sessions.ts';
import { onChange, refreshWorkspace, repoView, snapshot, workspace } from './workspace.ts';

const run = promisify(execFile);
const app = new Hono();

const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`, 'http://127.0.0.1:5173', 'http://localhost:5173']);

// Loopback alone does not stop a web page from reaching us; reject foreign hosts
// (DNS rebinding) and foreign origins (cross-site requests).
app.use(async (c, next) => {
  const host = c.req.header('host') ?? '';
  const origin = c.req.header('origin');
  if (!allowedHosts.has(host) && !host.endsWith(':5173')) return c.text('forbidden host', 403);
  if (origin && !allowedOrigins.has(origin)) return c.text('forbidden origin', 403);
  await next();
});

app.onError((err, c) => {
  console.error(c.req.method, c.req.path, err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
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
  const root = await repoRoot(path).catch(() => null);
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

app.post('/api/worktrees', async (c) => {
  const body = await c.req.json<{ repoId: number; name: string; branch?: string; path?: string; prompt?: string; startClaude?: boolean }>();
  const repo = repoView(body.repoId);
  if (!repo) throw new Error('unknown repo');
  const name = body.name.trim();
  if (!name) throw new Error('name is required');
  const path = body.path?.trim() || join(repo.defaultWorktreeRoot, name);
  await addWorktree(repo.path, path, body.branch?.trim() || name, repo.base);
  await refreshWorkspace();
  if (body.startClaude === false) {
    if (repo.setupCommand) await S.openShell(path, repo.setupCommand);
    return c.json({ path, sessionId: null });
  }
  const sessionId = await S.startClaude({ repoId: repo.id, worktree: path, prompt: body.prompt, title: name, setup: repo.setupCommand });
  return c.json({ path, sessionId });
});

app.delete('/api/worktrees', async (c) => {
  const body = await c.req.json<{ repoId: number; path: string; force?: boolean; deleteBranch?: boolean }>();
  const repo = repoView(body.repoId);
  if (!repo) throw new Error('unknown repo');
  S.stopWorktree(body.path);
  await removeWorktree(repo.path, body.path, { force: !!body.force, deleteBranch: !!body.deleteBranch });
  await refreshWorkspace();
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

app.post('/api/sessions/:id/:action', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  switch (c.req.param('action')) {
    case 'answer': await S.answer(id, body); break;
    case 'dismiss': S.dismiss(id); break;
    case 'accept-advice': await S.acceptAdvice(id); break;
    case 'retry-advice': retryAdvice(id); break;
    case 'stop-advice': stopAdvice(id); break;
    case 'focus': await S.focus(id); break;
    case 'quit': S.quit(id); break;
    case 'forget': await S.forget(id); break;
    case 'archive': S.archive(id, body.archived ?? true); break;
    default: return c.text('unknown action', 404);
  }
  return c.body(null, 204);
});

app.get('/api/diff', async (c) => {
  const worktree = c.req.query('worktree') ?? '';
  const repo = workspace().find((r) => r.worktrees.some((w) => w.path === worktree));
  if (!repo) throw new Error('unknown worktree');
  const diff = await fullDiff(worktree, repo.base);
  for (const s of sessions.all().filter((s) => s.worktree === worktree)) sessions.update(s.id, { diffstat: diff.stat });
  return c.json(diff);
});

const uiEntry = async () =>
  (await readFile(join(WEB_DIST, 'index.html'), 'utf8').catch(() => '')).match(/src="([^"]+\.js)"/)?.[1] ?? null;

app.get('/ws/events', upgradeWebSocket(() => {
  let off: (() => void) | undefined;
  return {
    async onOpen(_evt, ws) {
      ws.send(JSON.stringify({ ...snapshot(), uiEntry: await uiEntry() }));
      off = onChange(() => ws.send(JSON.stringify(snapshot())));
    },
    onClose() {
      off?.();
    },
  };
}));

app.use('/*', serveStatic({ root: WEB_DIST }));
app.get('*', async (c) => {
  const html = await readFile(join(WEB_DIST, 'index.html'), 'utf8').catch(() => null);
  return html ? c.html(html) : c.text('UI not built: run `pnpm build`', 503);
});

await refreshWorkspace({ scan: true });
await S.sync();
setInterval(() => void S.sync().catch((err) => console.warn('session sync failed', err)), 1500);
setInterval(() => void refreshWorkspace({ scan: true }).catch((err) => console.warn('workspace refresh failed', err)), 30_000);

serve({ fetch: app.fetch, hostname: HOST, port: PORT, websocket: { server: new WebSocketServer({ noServer: true }) } }, () => {
  console.log(`agent-ide listening on http://${HOST}:${PORT}`);
});
