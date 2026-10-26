import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';
import { answering, closeQuestion, liveTty, type Reply } from '../../server/answering.ts';
import type { FullDiff } from '../../server/git.ts';
import type { Session } from '../../server/db.ts';
import { checkDecision, decisionKey, openDecision, Refusal } from '../../server/decision.ts';
import { menuKeystrokes, type MenuAnswer } from '../../server/menu.ts';
import { readEntry, watchEntry } from '../../server/uiEntry.ts';
import type { RepoView } from '../../server/workspace.ts';
import { isolateHome, refuseLive } from '../isolate.ts';
import { addFromTemplate, artifactPage, COMMANDS, DELETE_LOSS, explanationOf, TEMPLATES, worktreeRootOf, type Template } from './fixtures.ts';
import { scenarios, type Flag, type Scenario } from './scenarios.ts';

// The contract of server/main.ts over made-up sessions, without a Claude, tmux, Ghostty or the live board behind it.

isolateHome();

const ROOT = resolve(import.meta.dirname, '../..');
const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '7421' },
    dist: { type: 'string', default: join(ROOT, 'web', 'dist') },
    scenario: { type: 'string', default: 'queue' },
    legacy: { type: 'boolean', default: false },
  },
});
refuseLive(Number(args.port));
const DIST = resolve(args.dist);
const UPLOADS_DIR = join(homedir(), 'Library', 'Caches', 'agent-board', 'uploads');
// Every Diff tab shows this commit of the repository itself, a real patch of 12 files.
const FIXTURE_COMMIT = 'ff30c77';

// Copied from server/artifacts.ts, which loads the MCP server.
const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'sandbox allow-scripts',
].join('; ');

const TYPING_MS = 300;

const run = promisify(execFile);

class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class Page {
  html: string;
  headers: Record<string, string>;
  constructor(html: string, headers: Record<string, string> = {}) {
    this.html = html;
    this.headers = headers;
  }
}

interface Entry {
  at: number;
  method: string;
  path: string;
  query: string;
  action: string | null;
  sessionId: string | null;
  body: unknown;
  raw?: string;
  status: number | null;
  code: string | null;
}

let state: Scenario = scenarios.queue(Date.now());
let scenarioName = 'queue';
const timers = new Set<NodeJS.Timeout>();
const pauses = new Set<() => void>();
const uploads = new Set<string>();
const log: Entry[] = [];
let failNext: { error: string; code?: string } | null = null;
let delayMs = 0;
let dropUntil = 0;
let announced: string | null = null;

const clients = new Set<WebSocket>();
let pushing = false;

function shown(s: Session) {
  if (!args.legacy) return s;
  const { answered: _, ...old } = s;
  return old;
}

const snapshot = () => ({
  roots: state.roots, repos: state.repos, sessions: state.sessions.toSorted((a, b) => a.createdAt - b.createdAt).map(shown),
  ...(!args.legacy && { usage: state.usage }),
});

// As in server/main.ts: every snapshot names the entry the polls have taken, and a socket that opens first reads
// index.html, which can only cast doubt on it. On --legacy only a socket that opens is told an entry, what that read
// finds. A src that /mock/ui-entry sets is named instead of either until {src: null} or a scenario load clears it.
const ui = watchEntry(() => readEntry(join(DIST, 'index.html')), () => {
  if (!args.legacy) push();
});

function push() {
  if (pushing) return;
  pushing = true;
  queueMicrotask(() => {
    pushing = false;
    const message = JSON.stringify({ ...snapshot(), ...(!args.legacy && { uiEntry: announced ?? ui.settled() }) });
    for (const ws of clients) ws.send(message);
  });
}

function load(name: string) {
  const make = scenarios[name];
  if (!make) throw new HttpError(404, `unknown scenario ${name}; there are ${Object.keys(scenarios).join(', ')}`);
  for (const t of timers) clearTimeout(t);
  timers.clear();
  for (const cancel of pauses) cancel();
  pauses.clear();
  failNext = null;
  delayMs = 0;
  dropUntil = 0;
  announced = null;
  state = make(Date.now());
  if (args.legacy) for (const s of state.sessions) s.answered = null;
  answers = answeringFor(state);
  scenarioName = name;
  push();
}

