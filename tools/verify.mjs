#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { verifyBundle } from '../src/lib/receipts.mjs';

/**
 * Recompute an evidence bundle's hash from its own receipts and compare it with
 * the recorded value. Exit 0 only when the bundle verifies.
 *
 *   node tools/verify.mjs runs/<runId>.evidence.json
 */
async function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: node tools/verify.mjs <bundle.evidence.json>\n');
    process.exit(2);
  }
  const bundle = JSON.parse(await readFile(file, 'utf8'));
  const result = verifyBundle(bundle);

  process.stdout.write(`file     ${file}\n`);
  process.stdout.write(`schema   ${bundle.schema}\n`);
  process.stdout.write(`runId    ${bundle.runId}\n`);
  process.stdout.write(`receipts ${bundle.receiptCount}\n`);
  for (const r of bundle.receipts || []) {
    const extras = Object.entries(r)
      .filter(([k]) => !['seq', 'type', 'at'].includes(k))
      .map(([k, v]) => `${k}=${summarise(v)}`)
      .join(' ');
    process.stdout.write(`  [${String(r.seq).padStart(2)}] ${r.type.padEnd(20)} ${extras}\n`);
  }
  process.stdout.write(`recorded   ${bundle.hash}\n`);
  process.stdout.write(`recomputed ${result.recomputed}\n`);
  for (const p of result.problems) process.stdout.write(`PROBLEM  ${p}\n`);
  process.stdout.write(result.ok ? 'VERIFIED\n' : 'FAILED\n');
  process.exit(result.ok ? 0 : 1);
}

function summarise(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s;
  }
  const s = String(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
