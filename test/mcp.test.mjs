// The MCP server, driven the way a real client drives it: a child process,
// newline-delimited JSON-RPC on stdin and stdout.
//
// Nothing here touches the network and nothing here calls a model. The store is
// a temporary JSON directory seeded with the fixture leads, so the round trip
// is over real data through the real registry.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEADS } from './fixtures/store.mjs';
import { verifyBundle } from '../src/lib/receipts.mjs';
import { PROTOCOL_VERSION, SERVER_INFO, toMcpTool, actorFrom, handleMessage } from '../src/mcp/server.mjs';
import { listTools } from '../src/tools/registry.mjs';

const SERVER = fileURLToPath(new URL('../src/mcp/server.mjs', import.meta.url));

/**
 * Start the server as a child process and hand back a `send` that writes one
 * request and resolves with the matching response.
 */
async function withServer(t, { actor = 'agent' } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'radar-mcp-data-'));
  const runsDir = await mkdtemp(path.join(tmpdir(), 'radar-mcp-runs-'));
  await writeFile(path.join(dataDir, 'leads.json'), JSON.stringify(LEADS));

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      RADAR_MCP_ACTOR: actor,
      RADAR_DATA_DIR: dataDir,
      RADAR_RUNS_DIR: runsDir,
      DATABASE_URL: '',
      DEEPSEEK_API_KEY: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.stdin.end();
    child.kill();
  });

  const pending = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiting = pending.get(message.id);
      if (waiting) {
        pending.delete(message.id);
        waiting(message);
      }
    }
  });

  let nextId = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = (nextId += 1);
      pending.set(id, resolve);
      const timer = setTimeout(() => reject(new Error(`no response to ${method}`)), 10000);
      const settle = pending.get(id);
      pending.set(id, (m) => {
        clearTimeout(timer);
        settle(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    });

  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);

  return { send, notify, child, dataDir, runsDir };
}

/** tools/call hands JSON back as one text content block. */
function payloadOf(response) {
  assert.equal(response.result.content[0].type, 'text');
  return JSON.parse(response.result.content[0].text);
}

