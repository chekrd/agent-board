import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileMeta } from './conversations.ts';

const dir = mkdtempSync(join(tmpdir(), 'agent-board-test-'));
let n = 0;

const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 12, minute)).toISOString();
const prompt = (text: string, minute = 0) => ({ type: 'user', uuid: `p${n++}`, timestamp: at(minute), message: { content: text } });
const assistant = (content: object[], minute = 0) => ({ type: 'assistant', uuid: `a${n++}`, timestamp: at(minute), message: { content } });
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: object = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, content: string) => ({ type: 'user', uuid: `r${n++}`, timestamp: at(0), message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

async function meta(entries: object[]) {
  const file = join(dir, `${n++}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const m = await fileMeta(file);
  assert.ok(m);
  return m;
}

const ask = (id: string, server = 'agent-board') => toolUse(id, `mcp__${server}__ask_human`, { title: 'Which way?', details: 'd', category: 'plan-problem' });

test('an ask_human call stays open until the developer prompts again', async () => {
  const open = await meta([prompt('Fix the login'), assistant([text('Found two ways.'), ask('q1')])]);
  assert.equal(open.ask?.toolUseId, 'q1');
  assert.equal(open.ask?.input.title, 'Which way?');

  const answered = await meta([prompt('Fix the login'), assistant([ask('q1')]), toolResult('q1', 'Posted'), prompt('Re: "Which way?" — My decision: A.')]);
  assert.equal(answered.ask, null);
});

test('ask_human calls under the names used before the renames still count', async () => {
  for (const server of ['docket', 'agent-ide']) {
    assert.equal((await meta([prompt('x'), assistant([ask('old', server)])])).ask?.toolUseId, 'old');
  }
});

test('a custom title beats a later generated one', async () => {
  const m = await meta([
    prompt('Fix the login'),
    { type: 'custom-title', customTitle: 'Login fix' },
    { type: 'ai-title', aiTitle: 'Generated title' },
    assistant([text('ok')]),
  ]);
  assert.equal(m.title, 'Login fix');
  assert.equal(m.firstPrompt, 'Fix the login');
});

test('turns skip synthetic and API error messages; the last message is the latest text', async () => {
  const m = await meta([
    prompt('Fix the login'),
    assistant([text('Looking.')]),
    { ...assistant([text('API Error')]), isApiErrorMessage: true },
    { type: 'assistant', uuid: 'syn', timestamp: at(0), message: { model: '<synthetic>', content: [text('No response requested.')] } },
    assistant([text('Done: the redirect was wrong.'), toolUse('t1', 'Bash', { command: 'pnpm test' })]),
  ]);
  assert.deepEqual(m.turns.map((t) => [t.role, t.text]), [
    ['developer', 'Fix the login'],
    ['claude', 'Looking.'],
    ['claude', 'Done: the redirect was wrong.'],
  ]);
  assert.equal(m.lastMessage, 'Done: the redirect was wrong.');
});

test('the current step is the latest block, timed from the last prompt', async () => {
  const m = await meta([
    prompt('first', 0),
    assistant([text('done')], 1),
    prompt('second', 5),
    assistant([toolUse('t1', 'Read', { file_path: '/repo/src/login.ts' })], 6),
  ]);
  assert.equal(m.activity?.step, 'Read · login.ts');
  assert.equal(m.activity?.since, Date.parse(at(5)));
  assert.deepEqual(m.toolResults, []);
});

test('tool results are collected, so an answered AskUserQuestion menu can be cleared', async () => {
  const m = await meta([prompt('x'), assistant([toolUse('menu1', 'AskUserQuestion')]), toolResult('menu1', 'User answered')]);
  assert.deepEqual(m.toolResults, ['menu1']);
});

test('pr-to-green: the created PR and the last watch-pr.sh result', async () => {
  const m = await meta([
    prompt('ship it'),
    assistant([toolUse('s', 'Skill', { skill: 'kontent-client-pr:pr-to-green' })]),
    assistant([toolUse('c', 'Bash', { command: 'az repos pr create --title x' })]),
    toolResult('c', '{ "pullRequestId": 23784, "status": "active" }'),
    assistant([toolUse('w', 'Bash', { command: 'FOO=1 ~/.claude/skills/pr-to-green/watch-pr.sh 23784 "RUNNING 3 checks"' })]),
    toolResult('w', 'PASSED all 12 checks'),
  ]);
  assert.equal(m.pr?.id, 23784);
  assert.equal(m.pr?.result, 'PASSED all 12 checks');
  assert.equal(m.pr?.watching, false);
});

test('a watcher still running in the background keeps watching', async () => {
  const m = await meta([
    prompt('ship it'),
    assistant([toolUse('w', 'Bash', { command: 'pr-to-green/watch-pr.sh 1 "RUNNING"' })]),
    toolResult('w', 'Command running in background with ID: b1'),
  ]);
  assert.equal(m.pr?.id, 1);
  assert.equal(m.pr?.result, 'RUNNING');
  assert.equal(m.pr?.watching, true);
});

test('huge inline lines are skipped and the tail grows back to the last prompt', async () => {
  const screenshot = (id: string) => toolResult(id, 'x'.repeat(300 << 10));
  const m = await meta([
    prompt('Fix the login'),
    assistant([text('earlier')]),
    prompt('Look at the screenshots'),
    assistant([ask('q-far')]),
    screenshot('s1'),
    screenshot('s2'),
    screenshot('s3'),
  ]);
  assert.equal(m.ask?.toolUseId, 'q-far');
  assert.equal(m.activity?.step, 'agent-board: ask_human');
});
