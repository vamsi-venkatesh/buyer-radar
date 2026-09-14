import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CITIES, CLIENT, DIGEST, DIGEST_COMBINED, DIGEST_SECTIONS, REGISTRATIONS } from './config.mjs';
import { DIGESTS_DIR } from './lib/paths.mjs';
import { opener, describeSegment } from './model.mjs';
import { normaliseCity, todayIso } from './lib/normalise.mjs';
import { openStore } from './lib/store.mjs';
import { catalogueItems } from './lib/catalogue.mjs';

/** Best contact string for one line of the digest. */
function contact(lead) {
  if (lead.phone) return lead.phone;
  if (lead.email) return lead.email;
  if (lead.website) return lead.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return 'no contact';
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}.`;
}

/**
 * Three layouts, tried widest first. Every layout keeps the lead number, the
 * name, the segment, a contact and the opener; the roomiest one also carries
 * the why-now line. The renderer falls back only when the character cap forces
 * it, and drops leads only after the tightest layout still does not fit.
 */
/**
 * The line the owner reads out. The model's two-line opener when the LLM stage
 * wrote one for this lead, otherwise the rule-based line, which is always
 * available and always plain.
 */
export function digestOpener(lead) {
  return lead.opener_model || opener(lead);
}

function quoted(text) {
  const lines = String(text).split('\n');
  return lines.map((l, i) => `   ${i === 0 ? '"' : ' '}${l}${i === lines.length - 1 ? '"' : ''}`).join('\n');
}

const LAYOUTS = [
  {
    // The widest layout, and the only one that carries a model-written opener.
    // If the two extra lines push the digest past its cap, the cascade below
    // falls back to the rule-based openers and keeps all ten leads rather than
    // showing five with better lines.
    key: 'model',
    block: (lead, n, showCity) => [
      `L${n} ${clip(lead.name, 34)} - ${describeSegment(lead)}${showCity ? ` - ${lead.city}` : ''}`,
      `   ${clip(contact(lead), 26)} - ${clip(lead.why_now || 'listed', 30)}`,
      quoted(digestOpener(lead)),
    ].join('\n'),
  },
  {
    key: 'full',
    block: (lead, n, showCity) => [
      `L${n} ${clip(lead.name, 34)} - ${describeSegment(lead)}${showCity ? ` - ${lead.city}` : ''}`,
      `   ${clip(contact(lead), 26)} - ${clip(lead.why_now || 'listed', 30)}`,
      `   "${opener(lead)}"`,
    ].join('\n'),
  },
  {
    key: 'compact',
    block: (lead, n, showCity) => [
      `L${n} ${clip(lead.name, 30)} - ${describeSegment(lead)}${showCity ? ` - ${lead.city}` : ''}`,
      `   ${clip(contact(lead), 26)} - "${opener(lead)}"`,
    ].join('\n'),
  },
  {
    key: 'tight',
    block: (lead, n) => [
      `L${n} ${clip(lead.name, 24)} - ${describeSegment(lead)}`,
      `   ${clip(contact(lead), 20)} - "${opener(lead)}"`,
    ].join('\n'),
  },
];

// ----------------------------------------------------------- requirements
//
// Section one, and it is first on purpose. A buyer in section two is someone
// who probably buys vegetables; a requirement in section one is someone who has
// said in public that they need them, how much, and by when. The owner's
// morning should start with the second kind.

/** The contact line for a requirement, or the truth when there is not one. */
export function requirementContact(lead) {
  const e = lead.extra || {};
  return lead.phone || e.contact_phone || lead.email || e.contact_email || 'contact not found yet';
}

function requirementWhat(lead) {
  const e = lead.extra || {};
  return e.requirement || lead.why_now || lead.name;
}

/** "1,500 kg per month - closes 2026-09-30", with whichever half exists. */
function requirementTerms(lead) {
  const e = lead.extra || {};
  const bits = [];
  if (e.quantity) bits.push(clip(e.quantity, 34));
  if (e.deadline) bits.push(`closes ${e.deadline}`);
  if (!bits.length && e.unreadable) return 'document could not be read as text';
  return bits.join(' - ') || 'no quantity or closing date stated';
}

function requirementWho(lead) {
  const e = lead.extra || {};
  return e.contact_name ? clip(e.contact_name, 24) : null;
}

function documentUrl(lead) {
  const e = lead.extra || {};
  return e.document_url || lead.source_url || null;
}

const REQUIREMENT_LAYOUTS = [
  {
    key: 'full',
    block: (lead, n, showCity) => {
      const who = requirementWho(lead);
      const url = documentUrl(lead);
      return [
        `R${n} ${clip(lead.name, 34)}${showCity && lead.city ? ` - ${lead.city}` : ''}`,
        `   ${clip(requirementWhat(lead), 52)}`,
        `   ${requirementTerms(lead)}`,
        `   ${clip(requirementContact(lead), 26)}${who ? ` - ${who}` : ''}`,
        quoted(digestOpener(lead)),
        url ? `   ${url}` : null,
      ].filter((l) => l !== null).join('\n');
    },
  },
  {
    key: 'mid',
    block: (lead, n, showCity) => [
      `R${n} ${clip(lead.name, 34)}${showCity && lead.city ? ` - ${lead.city}` : ''}`,
      `   ${clip(requirementWhat(lead), 52)}`,
      `   ${requirementTerms(lead)}`,
      `   ${clip(requirementContact(lead), 26)}`,
    ].join('\n'),
  },
  {
    key: 'compact',
    block: (lead, n) => [
      `R${n} ${clip(lead.name, 30)} - ${clip(requirementWhat(lead), 36)}`,
      `   ${clip(requirementContact(lead), 24)} - ${requirementTerms(lead)}`,
    ].join('\n'),
  },
  {
    key: 'tight',
    block: (lead, n) => [
      `R${n} ${clip(lead.name, 26)}`,
      `   ${clip(requirementContact(lead), 20)} - ${clip(requirementTerms(lead), 30)}`,
    ].join('\n'),
  },
];

// ---------------------------------------------------------- registrations

const REGISTRATION_LAYOUTS = [
  {
    key: 'full',
    block: (lead, n) => [
      `G${n} ${clip(lead.name, 34)}`,
      `   ${clip((lead.extra || {}).requirement || 'buys fresh produce', 52)}`,
      `   ${clip((lead.extra || {}).how || 'see the page', 52)}`,
      `   ${documentUrl(lead) || ''}`.trimEnd(),
    ].join('\n'),
  },
  {
    key: 'compact',
    block: (lead, n) => [
      `G${n} ${clip(lead.name, 30)}`,
      `   ${clip((lead.extra || {}).how || 'see the page', 46)}`,
    ].join('\n'),
  },
  {
    key: 'tight',
    block: (lead, n) => `G${n} ${clip(lead.name, 34)}`,
  },
];

/** Mondays only, and the same rule the registrations source applies. */
export function registrationsDue(dateIso, { weekday = REGISTRATIONS.weekday } = {}) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCDay() === weekday;
}

function priceBlock(prices) {
  if (!prices || !prices.length) return null;
  const PRIORITY = ['Garlic', 'Capsicum', 'Broccoli', 'Tomato', 'Onion', 'Potato', 'Carrot', 'Beans'];
  const rank = (p) => { const i = PRIORITY.indexOf((p.extra || {}).commodity); return i < 0 ? 99 : i; };
  const seen = new Set();
  const ordered = [...prices].sort((a, b) => rank(a) - rank(b) || String((b.extra||{}).arrivalDate||'').localeCompare(String((a.extra||{}).arrivalDate||''))).filter((p) => { const c = (p.extra||{}).commodity; if (seen.has(c)) return false; seen.add(c); return true; });
  const lines = ordered.slice(0, 4).map((p) => {
    const e = p.extra || {};
    const modal = e.modalPrice === null || e.modalPrice === undefined ? '?' : e.modalPrice;
    return `  ${e.commodity} ${clip(e.market, 22)} Rs ${modal}/qtl ${e.arrivalDate || ''}`
      .replace(/\s+/g, ' ')
      .trimEnd();
  });
  return ['Mandi prices (INR/quintal):', ...lines].join('\n');
}

/**
 * Leads with the same score are otherwise ordered by id, which in practice
 * hands every digest slot to whichever segment happens to have the most
 * phone-bearing listings. Scores are not touched; among leads that already tie,
 * the one whose segment has appeared least often so far goes first. The rule is
 * deterministic - equal score and equal segment count still falls back to id.
 */
export function diversifyTies(sorted) {
  const out = [];
  const seen = new Map();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j += 1;
    const tied = sorted.slice(i, j);
    while (tied.length) {
      let bestAt = 0;
      for (let k = 1; k < tied.length; k += 1) {
        const a = seen.get(tied[k].segment) || 0;
        const b = seen.get(tied[bestAt].segment) || 0;
        if (a < b) bestAt = k;
      }
      const [chosen] = tied.splice(bestAt, 1);
      seen.set(chosen.segment, (seen.get(chosen.segment) || 0) + 1);
      out.push(chosen);
    }
    i = j;
  }
  return out;
}

const FOOTER = 'Reply with R<n>/L<n>/G<n> won/lost/contacted to update.';

const HEADINGS = {
  requirements: 'REQUIREMENTS POSTED',
  buyers: 'BUYERS TO APPROACH',
  registrations: 'WHERE TO REGISTER',
};

export const REQUIREMENT_KINDS = ['requirement'];
export const BUYER_KINDS = ['buyer', 'tender', 'signal'];

/** Split the register into the sections the digest prints, each already ranked. */
export function splitForDigest(leads) {
  const ranked = (list) =>
    diversifyTies([...list].filter((l) => l.status === 'new').sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)));
  return {
    requirements: ranked(leads.filter((l) => REQUIREMENT_KINDS.includes(l.kind))),
    buyers: ranked(leads.filter((l) => BUYER_KINDS.includes(l.kind))),
    registrations: ranked(leads.filter((l) => l.kind === 'registration')),
  };
}

function section(heading, chosen, layout, showCity, total) {
  if (!chosen.length) return null;
  const head = total > chosen.length ? `${heading} (${chosen.length} of ${total})` : `${heading} (${chosen.length})`;
  return [head, '', ...chosen.flatMap((lead, i) => [layout.block(lead, i + 1, showCity), ''])].join('\n');
}

function assemble(plan, { date, city, priceText, sets }) {
  const head = `${CLIENT.digest.title} - ${date}${city ? ` - ${city}` : ''}`;
  const showCity = !city;
  const parts = [head, ''];

  const req = sets.requirements.slice(0, plan.requirements);
  const buy = sets.buyers.slice(0, plan.buyers);
  const reg = sets.registrations.slice(0, plan.registrations);

  const blocks = [
    section(HEADINGS.requirements, req, plan.requirementLayout, showCity, sets.requirements.length),
    section(HEADINGS.buyers, buy, plan.buyerLayout, showCity, sets.buyers.length),
    section(HEADINGS.registrations, reg, plan.registrationLayout, showCity, sets.registrations.length),
  ].filter(Boolean);

  if (!blocks.length) parts.push('No new leads today.', '');
  else parts.push(...blocks);

  if (!req.length && sets.requirements.length === 0) {
    parts.push('No requirement was posted anywhere we can read today.', '');
  }
  if (priceText) parts.push(priceText, '');
  parts.push(FOOTER);
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function indexFor(plan, sets) {
  const index = {};
  sets.requirements.slice(0, plan.requirements).forEach((l, i) => { index[`R${i + 1}`] = l.id; });
  sets.buyers.slice(0, plan.buyers).forEach((l, i) => { index[`L${i + 1}`] = l.id; });
  sets.registrations.slice(0, plan.registrations).forEach((l, i) => { index[`G${i + 1}`] = l.id; });
  return index;
}

const last = (a) => a[a.length - 1];

function layoutKey(plan) {
  if (!plan.requirements) return plan.buyerLayout.key;
  if (!plan.buyers) return plan.requirementLayout.key;
  return plan.requirementLayout.key === plan.buyerLayout.key
    ? plan.requirementLayout.key
    : `${plan.requirementLayout.key}/${plan.buyerLayout.key}`;
}

/**
 * Every layout and count combination the renderer will try, widest first.
 *
 * The order encodes what the owner loses first when the cap bites, and the
 * order is the point: the widest layouts are tried for everything, then the
 * registration section goes, then buyers go one at a time, and only when the
 * message is still too long does a posted requirement get dropped. A
 * requirement is the scarcest thing in the digest and the last thing to leave it.
 */
export function* digestPlans(wanted) {
  // For each requirement layout, widest first: try every buyer layout, then
  // shed the registration section, then shed buyers one at a time. Only when a
  // requirement layout cannot be made to fit even against a single-line buyer
  // list does the next, narrower requirement layout get a turn.
  //
  // The order matters and the obvious nesting gets it backwards. Trying every
  // layout pair before reducing any count produced a real digest with the
  // requirements squeezed into two clipped lines - "office.admin@iith.a." -
  // while six buyers each kept a three-line block with an opener. The scarce
  // thing was the thing that got cut.
  for (const requirementLayout of REQUIREMENT_LAYOUTS) {
    for (const buyerLayout of LAYOUTS) {
      yield { requirementLayout, buyerLayout, registrationLayout: REGISTRATION_LAYOUTS[0], ...wanted };
    }
    const buyerLayout = last(LAYOUTS);
    const registrationLayout = last(REGISTRATION_LAYOUTS);
    const base = { requirementLayout, buyerLayout, registrationLayout };
    for (let g = wanted.registrations - 1; g >= 0; g -= 1) yield { ...base, ...wanted, registrations: g };
    for (let b = wanted.buyers - 1; b >= 0; b -= 1) yield { ...base, ...wanted, registrations: 0, buyers: b };
  }
  // Everything else has already been given up. Now, and only now, a posted
  // requirement leaves the message.
  const base = {
    requirementLayout: last(REQUIREMENT_LAYOUTS),
    buyerLayout: last(LAYOUTS),
    registrationLayout: last(REGISTRATION_LAYOUTS),
  };
  for (let r = wanted.requirements - 1; r >= 0; r -= 1) yield { ...base, requirements: r, buyers: 0, registrations: 0 };
}

/**
 * Render the morning digest. Plain text, WhatsApp-shaped, hard-capped at
 * DIGEST.maxChars. This function only composes text. Nothing is sent anywhere.
 *
 * `full` is the same four sections with nothing dropped and every document link
 * intact, for the email, which has no such cap.
 */
export function renderDigest(
  leads,
  {
    date = todayIso(),
    city = null,
    prices = [],
    maxChars = DIGEST.maxChars,
    topN = DIGEST.topN,
    sections = DIGEST_SECTIONS,
    showRegistrations = null,
  } = {}
) {
  const sets = splitForDigest(leads);
  if (showRegistrations === null ? !registrationsDue(date) : !showRegistrations) sets.registrations = [];

  const priceText = priceBlock(prices);
  const wanted = {
    requirements: Math.min(sections.requirements ?? topN, sets.requirements.length),
    buyers: Math.min(sections.buyers ?? topN, sets.buyers.length),
    registrations: Math.min(sections.registrations ?? 0, sets.registrations.length),
  };

  const pack = (plan) => ({
    text: assemble(plan, { date, city, priceText, sets }),
    index: indexFor(plan, sets),
    shown: plan.requirements + plan.buyers + plan.registrations,
    requirementsShown: plan.requirements,
    buyersShown: plan.buyers,
    registrationsShown: plan.registrations,
    considered: sets.requirements.length + sets.buyers.length + sets.registrations.length,
    requirementsConsidered: sets.requirements.length,
    withContact: sets.requirements.filter((l) => l.phone || l.email || (l.extra || {}).contact_phone || (l.extra || {}).contact_email).length,
    // The layout of the sections that were actually rendered. A digest with no
    // requirements reports the buyer layout alone, exactly as it did before the
    // demand lane existed.
    layout: layoutKey(plan),
    // The ranked sets this digest was built from. The combined morning digest
    // needs the leads themselves, not the rendered text, so it can re-rank
    // requirements across cities and group buyers under a city heading.
    sets,
  });

  let result = null;
  for (const plan of digestPlans(wanted)) {
    result = pack(plan);
    if (result.text.length <= maxChars) break;
  }
  result.full = renderFullSheet(sets, { date, city, priceText });
  return result;
}

/**
 * Everything, uncapped: every requirement with its document link, every buyer,
 * every registration route. The email carries this; WhatsApp cannot.
 */
export function renderFullSheet(sets, { date = todayIso(), city = null, priceText = null } = {}) {
  const showCity = !city;
  const parts = [`${CLIENT.digest.title} - full sheet - ${date}${city ? ` - ${city}` : ''}`, ''];
  const blocks = [
    section(HEADINGS.requirements, sets.requirements, REQUIREMENT_LAYOUTS[0], showCity, sets.requirements.length),
    section(HEADINGS.buyers, sets.buyers, LAYOUTS[0], showCity, sets.buyers.length),
    section(HEADINGS.registrations, sets.registrations, REGISTRATION_LAYOUTS[0], showCity, sets.registrations.length),
  ].filter(Boolean);
  if (!blocks.length) parts.push('No new leads today.', '');
  else parts.push(...blocks);
  if (!sets.requirements.length) parts.push('No requirement was posted anywhere we can read today.', '');
  if (priceText) parts.push(priceText, '');
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Full price sheet: one line per catalogue item, nearest mandi modal price for the state of the run, or "no mandi quote". */
export function renderPriceSheet(prices, { date = todayIso(), state = null } = {}) {
  const best = new Map();
  for (const p of prices || []) {
    const e = p.extra || {};
    if (!e.commodity || e.modalPrice === null || e.modalPrice === undefined) continue;
    if (state && p.state && p.state !== state) continue;
    const cur = best.get(e.commodity);
    if (!cur || (e.arrivalDate || '') > (cur.arrivalDate || '')) best.set(e.commodity, e);
  }
  const lines = [];
  for (const item of catalogueItems()) {
    const e = item.commodity ? best.get(item.commodity) : null;
    const approx = item.approx ? ' ~' : '';
    lines.push(e ? `${item.label}${approx}: Rs ${e.modalPrice}/qtl, ${clip(e.market, 22)} ${e.arrivalDate || ''}`.replace(/\s+/g, ' ').trim() : `${item.label}: no mandi quote today`);
  }
  const head = `Mandi price sheet - ${date}${state ? ' - ' + state : ''} (INR per quintal; ~ = nearest mandi line)`;
  return [head, ...lines].join('\n');
}
// ------------------------------------------------------- the combined digest
//
// A morning pass runs several cities one after another. Meta applies a
// per-recipient frequency cap to a MARKETING template, so five messages is not
// five messages - it is three that arrive and two that are refused. One message
// per morning is therefore not a nicety, it is the only shape that delivers.
//
// The combination is not several digests glued together. Requirements are the
// scarce thing, so they are re-ranked across every city and printed first, as
// one series. Buyers are city-local and are printed under a city heading, a few
// each. Mandi prices are per state and per mandi, not per city, so the same
// quote arrives from several city runs and is printed once.

/**
 * One price row per commodity, market and arrival date, keeping the first
 * sighting. Several city runs in one state read the same mandi table; without
 * this the combined price block would print the same quote once per city.
 */
export function dedupePrices(prices) {
  const seen = new Set();
  const out = [];
  for (const p of prices || []) {
    const e = p.extra || {};
    const key = [e.commodity || '', e.market || '', e.arrivalDate || '', e.modalPrice ?? ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function dedupeById(leads) {
  const seen = new Set();
  const out = [];
  for (const l of leads || []) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(l);
  }
  return out;
}

const byScore = (a, b) => (b.score || 0) - (a.score || 0) || String(a.id).localeCompare(String(b.id));

/** Same shrink order as a single-city digest: layouts first, then registrations, then buyers, and a requirement last. */
export function* combinedPlans(wanted) {
  for (const requirementLayout of REQUIREMENT_LAYOUTS) {
    for (const buyerLayout of LAYOUTS) {
      yield { requirementLayout, buyerLayout, registrationLayout: REGISTRATION_LAYOUTS[0], ...wanted };
    }
    const base = {
      requirementLayout,
      buyerLayout: last(LAYOUTS),
      registrationLayout: last(REGISTRATION_LAYOUTS),
    };
    for (let g = wanted.registrations - 1; g >= 0; g -= 1) yield { ...base, ...wanted, registrations: g };
    for (let b = wanted.buyersPerCity - 1; b >= 0; b -= 1) {
      yield { ...base, ...wanted, registrations: 0, buyersPerCity: b };
    }
  }
  const base = {
    requirementLayout: last(REQUIREMENT_LAYOUTS),
    buyerLayout: last(LAYOUTS),
    registrationLayout: last(REGISTRATION_LAYOUTS),
  };
  for (let r = wanted.requirements - 1; r >= 0; r -= 1) {
    yield { ...base, requirements: r, buyersPerCity: 0, registrations: 0 };
  }
}

function assembleCombined(plan, { date, cities, failedCities, requirements, buyersByCity, registrations, priceText }) {
  const head = `${CLIENT.digest.title} - ${date}${cities.length ? ` - ${cities.join(', ')}` : ''}`;
  const parts = [head];
  // The failed cities are named above the cap's reach: a morning where two
  // cities did not run must never read like a morning where they found nothing.
  if (failedCities.length) parts.push(`Not run today: ${failedCities.join(', ')}.`);
  parts.push('');

  const req = requirements.slice(0, plan.requirements);
  const blocks = [];
  const reqBlock = section(HEADINGS.requirements, req, plan.requirementLayout, true, requirements.length);
  if (reqBlock) blocks.push(reqBlock);

  let n = 0;
  let totalBuyers = 0;
  const cityBlocks = [];
  const chosenBuyers = [];
  for (const entry of buyersByCity) {
    totalBuyers += entry.buyers.length;
    const chosen = entry.buyers.slice(0, plan.buyersPerCity);
    if (!chosen.length) continue;
    const lines = [entry.city];
    for (const lead of chosen) {
      n += 1;
      chosenBuyers.push(lead);
      lines.push(plan.buyerLayout.block(lead, n, false), '');
    }
    cityBlocks.push(lines.join('\n'));
  }
  if (cityBlocks.length) {
    const heading =
      totalBuyers > chosenBuyers.length
        ? `${HEADINGS.buyers} (${chosenBuyers.length} of ${totalBuyers})`
        : `${HEADINGS.buyers} (${chosenBuyers.length})`;
    blocks.push([heading, '', ...cityBlocks].join('\n'));
  }

  const reg = registrations.slice(0, plan.registrations);
  const regBlock = section(HEADINGS.registrations, reg, plan.registrationLayout, true, registrations.length);
  if (regBlock) blocks.push(regBlock);

  if (!blocks.length) parts.push('No new leads today.', '');
  else parts.push(...blocks);

  if (!requirements.length) parts.push('No requirement was posted anywhere we can read today.', '');
  if (priceText) parts.push(priceText, '');
  parts.push(FOOTER);

  const index = {};
  req.forEach((l, i) => { index[`R${i + 1}`] = l.id; });
  chosenBuyers.forEach((l, i) => { index[`L${i + 1}`] = l.id; });
  reg.forEach((l, i) => { index[`G${i + 1}`] = l.id; });

  return {
    text: parts.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    index,
    requirementsShown: req.length,
    buyersShown: chosenBuyers.length,
    registrationsShown: reg.length,
    buyersConsidered: totalBuyers,
  };
}

/**
 * Combine one morning's per-city digests into the single message the owner is
 * sent. Each entry is `{ city, sets, prices, full, priceSheet }` - `sets` and
 * `prices` are what that city's run already ranked, `full` is its uncapped
 * sheet. `failed` names the cities whose run threw.
 *
 * Composes text only. Nothing is sent anywhere.
 */
export function combineDigests(
  cityDigests,
  { date = todayIso(), maxChars = DIGEST.maxChars, failed = [], sections = DIGEST_COMBINED, showRegistrations = null } = {}
) {
  const entries = (cityDigests || []).filter(Boolean);
  const cities = entries.map((c) => c.city).filter(Boolean);
  const failedCities = (failed || []).map((f) => (typeof f === 'string' ? f : f.city)).filter(Boolean);

  // A city's run merges the whole register, so its ranked sets carry leads from
  // the cities that ran before it. De-duplicating by lead id is what makes the
  // requirement series one series rather than several overlapping ones.
  const requirements = diversifyTies(dedupeById(entries.flatMap((c) => c.sets?.requirements || [])).sort(byScore));
  const registrationsAll = diversifyTies(dedupeById(entries.flatMap((c) => c.sets?.registrations || [])).sort(byScore));
  const registrations =
    (showRegistrations === null ? registrationsDue(date) : showRegistrations) ? registrationsAll : [];

  const buyersByCity = entries.map((c) => ({
    city: c.city,
    buyers: (c.sets?.buyers || []).filter((l) => normaliseCity(l.city) === normaliseCity(c.city)),
  }));

  const prices = dedupePrices(entries.flatMap((c) => c.prices || []));
  const priceText = priceBlock(prices);

  const wanted = {
    requirements: Math.min(sections.requirements ?? DIGEST_COMBINED.requirements, requirements.length),
    buyersPerCity: sections.buyersPerCity ?? DIGEST_COMBINED.buyersPerCity,
    registrations: Math.min(sections.registrations ?? 0, registrations.length),
  };

  const context = { date, cities, failedCities, requirements, buyersByCity, registrations, priceText };
  let packed = null;
  for (const plan of combinedPlans(wanted)) {
    packed = assembleCombined(plan, context);
    if (packed.text.length <= maxChars) break;
  }

  const fullParts = [
    `${CLIENT.digest.title} - full sheet - ${date}${cities.length ? ` - ${cities.join(', ')}` : ''}`,
    failedCities.length ? `Not run today: ${failedCities.join(', ')}.` : null,
    '',
  ].filter((l) => l !== null);
  for (const entry of entries) {
    fullParts.push(`===== ${entry.city} =====`, '', String(entry.full || entry.text || '').trim(), '');
  }

  return {
    ...packed,
    date,
    cities,
    failedCities,
    full: fullParts.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    priceSheet: renderPriceSheet(prices, { date, state: null }),
    prices,
    requirementsConsidered: requirements.length,
    considered: requirements.length + packed.buyersConsidered + registrations.length,
    shown: packed.requirementsShown + packed.buyersShown + packed.registrationsShown,
    withContact: requirements.filter(
      (l) => l.phone || l.email || (l.extra || {}).contact_phone || (l.extra || {}).contact_email
    ).length,
  };
}

/**
 * The combined digest built from whatever is in the store, for the dashboard,
 * `digest.render` and the owner's WhatsApp reply. Renders each named city's own
 * digest from that city's leads, then combines them exactly as the morning pass
 * does.
 */
export function combineFromLeads(leads, { date = todayIso(), cities = null, maxChars = DIGEST.maxChars } = {}) {
  const all = leads || [];
  const priceLeads = all.filter((l) => l.kind === 'price');
  const buyerLeads = all.filter((l) => l.kind !== 'price');
  const wanted = cities && cities.length
    ? cities
        .map((c) => Object.values(CITIES).find((k) => normaliseCity(k.name) === normaliseCity(c) || k.key === String(c).toLowerCase()))
        .filter(Boolean)
    : Object.values(CITIES).filter((c) => buyerLeads.some((l) => normaliseCity(l.city) === normaliseCity(c.name)));

  const perCity = wanted.map((c) => {
    const cityBuyers = buyerLeads.filter((l) => normaliseCity(l.city) === normaliseCity(c.name));
    const cityPrices = priceLeads.filter((p) => !c.agmarknetState || !p.state || p.state === c.agmarknetState);
    const digest = renderDigest(cityBuyers, { date, city: c.name, prices: cityPrices });
    return {
      city: c.name,
      cityKey: c.key,
      sets: digest.sets,
      prices: cityPrices,
      full: digest.full,
      priceSheet: renderPriceSheet(cityPrices, { date, state: c.agmarknetState || null }),
    };
  });
  return combineDigests(perCity, { date, maxChars });
}

export async function writeDigest(result, date = todayIso(), { digestsDir = DIGESTS_DIR, cityKey = null } = {}) {
  await mkdir(digestsDir, { recursive: true });
  if (result.priceSheet) {
    await writeFile(path.join(digestsDir, `${date}.prices.txt`), `${result.priceSheet}\n`, 'utf8');
  }
  const txt = path.join(digestsDir, `${date}.txt`);
  const idx = path.join(digestsDir, `${date}.index.json`);
  await writeFile(txt, `${result.text}\n`, 'utf8');
  await writeFile(idx, `${JSON.stringify(result.index, null, 2)}\n`, 'utf8');
  // The uncapped sheet: every requirement with its document link. WhatsApp
  // cannot carry it, the email can, and the owner can open the file himself.
  let full = null;
  if (result.full) {
    full = path.join(digestsDir, `${date}.full.txt`);
    await writeFile(full, `${result.full}\n`, 'utf8');
  }
  // A city also keeps a copy of its own digest under its own name. Several
  // cities in one morning otherwise leave only the last one on disk, and the
  // combined digest written at the end of the pass would overwrite even that.
  let city = null;
  if (cityKey) {
    city = path.join(digestsDir, `${date}.${cityKey}.txt`);
    await writeFile(city, `${result.text}\n`, 'utf8');
    await writeFile(path.join(digestsDir, `${date}.${cityKey}.index.json`), `${JSON.stringify(result.index, null, 2)}\n`, 'utf8');
    if (result.full) await writeFile(path.join(digestsDir, `${date}.${cityKey}.full.txt`), `${result.full}\n`, 'utf8');
    if (result.priceSheet) {
      await writeFile(path.join(digestsDir, `${date}.${cityKey}.prices.txt`), `${result.priceSheet}\n`, 'utf8');
    }
  }
  return { txt, idx, full, city };
}

/**
 * Write the combined morning digest. It deliberately lands on the same
 * `<date>.txt`, `<date>.full.txt`, `<date>.prices.txt` and `<date>.index.json`
 * the per-city runs wrote, and it is written after the last city, so everything
 * that reads "the latest digest" - the dashboard's front page, the webhook's
 * reply to the owner - hands back the one message the owner was actually sent.
 * The per-city copies stay beside it under `<date>.<city>.txt`.
 */
export async function writeCombinedDigest(combined, date = todayIso(), { digestsDir = DIGESTS_DIR } = {}) {
  const files = await writeDigest(combined, date, { digestsDir });
  const combinedFile = path.join(digestsDir, `${date}.combined.txt`);
  await writeFile(combinedFile, `${combined.text}\n`, 'utf8');
  return { ...files, combined: combinedFile };
}

async function main() {
  const date = todayIso();
  const store = await openStore();
  try {
    const leads = await store.allLeads();
    const prices = leads.filter((l) => l.kind === 'price');
    const buyers = leads.filter((l) => l.kind !== 'price');
    const result = renderDigest(buyers, { date, prices });
    const files = await writeDigest(result, date);
    process.stdout.write(`${result.text}\n`);
    process.stderr.write(
      `\n[digest] ${result.shown}/${result.considered} leads, ${result.text.length} chars -> ${files.txt}\n` +
        `[digest] requirements ${result.requirementsShown}/${result.requirementsConsidered} (${result.withContact} with a contact)\n`
    );
  } finally {
    await store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
    process.exit(1);
  });
}
