// The words the two signal tiers are decided by, and where each half comes from.
//
// What the radar looks for is partly a property of the trade and partly a
// property of the client. A canteen is a canteen whoever fills it, and the word
// "tender" means the same thing to every supplier in the country; those lists
// are the engine's and are the defaults below. What the supplier actually sells
// is not: a radar run for a dairy has no use for 'garlic' and every use for
// 'milk', and neither word belongs in the engine. That half is read from the
// client profile (src/client.mjs), which is the one place business facts live.
//
// A deployment that wants different words does not edit this file. It sets
// `signals` in config/client.json - `procurement`, `opening`, `venue` and the
// `near` gaps - and every list here is replaced by its own.
//
// Two tiers, and the difference between them is money:
//
//   requirement_candidate  somebody has posted a requirement - a tender, an
//                          RFQ, an expression of interest, a rate contract -
//                          and the produce rule says it is about food. Only
//                          these are worth fetching an article for and asking
//                          a model about.
//   awareness              a hotel opened, a chain is expanding. Worth knowing
//                          and worth keeping as a signal; it cannot contain a
//                          posted requirement, so no article is fetched and no
//                          model is called for it.
//
// The first real run of the openings lane on a deployment read 12 articles over
// 34 model calls and found a requirement in none of them: every one of the 12
// was an opening or an expansion story. That run is why this file exists.

import { CLIENT } from '../client.mjs';

export const TIERS = ['requirement_candidate', 'awareness'];

// The food-service half of the produce rule: a property of the trade, not of
// the supplier, and every deployment wants these words.
const FOOD_SERVICE = [
  'vegetable', 'vegetables', 'fresh produce', 'fruits and vegetables',
  'perishable', 'perishables', 'grocery', 'groceries', 'canteen', 'cafeteria',
  'mess', 'hostel', 'kitchen', 'catering', 'caterer', 'caterers', 'diet',
  'midday meal', 'mid-day meal', 'meals', 'food supply',
];

// Somebody is buying. These are the words that earn an article read and a model
// call, and nothing else in the lane does.
const PROCUREMENT = [
  'tender', 'tenders', 'e-tender', 'etender', 'procure', 'procured',
  'procurement', 'supply of', 'supply', 'supplies', 'supplier', 'suppliers',
  'rfq', 'eoi', 'expression of interest', 'empanel', 'empanelment',
  'rate contract', 'annual supply', 'canteen contract', 'mess contract',
  'vendor registration', 'bid', 'bids', 'quotation', 'quotations',
  'contract', 'contractor', 'outsourced',
];

// Something is being opened or expanded. Awareness, and awareness only.
const OPENING = [
  'open', 'opens', 'opened', 'opening', 'launch', 'launches', 'launched',
  'inaugurate', 'inaugurated', 'inauguration', 'expand', 'expands', 'expanded',
  'expansion', 'unveil', 'unveils', 'set up', 'sets up', 'to come up',
];

// A place that will need vegetables one day.
const VENUE = [
  'hotel', 'hotels', 'resort', 'resorts', 'restaurant', 'restaurants', 'cafe',
  'eatery', 'bakery', 'food court', 'qsr', 'dining', 'banquet', 'canteen',
  'cafeteria', 'mess', 'hostel', 'kitchen', 'catering', 'supermarket',
  'hypermarket', 'grocery', 'hospital', 'university', 'college', 'campus',
];

/**
 * The commodity half of the produce rule, from the client profile.
 *
 * Three places in the profile name what the supplier sells - the catalogue's own
 * labels, the headline commodity's words, and the requirement keywords - and all
 * three are read, because a deployment that fills in only one of them should
 * still get a lane that works.
 */
export function clientProduceWords(client = CLIENT) {
  const words = [
    ...client.catalogue.items.map((i) => i.label),
    ...(client.capacity.headlineCommodityWords || []),
    ...(client.keywords.requirement || []),
  ];
  const seen = new Set();
  const out = [];
  for (const raw of words) {
    const w = String(raw || '').toLowerCase().trim();
    if (w.length < 3 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function words(list, fallback) {
  if (!Array.isArray(list) || !list.length) return fallback;
  return list.map((w) => String(w).trim().toLowerCase()).filter(Boolean);
}

function gap(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The profile as the client configured it, with the engine's lists standing in
 * wherever it configured nothing.
 */
export function loadProfile(client = CLIENT) {
  const signals = client.signals || {};
  return {
    client: client.business.name || null,
    produce: [...FOOD_SERVICE, ...clientProduceWords(client)],
    requirement: words(signals.procurement, PROCUREMENT),
    opening: words(signals.opening, OPENING),
    venue: words(signals.venue, VENUE),
    near: {
      requirement: gap((signals.near || {}).requirement, 140),
      awareness: gap((signals.near || {}).awareness, 90),
    },
  };
}

export const PROFILE = loadProfile();

/**
 * A word-boundary alternation over a phrase list, longest first.
 *
 * Longest first because alternation takes the first branch that matches: with
 * "vegetable" ahead of "vegetables" every plural item would report the singular,
 * which is a small lie in the receipt about what we actually saw. The word
 * boundaries are not a nicety either - without them "mess" matches inside
 * "message", and this project has already shipped a digest led by three notices
 * called "Director's message".
 */
export function phraseRe(list) {
  return new RegExp(
    `\\b(${[...list]
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
      .join('|')})\\b`,
    'i'
  );
}

export const PRODUCE_RE = phraseRe(PROFILE.produce);
export const REQUIREMENT_RE = phraseRe(PROFILE.requirement);
export const OPENING_RE = phraseRe(PROFILE.opening);
export const VENUE_RE = phraseRe(PROFILE.venue);

/**
 * Does this text use procurement wording at all?
 *
 * The cheapest question in the pipeline, and the one that decides whether a
 * model is asked about an article. An expansion story does not contain the word
 * tender, and no amount of model reading will find a requirement in it.
 */
export function hasRequirementWording(text) {
  return REQUIREMENT_RE.test(String(text || ''));
}
