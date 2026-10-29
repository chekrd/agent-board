import { PartlyTyped, type Keystroke } from './ghostty.ts';

// One tmux command; `input` goes to its stdin.
export type Tmux = (args: string[], input?: string) => Promise<unknown>;

const target = (name: string) => `=${name}:`;

// Text goes into a buffer through stdin, never onto tmux's command line, which takes a leading '-' for a flag and a
// trailing ';' for the end of the command, and refuses a command over about 16 KB.
async function load(tmux: Tmux, name: string, text: string) {
  const buffer = `pitwall-${name}`;
  await tmux(['load-buffer', '-b', buffer, '-'], text);
  return buffer;
}

// -p pastes with bracketed-paste markers, like Ghostty's `input text`.
export async function paste(tmux: Tmux, name: string, text: string) {
  await tmux(['paste-buffer', '-p', '-d', '-b', await load(tmux, name, text), '-t', target(name)]);
}

const KEYS: Record<string, string> = { enter: 'Enter', tab: 'Tab', escape: 'Escape', arrow_down: 'Down', arrow_up: 'Up' };

// Text among the keys goes in as typed, without paste markers.
export async function keys(tmux: Tmux, name: string, strokes: Keystroke[]) {
  for (const [i, k] of strokes.entries()) {
    try {
      if ('key' in k) await tmux(['send-keys', '-t', target(name), KEYS[k.key] ?? k.key]);
      else await tmux(['paste-buffer', '-d', '-b', await load(tmux, name, k.text), '-t', target(name)]);
    } catch (err) {
      if (i) throw new PartlyTyped(`tmux failed after ${i} of ${strokes.length} keys`, { cause: err });
      throw err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
