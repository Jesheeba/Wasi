#!/usr/bin/env node
// Wasi MCP server — stdio transport entry point (build plan §2/§10: local
// first, no OAuth needed). Run via `npx @wasi/mcp-server` (once published)
// or `node src/index.js` from a checkout, with WASI_API_KEY set in the
// environment. See README.md for full setup instructions.
//
// createServer() is exported separately from the stdio bootstrap below so
// test/ can construct the same McpServer instance and drive it over an
// in-memory or real-HTTP-backed transport without spawning a child process
// — see test/protocol.test.js and test/integration.test.js.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const packageJson = require('../package.json');
const { registerAllTools } = require('./tools');

function createServer() {
  const server = new McpServer({
    name: packageJson.name,
    version: packageJson.version,
  }, {
    capabilities: { tools: {} },
    instructions:
      'Tools for sending and reading WhatsApp Business messages through Wasi. ' +
      'Before sending a template message, call list_templates (and get_template_details) to confirm it exists and is approved — ' +
      'an unapproved or misspelled template name will fail. Free-form sends (send_text_message, send_button_message, ' +
      'send_list_message) only work within 24 hours of the contact\'s last inbound message; use send_template_message outside that window.',
  });

  registerAllTools(server);
  return server;
}

// Deliberately does NOT hard-fail if WASI_API_KEY is missing — an MCP
// client should still be able to list this server's tools and read their
// descriptions/schemas for debugging; each tool call itself returns a
// clear, structured missing_api_key error (see hubClient.js/errors.js)
// rather than the whole process refusing to start.
async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // MCP stdio servers must never write anything but protocol frames to
  // stdout — the transport owns stdout entirely. Diagnostics go to stderr,
  // which every MCP client (Claude Desktop, Claude Code) surfaces in its
  // own logs without corrupting the JSON-RPC stream.
  console.error(`${packageJson.name} v${packageJson.version} running on stdio.`);
  if (!process.env.WASI_API_KEY) {
    console.error('Warning: WASI_API_KEY is not set — tool calls will fail until it is configured. See README.md.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error starting Wasi MCP server:', err);
    process.exit(1);
  });
}

module.exports = { createServer };
