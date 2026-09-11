import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openStore } from './lib/store.mjs';
import { EXPORTS_DIR, DIGESTS_DIR } from './lib/paths.mjs';
import { STATUSES, normaliseCity, todayIso } from './lib/normalise.mjs';
import { ReceiptChain } from './lib/receipts.mjs';
import { RUNS_DIR } from './lib/paths.mjs';

const USAGE = `
Buyer Radar - lead register

  node src/register.mjs list [--status new] [--city bengaluru] [--limit 20] [--kind buyer]
  node src/register.mjs set-status L3 contacted "spoke to purchase manager"
  node src/register.mjs set-status 4f2a... won "first order 40 kg"
  node src/register.mjs export --csv
  node src/register.mjs export --json

Statuses: ${STATUSES.join(', ')}
R<n>, L<n> and G<n> refer to the numbering in the most recent digest (digests/<date>.index.json):
R is a posted requirement, L a buyer, G a registration route.
This command never sends a message to anyone.
`;

const CSV_COLUMNS = [
  'id', 'kind', 'segment', 'name', 'city', 'state', 'address', 'phone', 'email',
  'website', 'why_now', 'source', 'source_url', 'licence', 'first_seen',
  'last_seen', 'score', 'status', 'notes', 'segment_source', 'segment_model',
  'opener_model',
];

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(leads, columns = CSV_COLUMNS) {
  const lines = [columns.join(',')];
  for (const lead of leads) lines.push(columns.map((c) => csvCell(lead[c])).join(','));
  return `${lines.join('\n')}\n`;
}

/** Resolve an R<n>, L<n> or G<n> digest label, or pass a raw lead id through. */
export async function resolveLeadRef(ref, { digestsDir = DIGESTS_DIR } = {}) {
  const m = String(ref).match(/^([LlRrGg])(\d+)$/);
  if (!m) return { id: ref, via: 'id' };
  const label = `${m[1].toUpperCase()}${m[2]}`;
  const { readdir } = await import('node:fs/promises');
  let files = [];
  try {
    files = (await readdir(digestsDir)).filter((f) => f.endsWith('.index.json')).sort();
  } catch {
    files = [];
  }
  if (!files.length) throw new Error(`no digest index found; cannot resolve ${label}`);
  const latest = files[files.length - 1];
  const index = JSON.parse(await readFile(path.join(digestsDir, latest), 'utf8'));
  const id = index[label];
  if (!id) throw new Error(`${label} is not in the latest digest (${latest})`);
  return { id, via: latest };
}

