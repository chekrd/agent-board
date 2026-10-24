import { homedir } from 'node:os';
import { join } from 'node:path';

export const PORT = Number(process.env.DOCKET_PORT ?? 7420);
export const HOST = '127.0.0.1';
export const ORIGIN = `http://${HOST}:${PORT}`;

export const ROOT = join(import.meta.dirname, '..');
export const DATA_DIR = join(homedir(), 'Library', 'Application Support', 'docket');
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const SCRATCH_DIR = join(DATA_DIR, 'advisor');
export const DB_PATH = join(DATA_DIR, 'state.db');
// No spaces in the path: Claude Code reads a pasted path as one file only when it has none.
export const UPLOADS_DIR = join(homedir(), 'Library', 'Caches', 'docket', 'uploads');

export const RUBRIC_FILE = join(ROOT, 'config', 'priority-rubric.md');
export const WEB_DIST = join(ROOT, 'web', 'dist');

export const MCP_SERVER_NAME = 'docket';
export const ASK_TOOL = 'ask_human';
export const ASK_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${ASK_TOOL}`;
