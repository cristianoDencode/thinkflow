// Minimal MCP stdio server used by integration tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '1.0.0' });

server.registerTool(
  'echo',
  { description: 'Repete o texto recebido', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);

server.registerTool('fail', { description: 'Sempre falha' }, async () => ({
  content: [{ type: 'text', text: 'falhou' }],
  isError: true,
}));

await server.connect(new StdioServerTransport());
