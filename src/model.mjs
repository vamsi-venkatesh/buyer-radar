import { leadId } from './lib/hash.mjs';
import {
  normalisePhone,
  normaliseEmail,
  normaliseWebsite,
  normaliseName,
  normaliseCity,
  segmentLabel,
  daysBetween,
  tidy,
  STATUSES,
} from './lib/normalise.mjs';
import { BUSINESS, CLIENT } from './config.mjs';

/**
 * A Candidate is what a source returns. A Lead is the normalised, scored,
 * de-duplicated record the register stores.
 *
 * Candidate {
 *   kind, segment, name, city, state, address, phone, email, website,
 *   whyNow, whyNowDate, source, sourceUrl, licence, externalId, extra
 * }
 */

/**
 * The fields a demand-lane candidate carries beyond a plain buyer. They are
 * stored inside `extra` under these exact names, so a requirement read off a
 * tender PDF and one read off a news article describe themselves identically
 * and the digest has one shape to render.
 */
export const REQUIREMENT_FIELDS = [
  'requirement',
  'quantity',
  'deadline',
  'contact_name',
  'contact_phone',
  'contact_email',
  'document_url',
];

function requirementExtra(candidate) {
  const out = {};
  for (const field of REQUIREMENT_FIELDS) {
    if (candidate[field] !== undefined) out[field] = candidate[field] ?? null;
  }
  return out;
}

export function toLead(candidate, { nowIso = new Date().toISOString() } = {}) {
  const id = leadId(candidate.source, candidate.externalId);
  return {
    id,
    kind: candidate.kind || 'buyer',
    segment: candidate.segment || 'other',
    // What the source said, kept for good. The LLM stage may add a second
    // opinion in segment_model; it never overwrites this one.
    segment_source: candidate.segment || 'other',
    segment_model: null,
    opener_model: null,
    name: tidy(candidate.name, 160),
    city: candidate.city || null,
    state: candidate.state || null,
    address: candidate.address ? tidy(candidate.address, 240) : null,
    phone: normalisePhone(candidate.phone),
    email: normaliseEmail(candidate.email),
    website: normaliseWebsite(candidate.website),
    why_now: candidate.whyNow ? tidy(candidate.whyNow, 120) : null,
    source: candidate.source,
    source_url: candidate.sourceUrl || null,
    licence: candidate.licence || null,
    first_seen: nowIso,
    last_seen: nowIso,
    score: 0,
    status: 'new',
    notes: null,
    extra: {
      whyNowDate: candidate.whyNowDate || null,
      rawPhone: candidate.phone || null,
      ...requirementExtra(candidate),
      ...(candidate.extra || {}),
    },
  };
}

// ---------------------------------------------------------------- scoring

export const SEGMENT_POINTS = {
  // The four segments a produce supplier sells into most directly share the top
  // band, so no single one of them can starve the others out of a capped run.
  wholesale: 30,
  hotel: 30,
  restaurant: 30,
  food_manufacturer: 30,
  distributor: 26,
  caterer: 22,
  retailer: 18,
  institution: 16,
  other: 8,
};

export const CONTACT_POINTS = { phone: 30, email: 20, website: 10, none: 0 };
export const RECENCY_POINTS = { within14: 20, within30: 10, older: 0, unknown: 4 };
export const CITY_MATCH_POINTS = 10;
export const DETAIL_ADDRESS_POINTS = 5;
export const DETAIL_LOCATION_POINTS = 5;
export const CONTACTED_DUPLICATE_PENALTY = 25;

/**
 * The confidence a model answer has to reach before the score is allowed to use
 * it at all. Below it the answer is still stored and still shown on the
 * register - it is simply not permitted to move a number.
 */
export const MODEL_MIN_CONFIDENCE = 0.7;

/**
 * How the model's reading of business size moves the segment band.
 *
 * Size adjusts the segment component; it is not a component of its own. That
 * keeps the band at its documented 0-30 and the total at its documented 0-100,
 * so no lead scored before the LLM stage existed can be inflated past what the
 * rules already allowed. A large institution can climb towards the top of the
 * band; a large wholesaler is already there and gains nothing.
 */
export const SIZE_POINTS = { large: 6, medium: 2, small: -4, unknown: 0 };
export const SEGMENT_BAND_MAX = 30;

/**
 * The model's answer, but only when it carried enough confidence to be used.
 * One gate, read by every consumer, so "the model decided this" is never a
 * question of which caller checked.
 */
export function modelInputs(lead, { minConfidence = MODEL_MIN_CONFIDENCE } = {}) {
  const llm = lead && lead.extra && lead.extra.llm;
  if (!llm || typeof llm.confidence !== 'number' || llm.confidence < minConfidence) return null;
  return { segment: llm.segment || null, size: llm.size || 'unknown', deadline: llm.deadline || null, confidence: llm.confidence };
}

