// The tool layer.
//
// Everything an agent is allowed to do to this project is one of the tools
// below, and every one of them leaves a receipt. That is the whole point: the
// pipeline was already a set of functions, but a function has no schema, no
// cost label, no gate and no record of having been called. A tool has all four.
//
// Each tool declares:
//
//   kind   read | write | network | model - what it does to the world
//   cost   free | metered - whether calling it can spend money
//   role   scout | reader | verifier | desk | owner | auditor - whose job this
//          is, written onto every receipt the call leaves, so a bundle can be
//          read as who did what and not only as what happened
//   schemas  JSON Schema for the input and the output, so a caller that has
//            never seen this codebase can call it correctly and a caller that
//            gets it wrong is refused before the handler runs
//
// Two of them are gated. `leads.set_status` writes to the register and
// `owner.message` sends a WhatsApp message, and both refuse unless the caller
// is the owner (`ctx.actor === 'owner'`) or the pipeline itself
// (`ctx.system === true`). Over MCP the actor comes from RADAR_MCP_ACTOR, which
// defaults to `agent`, so a model driving this server can read everything and
// change nothing.
//
// `owner.message` has one more rule that is not a gate but a wall: the only
// recipient it can reach is RADAR_TO_WA, the owner's own number. There is no
// input field for a recipient. A buyer is never reachable from this codebase,
// and adding a way to reach one would mean rewriting this file, not configuring
// it.

import { sha256Hex } from '../lib/hash.mjs';
import { appendDayBundle, RECEIPT_ROLES } from '../lib/receipts.mjs';
import { RUNS_DIR } from '../lib/paths.mjs';
import { todayIso, STATUSES, KINDS, SEGMENTS, normaliseCity } from '../lib/normalise.mjs';
import { validate } from './schema.mjs';
import { filterLeads, setLeadStatus } from '../register.mjs';
import { renderDigest, renderPriceSheet } from '../digest.mjs';
import { createPageFetcher } from '../llm/page.mjs';
import { createCrawler } from '../lib/crawl.mjs';
import { pdfToText, looksLikePdf } from '../lib/pdf-text.mjs';
import { extractContacts } from '../lib/contacts.mjs';
import { catalogueItems } from '../lib/catalogue.mjs';
import { sendWhatsAppText } from '../deliver.mjs';
import { llmSettings } from '../llm/settings.mjs';
import { createRunner } from '../llm/stage.mjs';
import { loadPrompt } from '../llm/prompts.mjs';
import { enrichInput, parseEnrich } from '../llm/enrich.mjs';
import { requirementInput, parseRequirement } from '../llm/requirement.mjs';
import { ENRICH_MAX_TOKENS } from '../llm/stage.mjs';
import { REQUIREMENT_MAX_TOKENS } from '../llm/limits.mjs';
import { needsModel } from '../llm/needs.mjs';
import { CITIES } from '../config.mjs';
import { SOURCES, SOURCE_NAMES } from '../sources/all.mjs';

export const KINDS_OF_TOOL = ['read', 'write', 'network', 'model'];
export const COSTS = ['free', 'metered'];

/** Tools that refuse anybody who is not the owner or the pipeline itself. */
export const OWNER_ONLY = ['leads.set_status', 'owner.message'];

// ------------------------------------------------------------------ receipts

