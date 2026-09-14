import { sha256Hex } from './hash.mjs';
import { EVIDENCE_SCHEMA } from '../config.mjs';

/**
 * Evidence bundle hash recipe (fixed, do not change without a new schema string):
 *
 *   payload = schema + "\n" + receipts.length + "\n"
 *   then, for each receipt in order: JSON.stringify(receipt) + "\n"
 *   hash = sha256(payload) as lowercase hex
 *
 * The recipe is over the receipt objects as they are stored, so a field added
 * inside a receipt - `role`, for instance - changes that receipt's hash and
 * therefore the bundle's, exactly as any other change to it would. The recipe
 * itself is untouched.
 */
export function bundleHash(receipts, schema = EVIDENCE_SCHEMA) {
  let payload = `${schema}\n${receipts.length}\n`;
  for (const r of receipts) payload += `${JSON.stringify(r)}\n`;
  return sha256Hex(payload);
}

/**
 * The six roles the service's work divides into. Every receipt carries one, so
 * an evidence bundle can be read as "who did what" and not only "what
 * happened":
 *
 *   scout    a source: fetching a listing, a feed, an article, a document
 *   reader   the model stage: a call, a cache hit, a refusal to call
 *   verifier a check on what was read: a contact, a closing date, a licence
 *   desk     the register and the digest: what the owner is actually handed
 *   owner    the owner's own lane: his commands, his WhatsApp, his statuses
 *   auditor  the bundle's own bookkeeping: the run record and the seal
 *
 * The role is derived from the receipt type unless the caller states one, and a
 * caller that states one (the tool layer does, per tool) always wins.
 */
export const RECEIPT_ROLES = ['scout', 'reader', 'verifier', 'desk', 'owner', 'auditor'];

const ROLE_BY_TYPE = {
  'run.created': 'auditor',
  'evidence.sealed': 'auditor',
  'leads.upserted': 'desk',
  'lead.status_changed': 'owner',
  // An order is the desk's business: it arrives at the register, it is not
  // scouted and it is not the owner's own command.
  'lead.won': 'desk',
  // The openings lane is two jobs under one prefix. Reading the article is
  // scouting; deciding whether what came back is a real requirement with a real
  // contact on the organisation's own site is verification.
  'openings.not_a_requirement': 'verifier',
  'openings.no_site': 'verifier',
  'openings.contact_search': 'verifier',
  'openings.upgraded': 'verifier',
};

const ROLE_BY_PREFIX = [
  ['source.', 'scout'],
  ['openings.', 'scout'],
  ['llm.', 'reader'],
  ['digest.', 'desk'],
  ['order.', 'desk'],
  ['whatsapp.', 'owner'],
  ['owner.', 'owner'],
];

/** The role a receipt of this type belongs to. Never throws; defaults to auditor. */
export function roleForReceipt(type) {
  const t = String(type || '');
  if (ROLE_BY_TYPE[t]) return ROLE_BY_TYPE[t];
  for (const [prefix, role] of ROLE_BY_PREFIX) if (t.startsWith(prefix)) return role;
  return 'auditor';
}

export class ReceiptChain {
  constructor(runId, schema = EVIDENCE_SCHEMA) {
    this.runId = runId;
    this.schema = schema;
    this.receipts = [];
  }

  add(type, data = {}) {
    const { role, ...rest } = data;
    const receipt = {
      seq: this.receipts.length,
      type,
      at: new Date().toISOString(),
      role: role || roleForReceipt(type),
      ...rest,
    };
    this.receipts.push(receipt);
    return receipt;
  }

  /** Append the terminal receipt and return the sealed bundle object. */
  seal() {
    this.add('evidence.sealed', { runId: this.runId, receiptCount: this.receipts.length });
    return {
      schema: this.schema,
      runId: this.runId,
      sealedAt: new Date().toISOString(),
      receiptCount: this.receipts.length,
      hash: bundleHash(this.receipts, this.schema),
      receipts: this.receipts,
    };
  }
}

/** Recompute a stored bundle's hash and compare it with the recorded one. */
export function verifyBundle(bundle) {
  const problems = [];
  if (!bundle || typeof bundle !== 'object') return { ok: false, problems: ['not an object'] };
  if (typeof bundle.schema !== 'string') problems.push('missing schema');
  if (!Array.isArray(bundle.receipts)) return { ok: false, problems: ['missing receipts array'] };
  if (bundle.receiptCount !== bundle.receipts.length) {
    problems.push(`receiptCount ${bundle.receiptCount} != receipts.length ${bundle.receipts.length}`);
  }
  bundle.receipts.forEach((r, i) => {
    if (r.seq !== i) problems.push(`receipt ${i} has seq ${r.seq}`);
  });
  const recomputed = bundleHash(bundle.receipts, bundle.schema);
  if (recomputed !== bundle.hash) {
    problems.push(`hash mismatch: recorded ${bundle.hash} recomputed ${recomputed}`);
  }
  return { ok: problems.length === 0, recomputed, problems };
}

/**
 * Append receipts to a per-day bundle and reseal it.
 *
 * A run has a bundle of its own. Everything that happens outside a run - the
 * WhatsApp webhook, a tool an agent called - still has to leave a verifiable
 * trail, so it goes into one bundle per day per kind: `webhook_<date>`,
 * `tools_<date>`. The receipts already in the file keep their sequence numbers,
 * so an appended bundle verifies with tools/verify.mjs exactly as a run bundle
 * does.
 */
export async function appendDayBundle(runId, entries, { runsDir, schema = EVIDENCE_SCHEMA } = {}) {
  if (!entries || !entries.length) return null;
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const dir = runsDir || (await import('./paths.mjs')).RUNS_DIR;
  const file = path.join(dir, `${runId}.evidence.json`);
  let existing = [];
  try {
    const prior = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(prior.receipts)) existing = prior.receipts;
  } catch {
    existing = [];
  }
  const chain = new ReceiptChain(runId, schema);
  chain.receipts = existing;
  for (const e of entries) chain.add(e.type, e.data || {});
  const bundle = chain.seal();
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return { file, bundle };
}
