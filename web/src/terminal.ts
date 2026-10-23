import type { IDisposable } from 'ghostty-web';

export type Engine = 'ghostty' | 'xterm';

export interface TerminalHandle {
  readonly cols: number;
  readonly rows: number;
  write(data: string | Uint8Array): void;
  onData(fn: (data: string) => void): IDisposable;
  onResize(fn: (size: { cols: number; rows: number }) => void): IDisposable;
  fit(): void;
  focus(): void;
  dispose(): void;
}

// Switch with localStorage['terminal-engine'] = 'xterm' if ghostty-web misbehaves.
export const engine: Engine = (() => {
  try {
    return localStorage.getItem('terminal-engine') === 'xterm' ? 'xterm' : 'ghostty';
  } catch {
    return 'ghostty';
  }
})();

const theme = {
  background: '#0d0f13',
  foreground: '#e4e6ea',
  cursor: '#ff8a3d',
  selectionBackground: '#3a4150',
};

const options = {
  fontSize: 13,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
  cursorBlink: true,
  theme,
};

async function load() {
  if (engine === 'xterm') {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ]);
    return { Terminal, FitAddon, instance: undefined };
  }
  const { Ghostty, Terminal, FitAddon } = await import('ghostty-web');
  // A Terminal created after another one was disposed hangs the page when they share
  // the module-level WASM instance from init(), so each terminal gets its own.
  return {
    Terminal,
    FitAddon,
    instance: () => Ghostty.load(),
  };
}

let loaded: ReturnType<typeof load> | undefined;

export async function createTerminal(parent: HTMLElement): Promise<TerminalHandle> {
  const { Terminal, FitAddon, instance } = await (loaded ??= load());
  const term = new Terminal({ ...options, ghostty: await instance?.() });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(parent);
  fit.fit();
  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    write: (data) => term.write(data),
    onData: (fn) => term.onData(fn),
    onResize: (fn) => term.onResize(fn),
    fit: () => fit.fit(),
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  };
}