function hashOf(value) {
  if (value === undefined) return null;
  try {
    return sha256Hex(JSON.stringify(value) ?? 'null').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * A receipts sink for tools called outside a run: one bundle per day,
 * `runs/tools_<date>.evidence.json`, appended to and resealed, verified with
 * tools/verify.mjs exactly as a run bundle is.
 */
export function dayReceipts({ runsDir = RUNS_DIR, date = todayIso() } = {}) {
  const pending = [];
  return {
    runId: `tools_${date}`,
    add(type, data = {}) {
      const entry = { type, data };
      pending.push(entry);
      return entry;
    },
    async flush() {
      if (!pending.length) return null;
      return appendDayBundle(`tools_${date}`, pending.splice(0), { runsDir });
    },
  };
}

// ------------------------------------------------------------------ helpers

/** A lead as a tool hands it back: the register's fields, nothing computed. */
function leadView(lead) {
  const extra = lead.extra || {};
  return {
    id: lead.id,
    kind: lead.kind,
    segment: lead.segment,
    segment_source: lead.segment_source ?? null,
    segment_model: lead.segment_model ?? null,
    name: lead.name,
    city: lead.city ?? null,
    state: lead.state ?? null,
    address: lead.address ?? null,
    phone: lead.phone ?? null,
    email: lead.email ?? null,
    website: lead.website ?? null,
    why_now: lead.why_now ?? null,
    source: lead.source,
    source_url: lead.source_url ?? null,
    licence: lead.licence ?? null,
    first_seen: lead.first_seen ?? null,
    last_seen: lead.last_seen ?? null,
    score: lead.score ?? 0,
    status: lead.status,
    notes: lead.notes ?? null,
    requirement: extra.requirement ?? null,
    quantity: extra.quantity ?? null,
    deadline: extra.deadline ?? null,
    contact_name: extra.contact_name ?? null,
    contact_phone: extra.contact_phone ?? null,
    contact_email: extra.contact_email ?? null,
    document_url: extra.document_url ?? null,
  };
}

function matchesQuery(lead, query) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  if (String(lead.name || '').toLowerCase().includes(q)) return true;
  if (String((lead.extra || {}).requirement || '').toLowerCase().includes(q)) return true;
  if (digits.length >= 4 && String(lead.phone || '').replace(/\D/g, '').includes(digits)) return true;
  return false;
}

function requireStore(ctx, name) {
  if (!ctx || !ctx.store) throw new Error(`${name} needs a store on the context`);
  return ctx.store;
}

const LEAD_OUT = {
  type: 'object',
  description: 'One register row. Nothing here is computed at read time.',
};

// ------------------------------------------------------------------ the tools

export const TOOLS = [
  {
    name: 'leads.search',
    role: 'desk',
    kind: 'read',
    cost: 'free',
    description:
      'Search the lead register. Filters are ANDed; query matches the trading name, the requirement text or the phone digits. Returns the highest-scoring matches first.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: STATUSES, description: 'new, contacted, quoted, won, lost or ignored' },
        segment: { type: 'string', enum: SEGMENTS },
        city: { type: 'string', description: 'City name or key; matched loosely' },
        kind: { type: 'string', enum: KINDS },
        query: { type: 'string', maxLength: 200, description: 'Free text: trading name, requirement text, or phone digits' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 20 },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        matched: { type: 'integer' },
        total: { type: 'integer' },
        leads: { type: 'array', items: LEAD_OUT },
      },
    },
    async handler(input, ctx) {
      const store = requireStore(ctx, 'leads.search');
      const all = await store.allLeads();
      const filtered = filterLeads(all, {
        status: input.status,
        city: input.city,
        kind: input.kind,
        segment: input.segment,
      }).filter((l) => matchesQuery(l, input.query));
      return {
        count: Math.min(input.limit, filtered.length),
        matched: filtered.length,
        total: all.length,
        leads: filtered.slice(0, input.limit).map(leadView),
      };
    },
  },

  {
    name: 'leads.get',
    role: 'desk',
    kind: 'read',
    cost: 'free',
    description: 'One lead by its register id. Returns found:false rather than an error when there is no such lead.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
    },
    outputSchema: {
      type: 'object',
      properties: { found: { type: 'boolean' }, lead: { type: ['object', 'null'] } },
    },
    async handler(input, ctx) {
      const store = requireStore(ctx, 'leads.get');
      const lead = await store.getLead(input.id);
      return { found: Boolean(lead), lead: lead ? leadView(lead) : null };
    },
  },

  {
    name: 'leads.set_status',
    role: 'owner',
    kind: 'write',
    cost: 'free',
    ownerOnly: true,
    description:
      "Move a lead's status and append a dated note. OWNER ONLY. Writes the same note, the same receipt and the same event as the register CLI, because it calls the same function. ref accepts an R<n>/L<n>/G<n> label from the latest digest, or a raw lead id.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: {
        ref: { type: 'string', minLength: 1, maxLength: 64, description: 'R<n>, L<n>, G<n> or a lead id' },
        id: { type: 'string', minLength: 1, maxLength: 64, description: 'A lead id. Same thing as ref; one of the two is required.' },
        status: { type: 'string', enum: STATUSES },
        note: { type: ['string', 'null'], maxLength: 240, default: null },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        note: { type: ['string', 'null'] },
        resolvedVia: { type: 'string' },
        receiptHash: { type: 'string' },
        receiptFile: { type: 'string' },
      },
    },
    async handler(input, ctx) {
      const store = requireStore(ctx, 'leads.set_status');
      const ref = input.ref || input.id;
      if (!ref) throw new Error('leads.set_status needs ref or id');
      const result = await setLeadStatus(store, {
        ref,
        status: input.status,
        note: input.note,
        ...(ctx.digestsDir ? { digestsDir: ctx.digestsDir } : {}),
        ...(ctx.runsDir ? { runsDir: ctx.runsDir } : {}),
      });
      return {
        id: result.id,
        name: result.after.name,
        from: result.before.status,
        to: input.status,
        note: result.receipt.note,
        resolvedVia: result.receipt.resolvedVia,
        receiptHash: result.bundle.hash,
        receiptFile: result.file,
      };
    },
  },

  {
    name: 'prices.get',
    role: 'desk',
    kind: 'read',
    cost: 'free',
    description:
      'Mandi prices already in the store, newest first. Nothing is fetched and nothing is invented: an item with no stored reading is reported as having none.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          maxItems: 40,
          items: { type: 'string', maxLength: 60 },
          description: 'Catalogue ids (peeled-garlic) or Agmarknet commodity names (Garlic). Omit for the whole catalogue.',
        },
        state: { type: 'string', maxLength: 60 },
        days: { type: 'integer', minimum: 1, maximum: 90, default: 14 },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer' },
        from: { type: 'string' },
        rows: { type: 'array', items: { type: 'object' } },
        withoutReading: { type: 'array', items: { type: 'string' } },
      },
    },
    async handler(input, ctx) {
      const store = requireStore(ctx, 'prices.get');
      const now = ctx.now ? new Date(ctx.now()) : new Date();
      const from = new Date(now.getTime() - input.days * 86400000).toISOString().slice(0, 10);
      const wanted = new Set((input.items || []).map((s) => String(s).toLowerCase()));

      const catalogue = catalogueItems();
      const commodityOf = new Map(catalogue.map((c) => [c.id.toLowerCase(), c.commodity]));
      const wantedCommodities = wanted.size
        ? new Set(
            [...wanted]
              .map((w) => (commodityOf.has(w) ? commodityOf.get(w) : w))
              .filter(Boolean)
              .map((c) => String(c).toLowerCase())
          )
        : null;

      const rows = [];
      const seenCommodity = new Set();
      for (const lead of await store.allLeads()) {
        if (lead.kind !== 'price') continue;
        const e = lead.extra || {};
        const date = e.arrivalDate && /^\d{4}-\d{2}-\d{2}$/.test(e.arrivalDate) ? e.arrivalDate : e.whyNowDate;
        if (!e.commodity || !date || date < from) continue;
        if (input.state && lead.state && lead.state !== input.state) continue;
        if (wantedCommodities && !wantedCommodities.has(String(e.commodity).toLowerCase())) continue;
        seenCommodity.add(String(e.commodity).toLowerCase());
        rows.push({
          commodity: e.commodity,
          variety: e.variety ?? null,
          market: e.market ?? null,
          district: lead.city ?? null,
          state: lead.state ?? null,
          date,
          minPrice: e.minPrice ?? null,
          maxPrice: e.maxPrice ?? null,
          modalPrice: e.modalPrice ?? null,
          unit: e.unit || 'INR per quintal',
          source_url: lead.source_url ?? null,
        });
      }
      rows.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : a.commodity.localeCompare(b.commodity)));

      const withoutReading = [];
      for (const item of catalogue) {
        if (wanted.size && !wanted.has(item.id.toLowerCase()) && !(item.commodity && wanted.has(item.commodity.toLowerCase()))) continue;
        if (!item.commodity) withoutReading.push(`${item.label}: Agmarknet carries no line for it`);
        else if (!seenCommodity.has(item.commodity.toLowerCase())) withoutReading.push(`${item.label}: no stored reading in the last ${input.days} days`);
      }
      return { days: input.days, from, rows, withoutReading };
    },
  },

  {
    name: 'web.fetch',
    role: 'scout',
    kind: 'network',
    cost: 'free',
    description:
      "Fetch one page as text, obeying that host's robots.txt, one request every two seconds per host, 300 KB cap. A page robots.txt disallows comes back ok:false with the rule as the reason - there is no flag that overrides it.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: { url: { type: 'string', minLength: 8, maxLength: 2000 } },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        url: { type: 'string' },
        text: { type: ['string', 'null'] },
        title: { type: ['string', 'null'] },
        chars: { type: ['integer', 'null'] },
        reason: { type: ['string', 'null'] },
      },
    },
    async handler(input, ctx) {
      const pages = ctx.pageFetcher || createPageFetcher({ fetchImpl: ctx.fetch });
      const page = await pages.fetchText(input.url);
      return {
        ok: Boolean(page.ok),
        url: page.url || input.url,
        text: page.ok ? page.text : null,
        title: page.title || null,
        chars: page.ok ? page.text.length : null,
        reason: page.ok ? null : page.reason,
      };
    },
  },

  {
    name: 'contacts.extract',
    role: 'verifier',
    kind: 'read',
    cost: 'free',
    description:
      'Read Indian phone numbers, emails and the person or role a "Contact Person:" block names out of text. Deterministic, no network, no model - the same readers the demand lane uses.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', maxLength: 200000 } },
    },
    outputSchema: {
      type: 'object',
      properties: {
        phone: { type: ['string', 'null'] },
        phones: { type: 'array', items: { type: 'string' } },
        email: { type: ['string', 'null'] },
        emails: { type: 'array', items: { type: 'string' } },
        name: { type: ['string', 'null'] },
        nameKind: { type: ['string', 'null'] },
        complete: { type: 'boolean' },
      },
    },
    async handler(input) {
      return extractContacts(input.text);
    },
  },

  {
    name: 'pdf.text',
    role: 'scout',
    kind: 'network',
    cost: 'free',
    description:
      'Pull the text out of a PDF, from a URL (fetched under robots.txt and the 2 MB cap) or from base64 bytes. A scanned page comes back ok:false with reason "unreadable" - it is never an empty string pretending to be a document.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', minLength: 8, maxLength: 2000 },
        bytes: { type: 'string', maxLength: 8000000, description: 'base64 of the PDF, as an alternative to url' },
        maxChars: { type: 'integer', minimum: 100, maximum: 200000, default: 20000 },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        text: { type: ['string', 'null'] },
        chars: { type: ['integer', 'null'] },
        streams: { type: ['integer', 'null'] },
        decoded: { type: ['integer', 'null'] },
        url: { type: ['string', 'null'] },
        reason: { type: ['string', 'null'] },
      },
    },
    async handler(input, ctx) {
      if (!input.url && !input.bytes) throw new Error('pdf.text needs url or bytes');
      if (input.url && input.bytes) throw new Error('pdf.text takes url or bytes, not both');
      if (input.bytes) {
        const buf = Buffer.from(input.bytes, 'base64');
        if (!looksLikePdf(buf)) return { ok: false, text: null, chars: null, url: null, reason: 'the bytes are not a PDF' };
        const parsed = pdfToText(buf, { maxChars: input.maxChars });
        return parsed.ok
          ? { ok: true, text: parsed.text, chars: parsed.text.length, streams: parsed.streams ?? null, decoded: parsed.decoded ?? null, url: null, reason: null }
          : { ok: false, text: null, chars: null, url: null, reason: parsed.reason, detail: parsed.detail || null };
      }
      const crawler = ctx.crawler || createCrawler({ fetchImpl: ctx.fetch });
      const doc = await crawler.fetchDoc(input.url);
      if (!doc.ok) return { ok: false, text: null, chars: null, url: doc.url || input.url, reason: doc.reason };
      if (doc.kind !== 'pdf') return { ok: false, text: null, chars: null, url: doc.url, reason: `not a PDF: ${doc.kind}` };
      return { ok: true, text: doc.text, chars: doc.text.length, streams: doc.streams ?? null, decoded: doc.decoded ?? null, url: doc.url, reason: null };
    },
  },

  {
    name: 'source.run',
    role: 'scout',
    kind: 'network',
    cost: 'free',
    description:
      'Run one source module for one city and report what it returned. Candidates are NOT written to the register - that is what the pipeline does. A source that is blocked reports the block rather than an empty result.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', enum: SOURCE_NAMES },
        city: { type: 'string', enum: Object.keys(CITIES), default: 'bengaluru' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        city: { type: 'string' },
        candidates: { type: 'integer' },
        ms: { type: 'integer' },
        blocked: { type: ['object', 'null'] },
        detail: { type: ['object', 'null'] },
        sample: { type: 'array', items: { type: 'object' } },
      },
    },
    async handler(input, ctx) {
      const mod = SOURCES[input.name];
      const city = CITIES[input.city];
      const t0 = Date.now();
      const result = await mod.fetch({
        city,
        limit: input.limit,
        log: ctx.log || (() => {}),
        env: ctx.env || process.env,
        fetchImpl: ctx.fetch,
        todayIsoDate: todayIso(),
      });
      const got = (result.candidates || []).slice(0, input.limit);
      return {
        source: input.name,
        city: city.key,
        candidates: got.length,
        ms: Date.now() - t0,
        blocked: result.blocked || null,
        detail: result.detail || null,
        sample: got.slice(0, 5).map((c) => ({ kind: c.kind, name: c.name, city: c.city, phone: c.phone ?? null, source_url: c.sourceUrl ?? null })),
      };
    },
  },

  {
    name: 'digest.render',
    role: 'desk',
    kind: 'read',
    cost: 'free',
    description:
      'Render the morning digest from what is already in the store. Composes text and writes nothing, sends nothing and calls no model.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', maxLength: 10, description: 'ISO date; defaults to today' },
        city: { type: 'string', maxLength: 60, description: 'City display name, to head the digest with' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        text: { type: 'string' },
        full: { type: 'string' },
        priceSheet: { type: 'string' },
        index: { type: 'object' },
        shown: { type: 'integer' },
        considered: { type: 'integer' },
        requirementsShown: { type: 'integer' },
        requirementsWithContact: { type: 'integer' },
      },
    },
    async handler(input, ctx) {
      const store = requireStore(ctx, 'digest.render');
      const date = input.date || todayIso();
      const all = await store.allLeads();
      const prices = all.filter((l) => l.kind === 'price');
      const buyers = all.filter((l) => l.kind !== 'price');
      const cityName = input.city
        ? Object.values(CITIES).find((c) => normaliseCity(c.name) === normaliseCity(input.city))?.name || input.city
        : null;
      const result = renderDigest(buyers, { date, city: cityName, prices });
      const state = cityName ? Object.values(CITIES).find((c) => c.name === cityName)?.agmarknetState || null : null;
      return {
        date,
        text: result.text,
        full: result.full,
        priceSheet: renderPriceSheet(prices, { date, state }),
        index: result.index,
        shown: result.shown,
        considered: result.considered,
        requirementsShown: result.requirementsShown,
        requirementsWithContact: result.withContact,
      };
    },
  },

  {
    name: 'owner.message',
    role: 'owner',
    kind: 'write',
    cost: 'free',
    ownerOnly: true,
    description:
      "Send one WhatsApp text to the OWNER'S OWN number, the one in RADAR_TO_WA. OWNER ONLY. There is no recipient field: this tool cannot reach anybody else, and a buyer is never reachable from this codebase.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', minLength: 1, maxLength: 4096 } },
    },
    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        to: { type: ['string', 'null'] },
        chars: { type: 'integer' },
        trimmed: { type: 'boolean' },
        reason: { type: ['string', 'null'] },
      },
    },
    async handler(input, ctx) {
      const env = ctx.env || process.env;
      const to = env.RADAR_TO_WA || '';
      if (!to) return { sent: false, to: null, chars: input.text.length, trimmed: false, reason: 'not sent: RADAR_TO_WA unset' };
      const result = await sendWhatsAppText({ to, text: input.text, env, fetchImpl: ctx.fetch });
      return {
        sent: Boolean(result.sent),
        // The owner's own number, redacted to its last four digits: a receipt
        // should say where a message went, not carry the number around.
        to: `…${String(to).replace(/\D/g, '').slice(-4)}`,
        chars: result.chars ?? input.text.length,
        trimmed: Boolean(result.trimmed),
        reason: result.reason || null,
      };
    },
  },

  {
    name: 'model.read',
    role: 'reader',
    kind: 'model',
    cost: 'metered',
    description:
      'Ask the model to read text, through the same cache, the same daily budget and the same receipts the pipeline uses. Pass a lead and the "model only when needed" rules are applied first: a call the rules say is unnecessary is refused free of charge, with the reason.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['purpose', 'text'],
      properties: {
        purpose: { type: 'string', enum: ['enrich', 'requirement'] },
        text: { type: 'string', minLength: 1, maxLength: 200000 },
        name: { type: ['string', 'null'], maxLength: 200, default: null },
        city: { type: ['string', 'null'], maxLength: 80, default: null },
        url: { type: ['string', 'null'], maxLength: 2000, default: null },
        headline: { type: ['string', 'null'], maxLength: 300, default: null },
        leadId: { type: ['string', 'null'], maxLength: 64, default: null, description: 'Apply the "model only when needed" rules against this lead before spending anything' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        purpose: { type: 'string' },
        promptVersion: { type: ['string', 'null'] },
        answer: { type: ['object', 'null'] },
        cacheHit: { type: 'boolean' },
        needed: { type: 'boolean' },
        reason: { type: ['string', 'null'] },
      },
    },
    async handler(input, ctx) {
      const env = ctx.env || process.env;
      const settings = llmSettings(env);
      if (!settings.enabled) {
        return { ok: false, purpose: input.purpose, promptVersion: null, answer: null, cacheHit: false, needed: false, reason: `the model stage is off: ${settings.reason}` };
      }
      const store = requireStore(ctx, 'model.read');
      const prompt = loadPrompt(input.purpose);

      if (input.leadId) {
        const lead = await store.getLead(input.leadId);
        if (!lead) throw new Error(`lead not found: ${input.leadId}`);
        const decision =
          input.purpose === 'enrich'
            ? needsModel('enrich', lead, { hasText: Boolean(input.text), cacheHit: false, cutoff: 0 })
            : needsModel('requirement', lead, { hasText: Boolean(input.text), deterministic: deterministicReads(input.text) });
        if (!decision.needed) {
          ctx.receipts?.add?.('llm.not_needed', { purpose: input.purpose, leadId: lead.id, reason: decision.reason });
          return { ok: false, purpose: input.purpose, promptVersion: prompt.version, answer: null, cacheHit: false, needed: false, reason: decision.reason };
        }
      }

      const runner = ctx.runner || createRunner({ store, chain: ctx.receipts || undefined, settings, day: todayIso(), fetchImpl: ctx.fetch, env });
      const answer =
        input.purpose === 'enrich'
          ? await runner.ask({
              purpose: 'enrich',
              prompt,
              input: enrichInput({ name: input.name, city: input.city, url: input.url, text: input.text }),
              maxTokens: ENRICH_MAX_TOKENS,
              jsonMode: true,
              parse: parseEnrich,
            })
          : await runner.ask({
              purpose: 'requirement',
              prompt,
              input: requirementInput({ headline: input.headline, city: input.city, url: input.url, text: input.text }),
              maxTokens: REQUIREMENT_MAX_TOKENS,
              jsonMode: true,
              parse: parseRequirement,
            });
      return {
        ok: Boolean(answer.ok),
        purpose: input.purpose,
        promptVersion: prompt.version,
        answer: answer.ok ? answer.value : null,
        cacheHit: Boolean(answer.cacheHit),
        needed: true,
        reason: answer.ok ? null : `${answer.reason}${answer.detail ? `: ${answer.detail}` : ''}`,
      };
    },
  },
];