function later(ms: number, fn: () => void) {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
}

// Fails when another scenario loads meanwhile, so a request from before never acts on the new one.
function pause(ms: number) {
  return new Promise<void>((done, fail) => {
    const cancel = () => {
      clearTimeout(timer);
      fail(new Error('the mock loaded another scenario meanwhile'));
    };
    const timer = setTimeout(() => {
      pauses.delete(cancel);
      done();
    }, ms);
    pauses.add(cancel);
  });
}

const find = (id: string) => state.sessions.find((s) => s.id === id);

function must(id: string) {
  const s = find(id);
  if (!s) throw new Error(`unknown session ${id}`);
  return s;
}

function update(id: string, patch: Partial<Session>) {
  const s = find(id);
  if (!s) return;
  Object.assign(s, patch, { updatedAt: Date.now() });
  push();
}

const flagged = (id: string, flag: Flag) => !!state.flags[id]?.includes(flag);

const repoOf = (id: number) => state.repos.find((r) => r.id === id);

function mustRepo(id: number) {
  const repo = repoOf(id);
  if (!repo) throw new Error('unknown repo');
  return repo;
}

function claudeWorks(id: string) {
  later(600, () => {
    const since = Date.now();
    update(id, { status: 'working', menu: null, waitingFor: null, lastTurn: `t-${since.toString(36)}`, activity: { step: args.legacy ? 'Thinking' : null, since } });
    later(1500, () => {
      if (find(id)?.status === 'working') update(id, { activity: { step: 'Bash: pnpm test', since } });
    });
  });
}

function checkUploads(paths: unknown) {
  if (paths === undefined) return [];
  if (!Array.isArray(paths)) throw new Error('files must be a list');
  for (const p of paths) {
    if (typeof p !== 'string' || !p.startsWith(UPLOADS_DIR + sep) || p.includes('..') || /\s/.test(p)) throw new Error('unknown attachment');
    if (!uploads.has(p)) throw new Error(`attachment ${p} is gone; paste it again`);
  }
  return paths as string[];
}

const isCommand = (text: string) => text.startsWith('!') || COMMANDS.some((c) => c.name === text.match(/^\/(\S+)/)?.[1]);

// One per scenario: a send still waiting its turn when another scenario loads is refused, not run on the new one.
function answeringFor(scenario: Scenario) {
  const get = (id: string) => {
    if (scenario !== state) throw new Error('the mock loaded another scenario meanwhile');
    return find(id);
  };
  return answering({
    store: { get, update },
    send: () => pause(TYPING_MS),
    keys: () => pause(TYPING_MS),
    notify: push,
    decided: claudeWorks,
    isCommand: async (_s, text) => isCommand(text),
    checkUploads: async (files) => checkUploads(files),
  });
}

let answers = answeringFor(state);

function legacyAnswer(s: Session, reply: Reply, commands = true) {
  liveTty(s);
  if (s.status === 'waiting' || s.menu) throw new Error(`Claude is showing ${s.waitingFor ?? 'a question'} in its terminal; answer that first`);
  const text = reply.text?.trim() ?? '';
  const files = checkUploads(reply.files);
  if (!reply.choice && !text && !files.length) throw new Error('empty answer');
  if (commands && !reply.choice && !files.length && isCommand(text)) return;
  checkDecision(s, reply.key, !reply.choice);
  closeQuestion({ get: find, update }, s.id, reply.key ?? null);
  claudeWorks(s.id);
}

function legacyAnswerMenu(s: Session, body: { toolUseId?: string; answers?: MenuAnswer[] }) {
  liveTty(s);
  const menu = s.menu;
  if (!menu || menu.toolUseId !== body.toolUseId) throw new Error('this question is no longer open');
  menuKeystrokes(menu, body.answers!);
  claudeWorks(s.id);
}

