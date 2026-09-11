// A Model Context Protocol server over stdio, in plain Node, with no
// dependencies.
//
// It exposes the tool registry and nothing else. Every tool's JSON Schema goes
// out over `tools/list`, so a client that has never seen this codebase can call
// them correctly; every `tools/call` runs through `callTool`, so the schema
// check, the owner gate and the receipt all happen exactly as they do when the
// pipeline calls the same tool.
//
// The actor comes from RADAR_MCP_ACTOR and defaults to `agent`. An agent can
// read the register, read prices, read a page, read a PDF, run a source and
// render the digest. It cannot change a lead's status and it cannot send the
// owner a message: both refuse, with a `tool.refused` receipt naming the actor.
// Setting RADAR_MCP_ACTOR=owner is the owner saying so in his own environment,
// which is the same shape every other permission in this project has.
//
// Framing is newline-delimited JSON on stdin and stdout, one JSON-RPC 2.0
// message per line, as the stdio transport specifies. Nothing but protocol
// messages is ever written to stdout - logs go to stderr, because a log line on
// stdout would be an unparseable message to the client.

import { createInterface } from 'node:readline';
import { openStore } from '../lib/store.mjs';
import { RUNS_DIR, DIGESTS_DIR } from '../lib/paths.mjs';
import { listTools, callTool } from '../tools/registry.mjs';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = { name: 'buyer-radar', version: '0.1.0' };

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** The actor a call runs as. Anything that is not exactly "owner" is an agent. */
export function actorFrom(env = process.env) {
  return String(env.RADAR_MCP_ACTOR || '').toLowerCase() === 'owner' ? 'owner' : 'agent';
}

/**
 * One registry tool as MCP describes a tool.
 *
 * The kind, the cost and the gate are put in the description as well as in
 * `_meta`, because a client that ignores `_meta` still has to be able to tell a
 * metered network call from a free local one before it makes it.
 */
export function toMcpTool(tool) {
  const tags = [`kind: ${tool.kind}`, `cost: ${tool.cost}`, tool.ownerOnly ? 'owner only' : null]
    .filter(Boolean)
    .join(', ');
  return {
    name: tool.name,
    description: `${tool.description} [${tags}]`,
    inputSchema: tool.inputSchema,
    _meta: { kind: tool.kind, cost: tool.cost, ownerOnly: tool.ownerOnly, outputSchema: tool.outputSchema },
  };
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function failure(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * Handle one decoded JSON-RPC message. Returns the response object, or null for
 * a notification, which by the specification is never answered.
 */
export async function handleMessage(message, ctx) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return failure(null, JSONRPC_INVALID_REQUEST, 'a JSON-RPC message must be an object');
  }
  const { id = null, method, params } = message;
  const isNotification = id === null || id === undefined;

  if (typeof method !== 'string') {
    return isNotification ? null : failure(id, JSONRPC_INVALID_REQUEST, 'method is missing');
  }

  if (method === 'initialize') {
    return result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'The Buyer Radar lead register and its tools. Reading is unrestricted; leads.set_status and owner.message are owner-only and refuse unless RADAR_MCP_ACTOR=owner. No tool in this server can reach a buyer: owner.message has no recipient field and sends only to the owner\'s own number.',
    });
  }

  if (method.startsWith('notifications/')) return null;

  if (method === 'ping') return result(id, {});

  if (method === 'tools/list') {
    return result(id, { tools: listTools().map(toMcpTool) });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (typeof name !== 'string') {
      return failure(id, JSONRPC_INVALID_REQUEST, 'tools/call needs params.name');
    }
    let call;
    try {
      call = await callTool(name, args, await ctx.toolContext());
    } catch (err) {
      return failure(id, JSONRPC_INTERNAL_ERROR, `${err.name}: ${err.message}`);
    }
    // A tool that refused, or failed, is a *result* with isError - not a
    // protocol error. The model asked a legitimate question and is owed the
    // answer "no, and here is why" in a form it can read.
    const payload = call.ok ? call.output : { error: call.error, refused: Boolean(call.refused) };
    return result(id, {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: !call.ok,
    });
  }

  return isNotification ? null : failure(id, JSONRPC_METHOD_NOT_FOUND, `unknown method: ${method}`);
}

/**
 * Wire a reader and a writer to the handler. Exported so a test can drive the
 * server in-process as well as over a real child process.
 */
export function createMcpServer({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  storeFactory = openStore,
  fetchImpl = globalThis.fetch,
  runsDir = env.RADAR_RUNS_DIR || RUNS_DIR,
  digestsDir = env.RADAR_DIGESTS_DIR || DIGESTS_DIR,
} = {}) {
  const actor = actorFrom(env);
  let storePromise = null;

  // Requests are answered one at a time, in the order they arrived. Two writes
  // interleaving over one register file is not a race worth having for a server
  // whose busiest caller is one model.
  let queue = Promise.resolve();

  const ctx = {
    async toolContext() {
      if (!storePromise) storePromise = storeFactory();
      return {
        store: await storePromise,
        env,
        actor,
        fetch: fetchImpl,
        runsDir,
        digestsDir,
        now: () => new Date().toISOString(),
        log: (m) => process.stderr.write(`[mcp] ${m}\n`),
      };
    },
  };

  const write = (obj) => {
    if (obj === null) return;
    output.write(`${JSON.stringify(obj)}\n`);
  };

  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(text);
      } catch (err) {
        write(failure(null, JSONRPC_PARSE_ERROR, `could not parse the message: ${err.message}`));
        return;
      }
      try {
        write(await handleMessage(message, ctx));
      } catch (err) {
        write(failure(message.id ?? null, JSONRPC_INTERNAL_ERROR, `${err.name}: ${err.message}`));
      }
    });
  });

  return {
    actor,
    close: async () => {
      rl.close();
      await queue;
      if (storePromise) {
        const store = await storePromise;
        await store.close();
      }
    },
    whenIdle: () => queue,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createMcpServer();
  process.stderr.write(`[mcp] buyer-radar over stdio, actor=${server.actor}\n`);
  process.stdin.on('close', () => {
    server.close().then(() => process.exit(0));
  });
}
