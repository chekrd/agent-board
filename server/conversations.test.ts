import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exchanges, fileMeta, promptImage } from './conversations.ts';

const dir = mkdtempSync(join(tmpdir(), 'pitwall-test-'));
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

const ask = (id: string, server = 'pitwall') => toolUse(id, `mcp__${server}__ask_human`, { title: 'Which way?', details: 'd', category: 'plan-problem' });

test('an ask_human call stays open until the developer prompts again', async () => {
  const open = await meta([prompt('Fix the login'), assistant([text('Found two ways.'), ask('q1')])]);
  assert.equal(open.ask?.toolUseId, 'q1');
  assert.equal(open.ask?.input.title, 'Which way?');

  const answered = await meta([prompt('Fix the login'), assistant([ask('q1')]), toolResult('q1', 'Posted'), prompt('Re: "Which way?" — My decision: A.')]);
  assert.equal(answered.ask, null);
});

test('ask_human calls under the names used before the renames still count', async () => {
  for (const server of ['docket', 'agent-ide', 'agent-board']) {
    assert.equal((await meta([prompt('x'), assistant([ask('old', server)])])).ask?.toolUseId, 'old');
  }
});

test('create_artifact calls are collected from the transcript', async () => {
  const html = '<svg></svg>';
  const m = await meta([prompt('Explain the flow'), assistant([text('Here is a diagram.'), toolUse('v1', 'mcp__pitwall__create_artifact', { title: 'Flow', html })])]);
  assert.deepEqual(m.artifacts.map((a) => [a.toolUseId, a.input.title, a.input.html]), [['v1', 'Flow', html]]);
});

test('create_artifact calls under the name used before the rename to Pitwall still count', async () => {
  const m = await meta([prompt('x'), assistant([toolUse('v1', 'mcp__agent-board__create_artifact', { title: 'Flow', html: '<svg></svg>' })])]);
  assert.deepEqual(m.artifacts.map((a) => a.toolUseId), ['v1']);
});

