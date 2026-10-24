import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { ASK_TOOL, MCP_SERVER_NAME } from './config.ts';

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

export const askInput = z.object(inputSchema);

// The dashboard reads calls to this tool from the session transcript, so the tool
// itself only has to exist and acknowledge.
function server() {
  const mcp = new McpServer({ name: MCP_SERVER_NAME, version: '1.0.0' });
  mcp.registerTool(ASK_TOOL, {
    title: 'Ask the human',
    description:
      'The user supervises several Claude sessions from the Docket board and does not watch every terminal. ' +
      'Call this to put a question or request on that dashboard when you genuinely need them: a problem with the plan or ' +
      'requirements you did not anticipate together, failures you cannot fix yourself (CI, tests, access, environment), ' +
      'a decision that is theirs to make (product behavior, trade-offs, scope, anything irreversible or outward-facing), ' +
      'or finished work ready for review. Do not use it for routine progress or for questions the code answers. ' +
      'Give context in `details`, offer concrete `options` and mark the one you recommend. ' +
      'After calling this, end your turn; the answer arrives as the next user message, usually starting with Re: "<title>".',
    inputSchema,
  }, async () => ({
    content: [{ type: 'text', text: 'Posted to the user\'s dashboard. End your turn now and wait; their answer will arrive as the next user message.' }],
  }));
  return mcp;
}

export async function handleMcp(request: Request) {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server().connect(transport);
  return transport.handleRequest(request);
}
