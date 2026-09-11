// Finding a person to call in a page of text.
//
// This is the difference between a lead and a link. A notice that says a body
// needs 1,500 kg of vegetables is a fact; a notice that also carries the store
// officer's number is something the owner can act on this morning.
//
// Everything here is a regex over text that was already fetched. Nothing is
// invented: a page with no number yields no number, and the caller is expected
// to say "contact not found yet" rather than fill the gap.

import { normalisePhone, normaliseEmail } from './normalise.mjs';

// A run of digits that could be a phone number, with the separators Indian
// pages actually use. The lookarounds keep it out of tender ids (2026_ABC_1234),
// PIN codes inside longer runs, and rupee figures written with commas.
//
// The separator class is horizontal only, deliberately. A PDF lays a table out
// one cell per line, and treating a newline as a separator glued "22.05.2024",
// "1" and "5" from three table cells into a ten-digit run that normalised to a
// plausible-looking mobile number. Nobody writes a phone number across three
// lines; a wrong number in the digest is the one failure this project cannot
// afford, and this is where it came from.
const SEP = '[ \\t.\\-]';
const PHONE_CANDIDATE = new RegExp(
  `(?<![\\d_])(?:(?:\\+|00)${SEP}?91${SEP}?)?(?:\\(?0\\d{1,4}\\)?${SEP}?)?\\d[\\d \\t.\\-]{7,15}\\d(?![\\d_])`,
  'g'
);

// dd.mm.yyyy, dd-mm-yyyy, yyyy-mm-dd and friends. A date is not a phone number,
// however many digits it has.
const DATE_SHAPED = /^\s*(?:\d{1,2}[.\-]\d{1,2}[.\-]\d{2,4}|\d{4}[.\-]\d{1,2}[.\-]\d{1,2})\s*$/;

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

// "name [at] domain [dot] co [dot] in" - the obfuscation government pages use
// most. The domain half repeats, so a three-label domain is read whole rather
// than truncated at the first "dot".
const AT = String.raw`\s*[\[({]?\s*(?:at|AT)\s*[\])}]?\s*`;
const DOT = String.raw`\s*[\[({]?\s*(?:dot|DOT)\s*[\])}]?\s*`;
const OBFUSCATED_EMAIL_RE = new RegExp(
  String.raw`([A-Za-z0-9._%+\-]+)${AT}((?:[A-Za-z0-9\-]+${DOT})+[A-Za-z]{2,})`,
  'g'
);
const DOT_ONLY = new RegExp(DOT, 'g');

/**
 * Is this digit run plausibly a phone number rather than a reference number
 * that happens to be ten digits long?
 *
 * A bare ten-digit run is accepted only when it starts 6-9, which is the Indian
 * mobile range. Anything with a country code, a leading zero or a separator has
 * already announced itself as a number someone dials.
 */
export function looksLikePhone(raw, e164) {
  if (!e164) return false;
  const s = String(raw).trim();
  if (DATE_SHAPED.test(s)) return false;
  const announced = /^(?:\+|00)[ \t]?91/.test(s) || /^\(?0/.test(s) || /[ \t.\-]/.test(s);
  if (announced) return true;
  return /^[6-9]/.test(e164.slice(3));
}

/** Every phone number in the text, normalised to E.164, in order, deduplicated. */
export function findPhones(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text || '').matchAll(PHONE_CANDIDATE)) {
    const raw = m[0].trim();
    const e164 = normalisePhone(raw.replace(/[()]/g, ''));
    if (!e164 || !looksLikePhone(raw, e164)) continue;
    if (seen.has(e164)) continue;
    seen.add(e164);
    out.push({ phone: e164, raw, at: m.index });
  }
  return out;
}

/**
 * Addresses that belong to the e-procurement portal, not to the buyer.
 *
 * Practically every Indian tender PDF ends with "in case of any difficulty
 * contact eproc@nic.in" or the CPPP 24x7 helpdesk. Reading one of those as the
 * buyer's contact is not a small cosmetic error: it puts a national helpdesk in
 * front of the owner as the person to ring about a hostel mess tender. They are
 * dropped, and a notice that carries nothing else has no contact - which is the
 * truth about that notice.
 */
