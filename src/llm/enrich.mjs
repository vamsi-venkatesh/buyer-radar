// The enrich answer: its shape, how a model's reply is read into it, and how it
// is applied to a lead. Kept apart from the plumbing so the evaluation harness
// can use exactly the same input builder and the same validator the pipeline
// uses - an eval that scores a different contract scores nothing.

import { SEGMENTS } from '../lib/normalise.mjs';

export const SEGMENT_VALUES = SEGMENTS;
export const SIZE_VALUES = ['small', 'medium', 'large', 'unknown'];

/** The text the model is asked to read. One builder, used by the pipeline and the eval. */
export function enrichInput({ name = null, city = null, url = null, text = '' }) {
  const head = [
    name ? `Record name: ${name}` : null,
    city ? `Record city: ${city}` : null,
    url ? `Page URL: ${url}` : null,
  ].filter(Boolean);
  return `${head.join('\n')}\n\nPage text:\n${String(text).trim()}`.trim();
}

function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n).trimEnd();
}

/** Pull a JSON object out of a reply that may be fenced or have prose around it. */
export function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = [fenced ? fenced[1].trim() : null, raw].filter(Boolean);
  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch {
      const first = c.indexOf('{');
      const last = c.lastIndexOf('}');
      if (first !== -1 && last > first) {
        try {
          return { ok: true, value: JSON.parse(c.slice(first, last + 1)) };
        } catch {
          /* fall through to the next candidate */
        }
      }
    }
  }
  return { ok: false, reason: 'reply is not JSON' };
}

/**
 * Read a reply into the enrich answer.
 *
 * A reply that is not JSON, or that is missing the fields the score depends on
 * (`segment`, `size`, `confidence`), is malformed: the caller gets one repair
 * attempt and then gives up. Values that are present but out of range are
 * clamped rather than rejected - a confidence of 1.4 is a model being sloppy
 * about a number, not a model that failed to answer, and clamping it down can
 * only ever reduce the weight its answer carries.
 */
export function parseEnrich(text) {
  const parsed = extractJson(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, malformed: true };
  const v = parsed.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, reason: 'reply is not a JSON object', malformed: true };
  }

  const problems = [];
  if (typeof v.segment !== 'string') problems.push('segment is missing or not a string');
  if (typeof v.size !== 'string') problems.push('size is missing or not a string');
  if (typeof v.confidence !== 'number' || Number.isNaN(v.confidence)) problems.push('confidence is missing or not a number');
  if (v.segment && !SEGMENT_VALUES.includes(v.segment)) problems.push(`segment "${clip(v.segment, 40)}" is not one of the listed values`);
  if (v.size && !SIZE_VALUES.includes(v.size)) problems.push(`size "${clip(v.size, 40)}" is not one of the listed values`);
  if (problems.length) return { ok: false, reason: problems.join('; '), malformed: true, problems };

  const deadline = isIsoDate(v.deadline) ? v.deadline : null;
  return {
    ok: true,
    value: {
      segment: v.segment,
      size: v.size,
      buys: Array.isArray(v.buys) ? v.buys.filter((b) => typeof b === 'string' && b.trim()).slice(0, 8).map((b) => clip(b, 60)) : [],
      quantity: typeof v.quantity === 'string' && v.quantity.trim() ? clip(v.quantity, 120) : null,
      deadline,
      deadlineDropped: v.deadline != null && deadline === null ? clip(v.deadline, 40) : null,
      evidence: Array.isArray(v.evidence)
        ? v.evidence.filter((e) => typeof e === 'string' && e.trim()).slice(0, 4).map((e) => clip(e, 120))
        : [],
      confidence: Math.max(0, Math.min(1, Number(v.confidence))),
    },
  };
}

/**
 * Write one enrich answer onto a lead.
 *
 * The source-derived segment is never overwritten. `segment_model` is a second
 * opinion stored beside it; which one the score uses is decided in
 * src/model.mjs, by confidence, and nowhere else.
 */
export function applyEnrichment(lead, value, meta = {}) {
  lead.segment_source = lead.segment_source || lead.segment;
  lead.segment_model = value.segment;
  lead.extra = {
    ...lead.extra,
    llm: {
      segment: value.segment,
      size: value.size,
      buys: value.buys,
      quantity: value.quantity,
      deadline: value.deadline,
      evidence: value.evidence,
      confidence: value.confidence,
      promptVersion: meta.promptVersion || null,
      provider: meta.provider || null,
      model: meta.model || null,
      sourceUrl: meta.sourceUrl || null,
      // The page's own <title>. Kept because it is a concrete fact the opener
      // can be built on, which is one of the things the "model only when
      // needed" rules ask about before paying for a line.
      pageTitle: meta.pageTitle || null,
      at: meta.at || new Date().toISOString(),
      cacheHit: Boolean(meta.cacheHit),
    },
  };
  return lead;
}

/** The follow-up sent after a malformed reply. One attempt, then we stop asking. */
export function repairMessage(reason) {
  return [
    `Your previous reply could not be read: ${reason}.`,
    'Reply again with the JSON object only - no prose, no code fence, no trailing text.',
    'Every field listed in the instructions must be present, and "segment" and "size" must be one of the exact values listed.',
  ].join(' ');
}