/** What the deterministic readers find in a notice text, for the requirement rule. */
function deterministicReads(text) {
  const contacts = extractContacts(text);
  return { quantity: null, deadline: null, contact: contacts.complete };
}

// A tool whose role is not one of the six is a programming error, and it is
// caught at import time rather than found later in a bundle.
for (const t of TOOLS) {
  if (!RECEIPT_ROLES.includes(t.role)) {
    throw new Error(`tool ${t.name} declares role ${JSON.stringify(t.role)}, which is not one of ${RECEIPT_ROLES.join(', ')}`);
  }
}

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name) {
  return BY_NAME.get(String(name)) || null;
}

/** Every tool, as a caller sees it: no handlers, schemas intact. */
export function listTools() {
  return TOOLS.map(({ name, description, kind, cost, role, inputSchema, outputSchema, ownerOnly }) => ({
    name,
    description,
    kind,
    cost,
    role,
    ownerOnly: Boolean(ownerOnly),
    inputSchema,
    outputSchema,
  }));
}

/** Is this caller allowed to run this tool? */
export function allowed(tool, ctx = {}) {
  if (!tool.ownerOnly) return { ok: true };
  if (ctx.system === true) return { ok: true };
  if (ctx.actor === 'owner') return { ok: true };
  return {
    ok: false,
    reason: `${tool.name} is owner-only and the caller is ${JSON.stringify(ctx.actor || 'agent')}. Set RADAR_MCP_ACTOR=owner to call it, which is the owner saying so in his own environment.`,
  };
}

