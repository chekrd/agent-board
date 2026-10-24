import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function script(body: string, ...args: string[]) {
  const source = `on run argv\ntell application "Ghostty"\n${body}\nend tell\nend run`;
  const { stdout } = await run('/usr/bin/osascript', ['-e', source, ...args]);
  return stdout.trim();
}

const NOT_FOUND = 'NOT_FOUND';

// Claude runs in a Ghostty terminal whose tty is the process's controlling tty.
async function onTerminal(tty: string, body: string, ...args: string[]) {
  const out = await script(`set matches to (terminals whose tty is item 1 of argv)
if (count of matches) is 0 then return "${NOT_FOUND}"
set t to item 1 of matches
${body}`, tty, ...args);
  if (out === NOT_FOUND) throw new Error(`no Ghostty tab runs ${tty}; the session may be in another terminal app or inside tmux`);
  return out;
}

export async function ttys(): Promise<Set<string>> {
  const out = await script('return tty of terminals');
  return new Set(out.split(', ').filter(Boolean));
}

export async function focus(tty: string) {
  await onTerminal(tty, 'focus t\nactivate');
}

// `input text` arrives as a bracketed paste, so a multi-line message stays one prompt;
// Enter goes separately once the TUI has taken in the paste.
export async function send(tty: string, text: string) {
  await onTerminal(tty, 'input text (item 2 of argv) to t', text);
  await new Promise((r) => setTimeout(r, 200));
  await onTerminal(tty, 'send key "enter" to t');
}

// Opens a tab in the front Ghostty window (or a new window) running the user's shell,
// then types `input` into it, so the shell is still there after Claude quits.
export async function newTab(cwd: string, input: string) {
  await script(`set cfg to new surface configuration
set initial working directory of cfg to item 1 of argv
set initial input of cfg to (item 2 of argv) & linefeed
if (count of windows) > 0 then
  new tab in front window with configuration cfg
else
  new window with configuration cfg
end if
activate`, cwd, input);
}

// Working directory comes from the shell's OSC 7 reports, so a tab whose shell has
// no integration is only found through the tty of a process known to run in it.
export async function closeTerminalsIn(dir: string, knownTtys: string[], nested: string[]) {
  const out = await script(`set out to ""
set sep to character id 9
repeat with t in terminals
  set wd to ""
  try
    set wd to working directory of t
  end try
  set out to out & (id of t) & sep & wd & sep & (tty of t) & linefeed
end repeat
return out`);
  const inside = (wd: string, d: string) => wd === d || wd.startsWith(`${d}/`);
  const ids = out.split('\n').filter(Boolean).map((line) => line.split('\t')).filter(([, wd, tty]) =>
    knownTtys.includes(tty) || (inside(wd, dir) && !nested.some((n) => inside(wd, n)))).map(([id]) => id);
  for (const id of ids) await script('close (first terminal whose id is item 1 of argv)', id);
  return ids.length;
}
