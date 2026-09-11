// Reading the closing date off a notice.
//
// A requirement without a deadline is a requirement the owner cannot prioritise,
// and a *wrong* deadline is worse than none: he would ring a body whose tender
// shut last week, or skip one that shuts tomorrow. So this reads only the date
// shapes Indian notices actually use, prefers a date that a label has announced
// as the closing date, and returns null rather than a guess.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function iso(y, m, d) {
  if (!(y >= 1970 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const parsed = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== s ? null : s;
}

/**
 * One date, as an Indian notice writes it. Day-first throughout: `05/09/2026` is
 * the fifth of September, which is what every one of these pages means by it.
 */
export function parseIndianDate(raw) {
  const s = String(raw || '').trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return iso(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(s))) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return iso(y, +m[2], +m[1]);
  }
  if ((m = /^(\d{1,2})\s*[-./ ]\s*([A-Za-z]{3,9})\.?\s*[-./, ]\s*(\d{2}|\d{4})$/.exec(s))) {
    const mm = MONTHS[m[2].toLowerCase()];
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return mm ? iso(y, mm, +m[1]) : null;
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
    const mm = MONTHS[m[1].toLowerCase()];
    return mm ? iso(+m[3], mm, +m[2]) : null;
  }
  return null;
}

const DATE_TOKEN =
  /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\s*[-./ ]\s*[A-Za-z]{3,9}\.?\s*[-./, ]\s*\d{2,4}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\b/g;

/** Every date in the text, in the order it appears, with where it was found. */
export function findDates(text) {
  const out = [];
  for (const m of String(text || '').matchAll(DATE_TOKEN)) {
    const value = parseIndianDate(m[1]);
    if (value) out.push({ date: value, raw: m[1].replace(/\s+/g, ' '), at: m.index });
  }
  return out;
}

const CLOSING_LABEL =
  /(?:last\s+date(?:\s*(?:&|and)\s*time)?(?:\s+(?:of|for)\s+[a-z ]{0,30})?|closing\s+date|bid\s+(?:submission\s+)?end(?:\s+date)?|due\s+date|last\s+day|submission\s+(?:date|deadline)|end\s+date|valid\s+(?:up\s*to|till|until))/gi;

const OPENING_LABEL = /(?:date\s+of\s+opening|bid\s+opening|opening\s+date|tender\s+opening)/gi;

/**
 * The closing date of a notice, or null.
 *
 * A labelled date wins. Failing that, the earliest date still in the future
 * wins, because that is the one a reader would treat as the deadline. A notice
 * carrying only past dates gets null, not its newest past date - "closes
 * yesterday" is not a lead and should not look like one.
 */
export function findDeadline(text, { todayIsoDate = new Date().toISOString().slice(0, 10) } = {}) {
  const s = String(text || '');
  for (const label of [CLOSING_LABEL, OPENING_LABEL]) {
    label.lastIndex = 0;
    let m;
    while ((m = label.exec(s)) !== null) {
      const window = s.slice(m.index, m.index + m[0].length + 60);
      const dates = findDates(window);
      if (dates.length) {
        return { deadline: dates[0].date, from: 'label', label: m[0].replace(/\s+/g, ' ').trim(), raw: dates[0].raw };
      }
    }
  }
  const future = findDates(s)
    .filter((d) => d.date >= todayIsoDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (future.length) return { deadline: future[0].date, from: 'earliest future date', raw: future[0].raw };
  return null;
}
