// The demand lane: buyers who have POSTED a requirement.
//
// Fixtures marked REAL were fetched from the live site on 2026-09-11 with the
// project User-Agent and trimmed, never edited. Fixtures marked SYNTHETIC are
// built by tools/make-pdf-fixtures.mjs. No test in this file touches the
// network and none makes a model call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  pdfToText,
  findStreams,
  decodeStream,
  textFromContentStream,
  readLiteralString,
  readHexString,
  isReadableText,
} from '../src/lib/pdf-text.mjs';
import {
  findPhones,
  findEmails,
  findContactName,
  extractContacts,
  looksLikePerson,
  contactLinksFrom,
} from '../src/lib/contacts.mjs';
import { findQuantities, bestQuantity, quantityFit, mentionsHeadlineCommodity } from '../src/lib/quantity.mjs';
import { parseIndianDate, findDates, findDeadline } from '../src/lib/dates.mjs';
import { createCrawler, mapPool } from '../src/lib/crawl.mjs';
import * as institutions from '../src/sources/institutions.mjs';
import * as registrations from '../src/sources/registrations.mjs';
import * as exporters from '../src/sources/exporters.mjs';
import * as gem from '../src/sources/gem.mjs';
import * as openings from '../src/sources/openings.mjs';
import { parseRequirement, resolveSite, requirementInput } from '../src/llm/requirement.mjs';
import {
  toLead,
  scoreLead,
  scoreRequirement,
  opener,
  upsertLeads,
  phoneKey,
  nameCityKey,
  DEADLINE_POINTS,
  QUANTITY_FIT_POINTS,
  REQUIREMENT_CONTACT_POINTS,
  REQUIREMENT_PLACE_POINTS,
} from '../src/model.mjs';
import { renderDigest, splitForDigest, registrationsDue, requirementContact } from '../src/digest.mjs';
import { DIGEST_SECTIONS } from '../src/config.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f) => readFile(path.join(FIXTURES, f), 'utf8');
const readBin = (f) => readFile(path.join(FIXTURES, f));
const TODAY = '2026-09-11';

// ------------------------------------------------- institutional listings

