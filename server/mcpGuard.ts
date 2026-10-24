// The advisor keeps the user's MCP servers so it can read tickets and docs and drive a browser,
// but nothing outward-facing: a PreToolUse hook runs this file and denies MCP tools whose name
// says they change something.

const CHANGES = new Set([
  'create', 'update', 'edit', 'delete', 'remove', 'add', 'send', 'post', 'publish', 'transition', 'comment',
  'write', 'destructive', 'upload', 'move', 'rename', 'archive', 'merge', 'assign', 'reply', 'share', 'invite',
  'schedule', 'cancel', 'batch', 'insert', 'put', 'patch', 'submit', 'approve', 'resolve',
]);

const words = (name: string) =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function changesSomething(toolName: string) {
  const tool = toolName.match(/^mcp__.+?__(.+)$/)?.[1];
  return !!tool && words(tool).some((w) => CHANGES.has(w));
}

if (import.meta.main) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const name = String(JSON.parse(input || '{}').tool_name ?? '');
  if (changesSomething(name)) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${name} changes something outside the worktree; a second opinion only reads and tries things in its scratch copy.`,
      },
    }));
  }
}
