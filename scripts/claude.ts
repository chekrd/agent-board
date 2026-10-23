import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ASK_TOOL_NAME, MCP_SERVER_NAME, ORIGIN } from '../server/config.ts';

const SETTINGS = join(homedir(), '.claude', 'settings.json');

const claude = (...args: string[]) => execFileSync('claude', args, { stdio: 'inherit' });

function editAllowList(change: (allow: string[]) => string[]) {
  const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  settings.permissions ??= {};
  settings.permissions.allow = change(settings.permissions.allow ?? []);
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
    editAllowList((allow) => (allow.includes(ASK_TOOL_NAME) ? allow : [...allow, ASK_TOOL_NAME]));
    console.log(`allowed ${ASK_TOOL_NAME} in ${SETTINGS}\nRunning Claude sessions get the tool after a restart or /mcp reconnect.`);
    break;
  case 'disconnect':
    claude('mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME);
    editAllowList((allow) => allow.filter((rule) => rule !== ASK_TOOL_NAME));
    break;
  default:
    console.error('usage: claude.ts connect | disconnect');
    process.exit(1);
}