export const PORTAL_CONTACTS =
  /^(?:eproc|cppp-?nic|support-?eproc|eprochelpdesk|helpdesk|support)@(?:nic\.in|gov\.in|gem\.gov\.in)$/i;

/** Every email in the text, including the "[at] ... [dot] ..." spelling. */
export function findEmails(text) {
  const s = String(text || '');
  const seen = new Set();
  const out = [];
  for (const m of s.matchAll(EMAIL_RE)) {
    const email = normaliseEmail(m[0]);
    if (!email || seen.has(email) || PORTAL_CONTACTS.test(email)) continue;
    seen.add(email);
    out.push({ email, raw: m[0], at: m.index, obfuscated: false });
  }
  for (const m of s.matchAll(OBFUSCATED_EMAIL_RE)) {
    const email = normaliseEmail(`${m[1]}@${m[2].replace(DOT_ONLY, '.')}`);
    if (!email || seen.has(email) || PORTAL_CONTACTS.test(email)) continue;
    seen.add(email);
    out.push({ email, raw: m[0].replace(/\s+/g, ' ').trim(), at: m.index, obfuscated: true });
  }
  return out.sort((a, b) => a.at - b.at);
}

// The labels that introduce a PERSON on an Indian notice or contact page. What
// follows one of these is a name, if it is anything.
const PERSON_LABEL =
  /(?:contact\s*(?:person|officer|details?)|name\s+of\s+the\s+(?:contact|officer)|nodal\s+officer|purchase\s+officer|store(?:s)?\s+officer|catering\s+officer|mess\s+(?:secretary|manager|in[-\s]?charge)|tender\s+inviting\s+authority|for\s+(?:any\s+)?(?:further\s+)?(?:details|clarifications?|information)\s*,?\s*(?:please\s+)?contact|contact)/i;

// Roles that are an answer in themselves. "Ask for the Deputy Registrar" is a
// usable instruction; it is not a name and is not labelled as one.
const DESIGNATION_RE =
  /(?:Deputy\s+Registrar|Assistant\s+Registrar|Registrar|Chief\s+Warden|Warden|Medical\s+Superintendent|Superintendent|Purchase\s+Officer|Stores?\s+Officer|Catering\s+Officer|Mess\s+Secretary|Mess\s+Manager|Estate\s+Officer|Executive\s+Engineer|Nodal\s+Officer|Dean|Director|Principal|Commissioner|Secretary)/i;

const HONORIFIC = /^(?:Shri|Sri|Smt|Dr|Mr|Mrs|Ms|Prof|Col|Maj|Capt)\b\.?/i;

const NOT_A_NAME =
  /^(?:The|And|For|All|Any|No|Details?|Number|Numbers|Phone|Mobile|Email|Address|Tender|Notice|Date|Time|Page|Please|Contact|Office|India|Sir|Madam|Attn|Hrs|Bid|Bids|Ref|Sealed|Open|Last|Website|Fax)$/i;

// A labelled name runs until the next field begins. On a one-line contact block
// - "Purchase Officer: Shri A Rao. Phone: 080-2293 2222" - the capture would
// otherwise swallow the phone number and offer the whole string as the person.
const NEXT_FIELD = /\s+(?:Phone|Ph|Tel|Telephone|Mobile|Mob|Email|E-?mail|Fax|Contact|Address|Room|Office)\b|\s*\d/i;

function untilNextField(raw) {
  return String(raw || '').split(NEXT_FIELD)[0];
}

function cleanName(raw) {
  const n = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:,\-]+/, '')
    .replace(/^the\s+/i, '')
    .replace(/[,;:.\-]+$/, '')
    .trim();
  if (n.length < 3 || n.length > 70) return null;
  return n;
}