function legacyAcceptAdvice(s: Session) {
  const a = s.advice;
  const decision = openDecision(s);
  if (a?.state !== 'done' || a.key !== decision?.key) throw new Error('no advice to accept');
  if (decision.menu) legacyAnswerMenu(s, { toolUseId: decision.menu.toolUseId, answers: a.answers ?? [] });
  else legacyAnswer(s, { key: a.key, choice: a.choice ?? undefined, text: a.answer }, false);
}

function elaborate(s: Session) {
  const d = openDecision(s);
  if (!d) throw new Error('nothing to decide right now');
  if (s.explanation?.key === d.key && s.explanation.state !== 'failed') return;
  update(s.id, { explanation: { key: d.key, state: 'thinking', text: '', at: Date.now() } });
  later(1200, () => {
    const current = find(s.id)?.explanation;
    if (current?.key !== d.key) return;
    update(s.id, {
      explanation: flagged(s.id, 'explainFails')
        ? { ...current, state: 'failed', error: 'the explanation run timed out after 300 s', at: Date.now() }
        : { ...current, state: 'done', text: explanationOf(d.title), at: Date.now() },
    });
  });
}

function retryAdvice(s: Session) {
  const d = openDecision(s);
  if (!d) throw new Error('nothing to decide right now');
  if (s.advice?.key === d.key && s.advice.state === 'thinking') return;
  const at = Date.now();
  update(s.id, { advice: { key: d.key, state: 'thinking', startedAt: at, activity: 'Starting', choice: null, answer: '', confidence: 0, reasoning: '', at } });
}

function stopAdvice(s: Session) {
  const a = s.advice;
  if (a?.state === 'thinking' && a.key === openDecision(s)?.key) update(s.id, { advice: { ...a, state: 'failed', activity: null, error: 'stopped', at: Date.now() } });
}

async function rename(s: Session, title: unknown) {
  const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new Error('the name is empty');
  if (s.status !== 'exited') {
    if (!args.legacy) await answers.type(s.id, `/rename ${name}`);
    else if (s.status === 'waiting' || s.menu) throw new Error(`Claude is showing ${s.waitingFor ?? 'a question'} in its terminal; answer that first`);
    else liveTty(s);
  }
  update(s.id, { title: name });
}

function removeWorktree(repo: RepoView, path: string) {
  const worktree = repo.worktrees.find((w) => w.path === path);
  if (!worktree) throw new Error('worktree not found');
  if (worktree.isMain) throw new Error('this is the repository itself, not a worktree');
  repo.worktrees = repo.worktrees.filter((w) => w !== worktree);
  state.sessions = state.sessions.filter((s) => s.worktree !== path);
  push();
}

const onDecision = new Set(['dismiss', 'accept-advice', 'retry-advice', 'stop-advice', 'elaborate']);

const actions: Record<string, (s: Session, body: any) => void | Promise<void>> = {
  answer: (s, body) => (args.legacy ? legacyAnswer(s, body) : answers.answer(s.id, body)),
  dismiss: (s, body) => closeQuestion({ get: find, update }, s.id, body.key),
  rename: (s, body) => rename(s, body.title),
  'answer-menu': (s, body) => (args.legacy ? legacyAnswerMenu(s, body) : answers.answerMenu(s.id, body)),
  'accept-advice': (s, body) =>
    args.legacy ? legacyAcceptAdvice(s) : answers.acceptAdvice(s.id, typeof body.adviceAt === 'number' ? body.adviceAt : undefined),
  'retry-advice': (s) => retryAdvice(s),
  'stop-advice': (s) => stopAdvice(s),
  elaborate: (s) => elaborate(s),
  focus: (s) => answers.settled(s.id),
  finder: () => {},
  vscode: () => {},
  quit: (s) => later(300, () => update(s.id, { status: 'exited', pid: null, waitingFor: null, menu: null })),
  forget: (s) => {
    if (s.status !== 'exited') throw new Error('quit this session first, or archive it');
    state.sessions = state.sessions.filter((o) => o !== s);
    push();
  },
  archive: (s, body) => update(s.id, { archived: body.archived ?? true }),
  'delete-worktree': (s) => {
    if (!mustRepo(s.repoId).worktrees.find((w) => w.path === s.worktree)?.isMain) return removeWorktree(mustRepo(s.repoId), s.worktree);
    state.sessions = state.sessions.filter((o) => o !== s);
    push();
  },
};