/** The segment the score uses: the model's only when it cleared the confidence gate. */
export function effectiveSegment(lead, opts) {
  const m = modelInputs(lead, opts);
  if (m && m.segment && SEGMENT_POINTS[m.segment] !== undefined) return m.segment;
  return lead.segment;
}

export function contactability(lead) {
  if (lead.phone) return 'phone';
  if (lead.email) return 'email';
  if (lead.website) return 'website';
  return 'none';
}

export function recencyBand(lead, todayIsoDate, opts) {
  // The source's own date always wins. A model-read deadline is used only where
  // the record carries no date at all, so the model can fill a gap and can never
  // move a date the source already stated.
  const m = modelInputs(lead, opts);
  const d = (lead.extra && lead.extra.whyNowDate) || (m && m.deadline) || null;
  if (!d) return 'unknown';
  const days = daysBetween(d, todayIsoDate);
  if (days === null) return 'unknown';
  if (days < 0) return 'within14'; // a future date, e.g. a tender that closes soon
  if (days <= 14) return 'within14';
  if (days <= 30) return 'within30';
  return 'older';
}

// -------------------------------------------------------- requirement score
//
// A requirement is scored on different facts from a buyer, because different
// facts decide whether the owner should act on it this morning. A buyer is
// scored on "is this the kind of business that buys what we sell, and can I
// reach it". A requirement is already demand; what matters is when it shuts,
// whether we can fill it, whether there is a person to ring, and whether it is
// near enough to serve. The two scales are both 0-100 so one register can be
// ordered, and a requirement is shown in its own digest section so the numbers
// are never read against each other.

export const DEADLINE_POINTS = {
  closed: 0, // the date has passed: not a lead, and must not look like one
  within7: 30,
  within14: 25,
  within30: 18,
  later: 10,
  none: 8, // a posted requirement with no stated date is still a posted requirement
};

export const QUANTITY_FIT_POINTS = { within: 25, unstated: 12, small: 8, over: 6 };

export const REQUIREMENT_CONTACT_POINTS = {
  phone_and_email: 30,
  phone: 26,
  email: 18,
  name_only: 6,
  none: 0,
};

export const REQUIREMENT_PLACE_POINTS = { city: 15, state: 8, elsewhere: 0 };

export function deadlineBand(lead, todayIsoDate) {
  const d = (lead.extra && (lead.extra.deadline || lead.extra.whyNowDate)) || null;
  if (!d) return 'none';
  const days = daysBetween(todayIsoDate, d);
  if (days === null) return 'none';
  if (days < 0) return 'closed';
  if (days <= 7) return 'within7';
  if (days <= 14) return 'within14';
  if (days <= 30) return 'within30';
  return 'later';
}

/** How much of a contact the notice actually gave us. */
export function requirementContactBand(lead) {
  const phone = lead.phone || (lead.extra && lead.extra.contact_phone);
  const email = lead.email || (lead.extra && lead.extra.contact_email);
  if (phone && email) return 'phone_and_email';
  if (phone) return 'phone';
  if (email) return 'email';
  if (lead.extra && lead.extra.contact_name) return 'name_only';
  return 'none';
}

export function requirementPlaceBand(lead, city, state) {
  if (city && normaliseCity(lead.city) === normaliseCity(city)) return 'city';
  if (state && lead.state && normaliseCity(lead.state) === normaliseCity(state)) return 'state';
  return 'elsewhere';
}

export function scoreRequirement(lead, { city, state, todayIsoDate } = {}) {
  const fit = (lead.extra && lead.extra.quantityFit) || 'unstated';
  const parts = {
    deadline: DEADLINE_POINTS[deadlineBand(lead, todayIsoDate)],
    quantityFit: QUANTITY_FIT_POINTS[fit] ?? QUANTITY_FIT_POINTS.unstated,
    contact: REQUIREMENT_CONTACT_POINTS[requirementContactBand(lead)],
    place: REQUIREMENT_PLACE_POINTS[requirementPlaceBand(lead, city, state)],
    penalty: lead.status && lead.status !== 'new' ? -CONTACTED_DUPLICATE_PENALTY : 0,
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    score: Math.max(0, Math.min(100, total)),
    parts,
    inputs: {
      scale: 'requirement',
      deadlineBand: deadlineBand(lead, todayIsoDate),
      quantityFit: fit,
      contactBand: requirementContactBand(lead),
      placeBand: requirementPlaceBand(lead, city, state),
    },
  };
}