/**
 * Call one tool.
 *
 * The order is fixed and every step of it is receipted: find the tool, validate
 * the input against its schema, check the gate, run the handler, write a
 * `tool.call` receipt with the input and output hashes and how long it took.
 * A refusal writes `tool.refused` instead, so a gate that fired is as visible in
 * the evidence as a call that ran.
 *
 * It never throws for an ordinary failure: the result is { ok, output, error }.
 */
export async function callTool(name, rawInput = {}, ctx = {}) {
  const started = Date.now();
  const tool = getTool(name);
  const ownReceipts = ctx.receipts ? null : dayReceipts({ runsDir: ctx.runsDir });
  const receipts = ctx.receipts || ownReceipts;
  const finish = async (result) => {
    if (ownReceipts) await ownReceipts.flush();
    return result;
  };

  if (!tool) {
    receipts.add('tool.call', {
      name: String(name),
      kind: null,
      role: 'auditor',
      ms: Date.now() - started,
      ok: false,
      inputHash: hashOf(rawInput),
      outputHash: null,
      error: `unknown tool: ${name}`,
    });
    return finish({ ok: false, output: null, error: `unknown tool: ${name}` });
  }

  const checked = validate(rawInput ?? {}, tool.inputSchema);
  if (!checked.ok) {
    const error = `invalid input for ${tool.name}: ${checked.errors.join('; ')}`;
    receipts.add('tool.call', {
      name: tool.name,
      kind: tool.kind,
      role: tool.role,
      ms: Date.now() - started,
      ok: false,
      inputHash: hashOf(rawInput),
      outputHash: null,
      error,
    });
    return finish({ ok: false, output: null, error, errors: checked.errors });
  }

  const gate = allowed(tool, ctx);
  if (!gate.ok) {
    receipts.add('tool.refused', {
      name: tool.name,
      kind: tool.kind,
      role: tool.role,
      actor: ctx.actor || 'agent',
      reason: gate.reason,
      inputHash: hashOf(checked.value),
    });
    return finish({ ok: false, output: null, error: gate.reason, refused: true });
  }

  try {
    const output = await tool.handler(checked.value, { ...ctx, receipts });
    receipts.add('tool.call', {
      name: tool.name,
      kind: tool.kind,
      role: tool.role,
      ms: Date.now() - started,
      ok: true,
      inputHash: hashOf(checked.value),
      outputHash: hashOf(output),
    });
    return finish({ ok: true, output, error: null });
  } catch (err) {
    const error = `${err.name}: ${err.message}`;
    receipts.add('tool.call', {
      name: tool.name,
      kind: tool.kind,
      role: tool.role,
      ms: Date.now() - started,
      ok: false,
      inputHash: hashOf(checked.value),
      outputHash: null,
      error,
    });
    return finish({ ok: false, output: null, error });
  }
}
