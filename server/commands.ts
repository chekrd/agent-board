import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const CLAUDE_DIR = join(homedir(), '.claude');

export interface Command {
  name: string;
  description: string;
}

const BUILT_IN: Command[] = [
  ['clear', 'Clear the conversation and start fresh'],
  ['compact', 'Summarize the conversation to free context'],
  ['context', 'Show context usage'],
  ['cost', 'Show token usage and cost'],
  ['model', 'Switch the model'],
  ['review', 'Review a pull request'],
  ['security-review', 'Security review of pending changes'],
  ['init', 'Create a CLAUDE.md for this project'],
  ['memory', 'Edit memory files'],
  ['mcp', 'Manage MCP servers'],
  ['permissions', 'View or change tool permissions'],
  ['rewind', 'Rewind the conversation or code'],
  ['export', 'Export the conversation'],
  ['status', 'Show version, model and account'],
  ['usage', 'Show plan usage limits'],
  ['help', 'Show help'],
  ['resume', 'Resume another conversation'],
  ['config', 'Open settings'],
  ['agents', 'Manage subagents'],
  ['hooks', 'Manage hooks'],
  ['plugin', 'Manage plugins'],
  ['exit', 'Quit Claude Code'],
].map(([name, description]) => ({ name, description }));

async function frontmatter(file: string) {
  const text = (await readFile(file, 'utf8').catch(() => '')).replaceAll('\r\n', '\n');
  const lines = (text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '').split('\n');
  const field = (key: string) => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) return undefined;
    const value = lines[at].slice(key.length + 1).trim();
    if (!/^[>|][-+]?$/.test(value)) return value.replace(/^["']|["']$/g, '');
    const block = lines.slice(at + 1);
    const end = block.findIndex((l) => l.trim() && !/^\s/.test(l));
    return block.slice(0, end < 0 ? undefined : end).map((l) => l.trim()).filter(Boolean).join(' ');
  };
  return { name: field('name'), description: field('description') ?? '', invocable: field('user-invocable') !== 'false' };
}

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((e) =>
    e.isDirectory() ? markdownFiles(join(dir, e.name)) : Promise.resolve(e.name.endsWith('.md') ? [join(dir, e.name)] : [])));
  return nested.flat();
}

async function commandsIn(dir: string, prefix = ''): Promise<Command[]> {
  return Promise.all((await markdownFiles(dir)).map(async (file) => ({
    name: prefix + basename(file, '.md'),
    description: (await frontmatter(file)).description,
  })));
}

async function skillsIn(dir: string, prefix = ''): Promise<Command[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(entries.filter((e) => e.isDirectory()).map(async (e) => {
    const meta = await frontmatter(join(dir, e.name, 'SKILL.md'));
    return meta.invocable && (meta.name || meta.description) ? [{ name: prefix + (meta.name ?? e.name), description: meta.description }] : [];
  }));
  return skills.flat();
}

const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));

async function pluginCommands(cwd: string): Promise<Command[]> {
  const settings = await Promise.all([join(CLAUDE_DIR, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')].map(readJson));
  const enabledPlugins: Record<string, boolean> = Object.assign({}, ...settings.map((s) => s.enabledPlugins ?? {}));
  const installed = await readJson(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'));
  const lists = await Promise.all(Object.entries(enabledPlugins).filter(([, on]) => on).map(async ([id]) => {
    const installs: { scope: string; projectPath?: string; installPath: string }[] = installed.plugins?.[id] ?? [];
    const path = (installs.find((i) => i.projectPath && (cwd === i.projectPath || cwd.startsWith(`${i.projectPath}/`))) ?? installs.find((i) => i.scope === 'user'))?.installPath;
    if (!path) return [];
    const prefix = `${id.split('@')[0]}:`;
    return [...await commandsIn(join(path, 'commands'), prefix), ...await skillsIn(join(path, 'skills'), prefix)];
  }));
  return lists.flat();
}

export async function listCommands(cwd: string): Promise<Command[]> {
  const lists = await Promise.all([
    commandsIn(join(cwd, '.claude', 'commands')),
    skillsIn(join(cwd, '.claude', 'skills')),
    commandsIn(join(CLAUDE_DIR, 'commands')),
    skillsIn(join(CLAUDE_DIR, 'skills')),
    pluginCommands(cwd),
  ]);
  const seen = new Set<string>();
  return [...lists.flat(), ...BUILT_IN].filter((c) => !seen.has(c.name) && !!seen.add(c.name));
}
