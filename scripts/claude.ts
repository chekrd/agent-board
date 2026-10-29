import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACT_TOOL, ARTIFACT_TOOL_NAME, ASK_TOOL, ASK_TOOL_NAME, MCP_SERVER_NAME, OLD_MCP_SERVER_NAMES, OPEN_WORKTREE_TOOL_NAME, ORIGIN } from '../server/config.ts';

const SETTINGS = join(homedir(), '.claude', 'settings.json');

const claude = (...args: string[]) => execFileSync('claude', args, { stdio: 'inherit' });

const HOOK_URL = `${ORIGIN}/api/hooks/ask-user-question`;

// Reports Claude Code's own questions to Pitwall as they open, and never answers them: no output, exit 0.
const HOOK = {
  matcher: 'AskUserQuestion',
  hooks: [{ type: 'command', timeout: 5, command: `curl -s -m 2 -o /dev/null -X POST -H 'content-type: application/json' --data-binary @- ${HOOK_URL}; exit 0` }],
};

const OLD_TOOL_NAMES = OLD_MCP_SERVER_NAMES.flatMap((n) => [ASK_TOOL, ARTIFACT_TOOL].map((t) => `mcp__${n}__${t}`));
const TOOLS = [ASK_TOOL_NAME, ARTIFACT_TOOL_NAME, OPEN_WORKTREE_TOOL_NAME];

const removeServer = (name: string) => {
  try {
    claude('mcp', 'remove', '--scope', 'user', name);
  } catch {
    // not registered
  }
};

const ours = (entry: { hooks?: { command?: string }[] }) => entry.hooks?.some((h) => h.command?.includes(HOOK_URL));

function editSettings(connect: boolean) {
  const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  settings.permissions ??= {};
  // Connecting keeps the old names' rules: sessions started under them still call those tools until they end.
  const allow: string[] = (settings.permissions.allow ?? []).filter((rule: string) => !TOOLS.includes(rule) && (connect || !OLD_TOOL_NAMES.includes(rule)));
  settings.permissions.allow = connect ? [...allow, ...TOOLS] : allow;
  settings.hooks ??= {};
  const pre = (settings.hooks.PreToolUse ?? []).filter((entry: any) => !ours(entry));
  settings.hooks.PreToolUse = connect ? [...pre, HOOK] : pre;
  if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
}

switch (process.argv[2]) {
  case 'connect':
    for (const name of [MCP_SERVER_NAME, ...OLD_MCP_SERVER_NAMES]) removeServer(name);
    claude('mcp', 'add', '--scope', 'user', '--transport', 'http', MCP_SERVER_NAME, `${ORIGIN}/mcp`);
    editSettings(true);
    console.log(`allowed ${TOOLS.join(', ')} and added the AskUserQuestion hook in ${SETTINGS}\nRunning Claude sessions get the tools after a restart or /mcp reconnect.`);
    break;
  case 'disconnect':
    removeServer(MCP_SERVER_NAME);
    editSettings(false);
    break;
  default:
    console.error('usage: claude.ts connect | disconnect');
    process.exit(1);
}
