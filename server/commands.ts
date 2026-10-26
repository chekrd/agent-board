import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const CLAUDE_DIR = join(homedir(), '.claude');

export interface Command {
  name: string;
  description: string;
}

// Claude Code's own commands, bundled skills and workflows, each with its aliases (https://code.claude.com/docs/en/commands),
// so that a reply starting with one is typed as the command it is and never taken for an answer.
const BUILT_IN: Command[] = [
  ['add-dir', 'Add a working directory for this session'],
  ['advisor', 'Turn the advisor tool on or off'],
  ['agents', 'Manage subagents'],
  ['artifact-capabilities', 'What a published artifact can do at runtime'],
  ['artifact-diagramming', 'Diagramming guidance for artifacts'],
  ['artifacts', 'List, attach or open your artifacts'],
  ['auto-mode-setup', "Draft auto mode's environment entries"],
  ['autocompact', 'Set how full the context gets before it compacts'],
  ['autofix-pr', "A cloud session that fixes this branch's PR"],
  ['background', 'Detach this session to run in the background', 'bg'],
  ['batch', 'Make a large change in parallel'],
  ['branch', 'Branch the conversation at this point'],
  ['btw', 'Ask a side question'],
  ['bug', 'Report a bug', 'share'],
  ['cd', 'Move this session to another directory'],
  ['chrome', 'Claude in Chrome settings'],
  ['claude-api', 'Claude API reference'],
  ['claude-in-chrome', 'Carry out a task in your browser'],
  ['clear', 'Clear the conversation and start fresh', 'reset', 'new'],
  ['code-review', 'Review the diff for correctness bugs', 'review'],
  ['color', 'Set the prompt bar colour'],
  ['compact', 'Summarize the conversation to free context'],
  ['config', 'Open settings', 'settings'],
  ['context', 'Show context usage'],
  ['copy', 'Copy the last response'],
  ['dataviz', 'Design charts and dashboards'],
  ['debug', 'Turn on debug logging and troubleshoot'],
  ['deep-research', 'Research a question across sources'],
  ['design', 'Draft UI designs on a canvas'],
  ['design-login', 'Sign in for design-system access'],
  ['design-sync', 'Upload the design system to Claude Design'],
  ['desktop', 'Continue in the desktop app', 'app'],
  ['diff', 'Review the changes in the working tree'],
  ['doctor', 'Check the setup for problems', 'checkup'],
  ['effort', 'Set the effort level'],
  ['exit', 'Quit Claude Code', 'quit'],
  ['export', 'Export the conversation'],
  ['fast', 'Turn fast mode on or off'],
  ['feedback', 'Send feedback about Claude Code'],
  ['fewer-permission-prompts', 'Allow common read-only tool calls'],
  ['focus', 'Toggle the focus view'],
  ['fork', 'Copy the conversation into a background session'],
  ['goal', 'Set a goal to work towards'],
  ['heapdump', 'Write a heap snapshot'],
  ['help', 'Show help'],
  ['hooks', 'View hooks'],
  ['ide', 'Manage IDE integrations'],
  ['import', 'Bring in settings from Codex, Gemini CLI or Cursor'],
  ['init', 'Create a CLAUDE.md for this project'],
  ['insights', 'Report on your recent sessions'],
  ['install-github-app', 'Install the Claude GitHub App'],
  ['install-slack-app', 'Install the Claude Slack app'],
  ['keybindings', 'Open your keyboard shortcuts'],
  ['list-agents', 'List the agents Claude can message', 'peers'],
  ['login', 'Sign in'],
  ['logout', 'Sign out'],
  ['loop', 'Run a prompt repeatedly', 'proactive'],
  ['mcp', 'Manage MCP servers'],
  ['memory', 'Edit memory files'],
  ['mobile', 'Get the mobile app', 'ios', 'android'],
  ['model', 'Switch the model'],
  ['output-style', 'Switch the output style'],
  ['passes', 'Share a free week of Claude Code'],
  ['permissions', 'View or change tool permissions', 'allowed-tools'],
  ['plan', 'Enter plan mode'],
  ['plugin', 'Manage plugins'],
  ['plugin-authoring', 'Reference for writing a mod'],
  ['powerup', "Lessons on Claude Code's features"],
  ['privacy-settings', 'View or change privacy settings'],
  ['radio', 'Open Claude FM'],
  ['rate-limit-options', 'Ways to keep working past a usage limit'],
  ['recap', 'Sum up this session in a line'],
  ['release-notes', 'Read the changelog'],
  ['reload-plugins', 'Reload the plugins'],
  ['reload-skills', 'Find skills added or changed on disk'],
  ['remote-control', 'Make this session available for Remote Control', 'rc'],
  ['remote-env', 'Pick the default cloud environment'],
  ['rename', 'Rename this session'],
  ['resume', 'Resume another conversation', 'continue'],
  ['rewind', 'Rewind the conversation or code', 'checkpoint', 'undo'],
  ['run', 'Launch and drive the app'],
  ['run-skill-generator', 'Teach /run and /verify to build and launch the app'],
  ['sandbox', 'Turn sandbox mode on or off'],
  ['schedule', 'Cloud scheduled tasks', 'routines'],
  ['scroll-speed', 'Set the mouse wheel scroll speed'],
  ['security-review', 'Security review of pending changes'],
  ['setup-bedrock', 'Configure Amazon Bedrock'],
  ['setup-vertex', "Configure Google Cloud's Agent Platform"],
  ['simplify', 'Clean up the changed code'],
  ['skill-doctor', 'What each skill costs in context'],
  ['skills', 'List skills'],
  ['slides', 'Make a presentation'],
  ['status', 'Show version, model and account'],
  ['statusline', 'Configure the status line'],
  ['stickers', 'Order stickers'],
  ['stop', 'Stop the background session'],
  ['subtask', 'Hand a task to a forked subagent'],
  ['tasks', 'Background work in this session', 'bashes'],
  ['team-onboarding', 'Write a team onboarding guide'],
  ['teleport', 'Pull a cloud session into this terminal', 'tp'],
  ['terminal-setup', 'Install a Shift+Enter keybinding'],
  ['theme', 'Change the colour theme'],
  ['tui', 'Switch the terminal renderer'],
  ['ultrareview', 'A deep code review in the cloud'],
  ['update-config', 'Change settings'],
  ['upgrade', 'Upgrade your plan'],
  ['usage', 'Show session cost and plan usage limits', 'cost', 'stats'],
  ['usage-credits', 'Configure usage credits'],
  ['verify', 'Check a change works by running the app'],
  ['voice', 'Voice dictation'],
  ['web-setup', 'Connect GitHub for cloud sessions'],
  ['workflow-authoring', 'Reference for workflow scripts'],
  ['workflows', 'Watch running workflows'],
].flatMap(([name, description, ...aliases]) => [{ name, description }, ...aliases.map((alias) => ({ name: alias, description: `Same as /${name}` }))]);

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

const readJson = async (file: string) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
};

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
