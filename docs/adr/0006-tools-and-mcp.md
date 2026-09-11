# 6. Everything an agent may do is a typed tool, and MCP is one caller of it

Status: accepted, 2026-09-11

## Context

The pipeline was already a set of functions, and a model driving it could in
principle just call them. But a function has no schema, no cost label, no
permission gate and no record of having been called. "The agent updated a lead"
and "the agent did not update a lead" look identical afterwards.

Meanwhile there are three callers that want the same capabilities - the CLI, the
dashboard and an MCP client - and writing the capability three times is how the
three of them drift.

## Decision

One registry, `src/tools/registry.mjs`. Every tool declares a JSON Schema for its
input, a **kind** (`read`, `write`, `network`, `model`), a cost label, and a
handler. Input is validated **before the handler runs**, and a rejection names
the field.

- Every invocation appends `tool.call { name, kind, ms, ok, inputHash, outputHash }`
  to the active bundle; inside a run that is the run's bundle, outside one it is
  a per-day tools bundle, sealed and verified identically.
- The two tools that change something - `leads.set_status` and `owner.message` -
  refuse anybody who is not the owner or the pipeline itself, and a refusal
  writes `tool.refused { name, kind, actor, reason }`. A refusal is a record, not
  a silent no-op.
- Tools **delegate**; they never reimplement. There is exactly one
  `setLeadStatus`, one `extractContacts`, one `pdfToText`, one page fetcher and
  one model runner. The register CLI and the dashboard's status buttons both go
  through `leads.set_status`, as the owner.

`src/mcp/server.mjs` is then a thin protocol adapter: JSON-RPC 2.0 over stdio, no
dependencies, exposing the registry and nothing else. The actor comes from
`RADAR_MCP_ACTOR` and **defaults to `agent`**, so a model can read everything and
change nothing until the owner says otherwise in his own environment.

## Consequences

- A refused tool comes back as a result with `isError: true`, not a protocol
  error: the model asked a legitimate question and is owed "no, and here is why"
  in a form it can read.
- Adding a capability means adding a tool, which means adding a schema, a gate
  and a receipt. That friction is the point.
- The MCP server is tested by spawning it as a child process and driving it over
  real stdio, including reading the leads file off disk afterwards to prove a
  refused write wrote nothing.
