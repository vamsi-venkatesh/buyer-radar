// A stand-in for the model, used when there is no API key.
//
// It is a crude keyword-and-number reader: it never sees the label, so what it
// scores is a real floor, not a rehearsal. Two things it is good for: proving
// the whole path works end to end without spending anything, and giving the
// real model a number to beat. Anything it gets right, the model must get right
// too; anything it gets wrong is not automatically hard.

const RULES = [
  [/404|page not found|cookie preferences|this blog does not/i, 'other'],
  [/tender|quotations are invited|bids close|hostel|canteen|mid-day|patient diet/i, 'institution'],
  [/catering|caterers/i, 'caterer'],
  [/supermarket|greengrocer|vegetable stores|fruit and vegetable outlets/i, 'retailer'],
  [/processing plant|iqf|we make |ready-to-cook|manufactur|freeze /i, 'food_manufacturer'],
  [/distribut|depots|refrigerated vans/i, 'distributor'],
  [/wholesale|apmc|mandi/i, 'wholesale'],
  [/\d+[- ]room|hotel/i, 'hotel'],
  [/restaurant|cover|seat/i, 'restaurant'],
];

function biggestNumber(text) {
  const found = String(text).match(/\b\d[\d,]*\b/g) || [];
  const numbers = found.map((n) => Number(n.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
  return numbers.length ? Math.max(...numbers) : null;
}

function firstDate(text) {
  const m = /\b(\d{2})-(\d{2})-(\d{4})\b/.exec(String(text));
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Answer the enrich contract from the input text. Returns a JSON string, as a provider would. */
export function stubEnrich(input) {
  const text = String(input);
  const rule = RULES.find((r) => r[0].test(text));
  const segment = rule ? rule[1] : 'other';

  let size = 'unknown';
  if (segment !== 'other') {
    const n = biggestNumber(text);
    if (n === null) size = 'unknown';
    else if (n >= 1000) size = 'large';
    else if (n >= 100) size = 'medium';
    else size = 'small';
  }

  const sentence = (text.split('Page text:').pop() || text).replace(/\s+/g, ' ').trim().slice(0, 120);

  return JSON.stringify({
    segment,
    size,
    buys: /vegetable|garlic|onion|potato|produce/i.test(text) ? ['vegetables'] : [],
    quantity: null,
    deadline: firstDate(text),
    evidence: sentence ? [sentence] : [],
    confidence: rule ? 0.8 : 0.3,
  });
}

/**
 * Answer the requirement contract from an article's text, the same crude way.
 *
 * It reads a requirement out of the words a demand article actually uses, takes
 * the first domain the article mentions as the organisation's site, and says so
 * at a confidence that clears the gate only when several of those words are
 * present. It knows nothing the text does not carry, which is the point: it
 * proves the lane runs end to end without spending anything, and any answer it
 * gets right the real model must get right too.
 */
export function stubRequirement(input) {
  const text = String(input);
  const article = (text.split('Article text:').pop() || text).replace(/\s+/g, ' ').trim();
  const demand = /tender|quotation|supply of|supplier|canteen|mess|hostel|caterer|catering|procure|requirement|opens|opening|expand/i.test(article);
  const produce = /vegetable|garlic|fruit|produce|grocer|food|meal|diet/i.test(article);
  const isRequirement = demand && produce;

  const headline = /Headline on record:\s*(.+)/.exec(text);
  const city = /City the search was run for:\s*(.+)/.exec(text);
  const qty = /\b\d[\d,]*\s*(?:kg|kgs|quintals?|tonnes?|tons?|mt)\b(?:[^.]{0,40}?(?:per|\/)\s*(?:day|week|month|year))?/i.exec(article);
  const site = /\b((?:www\.)?[a-z0-9-]+\.(?:com|in|org|net|co\.in|ac\.in|gov\.in))\b/i.exec(article);

  return JSON.stringify({
    is_requirement: isRequirement,
    organisation: headline ? headline[1].split(/ - | to | at /)[0].trim().slice(0, 120) : null,
    city: city ? city[1].trim() : null,
    requirement: isRequirement ? article.slice(0, 140) : null,
    quantity: qty ? qty[0].trim() : null,
    deadline: firstDate(article),
    contact_hint: null,
    site: site ? site[1] : null,
    evidence: article ? [article.slice(0, 120)] : [],
    confidence: isRequirement ? 0.8 : 0.2,
  });
}

/**
 * Answer whichever contract the system prompt is asking for. The prompt files
 * name themselves in their own wording, so the stub reads the same instructions
 * the model would and picks the matching answer.
 */
export function stubAnswer(messages) {
  const system = String(messages.find((m) => m.role === 'system')?.content || '');
  const user = String(messages.find((m) => m.role === 'user')?.content || '');
  if (/"is_requirement"/.test(system)) return stubRequirement(user);
  if (/two lines of plain text/.test(system)) {
    const name = /Business:\s*(.+)/.exec(user);
    const what = /Stated requirement:\s*(.+)/.exec(user) || /What it is:\s*(.+)/.exec(user);
    return [
      `Saw your ${what ? what[1].trim().slice(0, 60) : 'listing'}.`,
      'We supply peeled garlic and vegetables in Bengaluru - can I send rates?',
    ].join('\n') + (name ? '' : '');
  }
  return stubEnrich(user);
}

export default stubEnrich;
