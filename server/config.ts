import { homedir } from 'node:os';
import { join } from 'node:path';

export const PORT = Number(process.env.PITWALL_PORT ?? 7420);
export const HOST = '127.0.0.1';
export const ORIGIN = `http://${HOST}:${PORT}`;

export const ROOT = join(import.meta.dirname, '..');
export const DATA_DIR = join(homedir(), 'Library', 'Application Support', 'pitwall');
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const SCRATCH_DIR = join(DATA_DIR, 'advisor');
export const DB_PATH = join(DATA_DIR, 'state.db');
// Written by the status line script; see the README.
export const USAGE_FILE = join(DATA_DIR, 'usage.json');
// No spaces in the path: Claude Code reads a pasted path as one file only when it has none.
export const UPLOADS_DIR = join(homedir(), 'Library', 'Caches', 'pitwall', 'uploads');

export const RUBRIC_FILE = join(ROOT, 'config', 'priority-rubric.md');
export const WEB_DIST = join(ROOT, 'web', 'dist');

export const MCP_SERVER_NAME = 'pitwall';
// Registered under these names before the renames; sessions started then still use them.
export const OLD_MCP_SERVER_NAMES = ['docket', 'agent-ide', 'agent-board'];
export const ASK_TOOL = 'ask_human';
export const ASK_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${ASK_TOOL}`;
export const ARTIFACT_TOOL = 'create_artifact';
export const ARTIFACT_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${ARTIFACT_TOOL}`;
export const OPEN_WORKTREE_TOOL = 'open_worktree';
export const OPEN_WORKTREE_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${OPEN_WORKTREE_TOOL}`;
