import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { conversation, hasTranscript, liveConversations } from './conversations.ts';
import { ASK_TOOL, MCP_SERVER_NAME, ORIGIN, SESSIONS_DIR, SYSTEM_PROMPT_FILE } from './config.ts';
import { sessions, type Question, type SessionStatus } from './db.ts';
import { loginEnv, quote, which } from './env.ts';
import { fullDiff } from './git.ts';
import { scheduleRerank } from './priority.ts';
import * as tmux from './tmux.ts';
import { notify, repoView } from './workspace.ts';

const run = promisify(execFile);

export const CLAUDE = await which('claude');

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop'];

export type ColorScheme = 'light' | 'dark';

// tmux hides the terminal background from Claude Code's `auto` theme, and a running
// Claude ignores theme changes in --settings but reloads ~/.claude/themes/, so sessions
// use this custom theme and its base follows the system scheme reported by the UI.
const THEME_SLUG = 'agent-ide';
const THEME_FILE = join(homedir(), '.claude', 'themes', `${THEME_SLUG}.json`);
let colorScheme: ColorScheme | undefined;

export async function setColorScheme(scheme: ColorScheme) {
  if (scheme === colorScheme) return;
  colorScheme = scheme;
  await mkdir(dirname(THEME_FILE), { recursive: true });
  await writeFile(THEME_FILE, JSON.stringify({ name: 'Agent IDE (follows system)', base: scheme }, null, 2));
}

await setColorScheme(await run('/usr/bin/defaults', ['read', '-g', 'AppleInterfaceStyle'])
  .then(({ stdout }) => (stdout.trim() === 'Dark' ? 'dark' : 'light'), () => 'light'));

async function writeSessionFiles(id: string) {
  const dir = join(SESSIONS_DIR, id);
  await mkdir(dir, { recursive: true });
  const hook = `curl -s -m 3 -X POST -H 'content-type: application/json' --data-binary @- ${ORIGIN}/api/hook/${id} >/dev/null 2>&1 || true`;
  const settings = {
    hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: 'command', command: hook }] }]])),
    permissions: { allow: [`mcp__${MCP_SERVER_NAME}__${ASK_TOOL}`] },
    theme: `custom:${THEME_SLUG}`,
  };
  const mcp = { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: `${ORIGIN}/mcp/${id}` } } };
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  await writeFile(join(dir, 'mcp.json'), JSON.stringify(mcp, null, 2));
  return dir;
}

function claudeCommand(id: string, dir: string, opts: { resume: boolean; prompt?: string }) {
  const args = [
    opts.resume ? '--resume' : '--session-id', id,
    '--settings', join(dir, 'settings.json'),
    '--mcp-config', join(dir, 'mcp.json'),
    '--append-system-prompt-file', SYSTEM_PROMPT_FILE,
  ];
  const prompt = opts.prompt ? ` -- ${quote(opts.prompt)}` : '';
  return `exec ${[CLAUDE, ...args].map(quote).join(' ')}${prompt}`;
}

function shellCommand(command?: string) {
  const shell = quote(loginEnv.SHELL!);
  return command ? `${shell} -l -c ${quote(command)}; exec ${shell} -l` : `exec ${shell} -l`;
}

export async function startClaude(opts: { repoId: number; worktree: string; prompt?: string; title?: string; continueId?: string }) {
  if (opts.continueId) return continueConversation({ ...opts, continueId: opts.continueId });
  const id = randomUUID();
  const name = `claude-${id.slice(0, 8)}`;
  const dir = await writeSessionFiles(id);
  sessions.insert({
    id, kind: 'claude', repoId: opts.repoId, worktree: opts.worktree, tmux: name,
    title: opts.title || null, firstPrompt: opts.prompt || null, status: 'idle',
  });
  try {
    await tmux.newSession(name, opts.worktree, claudeCommand(id, dir, { resume: false, prompt: opts.prompt }));
  } catch (err) {
    sessions.remove(id);
    throw err;
  }
  notify();
  return id;
}

