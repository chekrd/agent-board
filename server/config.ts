import { homedir } from 'node:os';
import { join } from 'node:path';

export const PORT = Number(process.env.AGENT_BOARD_PORT ?? 7420);
export const HOST = '127.0.0.1';
export const ORIGIN = `http://${HOST}:${PORT}`;

export const ROOT = join(import.meta.dirname, '..');
export const DATA_DIR = join(homedir(), 'Library', 'Application Support', 'agent-board');
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const SCRATCH_DIR = join(DATA_DIR, 'advisor');
export const DB_PATH = join(DATA_DIR, 'state.db');
// No spaces in the path: Claude Code reads a pasted path as one file only when it has none.
export const UPLOADS_DIR = join(homedir(), 'Library', 'Caches', 'agent-board', 'uploads');

export const RUBRIC_FILE = join(ROOT, 'config', 'priority-rubric.md');
export const WEB_DIST = join(ROOT, 'web', 'dist');

export const MCP_SERVER_NAME = 'agent-board';
// Registered under these names before the renames; sessions started then still use them.
export const OLD_MCP_SERVER_NAMES = ['docket', 'agent-ide'];
export const ASK_TOOL = 'ask_human';
export const ASK_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${ASK_TOOL}`;
export const ARTIFACT_TOOL = 'create_artifact';
export const ARTIFACT_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${ARTIFACT_TOOL}`;