test('initialize answers with the protocol version, the tool capability and the server name', async (t) => {
  const { send } = await withServer(t);
  const res = await send('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(res.result.serverInfo, SERVER_INFO);
  assert.ok(res.result.capabilities.tools, 'the server declares the tools capability');
  assert.match(res.result.instructions, /owner-only|owner\.message/);
});

test('a notification is never answered, and ping is', async (t) => {
  const { send, notify } = await withServer(t);
  await send('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {} });
  notify('notifications/initialized');
  const pong = await send('ping', {});
  assert.deepEqual(pong.result, {}, 'the notification did not consume the ping response');
});

test('tools/list carries every registry tool with its JSON Schema', async (t) => {
  const { send } = await withServer(t);
  await send('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {} });
  const res = await send('tools/list', {});
  const names = res.result.tools.map((t2) => t2.name);
  assert.deepEqual(names.sort(), listTools().map((t2) => t2.name).sort());
  for (const tool of res.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} carries its input schema`);
    assert.match(tool.description, /\[kind: (read|write|network|model), cost: (free|metered)/);
  }
  const gated = res.result.tools.find((t2) => t2.name === 'owner.message');
  assert.match(gated.description, /owner only/);
  assert.equal(gated._meta.ownerOnly, true);
});

test('tools/call runs leads.search, prices.get and contacts.extract over the real registry', async (t) => {
  const { send } = await withServer(t);
  await send('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {} });

  const search = await send('tools/call', { name: 'leads.search', arguments: { segment: 'hotel', limit: 5 } });
  assert.equal(search.result.isError, false);
  const found = payloadOf(search);
  assert.ok(found.leads.length >= 3);
  assert.equal(found.leads.every((l) => l.segment === 'hotel'), true);
  assert.equal(found.total, LEADS.length);

  const prices = await send('tools/call', { name: 'prices.get', arguments: { days: 90 } });
  const priceRows = payloadOf(prices);
  assert.ok(Array.isArray(priceRows.rows));
  assert.ok(priceRows.withoutReading.length > 0, 'items with no reading are named, never zeroed');

  const contacts = await send('tools/call', {
    name: 'contacts.extract',
    arguments: { text: 'Contact Person: Dr Anita Rao\nPhone: 040-2301 6773' },
  });
  const read = payloadOf(contacts);
  assert.equal(read.phone, '+914023016773');
  assert.equal(read.name, 'Dr Anita Rao');
});

test('an agent is refused owner.message and leads.set_status, and the register does not move', async (t) => {
  const { send, dataDir, runsDir } = await withServer(t, { actor: 'agent' });
  await send('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {} });

  const message = await send('tools/call', { name: 'owner.message', arguments: { text: 'ring this buyer' } });
  assert.equal(message.result.isError, true, 'a refusal is a result with isError, not a protocol error');
  const refusal = payloadOf(message);
  assert.equal(refusal.refused, true);
  assert.match(refusal.error, /owner-only/);
  assert.match(refusal.error, /RADAR_MCP_ACTOR=owner/);

  const status = await send('tools/call', {
    name: 'leads.set_status',
    arguments: { id: LEADS[0].id, status: 'won', note: 'not mine to write' },
  });
  assert.equal(status.result.isError, true);
  assert.equal(payloadOf(status).refused, true);

  const stored = JSON.parse(await readFile(path.join(dataDir, 'leads.json'), 'utf8'));
  assert.equal(stored.find((l) => l.id === LEADS[0].id).status, 'new', 'nothing was written');

  // Both refusals are in the day's tools bundle, and it verifies.
  const files = (await readdir(runsDir)).filter((f) => f.startsWith('tools_'));
  assert.equal(files.length, 1);
  const bundle = JSON.parse(await readFile(path.join(runsDir, files[0]), 'utf8'));
  assert.equal(verifyBundle(bundle).ok, true);
  const refusals = bundle.receipts.filter((r) => r.type === 'tool.refused');
  assert.deepEqual(refusals.map((r) => r.name), ['owner.message', 'leads.set_status']);
  assert.equal(refusals[0].actor, 'agent');
});

test('RADAR_MCP_ACTOR=owner opens the gate the agent was refused', async (t) => {
  const { send, dataDir } = await withServer(t, { actor: 'owner' });
  await send('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {} });
  const status = await send('tools/call', {
    name: 'leads.set_status',
    arguments: { id: LEADS[0].id, status: 'contacted', note: 'rang the purchase manager' },
  });
  assert.equal(status.result.isError, false);
  assert.equal(payloadOf(status).to, 'contacted');
  const stored = JSON.parse(await readFile(path.join(dataDir, 'leads.json'), 'utf8'));
  assert.equal(stored.find((l) => l.id === LEADS[0].id).status, 'contacted');
});

test('bad arguments and unknown methods come back as the right JSON-RPC shapes', async (t) => {
  const { send } = await withServer(t);
  await send('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {} });

  const bad = await send('tools/call', { name: 'leads.search', arguments: { limit: 'lots' } });
  assert.equal(bad.result.isError, true);
  assert.match(payloadOf(bad).error, /invalid input for leads\.search/);

  const unknownTool = await send('tools/call', { name: 'leads.burn', arguments: {} });
  assert.equal(unknownTool.result.isError, true);
  assert.match(payloadOf(unknownTool).error, /unknown tool/);

  const unknownMethod = await send('resources/list', {});
  assert.equal(unknownMethod.result, undefined);
  assert.equal(unknownMethod.error.code, -32601);
  assert.match(unknownMethod.error.message, /unknown method/);
});

// ------------------------------------------------------- the parts, in process

test('actorFrom defaults to agent and only the exact word owner opens the gate', () => {
  assert.equal(actorFrom({}), 'agent');
  assert.equal(actorFrom({ RADAR_MCP_ACTOR: 'Owner' }), 'owner');
  assert.equal(actorFrom({ RADAR_MCP_ACTOR: 'owner-ish' }), 'agent');
  assert.equal(actorFrom({ RADAR_MCP_ACTOR: 'true' }), 'agent');
});

test('toMcpTool puts the kind, the cost and the gate where a client will see them', () => {
  const tool = toMcpTool(listTools().find((t) => t.name === 'model.read'));
  assert.match(tool.description, /kind: model, cost: metered/);
  assert.equal(tool._meta.cost, 'metered');
  assert.ok(tool._meta.outputSchema);
});

test('a message that is not an object is an invalid request, not a crash', async () => {
  const res = await handleMessage([1, 2, 3], {});
  assert.equal(res.error.code, -32600);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled' }, {}), null);
});
