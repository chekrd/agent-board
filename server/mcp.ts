import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { ASK_TOOL, MCP_SERVER_NAME } from './config.ts';
import { ask } from './sessions.ts';

export const CATEGORIES = ['feature', 'bug', 'plan-problem', 'ci-failure', 'research', 'update', 'review-ready'] as const;

const inputSchema = {
  title: z.string().describe('One-line headline the user sees first, phrased as the question or the need.'),
  details: z.string().describe('Markdown with the context needed to decide: what you found, what you tried, trade-offs, your recommendation.'),
  options: z.array(z.object({
    label: z.string().describe('Short button label, e.g. "Keep the old API".'),
    description: z.string().optional(),
    recommended: z.boolean().optional().describe('Mark the option you recommend.'),
  })).optional().describe('Concrete choices, if the question has them. The user can always answer with free text instead.'),
  category: z.enum(CATEGORIES),
};

function server(sessionId: string) {
  const mcp = new McpServer({ name: MCP_SERVER_NAME, version: '1.0.0' });
  mcp.registerTool(ASK_TOOL, {
    title: 'Ask the human',
    description:
      'Put a question or request on the user\'s dashboard when you genuinely need them: a problem with the plan, ' +
      'failures you cannot fix yourself, a decision that is theirs to make, or finished work ready for review. ' +
      'After calling this, end your turn; the answer arrives as the next user message.',
    inputSchema,
  }, async (args) => {
    ask(sessionId, { title: args.title, details: args.details, options: args.options ?? [], category: args.category });
    return {
      content: [{ type: 'text', text: 'Posted to the user\'s dashboard. End your turn now and wait; their answer will arrive as the next user message.' }],
    };
  });
  return mcp;
}

export async function handleMcp(sessionId: string, request: Request) {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server(sessionId).connect(transport);
  return transport.handleRequest(request);
}
