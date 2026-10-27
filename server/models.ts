import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface Settings {
  model?: string;
  effortLevel?: string;
  modelSettings?: Record<string, { effortLevel?: string }>;
}

interface Seen {
  model: string | null;
  effort: string | null;
}

const read = (file: string): Promise<Settings> => readFile(file, 'utf8').then((t) => JSON.parse(t) as Settings, () => ({}));

// The layers Claude Code reads for a session started in the repository, the later ones winning.
export async function settingsFor(repoPath: string): Promise<Settings> {
  const layers = await Promise.all([
    join(homedir(), '.claude', 'settings.json'),
    join(repoPath, '.claude', 'settings.json'),
    join(repoPath, '.claude', 'settings.local.json'),
  ].map(read));
  return layers.reduce((a, b) => ({ ...a, ...b, modelSettings: { ...a.modelSettings, ...b.modelSettings } }), {});
}

const LONG = '[1m]';
const bare = (model: string) => model.replace(LONG, '');

// What a model name and the effort for it come to, from the settings and, for an alias or what the settings leave
// open, from the sessions seen running (newest first): Claude Code resolves aliases itself and does not say to what.
export function resolver(settings: Settings, seen: Seen[]) {
  const ids = seen.flatMap((s) => (s.model ? [bare(s.model)] : []));
  const real = (name: string) => {
    const base = bare(name);
    if (!ALIASES.includes(base)) return name;
    const id = ids.find((m) => m.startsWith(`claude-${base}-`));
    return id ? `${id}${name.endsWith(LONG) ? LONG : ''}` : name;
  };
  const model = settings.model ? real(settings.model) : (ids[0] ?? null);
  const effortOf = (name: string | null) => {
    if (!name) return null;
    const id = bare(name);
    return settings.modelSettings?.[id]?.effortLevel ?? settings.effortLevel ?? seen.find((s) => s.effort && s.model && bare(s.model) === id)?.effort ?? null;
  };
  return { model, real, effortOf };
}