/**
 * Deterministic 0-100 score. Documented in docs/scoring.md.
 *
 * This function makes no model call and never will. Where the LLM stage has
 * already run, its answer is read out of `extra.llm` as one more input - and
 * only when it cleared the confidence gate. The rules still decide the number.
 */
export function scoreLead(lead, { city, state = null, todayIsoDate, minConfidence = MODEL_MIN_CONFIDENCE } = {}) {
  if (lead.kind === 'requirement') return scoreRequirement(lead, { city, state, todayIsoDate });
  const opts = { minConfidence };
  const m = modelInputs(lead, opts);
  const segment = effectiveSegment(lead, opts);
  const parts = {
    segment: Math.max(
      0,
      Math.min(SEGMENT_BAND_MAX, (SEGMENT_POINTS[segment] ?? SEGMENT_POINTS.other) + (m ? SIZE_POINTS[m.size] ?? 0 : 0))
    ),
    contactability: CONTACT_POINTS[contactability(lead)],
    recency: RECENCY_POINTS[recencyBand(lead, todayIsoDate, opts)],
    cityMatch:
      city && normaliseCity(lead.city) === normaliseCity(city) ? CITY_MATCH_POINTS : 0,
    detail:
      (lead.address ? DETAIL_ADDRESS_POINTS : 0) +
      (lead.extra && (lead.extra.lat || lead.website) ? DETAIL_LOCATION_POINTS : 0),
    penalty: lead.status && lead.status !== 'new' ? -CONTACTED_DUPLICATE_PENALTY : 0,
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    score: Math.max(0, Math.min(100, total)),
    parts,
    // What the score was actually computed on, so a register row can say why it
    // scored what it scored without re-deriving the gate.
    inputs: {
      segment,
      segmentFrom: m && m.segment && SEGMENT_POINTS[m.segment] !== undefined ? 'model' : 'source',
      size: m ? m.size : null,
      modelConfidence: m ? m.confidence : null,
    },
  };
}

// ---------------------------------------------------------------- dedup

/**
 * Kinds that are a *document*, not a business.
 *
 * Three notices from one institution are three requirements, not one buyer
 * sighted three times. They share a name, a city and the same switchboard
 * number, so both dedup keys would collapse them - and the first real digest
 * showed exactly what that costs: one row claiming its document could not be
 * read while displaying a contact lifted from a different document. A
 * requirement is identified by the notice it came from and by nothing else, so
 * it matches only on its own id.
 */
const DOCUMENT_KINDS = new Set(['requirement', 'registration']);

export function phoneKey(lead) {
  if (DOCUMENT_KINDS.has(lead.kind)) return null;
  return lead.phone ? `p:${lead.phone}` : null;
}

export function nameCityKey(lead) {
  if (DOCUMENT_KINDS.has(lead.kind)) return null;
  const n = normaliseName(lead.name);
  if (!n) return null;
  return `n:${n}|${normaliseCity(lead.city)}`;
}

function preferString(a, b) {
  if (a && b) return a.length >= b.length ? a : b;
  return a || b || null;
}

/** Merge an incoming lead into an existing one without losing known facts. */
export function mergeLeads(existing, incoming) {
  const merged = { ...existing };
  merged.name = preferString(existing.name, incoming.name);
  merged.city = existing.city || incoming.city;
  merged.state = existing.state || incoming.state;
  merged.address = preferString(existing.address, incoming.address);
  merged.phone = existing.phone || incoming.phone;
  merged.email = existing.email || incoming.email;
  merged.website = existing.website || incoming.website;
  merged.segment =
    (SEGMENT_POINTS[incoming.segment] ?? 0) > (SEGMENT_POINTS[existing.segment] ?? 0)
      ? incoming.segment
      : existing.segment;
  // A model answer already on the record is kept; one arriving with a fresh
  // sighting fills a gap. Neither touches the source-derived segment.
  merged.segment_source = existing.segment_source || existing.segment || incoming.segment_source;
  merged.segment_model = existing.segment_model || incoming.segment_model || null;
  merged.opener_model = existing.opener_model || incoming.opener_model || null;
  merged.first_seen =
    existing.first_seen && existing.first_seen < incoming.first_seen
      ? existing.first_seen
      : incoming.first_seen;
  merged.last_seen =
    existing.last_seen && existing.last_seen > incoming.last_seen
      ? existing.last_seen
      : incoming.last_seen;
  // A fresher why_now wins; otherwise keep what we had.
  const exDate = existing.extra?.whyNowDate || '';
  const inDate = incoming.extra?.whyNowDate || '';
  if (incoming.why_now && inDate >= exDate) {
    merged.why_now = incoming.why_now;
    merged.extra = { ...existing.extra, ...incoming.extra };
  } else {
    merged.why_now = existing.why_now || incoming.why_now;
    merged.extra = { ...incoming.extra, ...existing.extra };
  }
  merged.extra.mergedFrom = Array.from(
    new Set([...(existing.extra?.mergedFrom || []), incoming.id].filter((x) => x && x !== existing.id))
  );
  merged.extra.sources = Array.from(
    new Set([...(existing.extra?.sources || [existing.source]), incoming.source])
  );
  // Status and notes belong to the register, never to a fetch.
  merged.status = existing.status;
  merged.notes = existing.notes;
  return merged;
}

