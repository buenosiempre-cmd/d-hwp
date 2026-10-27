// Synthetic MCP process: no real rules, documents, keys or external requests.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const mode = process.argv[2] || 'echo';
const server = new Server({ name: 'd-hwp-synthetic-rules', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const tool = request.params.name;
  if (mode === 'delay') await new Promise(resolve => setTimeout(resolve, 350));
  if (mode === 'malformed') return { content: [{ type: 'text', text: 'A prose answer is not a structured success.' }] };
  if (mode === 'error') return {
    content: [{ type: 'text', text: 'synthetic-private-path /private/demo Authorization: Bearer synthetic-token' }],
    structuredContent: { ok: false, tool, error: { code: 'AMBIGUOUS_RULE', message: 'synthetic-private-path', details: { credential: 'synthetic-token' } } },
  };
  if (mode === 'wrong-tool') return { content: [], structuredContent: { ok: true, tool: 'unexpected_tool', data: {} } };
  return {
    content: [{ type: 'text', text: '합성 자료' }],
    structuredContent: { ok: true, tool, data: {
      received: request.params.arguments, tool, pid: process.pid,
      unrelatedCredentialInherited: Boolean(process.env.SLACK_BOT_TOKEN),
      evidenceStatus: 'partial', incompleteReasons: ['EXCERPT_BLOCK_LIMIT'],
      excerpt: { text: '합성 규정 근거', truncated: true },
      evidence_status: 'needs_input', applicability: 'not_determined', external_action_state: 'none',
      context: { missing_facts: [{ key: 'base_date', label: '기준일을 알려주세요.' }] },
    } },
  };
});
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { void server.close().then(() => process.exit(0)); });
