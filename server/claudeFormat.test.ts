import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { drift, onDrift, report, resetDrift, sessionFileProblems, transcriptProblems } from './claudeFormat.ts';
import { fileMeta, hookedConversation, startSource, transcriptFile } from './conversations.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const versions = readdirSync(FIXTURES).filter((d) => d.startsWith('claude-'));

const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('there is a fixture from at least one Claude Code version', () => {
  assert.ok(versions.length > 0);
});

for (const version of versions) {
  const dir = join(FIXTURES, version);

  test(`${version}: its session file and transcript have the shape Pitwall reads`, () => {
    assert.deepEqual(sessionFileProblems(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'))), []);
    assert.deepEqual(transcriptProblems(lines(join(dir, 'transcript.jsonl'))), []);
  });

  test(`${version}: the transcript yields its prompt, title, model and current step`, async () => {
    const m = await fileMeta(join(dir, 'transcript.jsonl'));
    assert.ok(m);
    assert.equal(m.interactive, true);
    assert.equal(m.cleared, false);
    assert.equal(m.firstPrompt, 'redacted');
    assert.equal(m.title, 'redacted');
    assert.ok(m.model?.startsWith('claude-'));
    assert.ok(m.activity?.step);
  });
}

test('a session file without the fields Pitwall reads, or with an unknown status, is drift', () => {
  const ok = { pid: 1, sessionId: 's', cwd: '/r', kind: 'interactive', status: 'idle', procStart: 'Fri Oct 30 08:35:18 2026' };
  assert.deepEqual(sessionFileProblems(ok), []);
  assert.deepEqual(sessionFileProblems({ ...ok, status: 'thinking' }), ['session files report an unknown status "thinking"']);
  assert.deepEqual(sessionFileProblems({ ...ok, sessionId: undefined, procStart: undefined }), ['session files no longer carry sessionId', 'session files no longer carry procStart']);
  assert.deepEqual(sessionFileProblems({ ...ok, kind: 'headless', status: 'running', procStart: undefined }), []);
});

test('prompts and replies without their content, ids or times are drift; other entries are not checked', () => {
  const at = '2026-10-30T08:00:00Z';
  assert.deepEqual(transcriptProblems([
    { type: 'user', uuid: 'u', timestamp: at, message: { content: 'hi' } },
    { type: 'assistant', uuid: 'a', timestamp: at, message: { content: [] } },
    { type: 'something-new' },
  ]), []);
  assert.deepEqual(transcriptProblems([
    { type: 'user', uuid: 'u', timestamp: at, message: { text: 'hi' } },
    { type: 'assistant', id: 'a', time: at, message: { content: [] } },
  ]), [
    'transcript prompts no longer hold message.content',
    'transcript assistant entries no longer carry a uuid',
    'transcript assistant entries no longer carry a timestamp',
  ]);
});

test('drift is reported once per problem, with the version it was seen in', () => {
  resetDrift();
  let calls = 0;
  onDrift(() => calls++);
  report(['session files no longer carry cwd'], '9.9.9');
  report(['session files no longer carry cwd'], '9.9.10');
  assert.equal(calls, 1);
  assert.deepEqual(drift().map((d) => [d.problem, d.version]), [['session files no longer carry cwd', '9.9.9']]);
  resetDrift();
  onDrift(() => {});
});

test('a transcript path and start source from the hooks win over the guessed folder and the /clear marker', async () => {
  assert.equal(startSource('hooked-1'), null);
  hookedConversation('hooked-1', { transcript: '/elsewhere/hooked-1.jsonl', source: 'clear' });
  hookedConversation('hooked-1', { transcript: null, source: null });
  assert.equal(await transcriptFile('/any/cwd', 'hooked-1'), '/elsewhere/hooked-1.jsonl');
  assert.equal(startSource('hooked-1'), 'clear');
});