/**
 * Fold candidates into the existing register.
 * Dedup order: normalised phone first, then normalised name + city.
 * Returns { leads, newCount, updatedCount, duplicateCount }.
 */
export function upsertLeads(existingLeads, incomingLeads) {
  const byId = new Map();
  const byPhone = new Map();
  const byNameCity = new Map();

  const index = (lead) => {
    byId.set(lead.id, lead);
    const pk = phoneKey(lead);
    if (pk) byPhone.set(pk, lead.id);
    const nk = nameCityKey(lead);
    if (nk) byNameCity.set(nk, lead.id);
  };

  for (const lead of existingLeads) index(lead);

  let newCount = 0;
  let updatedCount = 0;
  let duplicateCount = 0;

  for (const incoming of incomingLeads) {
    const pk = phoneKey(incoming);
    const nk = nameCityKey(incoming);
    let targetId = null;
    if (byId.has(incoming.id)) targetId = incoming.id;
    else if (pk && byPhone.has(pk)) targetId = byPhone.get(pk);
    else if (nk && byNameCity.has(nk)) targetId = byNameCity.get(nk);

    if (targetId) {
      const merged = mergeLeads(byId.get(targetId), incoming);
      byId.set(targetId, merged);
      const mpk = phoneKey(merged);
      if (mpk) byPhone.set(mpk, targetId);
      const mnk = nameCityKey(merged);
      if (mnk) byNameCity.set(mnk, targetId);
      if (targetId === incoming.id) updatedCount += 1;
      else duplicateCount += 1;
    } else {
      index(incoming);
      newCount += 1;
    }
  }

  return {
    leads: Array.from(byId.values()),
    newCount,
    updatedCount,
    duplicateCount,
  };
}

// ---------------------------------------------------------------- opener

/**
 * One plain line the owner could say. Deterministic per segment, no hype, no
 * claims beyond what the supplier actually supplies. The lines come from the
 * client profile, so they are the owner's own words and not the engine's. This
 * composes text only; it never sends anything.
 */
const OPENERS = CLIENT.openers.bySegment;

/**
 * A requirement already tells the owner what to say: they have posted what they
 * need, so the line quotes for that rather than asking what they buy. The
 * requirement text is the notice's own wording, clipped, never a claim about it.
 */
function requirementOpener(lead) {
  const what = (lead.extra && lead.extra.requirement) || null;
  if (!what) return CLIENT.openers.requirementFallback;
  const short = tidy(what, 60).replace(/\.$/, '');
  // Lower-case the first letter so the notice's wording reads as part of the
  // sentence - but not when the first word is an acronym or a reference number,
  // which a tender title very often starts with. "dIT/2026/MS/14" is worse than
  // no change at all.
  const first = short.split(/\s+/)[0] || '';
  const keepCase = /[A-Z]{2,}|\d/.test(first);
  return CLIENT.openers.requirement.replace(
    '{what}',
    keepCase ? short : `${short.charAt(0).toLowerCase()}${short.slice(1)}`
  );
}

/** A standing way in, not a requirement: the line asks to be put on the list. */
function registrationOpener(lead) {
  const what = (lead.extra && lead.extra.requirement) || null;
  return what
    ? CLIENT.openers.registration.replace('{what}', tidy(what, 50).replace(/\.$/, ''))
    : CLIENT.openers.registrationFallback;
}

export function opener(lead) {
  if (lead.kind === 'requirement') return requirementOpener(lead);
  if (lead.kind === 'registration') return registrationOpener(lead);
  return OPENERS[lead.segment] || OPENERS.other;
}

/**
 * What to call this lead in the digest and on the register.
 *
 * It shows the segment the score was actually computed on. A digest that calls a
 * hostel tender a "Hotel" because the news query that found it was about hotels
 * is a digest that lies to the owner, and the stored source-derived segment is
 * still there in `segment_source` for anyone who wants to see the disagreement.
 */
export function describeSegment(lead) {
  return segmentLabel(effectiveSegment(lead));
}

export { STATUSES, BUSINESS };
