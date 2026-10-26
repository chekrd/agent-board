import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function script(body: string, ...args: string[]) {
  const source = `on run argv\ntell application "Ghostty"\n${body}\nend tell\nend run`;
  const { stdout } = await run('/usr/bin/osascript', ['-e', source, ...args]);
  return stdout.trim();
}

const NOT_FOUND = 'NOT_FOUND';

class NoTab extends Error {}

// Claude runs in a Ghostty terminal whose tty is the process's controlling tty.
async function onTerminal(tty: string, body: string, ...args: string[]) {
  const out = await script(`set matches to (terminals whose tty is item 1 of argv)
if (count of matches) is 0 then return "${NOT_FOUND}"
set t to item 1 of matches
${body}`, tty, ...args);
  if (out === NOT_FOUND) throw new NoTab(`no Ghostty tab runs ${tty}; the session may be in another terminal app or inside tmux`);
  return out;
}

export async function focus(tty: string) {
  await onTerminal(tty, 'focus t\nactivate');
}

// `input text` arrives as a bracketed paste.
export async function paste(tty: string, text: string) {
  await onTerminal(tty, 'input text (item 2 of argv) to t', text);
}

export type Keystroke = { key: string } | { text: string };

// Keys that failed after some of them went in, which moved what the terminal shows.
export class PartlyTyped extends Error {}

// Named keys rather than characters: `send key` goes through the keyboard layout, so a digit
// would arrive as ě or š on a Czech one. One script types them all, so one that fails may have typed some.
export async function keys(tty: string, strokes: Keystroke[]) {
  const args = strokes.map((k) => ('key' in k ? `k:${k.key}` : `t:${k.text}`));
  await onTerminal(tty, `repeat with i from 2 to count of argv
  set s to item i of argv
  if s starts with "k:" then
    send key (text 3 thru -1 of s) to t
  else
    input text (text 3 thru -1 of s) to t
  end if
  delay 0.2
end repeat`, ...args).catch((err: unknown) => {
    throw err instanceof NoTab ? err : new PartlyTyped('Ghostty failed while it typed the keys', { cause: err });
  });
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
export async function closeTerminalsIn(dir: string | null, knownTtys: string[]) {
  const out = await script(`set out to ""
set sep to character id 9
repeat with t in terminals
  set wd to ""
  try
    set wd to working directory of t
  end try
  if wd is missing value then set wd to ""
  set out to out & (id of t) & sep & wd & sep & (tty of t) & linefeed
end repeat
return out`);
  const ids = out.split('\n').filter(Boolean).map((line) => line.split('\t')).filter(([, wd, tty]) =>
    knownTtys.includes(tty) || (dir !== null && (wd === dir || wd.startsWith(`${dir}/`)))).map(([id]) => id);
  for (const id of ids) await script('close (first terminal whose id is item 1 of argv)', id);
  return ids.length;
}