async function sessionAction(id: string, action: string, body: any) {
  if (delayMs) await pause(delayMs);
  if (failNext) {
    const { error, code } = failNext;
    failNext = null;
    throw new HttpError(400, error, code);
  }
  const act = actions[action];
  if (!act) throw new HttpError(404, 'unknown action');
  const s = must(id);
  if (onDecision.has(action)) checkDecision(s, body.key);
  await act(s, body);
}

const longLived = (repo: RepoView, branch: string) =>
  ['master', 'main', 'develop', 'trunk', repo.base, repo.base.replace(/^[^/]+\//, '')].includes(branch) || branch.startsWith('release/');

function deleteLoss(s: Session) {
  if (flagged(s.id, 'lossFails')) throw new Error('git status failed: fatal: unable to read the index');
  const repo = repoOf(s.repoId);
  const worktree = repo?.worktrees.find((w) => w.path === s.worktree);
  if (!repo || !worktree) throw new Error('worktree not found');
  if (worktree.isMain) return { branch: worktree.branch, deletesBranch: false, files: 0, commits: 0, checkout: true };
  const deletesBranch = !!worktree.branch && !longLived(repo, worktree.branch);
  return { branch: worktree.branch, deletesBranch, files: DELETE_LOSS.files, commits: deletesBranch || !worktree.branch ? DELETE_LOSS.commits : 0 };
}

const OTHER_BRANCHES = ['release/2026.10', 'spike/edge-cache', 'renovate/vite-8'];

function branches(repo: RepoView) {
  const checkedOut = new Map(repo.worktrees.flatMap((w) => (w.branch ? [[w.branch, w.path]] : [])));
  return [...new Set([...checkedOut.keys(), ...OTHER_BRANCHES])].map((name) => ({ name, worktree: checkedOut.get(name) ?? null }));
}

function startSession(repo: RepoView, worktree: string, o: { id?: string; title?: string | null; prompt?: string | null }) {
  const now = Date.now();
  const id = o.id ?? randomUUID();
  const working = !!o.prompt;
  state.sessions.push({
    id, repoId: repo.id, worktree, cwd: worktree, pid: 41_000 + state.sessions.length, tty: '/dev/ttys041', title: o.title || null,
    firstPrompt: o.prompt || null, status: working ? 'working' : 'idle', question: null, rank: null, rankReason: null, diffstat: null,
    lastMessage: null, lastTurn: null, waitingFor: null, dismissedAsk: null, advice: null, pr: null, summary: null, explanation: null,
    activity: working ? { step: args.legacy ? 'Thinking' : null, since: now } : null, menu: null, answered: null, artifacts: [], archived: false, createdAt: now, updatedAt: now,
  });
  push();
  return id;
}

function addWorktree(repo: RepoView, body: { name?: string; branch?: string; path?: string; existingBranch?: boolean }) {
  const name = String(body.name ?? '').trim();
  const branch = body.branch?.trim();
  if (body.existingBranch) {
    if (!branch) throw new Error('pick a branch');
    const checkedOut = repo.worktrees.find((w) => w.branch === branch);
    if (checkedOut) return checkedOut.path;
    if (!branches(repo).some((b) => b.name === branch)) throw new Error(`no branch named ${branch}`);
    const main = repo.worktrees.find((w) => w.isMain)!;
    main.branch = branch;
    return main.path;
  }
  if (!name) throw new Error('name is required');
  if (name === 'fail') throw new Error(`git wt: a branch named '${branch || name}' cannot be created here`);
  const wanted = body.path?.trim();
  if (wanted && !wanted.startsWith('/') && !wanted.startsWith('~')) throw new Error('the worktree path must be absolute');
  const path = wanted || `${repo.defaultWorktreeRoot}/${name.replaceAll('/', '-')}/${repo.name}`;
  if (!repo.worktrees.some((w) => w.path === path)) {
    repo.worktrees.push({ path, branch: branch || name, head: randomUUID().replaceAll('-', '').padEnd(40, '0'), isMain: false, conversations: [] });
  }
  return path;
}

const diffs = new Map<string, Promise<Omit<FullDiff, 'base'>>>();

function fixtureDiff(paths: string[] = []) {
  const key = paths.join('\n');
  if (!diffs.has(key)) {
    const git = (...a: string[]) => run('git', a, { cwd: ROOT, maxBuffer: 64 << 20 }).then((r) => r.stdout);
    const show = ['show', '--format=', '--find-renames', '--no-color', '--no-ext-diff', FIXTURE_COMMIT];
    const only = paths.length ? ['--', ...paths] : [];
    const diff = Promise.all([
      git('rev-parse', `${FIXTURE_COMMIT}^`),
      git(...show, '--numstat', ...only),
      git(...show, ...(paths.length ? ['--unified=1000000'] : []), ...only),
    ]).then(([mergeBase, numstat, patch]) => {
      const stat = { files: 0, insertions: 0, deletions: 0 };
      for (const line of numstat.split('\n').filter(Boolean)) {
        const [add, del] = line.split('\t');
        stat.files++;
        stat.insertions += Number(add) || 0;
        stat.deletions += Number(del) || 0;
      }
      return { mergeBase: mergeBase.trim(), patch, stat };
    });
    diff.catch(() => diffs.delete(key));
    diffs.set(key, diff);
  }
  return diffs.get(key)!;
}

function repoOfWorktree(worktree: string) {
  const repo = state.repos.find((r) => r.worktrees.some((w) => w.path === worktree));
  if (!repo) throw new Error('unknown worktree');
  return repo;
}

const safeName = (name: string) => name.split(/[\\/]/).at(-1)!.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(-120) || 'file';

function setAdvice(s: Session, body: { state?: 'thinking' | 'done' | 'failed'; choice?: string | null; answer?: string; confidence?: number; answers?: MenuAnswer[]; error?: string }) {
  const key = decisionKey(s);
  if (!key) throw new Error(`${s.id} has no open decision`);
  const at = Date.now();
  const state = body.state ?? 'done';
  const choice = body.choice ?? null;
  update(s.id, {
    advice: {
      key, state, startedAt: state === 'thinking' ? at : (s.advice?.startedAt ?? at - 60_000), at,
      activity: state === 'thinking' ? 'Read the changed files' : null,
      choice: state === 'done' ? choice : null,
      answer: body.answer ?? (state === 'done' && !s.menu ? (choice ? `${choice}, because it fits what the task asks for.` : 'Use the smallest change that keeps the tests green.') : ''),
      confidence: state === 'done' ? (body.confidence ?? 70) : 0,
      reasoning: state === 'done' ? 'Checked the task, the open question and the code it touches.' : '',
      ...(body.answers && { answers: body.answers }),
      ...(state === 'failed' && { error: body.error ?? 'the advisor gave an empty answer' }),
    },
  });
}

function merge(target: Record<string, any>, patch: Record<string, any>) {
  for (const [k, v] of Object.entries(patch)) {
    const plain = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);
    target[k] = plain(v) && plain(target[k]) ? merge({ ...target[k] }, v) : v;
  }
  return target;
}

interface Request {
  params: string[];
  body: any;
  raw: Buffer;
  url: URL;
  headers: IncomingMessage['headers'];
  afterReply: (fn: () => void) => void;
}

type Handler = (req: Request) => unknown;

const NONE = Symbol('204');
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, path: string, handler: Handler) =>
  routes.push([method, new RegExp(`^${path.replace(/:[a-z]+/g, '([^/]+)')}$`), handler]);