async function continueConversation(opts: { repoId: number; worktree: string; continueId: string }) {
  const id = opts.continueId;
  if (sessions.get(id)) {
    if (!(await paneAlive(id))) await resume(id);
    return id;
  }
  const c = await conversation(opts.worktree, id);
  if (!c) throw new Error('conversation not found in this worktree');
  if (c.livePid) throw new Error(`this conversation is open in another terminal (pid ${c.livePid}); take it over or quit it there first`);
  const name = `claude-${id.slice(0, 8)}`;
  const dir = await writeSessionFiles(id);
  sessions.insert({
    id, kind: 'claude', repoId: opts.repoId, worktree: opts.worktree, tmux: name,
    title: c.title, firstPrompt: c.firstPrompt, status: 'idle',
  });
  try {
    await tmux.newSession(name, opts.worktree, claudeCommand(id, dir, { resume: true }));
  } catch (err) {
    sessions.remove(id);
    throw err;
  }
  void refreshDiffstat(id);
  notify();
  return id;
}

// Ends the Claude process that has the conversation open elsewhere (it saves on
// SIGTERM) and continues the conversation in tmux.
export async function takeOver(opts: { repoId: number; worktree: string; continueId: string }) {
  const pid = (await liveConversations()).get(opts.continueId);
  if (pid) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 50 && (await liveConversations()).has(opts.continueId); i++) await new Promise((r) => setTimeout(r, 100));
    if ((await liveConversations()).has(opts.continueId)) throw new Error(`pid ${pid} did not exit`);
  }
  return startClaude(opts);
}

async function paneAlive(id: string) {
  const pane = (await tmux.listPanes()).get(must(id).tmux);
  return !!pane && !pane.dead;
}

export async function startShell(opts: { repoId: number; worktree: string; command?: string; title?: string }) {
  const id = randomUUID();
  const name = `shell-${id.slice(0, 8)}`;
  sessions.insert({
    id, kind: 'shell', repoId: opts.repoId, worktree: opts.worktree, tmux: name,
    title: opts.title || null, firstPrompt: null, status: 'working',
  });
  await tmux.newSession(name, opts.worktree, shellCommand(opts.command));
  notify();
  return id;
}

export async function resume(id: string) {
  const s = must(id);
  if (s.kind !== 'claude') throw new Error('only Claude sessions can be resumed');
  const dir = await writeSessionFiles(id);
  const command = claudeCommand(id, dir, { resume: await hasTranscript(s.worktree, id) });
  const panes = await tmux.listPanes();
  if (panes.has(s.tmux)) await tmux.respawn(s.tmux, s.worktree, command);
  else await tmux.newSession(s.tmux, s.worktree, command);
  sessions.update(id, { status: 'idle', archived: false });
  notify();
}

export async function stop(id: string) {
  const s = must(id);
  await tmux.kill(s.tmux);
  if (s.kind === 'shell') sessions.remove(id);
  else sessions.update(id, { status: 'exited' });
  notify();
}

export async function forget(id: string) {
  const s = must(id);
  await tmux.kill(s.tmux);
  sessions.remove(id);
  await rm(join(SESSIONS_DIR, id), { recursive: true, force: true });
  scheduleRerank();
  notify();
}

export function archive(id: string, archived: boolean) {
  must(id);
  sessions.update(id, { archived });
  notify();
}

export async function stopWorktree(worktree: string) {
  for (const s of sessions.all().filter((s) => s.worktree === worktree)) await tmux.kill(s.tmux);
  sessions.removeByWorktree(worktree);
  scheduleRerank();
  notify();
}

export function ask(id: string, q: Omit<Question, 'askedAt'>) {
  must(id);
  sessions.update(id, { question: { ...q, askedAt: Date.now() }, rank: null, rankReason: null });
  scheduleRerank();
  void refreshDiffstat(id);
  notify();
}

