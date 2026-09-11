// Normalisation helpers. Every one of these is pure and deterministic.

import { CLIENT } from '../client.mjs';

export const SEGMENTS = [
  'wholesale',
  'restaurant',
  'hotel',
  'caterer',
  'retailer',
  'food_manufacturer',
  'distributor',
  'institution',
  'other',
];

// `requirement` is the demand lane's kind: a buyer who has POSTED what he needs.
// `registration` is a standing way in for a new supplier, refreshed weekly.
export const KINDS = ['requirement', 'buyer', 'tender', 'signal', 'registration', 'price'];
export const STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost', 'ignored'];

/**
 * Indian phone numbers to E.164. Returns null when the input cannot be parsed
 * with confidence - we would rather store nothing than store a wrong number.
 */
export function normalisePhone(raw) {
  if (!raw) return null;
  // Some OSM values carry several numbers separated by ; or ,
  const first = String(raw).split(/[;,/]/)[0];
  let d = first.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  d = d.replace(/\D/g, '');
  if (d.startsWith('0091')) d = d.slice(4);
  else if (d.startsWith('91') && d.length >= 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  if (d.length !== 10) return null;
  if (!/^[1-9]/.test(d)) return null;
  return `+91${d}`;
}

export function normaliseEmail(raw) {
  if (!raw) return null;
  const first = String(raw).split(/[;,\s]+/).find((s) => s.includes('@'));
  if (!first) return null;
  const e = first.trim().toLowerCase().replace(/^mailto:/, '');
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e) ? e : null;
}

export function normaliseWebsite(raw) {
  if (!raw) return null;
  let u = String(raw).split(/[;\s]+/)[0].trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Comparison key for names: lowercase, punctuation and business suffixes removed. */
export function normaliseName(raw) {
  if (!raw) return '';
  return String(raw)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(
      /\b(pvt|private|ltd|limited|llp|inc|co|company|the|and|restaurant|hotel|store|stores)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function normaliseCity(raw) {
  if (!raw) return '';
  return String(raw).toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Operations the supplier does not target. A listing is dropped when it
 * identifies itself as one. The patterns come from the client profile, and this
 * is the only place they are tested: no copy this project generates anywhere
 * uses that wording.
 */
const EXCLUDED_RE = CLIENT.excludePatterns.length
  ? new RegExp(CLIENT.excludePatterns.join('|'), 'i')
  : /(?!)/;

export function isExcluded(text) {
  return EXCLUDED_RE.test(String(text || ''));
}

/** Map OpenStreetMap tags onto a buyer segment. */
export function segmentFromOsmTags(tags = {}) {
  if (tags.industrial === 'food') return 'food_manufacturer';
  if (tags.shop === 'wholesale') return 'wholesale';
  if (tags.tourism === 'hotel') return 'hotel';
  if (tags.craft === 'caterer') return 'caterer';
  if (tags.amenity === 'restaurant') return 'restaurant';
  if (tags.amenity === 'food_court') return 'restaurant';
  if (tags.shop === 'greengrocer' || tags.shop === 'supermarket') return 'retailer';
  if (tags.shop === 'trade' || tags.office === 'wholesale') return 'distributor';
  return 'other';
}

/** Human label for a segment, used in the digest and CSV. */
export function segmentLabel(segment) {
  return String(segment || 'other').replace(/_/g, ' ');
}

export function osmAddress(tags = {}) {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:suburb'],
    tags['addr:city'],
    tags['addr:postcode'],
  ].filter(Boolean);
  return parts.join(', ') || null;
}

export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function daysBetween(aIso, bIso) {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** Collapse whitespace and hard-cap a string. */
export function tidy(s, max = 240) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
