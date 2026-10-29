import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changesSomething } from './mcpGuard.ts';

test('MCP tools that change something are denied', () => {
  for (const name of [
    'mcp__plugin_atlassian_atlassian__createJiraIssue',
    'mcp__plugin_atlassian_atlassian__addOrEditJiraIssueComment',
    'mcp__plugin_atlassian_atlassian__transitionJiraIssue',
    'mcp__plugin_atlassian_atlassian__executeWrite',
    'mcp__plugin_atlassian_atlassian__executeDestructive',
    'mcp__claude_ai_Claude_Docs__batch',
    'mcp__claude_ai_Claude_Docs__update',
    'mcp__claude-in-chrome__file_upload',
  ]) assert.equal(changesSomething(name), true, name);
});

test('reading and browser tools are allowed', () => {
  for (const name of [
    'mcp__plugin_atlassian_atlassian__getJiraIssue',
    'mcp__plugin_atlassian_atlassian__executeRead',
    'mcp__plugin_atlassian_atlassian__searchConfluence',
    'mcp__claude_ai_Claude_Docs__export',
    'mcp__brave-devtools__click',
    'mcp__brave-devtools__navigate_page',
    'mcp__brave-devtools__evaluate_script',
    'mcp__pitwall-advisor__scratch_copy',
  ]) assert.equal(changesSomething(name), false, name);
});

test('only MCP tool names are judged', () => {
  assert.equal(changesSomething('Write'), false);
  assert.equal(changesSomething('mcp__server'), false);
});
