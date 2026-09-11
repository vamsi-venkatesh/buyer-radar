// The tool registry from a terminal, mostly so the owner can see what an agent
// can see. `list` prints the table; `call` runs one tool with JSON arguments.
//
// It runs as `agent` unless --owner is given, which is the same gate the MCP
// server applies: the refusal an agent gets is reproducible here, by hand,
// before anybody wires a model to it.

import { openStore } from '../lib/store.mjs';
import { listTools, callTool } from './registry.mjs';

const USAGE = `
Buyer Radar - tools

  node src/tools/cli.mjs list
  node src/tools/cli.mjs call <tool> '<json arguments>' [--owner]

Every call writes a tool.call receipt into runs/tools_<date>.evidence.json,
verified with: node tools/verify.mjs runs/tools_<date>.evidence.json

--owner runs as the owner, which is what the two gated tools require. Without it
the caller is an agent and leads.set_status and owner.message refuse.
`;

async function main() {
  const argv = process.argv.slice(2);
  const owner = argv.includes('--owner');
  const rest = argv.filter((a) => a !== '--owner');
  const command = rest[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  if (command === 'list') {
    for (const t of listTools()) {
      process.stdout.write(
        `${t.name.padEnd(20)} ${t.kind.padEnd(8)} ${t.cost.padEnd(8)} ${t.ownerOnly ? 'owner only' : ''}\n`
      );
    }
    return;
  }

  if (command === 'call') {
    const name = rest[1];
    if (!name) throw new Error('usage: call <tool> \'<json arguments>\'');
    let args = {};
    if (rest[2]) {
      try {
        args = JSON.parse(rest[2]);
      } catch (err) {
        throw new Error(`the arguments are not JSON: ${err.message}`);
      }
    }
    const store = await openStore();
    try {
      const result = await callTool(name, args, {
        store,
        env: process.env,
        actor: owner ? 'owner' : 'agent',
        fetch: globalThis.fetch,
        now: () => new Date().toISOString(),
        log: (m) => process.stderr.write(`${m}\n`),
      });
      process.stdout.write(`${JSON.stringify(result.ok ? result.output : { error: result.error, refused: Boolean(result.refused) }, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
    } finally {
      await store.close();
    }
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n${USAGE}`);
  process.exit(1);
});