function clearQuestion(id: string) {
  if (!sessions.get(id)?.question) return;
  sessions.update(id, { question: null, rank: null, rankReason: null });
  scheduleRerank();
}

export function dismiss(id: string) {
  must(id);
  clearQuestion(id);
  notify();
}

export async function answer(id: string, reply: { choice?: string; text?: string }) {
  const s = must(id);
  if (s.status === 'exited') throw new Error('session has exited; resume it first');
  const parts = [s.question ? `Re: "${s.question.title}"` : '', reply.choice ? `My decision: ${reply.choice}.` : '', reply.text?.trim() ?? '']
    .filter(Boolean);
  if (!reply.choice && !reply.text?.trim()) throw new Error('empty answer');
  await tmux.sendPrompt(s.tmux, parts.join(' — '));
  clearQuestion(id);
  sessions.update(id, { status: 'working' });
  notify();
}

interface HookPayload {
  hook_event_name?: string;
  prompt?: string;
  session_title?: string;
  notification_type?: string;
}

export function hook(id: string, p: HookPayload) {
  const s = sessions.get(id);
  if (!s) return;
  const set = (status: SessionStatus) => status !== s.status && sessions.update(id, { status });
  if (p.session_title && p.session_title !== s.title) sessions.update(id, { title: p.session_title });
  switch (p.hook_event_name) {
    case 'SessionStart':
      if (s.status === 'exited') set('idle');
      break;
    case 'UserPromptSubmit':
      if (!s.firstPrompt && p.prompt) sessions.update(id, { firstPrompt: p.prompt });
      clearQuestion(id);
      set('working');
      break;
    case 'PreToolUse':
    case 'PostToolUse':
      set('working');
      break;
    case 'PermissionRequest':
      set('permission');
      break;
    case 'Notification':
      if (p.notification_type === 'permission_prompt') set('permission');
      break;
    case 'Stop':
      set('idle');
      void refreshDiffstat(id);
      break;
  }
  notify();
}

const diffInFlight = new Set<string>();

export async function refreshDiffstat(id: string) {
  const s = sessions.get(id);
  const repo = s && repoView(s.repoId);
  if (!s || !repo || diffInFlight.has(s.worktree)) return;
  diffInFlight.add(s.worktree);
  try {
    const { stat } = await fullDiff(s.worktree, repo.base, true);
    for (const other of sessions.all().filter((o) => o.worktree === s.worktree)) sessions.update(other.id, { diffstat: stat });
    notify();
  } catch (err) {
    console.warn('diffstat failed', s.worktree, err);
  } finally {
    diffInFlight.delete(s.worktree);
  }
}

export async function pollTmux() {
  const panes = await tmux.listPanes();
  let changed = false;
  for (const s of sessions.all()) {
    const pane = panes.get(s.tmux);
    const alive = !!pane && !pane.dead;
    if (s.kind === 'shell' && !alive) {
      await tmux.kill(s.tmux);
      sessions.remove(s.id);
      changed = true;
    } else if (s.kind === 'claude' && !alive && s.status !== 'exited') {
      sessions.update(s.id, { status: 'exited' });
      void refreshDiffstat(s.id);
      changed = true;
    } else if (s.kind === 'claude' && alive && s.status === 'exited') {
      sessions.update(s.id, { status: 'idle' });
      changed = true;
    }
  }
  if (changed) notify();
}

export async function openInGhostty(id: string) {
  const s = must(id);
  if (s.kind === 'claude' && !(await paneAlive(id))) await resume(id);
  const command = [tmux.TMUX, ...tmux.TMUX_ARGS, 'attach-session', '-t', `=${s.tmux}`].map(quote).join(' ');
  const script = `tell application "Ghostty"
    set cfg to new surface configuration
    set command of cfg to ${JSON.stringify(command)}
    set initial working directory of cfg to ${JSON.stringify(s.worktree)}
    new window with configuration cfg
    activate
  end tell`;
  await run('/usr/bin/osascript', ['-e', script]);
}

function must(id: string) {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session ${id}`);
  return s;
}
