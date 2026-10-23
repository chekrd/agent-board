import { homedir } from 'node:os';
import { join } from 'node:path';

export const PORT = Number(process.env.AGENT_IDE_PORT ?? 7420);
export const HOST = '127.0.0.1';
export const ORIGIN = `http://${HOST}:${PORT}`;

export const ROOT = join(import.meta.dirname, '..');
export const DATA_DIR = join(homedir(), 'Library', 'Application Support', 'agent-ide');
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const DB_PATH = join(DATA_DIR, 'state.db');

export const TMUX_SOCKET = 'agent-ide';
export const TMUX_CONF = join(ROOT, 'server', 'tmux.conf');
export const SYSTEM_PROMPT_FILE = join(ROOT, 'config', 'system-prompt.md');
export const RUBRIC_FILE = join(ROOT, 'config', 'priority-rubric.md');
export const WEB_DIST = join(ROOT, 'web', 'dist');

export const MCP_SERVER_NAME = 'agent-ide';
export const ASK_TOOL = 'ask_human';
