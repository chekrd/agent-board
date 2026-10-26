import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listCommands } from './commands.ts';

test("Claude Code's own commands, bundled skills and aliases are commands, so a reply starting with one is typed as one", async () => {
  const names = (await listCommands('/nowhere')).map((c) => c.name);
  for (const name of ['rename', 'doctor', 'checkup', 'add-dir', 'code-review', 'review', 'reset', 'quit', 'simplify', 'loop', 'stats']) {
    assert.ok(names.includes(name), `/${name}`);
  }
  assert.equal(new Set(names).size, names.length);
});
