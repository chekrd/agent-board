import * as ghostty from './ghostty.ts';
import * as tmux from './tmux.ts';

// Sessions Agent Board starts run in a detached tmux session, out of sight until shown in a
// Ghostty tab; ones started by hand run in their own Ghostty tab. Either is found by the tty
// of the Claude process.

export async function start(name: string, cwd: string, command: string) {
  if (tmux.TMUX) await tmux.start(name, cwd, command);
  else await ghostty.newTab(cwd, command);
}

export async function stop(name: string) {
  if (tmux.TMUX) await tmux.kill(name);
}

export async function tmuxSessions() {
  return new Set((await tmux.panes()).values());
}

async function driver(tty: string) {
  const name = (await tmux.panes()).get(tty);
  return name
    ? { paste: (text: string) => tmux.paste(name, text), keys: (strokes: ghostty.Keystroke[]) => tmux.keys(name, strokes) }
    : { paste: (text: string) => ghostty.paste(tty, text), keys: (strokes: ghostty.Keystroke[]) => ghostty.keys(tty, strokes) };
}

// A paste of text arrives as one prompt even with several lines; Enter goes separately once
// the TUI has taken it in. Control characters are dropped so the text cannot end the paste and
// type keys itself. Claude Code turns a paste of nothing but image paths into image attachments,
// so images go in a paste of their own first; other files stay paths in the text for Claude to read.
export async function send(tty: string, text: string, files: string[] = []) {
  const d = await driver(tty);
  const pause = () => new Promise((r) => setTimeout(r, 200));
  const images = files.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
  if (images.length) {
    await d.paste(images.join(' '));
    await pause();
  }
  const clean = [...files.filter((f) => !images.includes(f)), text.replaceAll('\r\n', '\n').replace(/[^\P{Cc}\n\t]/gu, '')]
    .filter(Boolean)
    .join(' ');
  if (clean) await d.paste(images.length ? ` ${clean}` : clean);
  await pause();
  await d.keys([{ key: 'enter' }]);
}

export async function keys(tty: string, strokes: ghostty.Keystroke[]) {
  await (await driver(tty)).keys(strokes.map((k) => ('key' in k ? k : { text: k.text.replace(/[^\P{Cc}\n\t]/gu, '') })));
}

// A tmux session already attached in a Ghostty tab gets that tab; otherwise a new tab attaches.
export async function show(tty: string | null, name: string, cwd: string) {
  const panes = await tmux.panes();
  const session = tty ? panes.get(tty) : [...panes.values()].find((n) => n === name);
  if (!session) {
    if (!tty) throw new Error('this session has no terminal yet');
    return ghostty.focus(tty);
  }
  for (const client of await tmux.clients(session)) {
    try {
      return await ghostty.focus(client);
    } catch {
      // attached from another terminal app
    }
  }
  await ghostty.newTab(cwd, tmux.attachCommand(session));
}
