import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ASK_TOOL_NAME, MCP_SERVER_NAME, ORIGIN } from '../server/config.ts';

const SETTINGS = join(homedir(), '.claude', 'settings.json');

const claude = (...args: string[]) => execFileSync('claude', args, { stdio: 'inherit' });

const HOOK_URL = `${ORIGIN}/api/hooks/ask-user-question`;

// Reports Claude Code's own questions to Docket as they open, and never answers them: no output, exit 0.
const HOOK = {
  matcher: 'AskUserQuestion',
  hooks: [{ type: 'command', timeout: 5, command: `curl -s -m 2 -o /dev/null -X POST -H 'content-type: application/json' --data-binary @- ${HOOK_URL}; exit 0` }],
};

const ours = (entry: { hooks?: { command?: string }[] }) => entry.hooks?.some((h) => h.command?.includes(HOOK_URL));

function editSettings(connect: boolean) {
  const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  settings.permissions ??= {};
  const allow: string[] = (settings.permissions.allow ?? []).filter((rule: string) => rule !== ASK_TOOL_NAME);
  settings.permissions.allow = connect ? [...allow, ASK_TOOL_NAME] : allow;
  settings.hooks ??= {};
  const pre = (settings.hooks.PreToolUse ?? []).filter((entry: any) => !ours(entry));
  settings.hooks.PreToolUse = connect ? [...pre, HOOK] : pre;
  if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
}

switch (process.argv[2]) {
  case 'connect':
    try {
      claude('mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME);
    } catch {
      // not registered yet
    }
    claude('mcp', 'add', '--scope', 'user', '--transport', 'http', MCP_SERVER_NAME, `${ORIGIN}/mcp`);
    editSettings(true);
    console.log(`allowed ${ASK_TOOL_NAME} and added the AskUserQuestion hook in ${SETTINGS}\nRunning Claude sessions get the tool after a restart or /mcp reconnect.`);
    break;
  case 'disconnect':
    claude('mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME);
    editSettings(false);
    break;
  default:
    console.error('usage: claude.ts connect | disconnect');
    process.exit(1);
}