export function filterLeads(leads, { status, city, kind, segment, minScore } = {}) {
  return leads
    .filter((l) => (status ? l.status === status : true))
    .filter((l) => (city ? normaliseCity(l.city) === normaliseCity(city) : true))
    .filter((l) => (kind ? l.kind === kind : true))
    .filter((l) => (segment ? l.segment === segment : true))
    .filter((l) => (minScore === undefined ? true : l.score >= minScore))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

async function writeStatusReceipt(entry, { runsDir = RUNS_DIR } = {}) {
  const chain = new ReceiptChain(`status_${Date.now().toString(36)}`);
  chain.add('lead.status_changed', entry);
  const bundle = chain.seal();
  await mkdir(runsDir, { recursive: true });
  const file = path.join(runsDir, `${bundle.runId}.evidence.json`);
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return { file, bundle };
}

/**
 * The one place a lead's status changes. The CLI and the dashboard both call
 * this, so both append the same dated note, write the same verifiable receipt
 * and record the same event. Nothing here sends a message to anyone.
 */
export async function setLeadStatus(
  store,
  { ref, status, note = null, digestsDir = DIGESTS_DIR, runsDir = RUNS_DIR } = {}
) {
  if (!ref || !status) throw new Error('setLeadStatus needs a lead ref and a status');
  if (!STATUSES.includes(status)) {
    throw new Error(`unknown status: ${status} (${STATUSES.join(', ')})`);
  }
  const { id, via } = await resolveLeadRef(ref, { digestsDir });
  const before = await store.getLead(id);
  if (!before) throw new Error(`lead not found: ${id}`);
  const cleanNote = note ? String(note).replace(/\s+/g, ' ').trim().slice(0, 240) : null;
  const notes = cleanNote
    ? [before.notes, `${todayIso()} ${status}: ${cleanNote}`].filter(Boolean).join('\n')
    : before.notes;
  const after = await store.updateLead(id, {
    status,
    notes,
    last_seen: new Date().toISOString(),
  });
  const receipt = {
    leadId: id,
    ref,
    resolvedVia: via,
    from: before.status,
    to: status,
    note: cleanNote,
    at: new Date().toISOString(),
  };
  const { file, bundle } = await writeStatusReceipt(receipt, { runsDir });
  await store.appendEvents(bundle.receipts.map((r) => ({ ...r, runId: bundle.runId })));
  return { id, before, after, receipt, bundle, file };
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const { flags, positional } = parseFlags(argv.slice(1));
  const store = await openStore();

  try {
    if (command === 'list') {
      const leads = await store.allLeads();
      const filtered = filterLeads(leads, {
        status: typeof flags.status === 'string' ? flags.status : undefined,
        city: typeof flags.city === 'string' ? flags.city : undefined,
        kind: typeof flags.kind === 'string' ? flags.kind : undefined,
        segment: typeof flags.segment === 'string' ? flags.segment : undefined,
        minScore: flags['min-score'] ? Number(flags['min-score']) : undefined,
      });
      const limit = flags.limit ? Number(flags.limit) : 20;
      for (const l of filtered.slice(0, limit)) {
        process.stdout.write(
          [
            l.id,
            String(l.score).padStart(3),
            l.status.padEnd(9),
            l.segment.padEnd(17),
            (l.city || '-').padEnd(12),
            (l.phone || l.email || l.website || '-').padEnd(24),
            l.name,
          ].join('  ') + '\n'
        );
      }
      process.stderr.write(`\n${Math.min(limit, filtered.length)} of ${filtered.length} matching leads (${leads.length} total)\n`);
      return;
    }

    if (command === 'set-status') {
      const [ref, status, ...noteParts] = positional;
      if (!ref || !status) throw new Error('usage: set-status <R<n>|L<n>|G<n>|leadId> <status> ["note"]');
      // Through the tool layer, as the owner. The CLI is the owner at his own
      // terminal, so the gate is satisfied; an agent calling the same tool over
      // MCP is not, and is refused. Either way the write goes through
      // setLeadStatus() below, so the note, the receipt and the event are the
      // same ones this command has always written.
      const { callTool } = await import('./tools/registry.mjs');
      const call = await callTool(
        'leads.set_status',
        { ref, status, note: noteParts.join(' ').trim() || null },
        { store, actor: 'owner', env: process.env }
      );
      if (!call.ok) throw new Error(call.error);
      const r = call.output;
      process.stdout.write(`${r.name} [${r.id}]: ${r.from} -> ${r.to}\n`);
      process.stderr.write(`receipt ${path.relative(process.cwd(), r.receiptFile)} hash ${r.receiptHash}\n`);
      return;
    }

    if (command === 'export') {
      const leads = filterLeads(await store.allLeads(), {
        status: typeof flags.status === 'string' ? flags.status : undefined,
        city: typeof flags.city === 'string' ? flags.city : undefined,
      });
      await mkdir(EXPORTS_DIR, { recursive: true });
      const date = todayIso();
      if (flags.json) {
        const file = path.join(EXPORTS_DIR, `leads-${date}.json`);
        await writeFile(file, `${JSON.stringify(leads, null, 2)}\n`, 'utf8');
        process.stdout.write(`${file}\n`);
      } else {
        const file = path.join(EXPORTS_DIR, `leads-${date}.csv`);
        await writeFile(file, toCsv(leads), 'utf8');
        process.stdout.write(`${file}\n`);
      }
      process.stderr.write(`${leads.length} leads exported\n`);
      return;
    }

    throw new Error(`unknown command: ${command}`);
  } finally {
    await store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n${USAGE}`);
    process.exit(1);
  });
}
