# MCP

`src/mcp/server.mjs` exposes the [tool registry](../README.md#tools) over the
Model Context Protocol, on stdio, in plain Node with no dependencies.

- **Transport** stdio. One JSON-RPC 2.0 message per line, newline-delimited, on
  stdin and stdout. Nothing but protocol messages is ever written to stdout -
  logs go to stderr, because a log line on stdout is an unparseable message to
  the client.
- **Protocol version** `2024-11-05`.
- **Methods** `initialize`, `tools/list`, `tools/call`, `ping`. Notifications
  (`notifications/initialized` and anything else under `notifications/`) are
  accepted and, as the specification requires, never answered. Any other method
  is `-32601`.
- **Capabilities** `{ "tools": { "listChanged": false } }`. The tool list is
  fixed at startup; there is no resources or prompts capability because this
  server has neither.

```bash
npm run mcp
```

## Client configuration

Generic JSON, the shape most MCP clients accept:

```json
{
  "mcpServers": {
    "buyer-radar": {
      "command": "node",
      "args": ["src/mcp/server.mjs"],
      "cwd": "/srv/buyer-radar",
      "env": {
        "RADAR_MCP_ACTOR": "agent",
        "DATABASE_URL": "",
        "RADAR_DATA_DIR": "/srv/buyer-radar/data"
      }
    }
  }
}
```

`cwd` matters: with `DATABASE_URL` unset the store is the JSON directory under
`data/`, and `RADAR_DATA_DIR` is what points at it from elsewhere. Set
`DATABASE_URL` instead to run the server against Postgres; nothing else changes.

| Variable | What it does here |
| --- | --- |
| `RADAR_MCP_ACTOR` | `owner` or `agent`. **Defaults to `agent`.** Only the exact word `owner` opens the two gated tools. |
| `DATABASE_URL` | Postgres, or unset for the JSON store |
| `RADAR_DATA_DIR` | Where the JSON store lives, when it is not `./data` |
| `RADAR_RUNS_DIR` | Where `tools_<date>.evidence.json` is written, when it is not `./runs` |
| `RADAR_DIGESTS_DIR` | Where `L<n>` labels are resolved from, when it is not `./digests` |
| `RADAR_TO_WA`, `WA_PHONE_NUMBER_ID`, `WA_TOKEN` | Only `owner.message` reads these, and only to reach the owner's own number |
| `DEEPSEEK_API_KEY` and the other `LLM_*` variables | Only `model.read` reads these. With no key it answers "the model stage is off" and spends nothing. |

## What an agent can and cannot do

Run as `agent` - the default - a model driving this server can:

- search and read the lead register (`leads.search`, `leads.get`)
- read stored mandi prices (`prices.get`)
- fetch a page under its host's robots.txt (`web.fetch`)
- read a PDF (`pdf.text`) and pull contacts out of text (`contacts.extract`)
- run one source module and see what it returned (`source.run`)
- render the morning digest (`digest.render`)
- ask the model to read text, under the cache and the daily budget
  (`model.read`)

It **cannot** change a lead's status and it **cannot** send a message. Both
refuse with a `tool.refused` receipt naming the actor. `owner.message` has no
recipient field at any actor level: the only address reachable from this
codebase is the owner's own.

Every call - and every refusal - is appended to
`runs/tools_<date>.evidence.json`, sealed with the same hash recipe as a run
bundle:

```bash
node tools/verify.mjs runs/tools_$(date +%F).evidence.json
```

## A round trip

Lines beginning `->` are written to the server's stdin, `<-` are read from its
stdout. Real output, captured from a server started over the test fixture store and
reformatted for reading. `matched` is how many leads the filter matched and
`count` how many the limit returned - the cap never hides the total.

```jsonc
-> {"jsonrpc":"2.0","id":1,"method":"initialize",
   "params":{"protocolVersion":"2024-11-05","capabilities":{},
             "clientInfo":{"name":"test-client","version":"1.0.0"}}}

<- {"jsonrpc":"2.0","id":1,"result":{
     "protocolVersion":"2024-11-05",
     "capabilities":{"tools":{"listChanged":false}},
     "serverInfo":{"name":"buyer-radar","version":"0.1.0"},
     "instructions":"The Buyer Radar lead register and its tools. ..."}}

-> {"jsonrpc":"2.0","method":"notifications/initialized"}
   (no response, by the specification)

-> {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}

<- {"jsonrpc":"2.0","id":2,"result":{"tools":[
     {"name":"leads.search",
      "description":"Search the lead register. ... [kind: read, cost: free]",
      "inputSchema":{"type":"object","additionalProperties":false,
        "properties":{"status":{"type":"string","enum":["new","contacted",...]},
                      "limit":{"type":"integer","minimum":1,"maximum":500,"default":20}}},
      "_meta":{"kind":"read","cost":"free","ownerOnly":false,"outputSchema":{...}}},
     ... ten more ...]}}

-> {"jsonrpc":"2.0","id":3,"method":"tools/call",
   "params":{"name":"leads.search","arguments":{"segment":"hotel","limit":2}}}

<- {"jsonrpc":"2.0","id":3,"result":{"isError":false,"content":[{"type":"text","text":
     "{\"count\":2,\"matched\":4,\"total\":14,\"leads\":[{\"id\":\"67a4f3886f19824f\",\"name\":\"Chennai Regency\",...}]}"}]}}

-> {"jsonrpc":"2.0","id":4,"method":"tools/call",
   "params":{"name":"owner.message","arguments":{"text":"ring this buyer"}}}

<- {"jsonrpc":"2.0","id":4,"result":{"isError":true,"content":[{"type":"text","text":
     "{\"error\":\"owner.message is owner-only and the caller is \\\"agent\\\". Set RADAR_MCP_ACTOR=owner to call it, which is the owner saying so in his own environment.\",\"refused\":true}"}]}}
```

A refusal is a **result with `isError: true`**, not a JSON-RPC error. The model
asked a legitimate question and is owed the answer "no, and here is why" in a
form it can read; a transport-level error would just look like a broken server.

## Notes

- Requests are answered one at a time, in the order they arrived. Two writes
  interleaving over one register file is not a race worth having for a server
  whose busiest caller is one model.
- There is no HTTP transport, on purpose. The owner's dashboard is the HTTP
  surface and it is behind a bearer token; adding a second HTTP surface would
  mean a second thing to authenticate.
- Tool inputs are validated against their JSON Schema before any handler runs, so
  a client that gets an argument wrong is told which field, not handed a failure
  from somewhere inside the pipeline.
