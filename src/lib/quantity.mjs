// Reading a stated quantity out of a notice, and deciding whether the supplier
// can fill it.
//
// A requirement that says "1,500 kg of vegetables per month" is worth more to
// the owner than one that says "as required", and one that says "50 MT per day"
// is worth less than both, because he cannot supply it. The score needs a
// number to say that with, so this turns the phrase into kilograms per day where
// the phrase carries enough to do it honestly, and returns null where it does
// not. A guessed quantity would move a score on nothing.

import { CAPACITY } from '../config.mjs';

// The words that mean "this notice is about the headline commodity", which has
// its own capacity ceiling. From the client profile, so a supplier whose
// headline line is not garlic changes one config entry and nothing else.
const HEADLINE_RE = new RegExp(
  `\\b(?:${CAPACITY.headlineCommodityWords.map((w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);

const UNIT_KG = {
  kg: 1,
  kgs: 1,
  kilo: 1,
  kilos: 1,
  kilogram: 1,
  kilograms: 1,
  quintal: 100,
  quintals: 100,
  qtl: 100,
  ton: 1000,
  tons: 1000,
  tonne: 1000,
  tonnes: 1000,
  mt: 1000,
  't': 1000,
};

const PER_DAY = {
  day: 1,
  daily: 1,
  week: 7,
  weekly: 7,
  fortnight: 14,
  month: 30,
  monthly: 30,
  quarter: 91,
  year: 365,
  annum: 365,
  yearly: 365,
  annual: 365,
};

const NUMBER = String.raw`(\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)`;
const UNIT = String.raw`(kgs?|kilograms?|kilos?|quintals?|qtl|tonnes?|tons?|mt)\b`;
// The period is rarely adjacent to the unit - "1,500 kg vegetables per month"
// puts a commodity between them - so a short gap is allowed. It stops at a full
// stop and at a line break, so a rate in the next sentence is never attached to
// a quantity in this one.
const PERIOD = String.raw`(?:(?:[^\n.]{0,40}?)\s*(?:per|\/|every)\s*(day|daily|week|weekly|fortnight|month|monthly|quarter|year|annum|yearly|annual)\b)?`;

const QUANTITY_RE = new RegExp(`${NUMBER}\\s*${UNIT}${PERIOD}`, 'gi');

function toNumber(raw) {
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The quantities a piece of text states, largest first.
 *
 * `kgPerDay` is filled only when the text names a period. A bare "1,500 kg" is
 * a real quantity and is returned as such, with `kgPerDay: null`, because a
 * total with no period is not a daily rate and pretending otherwise would be an
 * invention.
 */
export function findQuantities(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(QUANTITY_RE)) {
    const value = toNumber(m[1]);
    const unit = String(m[2]).toLowerCase();
    const factor = UNIT_KG[unit] ?? UNIT_KG[unit.replace(/s$/, '')] ?? null;
    if (value === null || factor === null) continue;
    const kg = value * factor;
    const periodWord = m[3] ? String(m[3]).toLowerCase() : null;
    const days = periodWord ? PER_DAY[periodWord] ?? null : null;
    const phrase = m[0].replace(/\s+/g, ' ').trim();
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    out.push({ phrase, value, unit, kg, period: periodWord, kgPerDay: days ? kg / days : null });
  }
  return out.sort((a, b) => b.kg - a.kg);
}

/** The one quantity worth printing next to a requirement: the largest stated. */
export function bestQuantity(text) {
  const all = findQuantities(text);
  return all.length ? all[0] : null;
}

export const FIT = ['within', 'small', 'over', 'unstated'];

/**
 * Can the supplier fill this?
 *
 * `within`   - inside the daily range he supplies today.
 * `small`    - real, but below the size at which a quote is worth the trip.
 * `over`     - larger than he can serve alone; still a lead, worth less.
 * `unstated` - the notice gives no number. Not a fault of the notice, and not a
 *              reason to rank it with the ones he cannot fill.
 */
export function quantityFit(quantity, { headline = false, capacity = CAPACITY } = {}) {
  if (!quantity) return 'unstated';
  const perDay = quantity.kgPerDay ?? quantity.kg;
  if (!Number.isFinite(perDay) || perDay <= 0) return 'unstated';
  const ceiling = headline ? capacity.headlineCommodityKgPerDay : capacity.kgPerDayMax;
  if (perDay < capacity.kgPerDayMin) return 'small';
  if (perDay > ceiling) return 'over';
  return 'within';
}

/**
 * Does this text talk about the headline commodity specifically? The capacity
 * ceiling differs, so the answer changes the fit.
 */
export function mentionsHeadlineCommodity(text) {
  return HEADLINE_RE.test(String(text || ''));
}