test('REAL: the IIT Hyderabad tender page yields only the notices that match a keyword', async () => {
  const html = await read('institutions-iith-tenders.html');
  const links = institutions.extractNoticeLinks(html, 'https://www.iith.ac.in/tenders/');
  assert.ok(links.length >= 6, `found ${links.length} matching notices`);
  for (const link of links) {
    assert.match(link.url, /^https:\/\/www\.iith\.ac\.in\/assets\/files\/tenders\//, 'links are absolute');
    assert.ok(['mess', 'canteen'].includes(link.keyword), `keyword ${link.keyword}`);
    assert.ok(link.title.length > 10, 'the row lends its text as the title');
  }
  // The non-matching rows in the fixture - an AMC for electron microscopes,
  // solid waste management - must not appear. A demand lane that opens every
  // tender on the page is a crawler, not a lead finder.
  assert.ok(!links.some((l) => /JEOL|Solid Waste/i.test(l.title)), 'non-matching rows are ignored');
});

test('a notice whose only link is a Download button still gets the row text as its title', () => {
  const html =
    '<table><tr><td>Supply of fresh vegetables for the hostel mess 2026-27</td>' +
    '<td><a href="/docs/n1.pdf">Download</a></td></tr>' +
    '<tr><td>Purchase of laptops</td><td><a href="/docs/n2.pdf">Download</a></td></tr></table>';
  const links = institutions.extractNoticeLinks(html, 'https://x.ac.in/tenders/');
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://x.ac.in/docs/n1.pdf');
  assert.equal(links[0].via, 'table row');
  assert.match(links[0].title, /Supply of fresh vegetables/);
});

test('notice link extraction skips mailto, anchors and the listing page itself', () => {
  const html =
    '<a href="mailto:mess@x.ac.in">vegetables</a>' +
    '<a href="#vegetables">vegetables</a>' +
    '<a href="/tenders/">canteen</a>' +
    '<a href="/n.pdf">canteen supply notice</a>';
  const links = institutions.extractNoticeLinks(html, 'https://x.ac.in/tenders/');
  assert.deepEqual(links.map((l) => l.url), ['https://x.ac.in/n.pdf']);
});

test('keyword matching covers every documented word and nothing else', () => {
  const words = ['vegetable', 'vegetables', 'garlic', 'produce', 'perishable', 'mess', 'canteen', 'hostel supply', 'diet', 'kitchen supply'];
  for (const word of words) {
    assert.equal(institutions.matchedKeyword(`Tender for ${word} 2026`), word, word);
  }
  assert.equal(institutions.matchedKeyword('Annual maintenance contract for lifts'), null);
  assert.equal(institutions.matchedKeyword('Supply of FRESH VEGETABLES'), 'vegetables', 'case-insensitive, and the longest keyword wins');
  assert.equal(institutions.matchedKeyword('hostel   supply of items'), 'hostel supply', 'runs of whitespace match');
});

test('a keyword has to be a word: "message" is not a mess tender', () => {
  // The first real digest this lane produced led with three notices called
  // "Director's message" and "Commissioner's Message", because "mess" matched
  // inside "message". Every keyword is anchored on word boundaries.
  for (const title of ["Director's message", "Commissioner's Message", 'messenger service', 'dietary supplements', 'produced goods']) {
    assert.equal(institutions.matchedKeyword(title), null, title);
  }
  assert.equal(institutions.matchedKeyword('Providing Mess Services at Mess A'), 'mess');
  assert.equal(institutions.matchedKeyword('Supply of Diet articles to the hospital'), 'diet');
});

test('a probe record that found nothing reachable takes that entry out of the daily crawl', () => {
  const entry = { name: 'Dead University', domain: 'https://dead.ac.in', tender_paths: ['https://dead.ac.in/tenders'] };
  const probe = { entries: [{ name: 'Dead University', reachable: false, reason: 'HTTP 404' }] };
  assert.equal(institutions.skipFromProbe(entry, probe), 'HTTP 404');
  assert.equal(institutions.skipFromProbe(entry, { entries: [{ name: 'Dead University', reachable: true }] }), null);
  assert.equal(institutions.skipFromProbe(entry, null), null, 'no probe file means probe everything');
});

test('the shipped registry is well formed, and a probe file - if there is one - agrees with it', async () => {
  const registry = await institutions.loadRegistry();
  assert.ok(registry.length >= 40, `${registry.length} registry entries`);
  for (const e of registry) {
    assert.ok(e.name && e.city && e.state && e.category, `${e.name} is complete`);
    assert.doesNotMatch(e.category, /kitchen/i, 'no output-facing field uses that wording');
    for (const url of e.tender_paths) assert.match(url, /^https?:\/\//, `${e.name} path is absolute`);
  }

  // The probe file is a local crawl result - what answered this machine, on the
  // day it ran - so it is not committed here. `node tools/probe-institutions.mjs`
  // writes it, and with no probe file the daily run simply probes everything.
  const probe = await institutions.loadProbe();
  if (!probe) return;
  assert.equal(probe.entries.length, registry.length, 'every entry was probed');
  for (const r of probe.entries) {
    assert.equal(typeof r.reachable, 'boolean');
    assert.equal(typeof r.notice_links_found, 'number');
    if (!r.reachable) assert.ok(r.reason && r.reason.length > 5, `${r.name} records why`);
  }
});

// ------------------------------------------------------------------- PDFs

test('SYNTHETIC: an uncompressed content stream is read', async () => {
  const result = pdfToText(await readBin('pdf-notice-uncompressed.pdf'));
  assert.equal(result.ok, true);
  assert.match(result.text, /NOTICE INVITING TENDER/);
  assert.match(result.text, /1,500 kg vegetables per month/);
  assert.match(result.text, /Shri R\. K\. Sharma/);
});

test('SYNTHETIC: a FlateDecode content stream reads to exactly the same text', async () => {
  const flate = pdfToText(await readBin('pdf-notice-flate.pdf'));
  const plain = pdfToText(await readBin('pdf-notice-uncompressed.pdf'));
  assert.equal(flate.ok, true);
  assert.equal(flate.text, plain.text, 'the filter changes nothing about the words');
});

test('SYNTHETIC: a scanned page is unreadable, and says so rather than returning nothing', async () => {
  const result = pdfToText(await readBin('pdf-scanned-no-text.pdf'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreadable');
  assert.match(result.detail, /image/);
});

test('a buffer that is not a PDF is refused before anything is parsed', () => {
  assert.deepEqual(pdfToText(Buffer.from('<html>hello</html>')), { ok: false, reason: 'not a pdf' });
});

test('an image XObject is never mistaken for a content stream', async () => {
  const streams = findStreams(await readBin('pdf-scanned-no-text.pdf'));
  const image = streams.find((s) => /\/Subtype\s*\/Image/.test(s.dict));
  assert.ok(image, 'the fixture carries an image stream');
  assert.deepEqual(decodeStream(image), { ok: false, reason: 'image stream' });
});

test('PDF string escapes, octal codes and hex strings are decoded', () => {
  assert.equal(readLiteralString('(a\\(b\\)c)', 0).value, 'a(b)c');
  assert.equal(readLiteralString('(line\\nbreak)', 0).value, 'line\nbreak');
  assert.equal(readLiteralString('(\\101\\102)', 0).value, 'AB');
  assert.equal(readLiteralString('(outer (inner) end)', 0).value, 'outer (inner) end');
  assert.equal(readHexString('<48656C6C6F>', 0).value, 'Hello');
  assert.equal(readHexString('<4A4B4>', 0).value, 'JK@', 'an odd digit count is padded, as the spec says');
});

test('a TJ array becomes words: a wide gap is a space, a kerning pair is not', () => {
  // Many PDF writers never emit a space character at all - the gap between two
  // words is an adjustment in the TJ array. A small positive adjustment between
  // two glyphs of one word is kerning and must not become a space.
  const text = textFromContentStream('BT [(Supply of)-250(veg)] TJ 0 -14 Td [(Su) 20 (pply)] TJ ET');
  assert.equal(text, 'Supply of veg\nSupply');
});

test('text-positioning operators break the line and a string outside an array still shows', () => {
  assert.equal(textFromContentStream('BT (First line) Tj 0 -14 Td (Second line) Tj ET'), 'First line\nSecond line');
});

test('a font that carries its own encoding is called unreadable, not summarised', () => {
  const garbage = ' ' + 'ÍÛâ'.repeat(40);
  assert.equal(isReadableText(garbage), false);
  assert.equal(
    isReadableText('Sealed tenders are invited for the supply of fresh vegetables to the hostel mess this year'),
    true
  );
});

test('REAL: the mixed IIT Hyderabad notice gives up its contact, and it is the right one', async () => {
  const text = await read('institutions-iith-notice.txt');
  const contacts = extractContacts(text);
  assert.equal(contacts.email, 'office.admin@iith.ac.in');
  assert.equal(contacts.complete, true);
  // The bug this test exists for: the notice lays its schedule out one table
  // cell per line, and gluing those lines together produced a ten-digit run
  // that normalised to a plausible mobile number nobody has.
  assert.ok(!contacts.phones.includes('+912205202415'), 'a date split across lines is not a phone number');
  assert.ok(!contacts.phones.includes('+912405202410'), 'nor is the one after it');
  // And the second: "Registrar" followed by the page footer offered "Page" as
  // the person to ask for.
  assert.notEqual(contacts.name, 'Page');
});

// --------------------------------------------------------------- contacts

test('Indian phone formats normalise to E.164, and near misses do not', () => {
  const cases = [
    ['Phone: 040-2301 6773', '+914023016773'],
    ['Mobile +91 98450 12345', '+919845012345'],
    ['Tel: 011 2658 1234', '+911126581234'],
    ['(080) 2293 2222', '+918022932222'],
    ['call 9845012345', '+919845012345'],
    ['0091 98450 12345', '+919845012345'],
    ['+91-98450-12345', '+919845012345'],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(findPhones(text).map((p) => p.phone), [expected], text);
  }
  for (const text of ['dated 11-09-2026', 'Ref 2026_IITH_812345_1', 'EMD Rs 1,00,000', 'PIN 560001', 'valid 22.05.2024']) {
    assert.deepEqual(findPhones(text), [], text);
  }
});

test('emails are read plain and through the [at]/[dot] spelling, multi-label domains included', () => {
  const found = findEmails('write to stores[at]iisc[dot]ac[dot]in, info [at] nimhans [dot] ac [dot] in or purchase@iisc.ac.in');
  const emails = found.map((e) => e.email);
  assert.ok(emails.includes('stores@iisc.ac.in'), 'a three-label domain survives the first dot');
  assert.ok(emails.includes('info@nimhans.ac.in'));
  assert.ok(emails.includes('purchase@iisc.ac.in'));
  assert.ok(found.find((e) => e.email === 'stores@iisc.ac.in').obfuscated, 'and is marked as obfuscated');
});

test('the e-procurement helpdesk is not the buyer, and is never offered as one', () => {
  // Practically every Indian tender PDF ends with "in case of any difficulty
  // contact eproc@nic.in". The first real run offered that as the contact for
  // an IIT Hyderabad mess tender.
  assert.deepEqual(
    findEmails('In case of any difficulty contact eproc@nic.in or write to stores@iith.ac.in').map((e) => e.email),
    ['stores@iith.ac.in']
  );
  assert.deepEqual(findEmails('Helpdesk: eproc@nic.in').map((e) => e.email), [], 'and a notice with only that has no contact');
  assert.equal(extractContacts('Helpdesk: eproc@nic.in').complete, false);
});

test('a Contact block names a person, and a page that names nobody says nobody', () => {
  assert.equal(findContactName('Contact Person: Shri R. K. Sharma, Deputy Registrar').name, 'Shri R. K. Sharma');
  assert.equal(findContactName('Nodal Officer: Dr A Kumar').name, 'Dr A Kumar');
  assert.equal(findContactName('For further details contact the Deputy Registrar (Stores)').name, 'Deputy Registrar (Stores)');
  assert.equal(findContactName('Signed by the Medical Superintendent').kind, 'designation');
  assert.equal(findContactName('Contact: 9845012345'), null, 'a number is not a name');
  assert.equal(findContactName('Contact Person: Page'), null, 'a page footer is not a name');
  assert.equal(findContactName('No person is named anywhere on this notice.'), null);
});

test('looksLikePerson refuses a single ordinary word and accepts a role', () => {
  assert.equal(looksLikePerson('Page'), false);
  assert.equal(looksLikePerson('Tender'), false);
  assert.equal(looksLikePerson('Deputy Registrar'), true);
  assert.equal(looksLikePerson('Shri R K Sharma'), true);
  assert.equal(looksLikePerson('Sharma'), false);
});

test('contact links on a page beat guessing at paths', () => {
  const links = [
    { href: '/about', text: 'About us' },
    { href: '/contact-us', text: 'Contact us' },
    { href: 'https://other.example/reach-us', text: 'Reach us' },
  ];
  assert.deepEqual(contactLinksFrom(links, 'https://x.in/'), ['https://x.in/contact-us', 'https://other.example/reach-us']);
});

// --------------------------------------------------------------- quantity

test('a stated quantity becomes kilograms per day only when a period is stated', () => {
  assert.equal(bestQuantity('Supply of 1,500 kg vegetables per month').kgPerDay, 50);
  assert.equal(bestQuantity('requirement of 2 MT per day').kgPerDay, 2000);
  assert.equal(bestQuantity('Supply of 100 kg tomatoes').kgPerDay, null, 'a total is not a rate');
  assert.equal(bestQuantity('Supply of assorted vegetables as required'), null);
  assert.equal(
    bestQuantity('Supply of 100 kg tomatoes. The rate per day will be fixed.').kgPerDay,
    null,
    'the next sentence is not this quantity'
  );
});

test('quantity fit knows what the supplier can actually fill', () => {
  assert.equal(quantityFit(bestQuantity('800 kg of peeled garlic per day'), { headline: true }), 'within');
  assert.equal(quantityFit(bestQuantity('5 MT of peeled garlic per day'), { headline: true }), 'over');
  assert.equal(quantityFit(bestQuantity('50 MT per day of onion'), {}), 'over');
  assert.equal(quantityFit(bestQuantity('5 kg per day'), {}), 'small');
  assert.equal(quantityFit(null, {}), 'unstated');
  assert.equal(mentionsHeadlineCommodity('supply of garlic'), true);
  assert.equal(mentionsHeadlineCommodity('supply of onion'), false);
});

test('quantities come back largest first', () => {
  const all = findQuantities('10 kg onion, 2 tonnes potato and 50 kg carrot');
  assert.deepEqual(all.map((q) => q.kg), [2000, 50, 10]);
});

// ------------------------------------------------------------------ dates

test('Indian notices are read day-first, and a closing label beats a published date', () => {
  assert.equal(parseIndianDate('05/09/2026'), '2026-09-05');
  assert.equal(parseIndianDate('25-Sep-2026'), '2026-09-25');
  assert.equal(parseIndianDate('2026-09-25'), '2026-09-25');
  assert.equal(parseIndianDate('September 25, 2026'), '2026-09-25');
  assert.equal(parseIndianDate('31/02/2026'), null, 'a date that does not exist is refused');
  assert.equal(findDeadline('Published 01.08.2026. Last date of submission: 30/09/2026', { todayIsoDate: TODAY }).deadline, '2026-09-30');
  assert.equal(findDeadline('Published 11/09/2026 only', { todayIsoDate: TODAY }).from, 'earliest future date');
  assert.equal(
    findDeadline('Notice dated 01/01/2020 closed 05/01/2020', { todayIsoDate: TODAY }),
    null,
    'a notice with only past dates has no deadline'
  );
  assert.equal(findDates('nothing here').length, 0);
});

// ----------------------------------------------------------------- robots

test('robots.txt is fetched once per host and obeyed', async () => {
  const asked = [];
  const routes = {
    'https://x.in/robots.txt': 'User-agent: buyerradar\nDisallow: /private/\n',
    'https://x.in/tenders': '<html><body><p>Supply of vegetables</p></body></html>',
    'https://x.in/private/list': '<html><body><p>secret</p></body></html>',
  };
  const crawler = createCrawler({
    perHostPauseMs: 0,
    fetchImpl: async (url) => {
      asked.push(String(url));
      const body = routes[String(url)];
      if (body === undefined) return new Response('', { status: 404 });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
    },
  });
  const allowed = await crawler.fetchDoc('https://x.in/tenders');
  assert.equal(allowed.ok, true);
  const refused = await crawler.fetchDoc('https://x.in/private/list');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /robots\.txt disallows \/private\/list for buyerradar/);
  assert.equal(asked.filter((u) => u.endsWith('/robots.txt')).length, 1, 'robots.txt is read once per host');
  assert.ok(!asked.includes('https://x.in/private/list'), 'the disallowed page is never requested');
});

test('a URL is fetched once per run, however many notices point at it', async () => {
  let hits = 0;
  const crawler = createCrawler({
    perHostPauseMs: 0,
    fetchImpl: async (url) => {
      if (String(url).endsWith('robots.txt')) return new Response('', { status: 404 });
      hits += 1;
      return new Response('<p>Supply of fresh vegetables to the hostel mess this year</p>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    },
  });
  await crawler.fetchDoc('https://y.in/n.html');
  const second = await crawler.fetchDoc('https://y.in/n.html');
  assert.equal(hits, 1);
  assert.equal(second.cached, true);
});

test('the deadline covers the response body, not just the headers', async () => {
  // A server that sends headers and then stalls the body hung a real
  // institutional crawl indefinitely: the abort timer had already been cleared
  // when fetch resolved, and mapPool waits for every lane.
  const stalling = new Response(
    new ReadableStream({
      start() {
        /* headers sent, body never arrives and never closes */
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  );
  const crawler = createCrawler({
    perHostPauseMs: 0,
    timeoutMs: 50,
    fetchImpl: async (url) => {
      if (String(url).endsWith('robots.txt')) return new Response('', { status: 404 });
      return stalling;
    },
  });
  const result = await crawler.fetchDoc('https://stalls.example/notice.html');
  assert.equal(result.ok, false);
  assert.match(result.reason, /AbortError|aborted|TimeoutError/i, `reason was: ${result.reason}`);
});

test('the LLM stage page fetcher observes the same deadline on the body', async () => {
  const { createPageFetcher } = await import('../src/llm/page.mjs');
  const stalling = () =>
    new Response(new ReadableStream({ start() { /* headers sent, body never arrives */ } }), {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  const pages = createPageFetcher({
    perHostPauseMs: 0,
    timeoutMs: 50,
    fetchImpl: async (url) => (String(url).endsWith('robots.txt') ? new Response('', { status: 404 }) : stalling()),
  });
  const result = await pages.fetchText('https://stalls.example/page.html');
  assert.equal(result.ok, false);
  assert.match(result.reason, /AbortError|aborted|TimeoutError/i, `reason was: ${result.reason}`);
});

test('mapPool keeps input order however the lanes interleave', async () => {
  const out = await mapPool([5, 1, 3, 2], 3, async (n) => {
    await new Promise((r) => setTimeout(r, n));
    return n;
  });
  assert.deepEqual(out, [5, 1, 3, 2]);
});

// ------------------------------------------------------ requirement score

function requirementLead(over = {}) {
  return toLead(
    {
      kind: 'requirement',
      segment: 'institution',
      name: 'Example Institute',
      city: 'Bengaluru',
      state: 'Karnataka',
      source: 'institutions',
      externalId: over.externalId || 'n1',
      requirement: 'Supply of fresh vegetables to the hostel mess',
      quantity: '1,500 kg vegetables per month',
      deadline: '2026-09-15',
      contact_name: 'Deputy Registrar',
      contact_phone: '+919845012345',
      contact_email: 'stores@example.ac.in',
      document_url: 'https://example.ac.in/n.pdf',
      phone: '+919845012345',
      email: 'stores@example.ac.in',
      extra: { quantityFit: 'within' },
      ...over,
    },
    { nowIso: `${TODAY}T06:00:00.000Z` }
  );
}

test('the candidate fields the demand lane promises land on the lead under those names', () => {
  const lead = requirementLead();
  assert.equal(lead.kind, 'requirement');
  for (const field of ['requirement', 'quantity', 'deadline', 'contact_name', 'contact_phone', 'contact_email', 'document_url']) {
    assert.ok(lead.extra[field], `extra.${field} is carried`);
  }
});

test('a requirement is scored on its own four facts, and the total is the sum', () => {
  const lead = requirementLead();
  const { score, parts, inputs } = scoreRequirement(lead, { city: 'Bengaluru', state: 'Karnataka', todayIsoDate: TODAY });
  assert.equal(parts.deadline, DEADLINE_POINTS.within7);
  assert.equal(parts.quantityFit, QUANTITY_FIT_POINTS.within);
  assert.equal(parts.contact, REQUIREMENT_CONTACT_POINTS.phone_and_email);
  assert.equal(parts.place, REQUIREMENT_PLACE_POINTS.city);
  assert.equal(score, 100);
  assert.equal(inputs.scale, 'requirement');
  assert.equal(scoreLead(lead, { city: 'Bengaluru', state: 'Karnataka', todayIsoDate: TODAY }).score, 100, 'scoreLead routes by kind');
});

test('a closed requirement scores zero on its deadline and never looks urgent', () => {
  const lead = requirementLead({ deadline: '2026-08-01' });
  const { parts } = scoreRequirement(lead, { city: 'Bengaluru', todayIsoDate: TODAY });
  assert.equal(parts.deadline, DEADLINE_POINTS.closed);
});

test('a requirement with no contact scores below one with a phone, on the same notice', () => {
  const withPhone = requirementLead();
  const without = requirementLead({
    externalId: 'n2',
    phone: null,
    email: null,
    contact_phone: null,
    contact_email: null,
    contact_name: null,
  });
  const opts = { city: 'Bengaluru', state: 'Karnataka', todayIsoDate: TODAY };
  assert.ok(scoreRequirement(without, opts).score < scoreRequirement(withPhone, opts).score);
  assert.equal(scoreRequirement(without, opts).parts.contact, REQUIREMENT_CONTACT_POINTS.none);
});

test('a quantity the supplier cannot fill scores below one it can, and below one not stated', () => {
  const opts = { city: 'Bengaluru', todayIsoDate: TODAY };
  const over = scoreRequirement(requirementLead({ externalId: 'a', extra: { quantityFit: 'over' } }), opts).score;
  const within = scoreRequirement(requirementLead({ externalId: 'b', extra: { quantityFit: 'within' } }), opts).score;
  const unstated = scoreRequirement(requirementLead({ externalId: 'c', extra: { quantityFit: 'unstated' } }), opts).score;
  assert.ok(over < unstated && unstated < within);
});

test('the state counts for something when the city does not match', () => {
  const opts = { city: 'Chennai', state: 'Karnataka', todayIsoDate: TODAY };
  assert.equal(scoreRequirement(requirementLead(), opts).parts.place, REQUIREMENT_PLACE_POINTS.state);
});

test('the opener for a requirement quotes for what they asked for', () => {
  assert.equal(opener(requirementLead()), 'We can quote for supply of fresh vegetables to the hostel mess.');
  assert.equal(opener({ kind: 'requirement', extra: {} }), 'We can quote for your posted requirement.');
});

// ----------------------------------------------------------------- digest

function buyerLead(i) {
  const lead = toLead(
    {
      kind: 'buyer',
      segment: 'wholesale',
      name: `Wholesaler ${i}`,
      city: 'Bengaluru',
      phone: `+9198450000${String(i).padStart(2, '0')}`,
      source: 'overpass',
      externalId: `node/${i}`,
    },
    { nowIso: `${TODAY}T06:00:00.000Z` }
  );
  lead.score = scoreLead(lead, { city: 'Bengaluru', todayIsoDate: TODAY }).score;
  return lead;
}

function scored(lead) {
  lead.score = scoreLead(lead, { city: 'Bengaluru', state: 'Karnataka', todayIsoDate: TODAY }).score;
  return lead;
}

test('requirements come before buyers however the scores fall', () => {
  // A deliberately weak requirement against a strong buyer: section order is
  // not a consequence of the numbers and must not become one.
  const weak = scored(
    requirementLead({
      externalId: 'weak',
      deadline: null,
      phone: null,
      email: null,
      contact_phone: null,
      contact_email: null,
      contact_name: null,
      extra: { quantityFit: 'over' },
    })
  );
  const strong = buyerLead(1);
  assert.ok(weak.score < strong.score, 'the requirement really does score lower');
  const digest = renderDigest([strong, weak], { date: TODAY, city: 'Bengaluru' });
  assert.ok(digest.text.indexOf('REQUIREMENTS POSTED') < digest.text.indexOf('BUYERS TO APPROACH'));
  assert.equal(digest.index.R1, weak.id);
  assert.equal(digest.index.L1, strong.id);
});

test('the digest prints what was posted: quantity, deadline, contact, link and one opener line', () => {
  const digest = renderDigest([scored(requirementLead())], { date: TODAY, city: 'Bengaluru' });
  assert.match(digest.text, /Supply of fresh vegetables to the hostel mess/);
  assert.match(digest.text, /1,500 kg vegetables per month - closes 2026-09-15/);
  assert.match(digest.text, /\+919845012345 - Deputy Registrar/);
  assert.match(digest.text, /"We can quote for supply of fresh vegetables/);
  assert.match(digest.full, /https:\/\/example\.ac\.in\/n\.pdf/);
});

test('a requirement with no contact says so instead of showing an empty field', () => {
  const lead = scored(
    requirementLead({ externalId: 'nc', phone: null, email: null, contact_phone: null, contact_email: null, contact_name: null })
  );
  assert.equal(requirementContact(lead), 'contact not found yet');
  assert.match(renderDigest([lead], { date: TODAY, city: 'Bengaluru' }).text, /contact not found yet/);
});

test('a day with no requirement says so plainly rather than leaving a gap', () => {
  const digest = renderDigest([buyerLead(1)], { date: TODAY, city: 'Bengaluru' });
  assert.match(digest.text, /No requirement was posted anywhere we can read today\./);
  assert.equal(digest.requirementsShown, 0);
});

test('the WhatsApp cap holds, and the full sheet is the one that keeps everything', () => {
  const leads = [
    ...Array.from({ length: 12 }, (_, i) =>
      scored(requirementLead({ externalId: `r${i}`, name: `Institute Number ${i} With A Long Name` }))
    ),
    ...Array.from({ length: 20 }, (_, i) => buyerLead(i)),
  ];
  const digest = renderDigest(leads, { date: TODAY, city: 'Bengaluru' });
  assert.ok(digest.text.length <= 1500, `${digest.text.length} chars`);
  assert.ok(digest.full.length > digest.text.length, 'the sheet carries more than the message');
  assert.equal(digest.requirementsConsidered, 12);
  // Whatever was dropped to fit, it was not every posted requirement.
  assert.ok(digest.requirementsShown >= 1, 'a requirement survives the cap');
});

test('when the cap bites it is the buyers that are squeezed, not the requirements', () => {
  // The failure this pins: a real digest put the requirements into two clipped
  // lines - "office.admin@iith.a." - while six buyers each kept a three-line
  // block with an opener. The scarce thing must not be the thing that gets cut.
  const leads = [
    ...Array.from({ length: 4 }, (_, i) =>
      scored(requirementLead({ externalId: `r${i}`, name: `Indian Institute of Technology Number ${i}` }))
    ),
    ...Array.from({ length: 30 }, (_, i) => buyerLead(i)),
  ];
  const digest = renderDigest(leads, { date: TODAY, city: 'Bengaluru' });
  assert.ok(digest.text.length <= 1500);
  assert.equal(digest.requirementsShown, 4, 'every requirement is still shown');
  assert.ok(digest.buyersShown < DIGEST_SECTIONS.buyers, 'buyers gave up the room');
  // The requirement keeps its own line saying what they need - the first thing
  // the tight layout throws away.
  assert.match(digest.text, /Supply of fresh vegetables to the hostel mess/);
});

test('the digest index numbers each section in its own series', () => {
  const registration = toLead(
    {
      kind: 'registration',
      segment: 'retailer',
      name: 'A Platform',
      source: 'registrations',
      externalId: 'p1',
      requirement: 'fresh produce',
      document_url: 'https://p.example/supplier',
    },
    { nowIso: `${TODAY}T06:00:00.000Z` }
  );
  const digest = renderDigest([scored(requirementLead()), buyerLead(1), scored(registration)], {
    date: '2026-09-14', // a Monday
    city: 'Bengaluru',
  });
  assert.deepEqual(Object.keys(digest.index).sort(), ['G1', 'L1', 'R1']);
});

test('three notices from one institution stay three requirements', () => {
  // They share a name, a city and the same switchboard number, so both dedup
  // keys would otherwise collapse them into one lead - and the first real
  // digest showed what that costs: a row claiming its document could not be
  // read while displaying a contact taken from a different document.
  const notices = ['n1', 'n2', 'n3'].map((id) =>
    requirementLead({ externalId: id, document_url: `https://example.ac.in/${id}.pdf` })
  );
  const folded = upsertLeads([], notices);
  assert.equal(folded.leads.length, 3);
  assert.equal(folded.duplicateCount, 0);
  for (const lead of notices) {
    assert.equal(phoneKey(lead), null, 'a shared switchboard number is not an identity');
    assert.equal(nameCityKey(lead), null, 'nor is the institution name');
  }
  // A buyer is still deduplicated exactly as it was before.
  const a = buyerLead(1);
  const b = buyerLead(1);
  assert.ok(phoneKey(a), 'a buyer still matches on its phone');
  assert.equal(upsertLeads([a], [{ ...b, id: 'different-id' }]).leads.length, 1);
});

test('splitForDigest shows only leads the owner has not worked yet', () => {
  const worked = scored(requirementLead({ externalId: 'w' }));
  worked.status = 'contacted';
  const fresh = scored(requirementLead({ externalId: 'f' }));
  const sets = splitForDigest([worked, fresh]);
  assert.deepEqual(sets.requirements.map((l) => l.id), [fresh.id]);
});

// ---------------------------------------------------------- registrations

test('the registration section is weekly, on Mondays, and silent the rest of the week', () => {
  assert.equal(registrations.isDue('2026-09-14').due, true, 'Monday');
  for (const day of ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-15']) {
    const due = registrations.isDue(day);
    assert.equal(due.due, false, day);
    assert.match(due.reason, /weekly, on Monday/);
  }
  assert.equal(registrationsDue('2026-09-14'), true);
  assert.equal(registrationsDue('2026-09-11'), false);
});

test('a run on a day that is not Monday fetches no registration page at all', async () => {
  let fetched = 0;
  const result = await registrations.fetch({
    todayIsoDate: '2026-09-11',
    registry: [{ name: 'X', url: 'https://x.in/supplier' }],
    crawler: {
      fetchDoc: async () => {
        fetched += 1;
        return { ok: true, text: '' };
      },
      stats: () => ({}),
    },
  });
  assert.deepEqual(result.candidates, []);
  assert.equal(fetched, 0, 'nothing is asked of anybody on a Friday');
  assert.equal(result.detail.due, false);
});

test('a registration entry records whether its page is live and never invents a contact', async () => {
  const registry = [
    { name: 'Live Platform', url: 'https://live.in/supplier', buys: 'fruit and vegetables', how: 'fill the form', type: 'agri_b2b', city: 'Bengaluru' },
    { name: 'Dead Platform', url: 'https://dead.in/supplier', buys: 'vegetables', how: 'email the team', type: 'modern_trade' },
  ];
  const result = await registrations.fetch({
    todayIsoDate: '2026-09-14',
    registry,
    concurrency: 1,
    crawler: {
      stats: () => ({}),
      fetchDoc: async (url) =>
        url.includes('live.in')
          ? { ok: true, status: 200, text: 'Supplier onboarding. Call 080-2293 2222 or write to vendors@live.in' }
          : { ok: false, status: 404, reason: 'HTTP 404' },
    },
  });
  const [live, dead] = result.candidates;
  assert.equal(live.kind, 'registration');
  assert.equal(live.segment, 'distributor');
  assert.equal(live.extra.live, true);
  assert.equal(live.contact_phone, '+918022932222');
  assert.equal(live.extra.contactFromPage, true);
  assert.equal(dead.extra.live, false);
  assert.equal(dead.extra.status, 404);
  assert.equal(dead.contact_phone, null, 'a page that did not answer publishes no contact');
  assert.equal(dead.contact_email, null);
  assert.equal(result.detail.live, 1);
});

test('the shipped registration registry is complete and carries no invented contact', async () => {
  const registry = await registrations.loadRegistry();
  assert.ok(registry.length >= 15, `${registry.length} entries`);
  for (const e of registry) {
    assert.match(e.url, /^https?:\/\//);
    assert.ok(e.buys && e.how, `${e.name} says what it buys and how to register`);
    assert.ok(e.contact === null || typeof e.contact === 'string');
  }
});

// -------------------------------------------------------------------- GeM

const GEM_ASSUMED_BODY = JSON.stringify({
  response: {
    response: {
      numFound: 2,
      docs: [
        {
          b_bid_number: 'GEM/2026/B/1234567',
          b_category_name: 'Fresh Vegetables',
          b_total_quantity: 1500,
          b_unit: 'Kilogram',
          b_bid_end_date_sort: '2026-09-30T15:00:00Z',
          ba_official_details_deptName: ['Department of Health and Family Welfare'],
          ba_official_details_officeZone: ['Bengaluru'],
        },
        { b_bid_number: 'GEM/2026/B/7654321', b_category_name: 'Peeled Garlic', b_total_quantity: 50000, b_unit: 'Kilogram' },
      ],
    },
  },
});

test('the GeM client reads the response shape this project documents as assumed', () => {
  const parsed = gem.parseBids(GEM_ASSUMED_BODY, { keyword: 'vegetables', todayIsoDate: TODAY });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.candidates.length, 2);
  const [veg, garlic] = parsed.candidates;
  assert.equal(veg.kind, 'requirement');
  assert.equal(veg.name, 'Department of Health and Family Welfare');
  assert.equal(veg.deadline, '2026-09-30');
  assert.equal(veg.quantity, '1500 Kilogram');
  assert.match(veg.document_url, /showbidDocument/);
  assert.equal(veg.contact_phone, null, 'GeM publishes no buyer contact and the lane never claims one');
  assert.equal(veg.extra.shape, 'assumed');
  assert.equal(garlic.extra.mentionsHeadline, true);
  assert.equal(garlic.extra.quantityFit, 'over', '50 tonnes is more than the supplier can fill');
});

test('a GeM body of the wrong shape produces nothing at all, never a coerced guess', () => {
  for (const body of ['not json', '{}', '{"response":{}}', '{"response":{"response":{"docs":{}}}}']) {
    const parsed = gem.parseBids(body);
    assert.equal(parsed.ok, false, body);
    assert.match(parsed.reason, /unrecognised shape/);
    assert.deepEqual(parsed.candidates, []);
  }
  // A doc missing the two fields the candidate is built from is skipped, not
  // filled in from somewhere else.
  const partial = gem.parseBids(JSON.stringify({ response: { response: { docs: [{ b_bid_number: 'GEM/1' }] } } }));
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.candidates, []);
});

test('the GeM lane is off unless it is switched on, and says why', async () => {
  assert.equal(gem.enabled({}), false);
  assert.equal(gem.enabled({ GEM_ENABLED: 'true' }), true);
  const result = await gem.fetch({ env: {} });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.blocked.kind, 'disabled');
  assert.match(result.blocked.reason, /timed out at the TCP connect stage/);
});

test('the GeM search body carries the keyword and the token the page gave us', () => {
  const body = gem.searchBody({ keyword: 'garlic', csrf: 'abc123' });
  const form = new URLSearchParams(body);
  assert.equal(form.get('csrf_bd_gem_nk'), 'abc123');
  assert.equal(JSON.parse(form.get('payload')).param.searchBid, 'garlic');
  assert.equal(gem.readCsrf('<input name="csrf_bd_gem_nk" value="tok" />'), 'tok');
  assert.equal(gem.readCsrf('<html></html>'), null);
});

// -------------------------------------------------------------- exporters

test('REAL: the APEDA directory listing parses into buyers with an address and no contact', async () => {
  const html = await read('exporters-apeda-letter-a.html');
  const rows = exporters.parseApedaListing(html, { letter: 'A' });
  assert.ok(rows.length >= 10, `${rows.length} exporters`);
  const candidate = exporters.buildCandidate(rows[0]);
  assert.equal(candidate.kind, 'buyer');
  assert.equal(candidate.segment, 'food_manufacturer');
  assert.ok(candidate.address.length > 10);
  assert.equal(candidate.phone, null);
  assert.equal(candidate.email, null);
  assert.match(candidate.extra.contactNotFound, /captcha-gated enquiry form/);
  assert.ok(rows.find((r) => /vegetable/i.test(r.product || '')), 'the directory states what each exporter deals in');
});

// ------------------------------------------------------- the openings lane

test('a model answer must state whether it found a requirement, and how sure it is', () => {
  assert.equal(parseRequirement('{"is_requirement":true,"confidence":0.8}').ok, true);
  assert.equal(parseRequirement('{"confidence":0.8}').ok, false);
  assert.equal(parseRequirement('{"is_requirement":true}').ok, false);
  assert.equal(parseRequirement('sorry, I cannot').ok, false);
  const loose = parseRequirement('{"is_requirement":true,"confidence":1.7,"deadline":"next month"}');
  assert.equal(loose.value.confidence, 1, 'a sloppy number is clamped down');
  assert.equal(loose.value.deadline, null, 'a vague phrase is not a date');
  assert.equal(loose.value.deadlineDropped, 'next month', 'and what was dropped is recorded');
});

test('the crawler is never pointed at a search engine, a news site or a social page', () => {
  assert.equal(resolveSite('www.thehotel.in').url, 'https://www.thehotel.in');
  for (const bad of ['google.com/search?q=x', 'www.facebook.com/thehotel', 'timesofindia.indiatimes.com/x', 'zomato.com/thehotel']) {
    const r = resolveSite(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.reason, /refused host/);
  }
  assert.equal(resolveSite(null).ok, false);
  assert.equal(resolveSite('not a host').ok, false);
});

test('the site falls back to a link in the article that names the organisation, and no further', () => {
  const html = '<a href="https://sunrisehotels.in/">Sunrise Hotels official site</a><a href="https://google.com/s">more</a>';
  const found = openings.siteFromArticle(
    { organisation: 'Sunrise Hotels Bengaluru', site: null },
    { html, articleUrl: 'https://paper.example/story' }
  );
  assert.equal(found.ok, true);
  assert.equal(found.url, 'https://sunrisehotels.in');
  assert.match(found.from, /names Sunrise Hotels Bengaluru/);

  const nothing = openings.siteFromArticle({ organisation: 'Nobody', site: null }, { html, articleUrl: 'https://paper.example/story' });
  assert.equal(nothing.ok, false, 'no search engine is queried as a third fallback');
});

test('a signal becomes a requirement only once a contact has been read off the site', async () => {
  const pages = {
    'https://sunrisehotels.in': '<html><body><p>Sunrise Hotels, Bengaluru.</p><a href="/contact-us">Contact us</a></body></html>',
    'https://sunrisehotels.in/contact-us': '<html><body><p>Purchase Officer: Shri A Rao. Phone: 080-2293 2222</p></body></html>',
  };
  const crawler = {
    fetchDoc: async (url) =>
      pages[url] ? { ok: true, url, html: pages[url], text: pages[url].replace(/<[^>]+>/g, ' ') } : { ok: false, reason: 'HTTP 404' },
  };
  const found = await openings.findContactOnSite('https://sunrisehotels.in', { crawler });
  assert.equal(found.ok, true);
  assert.equal(found.contacts.phone, '+918022932222');
  assert.equal(found.contacts.name, 'Shri A Rao');
  assert.equal(found.url, 'https://sunrisehotels.in/contact-us');
});

test('a site with no contact anywhere leaves the lead a signal and records the reason', async () => {
  const crawler = { fetchDoc: async (url) => ({ ok: true, url, html: '<p>About us</p>', text: 'About us and nothing else' }) };
  const found = await openings.findContactOnSite('https://quiet.example', { crawler });
  assert.equal(found.ok, false);
  assert.match(found.reason, /no phone or email/);

  const lead = { id: 'l1', kind: 'signal', name: 'Quiet Hotel opens', extra: {} };
  openings.markNoContact(lead, {
    reason: found.reason,
    answer: { requirement: 'produce for a new hotel', confidence: 0.9, evidence: [] },
    promptVersion: 'requirement/2026-09-11a',
  });
  assert.equal(lead.kind, 'signal', 'it is still only a signal');
  assert.equal(lead.extra.contactComplete, false);
  assert.match(lead.extra.contactNotFound, /no phone or email/);
});

test('an upgraded signal carries the requirement, the contact and where the contact came from', () => {
  const lead = {
    id: 'l1',
    kind: 'signal',
    name: 'Sunrise Hotels opens 40 outlets',
    city: 'Bengaluru',
    phone: null,
    email: null,
    website: null,
    why_now: 'reported 2026-09-10',
    extra: { whyNowDate: '2026-09-10' },
  };
  openings.applyRequirement(lead, {
    answer: {
      organisation: 'Sunrise Hotels',
      requirement: 'fresh produce for 40 new outlets',
      quantity: '1,500 kg vegetables per month',
      deadline: '2026-10-01',
      confidence: 0.9,
      evidence: ['will open 40 outlets'],
      promptVersion: 'requirement/2026-09-11a',
      siteFrom: 'the article',
    },
    contacts: { phone: '+918022932222', email: null, name: 'Shri A Rao' },
    contactUrl: 'https://sunrisehotels.in/contact-us',
    site: 'https://sunrisehotels.in',
    articleUrl: 'https://paper.example/story',
    todayIsoDate: TODAY,
  });
  assert.equal(lead.kind, 'requirement');
  assert.equal(lead.phone, '+918022932222');
  assert.equal(lead.extra.contact_name, 'Shri A Rao');
  assert.equal(lead.extra.deadline, '2026-10-01');
  assert.equal(lead.extra.whyNowDate, '2026-10-01', 'the deadline becomes the date the score reads');
  assert.equal(lead.extra.quantityFit, 'within');
  assert.equal(lead.extra.contactFoundOn, 'https://sunrisehotels.in/contact-us');
  assert.match(lead.why_now, /closes 2026-10-01/);
});

test('only signals that say something about demand are worth a model call', () => {
  const make = (id, name) => ({ id, kind: 'signal', source: 'news', source_url: `https://n/${id}`, name, score: 40, extra: {} });
  const chosen = openings.selectSignals(
    [
      make('a', 'New hotel opening in Bengaluru next month'),
      make('b', 'Cricket match report'),
      make('c', 'Canteen tender floated by the railway'),
      { ...make('d', 'Hotel expansion'), extra: { opening: { promptVersion: 'v1' } } },
    ],
    { limit: 10, promptVersion: 'v1' }
  );
  // Requirement candidates first, awareness after: 'c' is a posted tender and
  // 'a' is an opening story the lane will keep without paying to read it.
  assert.deepEqual(chosen.map((l) => l.id), ['c', 'a'], 'b says nothing about demand, d was already read');
  assert.equal(openings.tierOf(chosen[0]), 'requirement_candidate');
  assert.equal(openings.tierOf(chosen[1]), 'awareness');
});

test('the requirement prompt input carries the headline and the article, nothing else', () => {
  const input = requirementInput({ headline: 'Hotel opens', city: 'Bengaluru', url: 'https://n/1', text: '  body text  ' });
  assert.match(input, /Headline on record: Hotel opens/);
  assert.match(input, /Article text:\nbody text/);
});
