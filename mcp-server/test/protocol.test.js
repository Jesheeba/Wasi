// MCP protocol conformance — a real MCP Client (from the same SDK) talks to
// our real McpServer over an in-memory transport pair (no shell/stdio
// process spawning, no network — see @modelcontextprotocol/sdk's
// InMemoryTransport). Confirms: initialization succeeds, every tool this
// server advertises has a name/description/inputSchema a client can
// actually use, and a tool call round-trips through the real MCP JSON-RPC
// layer (not just our handler function called directly in-process).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = require('../src/index');
const { allTools } = require('../src/tools');

let client;
let server;

before(async () => {
  server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
});

after(async () => {
  await client.close();
});

test('server initializes and advertises the tools capability', () => {
  const caps = client.getServerCapabilities();
  assert.ok(caps?.tools, 'server must advertise the tools capability');
});

test('listTools returns every registered tool with a usable name, description, and inputSchema', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, allTools.length);

  const expectedNames = allTools.map((t) => t.name).sort();
  assert.deepEqual(tools.map((t) => t.name).sort(), expectedNames);

  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a real, specific description`);
    assert.ok(tool.inputSchema && tool.inputSchema.type === 'object', `${tool.name} must expose a JSON Schema object inputSchema`);
  }
});

// The SDK validates inputSchema itself (before our handler ever runs) and
// surfaces a violation as a normal isError:true tool result carrying the
// zod validation message — not a rejected JSON-RPC call — see probe output
// captured while writing this test: {"content":[{"type":"text","text":
// "MCP error -32602: ... Array must contain at most 3 element(s) at
// buttons"}],"isError":true}. Proves the schema-level constraint (plan doc
// §3: enforce Meta's real limits in the schema, not just at runtime) is
// actually wired into the tool's inputSchema, not just documented in prose.
test('send_button_message: inputSchema rejects more than 3 buttons at the protocol layer', async () => {
  const result = await client.callTool({
    name: 'send_button_message',
    arguments: {
      to: '919876543210',
      body: 'Pick one',
      buttons: [
        { id: 'a', title: 'A' }, { id: 'b', title: 'B' },
        { id: 'c', title: 'C' }, { id: 'd', title: 'D' },
      ],
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /at most 3/i);
});

test('send_list_message: inputSchema rejects more than 10 total rows across sections', async () => {
  const result = await client.callTool({
    name: 'send_list_message',
    arguments: {
      to: '919876543210',
      body: 'Choose',
      button: 'Open',
      sections: [
        { rows: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, title: `Row ${i}` })) },
        { rows: Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, title: `Row ${i}` })) },
      ],
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /10 rows total/i);
});

test('get_message_status: inputSchema rejects a non-UUID message_id before any network call', async () => {
  const result = await client.callTool({ name: 'get_message_status', arguments: { message_id: 'not-a-uuid' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /uuid/i);
});

test('calling a tool with no WASI_API_KEY set returns a structured isError result, not a protocol crash', async () => {
  const original = process.env.WASI_API_KEY;
  delete process.env.WASI_API_KEY;
  try {
    const result = await client.callTool({ name: 'get_account_status', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /WASI_API_KEY/);
  } finally {
    if (original !== undefined) process.env.WASI_API_KEY = original;
  }
});
