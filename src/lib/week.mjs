// ISO-8601 week helpers. Pure, deterministic, UTC-based.
// A week is written "2026-W37" and runs Monday to Sunday inclusive.

function utcDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** The Thursday of the ISO week containing this instant. */
function isoThursday(date) {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = t.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  t.setUTCDate(t.getUTCDate() + 4 - dayNumber);
  return t;
}

/** "2026-W37" for the ISO week containing the given date. */
export function isoWeek(date = new Date()) {
  const t = isoThursday(date instanceof Date ? date : utcDate(date));
  const year = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((t - jan1) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function parseWeek(week) {
  const m = String(week).match(/^(\d{4})-W(\d{2})$/);
  if (!m) throw new Error(`week must look like 2026-W37, got: ${week}`);
  const year = Number(m[1]);
  const week_ = Number(m[2]);
  if (week_ < 1 || week_ > 53) throw new Error(`week out of range: ${week}`);
  return { year, week: week_ };
}

/**
 * { start, end } as ISO dates - the Monday and the Sunday of that ISO week.
 * Throws when the week number does not exist in that year (e.g. 2026-W53 does,
 * 2025-W53 does not).
 */
export function weekRange(week) {
  const { year, week: n } = parseWeek(week);
  // 4 January is always in ISO week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
  const monday = new Date(week1Monday.getTime() + (n - 1) * 7 * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  if (isoWeek(monday) !== week) throw new Error(`no such ISO week: ${week}`);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

export function previousWeek(week) {
  const { start } = weekRange(week);
  const monday = new Date(`${start}T00:00:00.000Z`);
  return isoWeek(new Date(monday.getTime() - 7 * 86400000));
}

/** True when an ISO timestamp or date falls inside [start, end] of the week. */
export function inWeek(isoTimestamp, range) {
  if (!isoTimestamp) return false;
  const day = String(isoTimestamp).slice(0, 10);
  return day >= range.start && day <= range.end;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "07 Sep" - short, unambiguous, no locale dependency. */
export function shortDate(iso) {
  const d = utcDate(iso);
  if (!d) return String(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;
}

/** The n ISO dates ending at (and including) `endIso`, oldest first. */
export function lastDays(n, endIso) {
  const end = utcDate(endIso);
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}
