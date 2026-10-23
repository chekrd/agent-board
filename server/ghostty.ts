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