/**
 * Does this read as a person, or as the next words on the page?
 *
 * The failure this guards against is real and was caught on a live IIT
 * Hyderabad notice: the word "Registrar" appeared, the next token was "Page"
 * from the page footer, and the extractor offered "Page" as the person to ask
 * for. A name is an honorific followed by something, or two or more capitalised
 * words, or a designation - and never a single ordinary word.
 */
export function looksLikePerson(name) {
  const n = String(name || '').trim();
  if (!n || NOT_A_NAME.test(n)) return false;
  if (DESIGNATION_RE.test(n)) return true;
  const words = n.split(/\s+/).filter(Boolean);
  if (words.some((w) => NOT_A_NAME.test(w.replace(/[.,]/g, '')))) return false;
  if (HONORIFIC.test(n) && words.length >= 2) return true;
  const capitalised = words.filter((w) => /^[A-Z]/.test(w) && /[A-Za-z]/.test(w));
  return capitalised.length >= 2 && capitalised.length === words.length;
}

/**
 * The person a notice points at, if it names one.
 *
 * A labelled line ("Contact Person: Shri R K Sharma") is read first. Failing
 * that, a bare designation ("The Deputy Registrar") is returned with
 * `kind: 'designation'` - that is who the owner asks for on the phone, so it is
 * a real answer, just not a name. Anything that passes neither test returns
 * null: the notice named nobody, and saying so is the correct output.
 */
export function findContactName(text) {
  const s = String(text || '').replace(/\r/g, '');
  const labelled = new RegExp(`${PERSON_LABEL.source}\\s*[:\\-]?\\s*([^\\n,;|]{3,70})`, 'gi');
  for (const m of s.matchAll(labelled)) {
    const name = cleanName(untilNextField(m[1]));
    if (name && looksLikePerson(name)) {
      return { name, kind: 'labelled', raw: m[0].replace(/\s+/g, ' ').trim().slice(0, 120) };
    }
    // The label may sit on its own line with the name under it.
    const trimmed = name ? cleanName(name.split(/\s{2,}/)[0]) : null;
    if (trimmed && trimmed !== name && looksLikePerson(trimmed)) {
      return { name: trimmed, kind: 'labelled', raw: m[0].replace(/\s+/g, ' ').trim().slice(0, 120) };
    }
  }
  const d = s.match(new RegExp(`(?:The\\s+)?${DESIGNATION_RE.source}`, 'i'));
  if (d) {
    const name = cleanName(d[0].replace(/^The\s+/i, ''));
    if (name) return { name, kind: 'designation', raw: name };
  }
  return null;
}

/**
 * Everything callable in one page of text.
 *
 * `complete` is what the digest cares about: a requirement with a phone or an
 * email is a lead, and a requirement with neither is a notice the owner would
 * have to chase himself.
 */
export function extractContacts(text) {
  const phones = findPhones(text);
  const emails = findEmails(text);
  const person = findContactName(text);
  return {
    phone: phones.length ? phones[0].phone : null,
    phones: phones.map((p) => p.phone),
    email: emails.length ? emails[0].email : null,
    emails: emails.map((e) => e.email),
    name: person ? person.name : null,
    nameKind: person ? person.kind : null,
    complete: Boolean(phones.length || emails.length),
  };
}

// ------------------------------------------------------------------ pages

/**
 * The pages on a site most likely to carry a phone number, in the order worth
 * trying. Relative to an origin; the caller still checks robots.txt for each.
 */
export const CONTACT_PATHS = [
  '/contact',
  '/contact-us',
  '/contactus',
  '/contact.html',
  '/contact-us.html',
  '/about/contact',
  '/pages/contact',
  '/reach-us',
];

/** Contact-page links already on a page, which beat guessing at paths. */
export function contactLinksFrom(links, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const l of links || []) {
    const text = String(l.text || '').toLowerCase();
    const href = String(l.href || '');
    if (!/contact|reach\s*us|get\s*in\s*touch|enquir/i.test(`${text} ${href}`)) continue;
    let abs;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/.test(abs) || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}