route('GET', '/api/state', () => snapshot());
route('POST', '/api/pick-folder', () => ({ path: '~/code/payments' }));
route('POST', '/api/repos', ({ body }) => {
  const path = String(body.path ?? '').trim().replace(/(.)\/$/, '$1');
  if (!path.startsWith('/') && !path.startsWith('~')) throw new Error(`not a folder: ${path}`);
  if (!state.repos.some((r) => r.path === path)) {
    const name = path.split('/').at(-1)!;
    state.repos.push({
      id: Math.max(0, ...state.repos.map((r) => r.id)) + 1, path, name, baseBranch: null, setupCommand: null, worktreeRoot: null,
      base: 'origin/main', defaultWorktreeRoot: worktreeRootOf(path),
      worktrees: [{ path, branch: 'main', head: '0'.repeat(40), isMain: true, conversations: [] }],
    });
    push();
  }
  return { scanned: false };
});
route('DELETE', '/api/roots', ({ body }) => {
  state.roots = state.roots.filter((r) => r !== body.path);
  push();
  return NONE;
});
route('POST', '/api/rescan', () => NONE);
route('PATCH', '/api/repos/:id', ({ params, body }) => {
  const repo = repoOf(Number(params[0]));
  if (!repo) return NONE;
  for (const key of ['baseBranch', 'setupCommand', 'worktreeRoot'] as const) if (key in body) repo[key] = body[key] || null;
  repo.base = repo.baseBranch ?? 'origin/main';
  repo.defaultWorktreeRoot = repo.worktreeRoot ?? worktreeRootOf(repo.path);
  push();
  return NONE;
});
route('DELETE', '/api/repos/:id', ({ params }) => {
  const id = Number(params[0]);
  state.sessions = state.sessions.filter((s) => s.repoId !== id);
  state.repos = state.repos.filter((r) => r.id !== id);
  push();
  return NONE;
});
route('GET', '/api/repos/:id/branches', ({ params }) => branches(mustRepo(Number(params[0]))));
route('POST', '/api/worktrees', ({ body }) => {
  const repo = mustRepo(body.repoId);
  const path = addWorktree(repo, body);
  push();
  if (body.startClaude === false) return { path, sessionId: null };
  return { path, sessionId: startSession(repo, path, { title: String(body.name ?? '').trim(), prompt: body.prompt }) };
});
route('DELETE', '/api/worktrees', ({ body }) => {
  removeWorktree(mustRepo(body.repoId), body.path);
  return NONE;
});
route('POST', '/api/sessions', ({ body }) => {
  const repo = mustRepo(body.repoId);
  if (!body.continueId) return { id: startSession(repo, body.worktree, { prompt: body.prompt }) };
  const existing = find(body.continueId);
  if (existing && existing.status !== 'exited') return { id: existing.id };
  const conversation = repo.worktrees.find((w) => w.path === body.worktree)?.conversations.find((c) => c.id === body.continueId);
  if (!existing && !conversation) throw new Error('conversation not found in this worktree');
  if (existing) update(existing.id, { status: 'idle', pid: 41_500, tty: '/dev/ttys042' });
  else startSession(repo, body.worktree, { id: body.continueId, title: conversation!.title, prompt: null });
  return { id: body.continueId };
});
route('POST', '/api/shell', () => NONE);
route('GET', '/api/sessions/:id/artifacts/:artifact', ({ params }) => {
  const artifact = find(params[0])?.artifacts.find((a) => a.id === params[1]);
  if (!artifact) throw new HttpError(404, 'artifact not found');
  return new Page(artifactPage(artifact.title), { 'content-security-policy': ARTIFACT_CSP });
});
route('GET', '/api/sessions/:id/delete-worktree', ({ params }) => deleteLoss(must(params[0])));
route('POST', '/api/sessions/:id/:action', async ({ params, body }) => {
  await sessionAction(params[0], params[1], body);
  return NONE;
});
route('POST', '/api/uploads', ({ raw, headers }) => {
  if (!raw.length) throw new Error('empty file');
  if (raw.length > 30 * 1024 * 1024) throw new Error('files over 30 MB are not accepted');
  const path = join(UPLOADS_DIR, randomUUID(), safeName(decodeURIComponent(String(headers['x-filename'] ?? 'file'))));
  uploads.add(path);
  return { path };
});
route('GET', '/api/commands', () => COMMANDS);
route('GET', '/api/diff/file', async ({ url }) => {
  const repo = repoOfWorktree(url.searchParams.get('worktree') ?? '');
  const paths = url.searchParams.getAll('path');
  if (!paths.length || paths.some((p) => p.startsWith('/') || p.split('/').includes('..'))) throw new Error('bad path');
  return { base: repo.base, ...(await fixtureDiff(paths)) };
});
route('GET', '/api/diff', async ({ url }) => {
  const worktree = url.searchParams.get('worktree') ?? '';
  const repo = repoOfWorktree(worktree);
  const diff = { base: repo.base, ...(await fixtureDiff()) };
  for (const s of state.sessions.filter((s) => s.worktree === worktree)) s.diffstat = diff.stat;
  push();
  return diff;
});