test('links come from what Claude wrote and asked, not from prompts or tool results', async () => {
  const m = await meta([
    prompt('Look at https://prompt.dev/x'),
    assistant([text('Opened [PR #3](https://github.com/o/r/pull/3).'), toolUse('b1', 'Bash', { command: 'curl https://tool.dev' })]),
    toolResult('b1', 'see https://result.dev'),
    assistant([toolUse('q1', 'mcp__pitwall__ask_human', { title: 'Which way?', details: 'Per https://docs.dev/y', category: 'plan-problem' })]),
  ]);
  assert.deepEqual(m.links.map((l) => l.url), ['https://github.com/o/r/pull/3', 'https://docs.dev/y']);
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

test('the last message is what Claude wrote after its last tool call, or the turn before while the current one has none', async () => {
  const entries = [
    prompt('first', 0),
    assistant([text('Old reply.')], 1),
    prompt('second', 2),
    assistant([text('Reading the code.'), toolUse('t1', 'Read', { file_path: '/repo/a.ts' })], 3),
    toolResult('t1', 'file'),
  ];
  assert.equal((await meta(entries)).lastMessage, 'Old reply.');
  assert.equal((await meta([...entries, assistant([text('Fixed it.')], 4), assistant([text('Tests pass.')], 4)])).lastMessage, 'Fixed it.\n\nTests pass.');
  assert.equal((await meta([...entries, prompt('third', 5)])).lastMessage, 'Old reply.');
  assert.equal((await meta(entries)).lastPrompt, 'first');
  assert.equal((await meta([...entries, assistant([text('Fixed it.')], 4)])).lastPrompt, 'second');
  assert.equal((await meta([assistant([text('Before any prompt.')])])).lastPrompt, null);
});

test('the text before a question or a menu stays in the last message', async () => {
  const m = await meta([prompt('Fix it'), assistant([text('Two ways to fix it.'), toolUse('m1', 'AskUserQuestion', { questions: [] })])]);
  assert.equal(m.lastMessage, 'Two ways to fix it.');
  assert.equal((await meta([prompt('Fix it'), assistant([text('Found two ways.'), ask('q1')])])).lastMessage, 'Found two ways.');
});

test('the conversation pairs each prompt with what Claude wrote after its last tool call, skipping commands, notifications and compaction', async () => {
  const file = join(dir, `${n++}.jsonl`);
  writeFileSync(file, [
    prompt('Fix the login', 0),
    assistant([text('Reading.'), toolUse('t1', 'Read', { file_path: '/repo/a.ts' })], 1),
    toolResult('t1', 'file'),
    assistant([text('The redirect was wrong.'), text('Fixed it.')], 2),
    prompt('<command-name>/rename</command-name>', 3),
    { ...prompt('This session is being continued from a previous conversation…', 3), isCompactSummary: true },
    prompt('<task-notification>done</task-notification>', 3),
    prompt('Now the tests', 4),
    assistant([text('Running them.'), toolUse('t2', 'Bash', { command: 'pnpm test' })], 5),
    prompt('Which way?', 6),
    assistant([text('Two ways.'), toolUse('m1', 'AskUserQuestion', { questions: [] })], 7),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n{"type":"user","mess');
  assert.deepEqual((await exchanges(file)).map((e) => [e.prompt, e.reply, e.at]), [
    ['Fix the login', 'The redirect was wrong.\n\nFixed it.', Date.parse(at(0))],
    ['Now the tests', null, Date.parse(at(4))],
    ['Which way?', 'Two ways.', Date.parse(at(6))],
  ]);
  assert.deepEqual(await exchanges(join(dir, 'gone.jsonl')), []);
});

test('a prompt keeps its pictures, also one with no text, served one by one; a reply keeps the artifacts made for it', async () => {
  const png = Buffer.from('fake png').toString('base64');
  const image = (data: string, media_type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type, data } });
  const file = join(dir, `${n++}.jsonl`);
  writeFileSync(file, [
    { type: 'user', uuid: 'u1', timestamp: at(0), message: { content: [{ type: 'text', text: '[Image #1] [Image #2] Look' }, image(png), image('x', 'image/svg+xml')] } },
    assistant([toolUse('v1', 'mcp__pitwall__create_artifact', { title: 'Flow', html: '<svg></svg>' }), text('Drew it.')], 1),
    { type: 'user', uuid: 'u2', timestamp: at(2), message: { content: [image(png)] } },
    assistant([text('Seen.')], 3),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.deepEqual((await exchanges(file)).map((e) => [e.id, e.prompt, e.images, e.reply, e.artifacts]), [
    ['u1', '[Image #1] [Image #2] Look', 1, 'Drew it.', ['v1']],
    ['u2', '', 1, 'Seen.', []],
  ]);
  assert.deepEqual(await promptImage(file, 'u2', 0), { type: 'image/png', data: Buffer.from('fake png') });
  assert.equal(await promptImage(file, 'u2', 1), null);
  assert.equal(await promptImage(file, 'nope', 0), null);
});

test('turns and the last message skip synthetic and API error messages', async () => {
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
  const after = await meta([
    prompt('Fix the login'),
    assistant([text('Done.')]),
    { ...assistant([text('API Error')]), isApiErrorMessage: true },
    { type: 'assistant', uuid: 'syn2', timestamp: at(0), message: { model: '<synthetic>', content: [text('No response requested.')] } },
  ]);
  assert.equal(after.lastMessage, 'Done.');
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

test('right after a new prompt there is no step yet, and the clock starts at that prompt, not the turn before', async () => {
  const m = await meta([prompt('first', 0), assistant([ask('q1')], 1), toolResult('q1', 'Posted'), prompt('Re: "Which way?" — My decision: A.', 5)]);
  assert.deepEqual(m.activity, { step: null, since: Date.parse(at(5)) });
  const fresh = await meta([prompt('Fix the login', 2)]);
  assert.deepEqual(fresh.activity, { step: null, since: Date.parse(at(2)) });
});

test('background work stays open until its task notification or a TaskStop; an agent launched async counts too', async () => {
  const started = (use: string, result: object) => ({ ...toolResult(use, 'Command running in background'), toolUseResult: result });
  const notified = (id: string) => ({ type: 'user', uuid: `n${n++}`, timestamp: at(9), message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` } });
  const entries = [
    prompt('run the suite', 0),
    assistant([toolUse('b1', 'Bash', { command: 'pnpm e2e', description: 'Run full e2e suite', run_in_background: true })], 1),
    started('b1', { stdout: '', backgroundTaskId: 'bg1' }),
    assistant([toolUse('b2', 'Bash', { command: 'pnpm check', description: 'Run checks' })], 2),
    started('b2', { stdout: '', backgroundTaskId: 'bg2', timedOutAfterMs: 120000 }),
    assistant([toolUse('a1', 'Agent', { description: 'Review the diff', prompt: 'p' })], 3),
    started('a1', { status: 'async_launched', agentId: 'ag1' }),
    assistant([text('Waiting for the suite.')], 4),
  ];
  assert.deepEqual((await meta(entries)).background, [['bg1', 'Bash · Run full e2e suite'], ['bg2', 'Bash · Run checks'], ['ag1', 'Agent · Review the diff']]);
  const ended = [...entries, notified('bg1'), assistant([toolUse('s1', 'TaskStop', { task_id: 'bg2' })], 10), started('s1', { message: 'stopped', task_id: 'bg2' })];
  assert.deepEqual((await meta(ended)).background, [['ag1', 'Agent · Review the diff']]);
  assert.deepEqual((await meta([...ended, notified('ag1')])).background, []);
});

test('a background task whose start has left the tail stays open until its notification comes', async () => {
  const file = join(dir, `${n++}.jsonl`);
  const write = (entries: object[]) => writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const start = [
    prompt('run it', 0),
    assistant([toolUse('b1', 'Bash', { description: 'Run full e2e suite', run_in_background: true })], 1),
    { ...toolResult('b1', 'Command running in background'), toolUseResult: { backgroundTaskId: 'bg1' } },
  ];
  write(start);
  assert.deepEqual((await fileMeta(file))?.background, [['bg1', 'Bash · Run full e2e suite']]);
  // A later prompt after more than the tail's worth of output.
  const filler = Array.from({ length: 12 }, (_, i) => assistant([text('x'.repeat(60_000))], 2 + i));
  write([...start, ...filler, prompt('meanwhile', 20), assistant([text('ok')], 21)]);
  assert.deepEqual((await fileMeta(file))?.background, [['bg1', 'Bash · Run full e2e suite']]);
  write([...start, ...filler, prompt('meanwhile', 20), assistant([text('ok')], 21),
    { type: 'user', uuid: `n${n++}`, timestamp: at(30), message: { content: '<task-notification>\n<task-id>bg1</task-id>\n</task-notification>' } }]);
  assert.deepEqual((await fileMeta(file))?.background, []);
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
  assert.equal(m.prs[0]?.id, 23784);
  assert.equal(m.prs[0]?.result, 'PASSED all 12 checks');
  assert.equal(m.prs[0]?.watching, false);
});

test('a watcher still running in the background keeps watching', async () => {
  const m = await meta([
    prompt('ship it'),
    assistant([toolUse('w', 'Bash', { command: 'pr-to-green/watch-pr.sh 1 "RUNNING"' })]),
    toolResult('w', 'Command running in background with ID: b1'),
  ]);
  assert.equal(m.prs[0]?.id, 1);
  assert.equal(m.prs[0]?.result, 'RUNNING');
  assert.equal(m.prs[0]?.watching, true);
  assert.deepEqual(m.greenWatches, []);
});

test('a watcher waiting on checks already green is a green watch; one waiting on a fix is not', async () => {
  const watch = (result: string) => meta([
    prompt('ship it'),
    assistant([toolUse('w', 'Bash', { command: `pr-to-green/watch-pr.sh 1 "${result}"`, run_in_background: true })]),
    { ...toolResult('w', 'Command running in background with ID: b1'), toolUseResult: { stdout: '', backgroundTaskId: 'b1' } },
  ]);
  const green = await watch('PASSED iteration 5 commit d2a7d6ef91');
  assert.equal(green.prs[0]?.watching, true);
  assert.deepEqual(green.background, [['b1', 'Bash · pr-to-green/watch-pr.sh 1 "PASSED iteration 5 commit d2a7d6ef91"']]);
  assert.deepEqual(green.greenWatches, ['b1']);
  assert.deepEqual((await watch('FAILED: e2e')).greenWatches, []);
});

test('pr-to-green in a task across repos: each PR on its own, with where its command ran and the repository az named', async () => {
  const at = (cwd: string, e: Record<string, any>) => ({ ...e, cwd });
  const m = await meta([
    prompt('ship both'),
    assistant([toolUse('s', 'Skill', { skill: 'pr-to-green' })]),
    at('/t', assistant([toolUse('c1', 'Bash', { command: 'cd api && az repos pr create --title x' })])),
    toolResult('c1', '{ "pullRequestId": 11, "repository": { "id": "r1", "name": "api" } }'),
    at('/t', assistant([toolUse('c2', 'Bash', { command: 'az repos pr create --repository web --title y' })])),
    toolResult('c2', '{ "pullRequestId": 12 }'),
    at('/t', assistant([toolUse('w1', 'Bash', { command: 'cd "/t/api" && pr-to-green/watch-pr.sh 11 "RUNNING"', run_in_background: true })])),
    { ...toolResult('w1', 'Command running in background with ID: b1'), toolUseResult: { stdout: '', backgroundTaskId: 'b1' } },
    at('/t/web', assistant([toolUse('w2', 'Bash', { command: 'pr-to-green/watch-pr.sh 12 "PASSED iteration 1"', run_in_background: true })])),
    { ...toolResult('w2', 'Command running in background with ID: b2'), toolUseResult: { stdout: '', backgroundTaskId: 'b2' } },
  ]);
  assert.deepEqual(m.prs.map(({ id, dir, repository, watching }) => ({ id, dir, repository, watching })), [
    { id: 11, dir: '/t/api', repository: 'api', watching: true },
    { id: 12, dir: '/t/web', repository: 'web', watching: true },
  ]);
  assert.deepEqual(m.greenWatches, ['b2']);
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
  assert.equal(m.activity?.step, 'pitwall: ask_human');
});

test('a conversation that /clear started says so; one that only mentions /clear later does not', async () => {
  const caveat = { type: 'user', isMeta: true, uuid: `m${n++}`, timestamp: at(0), message: { content: '<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>' } };
  const clear = prompt('<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>');
  assert.equal((await meta([caveat, clear, prompt('Now the tests', 1)])).cleared, true);
  assert.equal((await meta([prompt('Fix the login'), clear])).cleared, false);
});

test('the model and effort come from the last request of the main conversation, not a side query', async () => {
  const request = (model: string, effort: string, querySource = 'repl_main_thread') => ({ type: 'api-request', querySource, params: { model, output_config: { effort } } });
  const m = await meta([prompt('x'), request('claude-opus-5-5', 'high'), assistant([text('ok')]), request('claude-haiku-5-5', 'low', 'sdk')]);
  assert.deepEqual([m.model, m.effort], ['claude-opus-5-5', 'high']);
  const older = await meta([prompt('x'), { ...assistant([text('ok')]), message: { model: 'claude-sonnet-5-5', content: [text('ok')] } }]);
  assert.deepEqual([older.model, older.effort], ['claude-sonnet-5-5', null]);
});