route('GET', '/mock', () => ({ scenario: scenarioName, scenarios: Object.keys(scenarios), templates: TEMPLATES, legacy: args.legacy }));
route('POST', '/mock/scenario/:name', ({ params }) => {
  load(params[0]);
  return { scenario: scenarioName };
});
route('POST', '/mock/patch', ({ body }) => {
  const s = must(body.id);
  merge(s, body.patch ?? {});
  push();
  return s;
});
route('POST', '/mock/usage', ({ body }) => {
  state.usage = body.usage ?? null;
  push();
  return NONE;
});
route('POST', '/mock/add', ({ body }) => {
  const { template, id, rank, repoId = 1, flags, ...fields } = body;
  if (!TEMPLATES.includes(template)) throw new Error(`unknown template ${template}; there are ${TEMPLATES.join(', ')}`);
  if (!id || find(id)) throw new Error(`pick a new id, not ${id}`);
  const s = addFromTemplate(mustRepo(repoId), template as Template, { id, title: fields.title, now: Date.now(), rank });
  state.sessions.push(merge(s, fields) as Session);
  if (flags) state.flags[id] = flags;
  push();
  return s;
});
route('POST', '/mock/advice', ({ body }) => {
  setAdvice(must(body.id), body);
  return find(body.id)!.advice;
});
route('POST', '/mock/fail', ({ body }) => {
  failNext = { error: String(body.error ?? 'mock failure'), ...(body.code && { code: String(body.code) }) };
  return failNext;
});
route('POST', '/mock/delay', ({ body }) => {
  delayMs = Number(body.ms) || 0;
  return { ms: delayMs };
});
route('POST', '/mock/drop', ({ body, afterReply }) => {
  const ms = Number(body.ms) || 0;
  afterReply(() => setTimeout(() => drop(ms), 50));
  return { ms };
});
// Names src in place of the build's entry until {src: null} or a scenario load clears it: to the open sockets at once,
// to every socket that opens and in every push (on --legacy pushes name no entry).
route('POST', '/mock/ui-entry', ({ body }) => {
  announced = body.src == null ? null : String(body.src);
  const message = JSON.stringify({ ...snapshot(), uiEntry: announced ?? ui.settled() });
  for (const ws of clients) ws.send(message);
  return { sockets: clients.size };
});
route('GET', '/mock/log', ({ url }) => {
  const entries = [...log];
  if (url.searchParams.has('clear')) log.length = 0;
  return entries;
});

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(res: ServerResponse, pathname: string) {
  const asset = !!extname(pathname);
  const file = asset ? resolve(DIST, `.${decodeURIComponent(pathname)}`) : join(DIST, 'index.html');
  const body = file.startsWith(DIST + sep) ? await readFile(file).catch(() => null) : null;
  if (!body) {
    res.writeHead(asset ? 404 : 503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(asset ? 'not found' : 'UI not built: run `pnpm build`');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

let port = 0;

// Like server/main.ts: loopback alone does not stop a web page elsewhere from calling us.
function allowed(req: IncomingMessage) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173', 'localhost:5173'];
  const origin = req.headers.origin;
  return hosts.includes(req.headers.host ?? '') && (!origin || hosts.some((h) => origin === `http://${h}`));
}

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });

// Uploads are the only bodies that are not JSON; fetch sends a string body as text/plain.
function parse(raw: Buffer, type = '') {
  if (!raw.length) return { body: {} };
  if (!type.includes('json') && !type.startsWith('text/')) return { body: undefined };
  const text = raw.toString('utf8');
  try {
    return { body: JSON.parse(text), text };
  } catch {
    return { body: undefined, text };
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://mock');
  if (!allowed(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden host or origin');
    return;
  }
  const api = url.pathname.startsWith('/api/');
  const control = url.pathname === '/mock' || url.pathname.startsWith('/mock/');
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!api && !control && req.method === 'GET') return serveStatic(res, url.pathname);
  const raw = await readBody(req);
  const { body, text } = parse(raw, req.headers['content-type']);
  const parts = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)/);
  const entry: Entry | null = api ? {
    at: Date.now(), method: req.method ?? '', path: url.pathname, query: url.search, action: parts?.[2] ?? null, sessionId: parts?.[1] ?? null,
    body: body ?? { bytes: raw.length, filename: req.headers['x-filename'] ?? null }, ...(text !== undefined && { raw: text }), status: null, code: null,
  } : null;
  if (entry) log.push(entry);
  const reply = (status: number, data?: unknown, headers: Record<string, string> = {}) => {
    if (entry) {
      entry.status = status;
      entry.code = (data as { code?: string } | undefined)?.code ?? null;
    }
    if (data === undefined) {
      res.writeHead(status, headers);
      res.end();
    } else if (typeof data === 'string') {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
      res.end(data);
    } else {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    }
  };
  const match = routes.map(([method, pattern, handler]) => ({ method, handler, params: url.pathname.match(pattern) })).find((r) => r.method === req.method && r.params);
  if (!match) return reply(404, 'not found');
  try {
    const result = await match.handler({
      params: match.params!.slice(1).map(decodeURIComponent), body: body ?? {}, raw, url, headers: req.headers,
      afterReply: (fn) => res.on('finish', fn),
    });
    if (result === NONE) reply(204);
    else if (result instanceof Page) reply(200, result.html, { 'content-type': 'text/html; charset=utf-8', ...result.headers });
    else reply(200, result);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 404) return reply(404, message);
    const code = err instanceof HttpError ? err.code : err instanceof Refusal && !args.legacy ? err.code : undefined;
    reply(status, { error: message, ...(code && { code }) });
  }
}

const sockets = new Set<Socket>();

function drop(ms: number) {
  dropUntil = Date.now() + ms;
  for (const ws of clients) ws.terminate();
  for (const socket of sockets) socket.destroy();
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err));
  });
});

server.on('connection', (socket) => {
  if (Date.now() < dropUntil) return socket.destroy();
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws/events' || !allowed(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, async (ws) => {
    const read = await ui.fresh();
    if (ws.readyState !== ws.OPEN) return;
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ ...snapshot(), uiEntry: announced ?? (args.legacy ? read : ui.settled()) }));
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));

load(args.scenario);
server.listen(Number(args.port), '127.0.0.1', () => {
  port = (server.address() as AddressInfo).port;
  console.log(`agent-board mock on http://127.0.0.1:${port} · scenario ${scenarioName} · ${DIST}${args.legacy ? ' · legacy' : ''}`);
});
