// Turning a news signal into a lead with a phone number.
//
// The news lane already finds articles: a hotel opening, a hostel mess tender, a
// canteen contract. On its own that is a headline, and a headline is not
// something the owner can ring. This lane does the three steps that turn one
// into a lead, and refuses to pretend when any of them fails:
//
//   1. the model reads the article and says whether it states a requirement,
//      who has it, how much, by when;
//   2. the pipeline fetches that organisation's own website - the one the
//      article named, never a search engine, never a guess;
//   3. it reads a phone or an email off the organisation's contact page.
//
// Only after step 3 does the signal become a requirement candidate. Without a
// contact it stays a signal and the digest says "contact not found yet", which
// is the truth and is more useful than a lead that cannot be called.

import { OPENINGS, INSTITUTIONS } from '../config.mjs';
import { loadPrompt } from '../llm/prompts.mjs';
import { requirementInput, parseRequirement, resolveSite } from '../llm/requirement.mjs';
import { REQUIREMENT_MAX_TOKENS } from '../llm/limits.mjs';
import { extractContacts, contactLinksFrom, CONTACT_PATHS } from '../lib/contacts.mjs';
import { bestQuantity, mentionsHeadlineCommodity, quantityFit } from '../lib/quantity.mjs';
import { parseLinks } from '../lib/xml.mjs';
import { findDeadline } from '../lib/dates.mjs';
import { resolveNewsLink, isGoogleNewsLink } from '../lib/news-link.mjs';
import { needsModel } from '../llm/needs.mjs';
import { tidy, todayIso } from '../lib/normalise.mjs';

export const name = 'openings';

const NO_CHAIN = { add() {} };

/**
 * The signals worth a model call: one whose headline talks about demand, or one
 * whose own lane already matched it on more than the headline.
 *
 * The Google News lane searches for demand words and then keeps whatever comes
 * back, so its headlines are filtered here. The publisher-feed lane has already
 * matched the title AND the summary against its own two rules and written down
 * which words matched, so re-testing its headline alone would throw away items
 * whose demand is stated in the second sentence - "Chalet Hotels targets 5,500
 * keys by FY30" says nothing in its headline and states the expansion below it.
 */
export function selectSignals(leads, { limit = OPENINGS.maxPerRun, promptVersion } = {}) {
  return leads
    .filter((l) => l.kind === 'signal' && OPENINGS.signalSources.includes(l.source) && l.source_url)
    .filter((l) => OPENINGS.triggers.test(`${l.name} ${l.why_now || ''}`) || Boolean(l.extra && l.extra.matchRule))
    .filter((l) => !(l.extra && l.extra.opening && l.extra.opening.promptVersion === promptVersion))
    // A signal whose link is already the publisher's article comes first, and
    // not because it scores better. The limit is a budget, and a Google News
    // item whose id is the opaque post-2024 form is a dead end we can name in
    // advance: it will be skipped at the resolver. A run that spent eleven of
    // its twelve slots on those and read one article is the reason this sort
    // has two keys.
    .sort(
      (a, b) =>
        (isGoogleNewsLink(a.source_url) ? 1 : 0) - (isGoogleNewsLink(b.source_url) ? 1 : 0) ||
        b.score - a.score ||
        String(a.id).localeCompare(String(b.id))
    )
    .slice(0, limit);
}

/**
 * Find the organisation's own site to read a contact off.
 *
 * The model's answer is tried first and is checked by `resolveSite`, which
 * refuses a search engine, a news site or a social page. Failing that, an
 * outbound link in the article whose anchor text carries the organisation's name
 * is used - a newspaper linking a business by name is pointing at that business.
 * There is no third fallback: no search engine is queried, ever.
 */
export function siteFromArticle(answer, { html, articleUrl }) {
  const fromModel = resolveSite(answer.site);
  if (fromModel.ok) return { ...fromModel, from: 'the article, as the model read it' };

  const org = String(answer.organisation || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
  const words = org.split(/\s+/).filter((w) => w.length > 3);
  if (html && words.length) {
    for (const link of parseLinks(html)) {
      const text = String(link.text || '').toLowerCase();
      if (!words.some((w) => text.includes(w))) continue;
      let abs;
      try {
        abs = new URL(link.href, articleUrl);
      } catch {
        continue;
      }
      const site = resolveSite(abs.href);
      if (site.ok && site.host !== new URL(articleUrl).hostname) {
        return { ...site, from: `a link in the article whose text names ${answer.organisation}` };
      }
    }
  }
  return { ok: false, reason: fromModel.reason };
}

/**
 * Read a contact off one organisation's site.
 *
 * Contact links already on the home page are tried before guessed paths,
 * because a link a site publishes is better than a path we hope exists. Every
 * fetch goes through the same crawler, so robots.txt and the per-host pause
 * apply here exactly as they do everywhere else.
 */
export async function findContactOnSite(siteUrl, { crawler, maxPages = OPENINGS.contactPathsTried }) {
  const tried = [];
  const home = await crawler.fetchDoc(siteUrl);
  tried.push({ url: siteUrl, ok: Boolean(home.ok), reason: home.ok ? null : home.reason });
  if (home.ok) {
    const found = extractContacts(home.text);
    if (found.complete) return { ok: true, contacts: found, url: home.url || siteUrl, tried };
  }

  const candidates = [
    ...(home.ok && home.html ? contactLinksFrom(parseLinks(home.html), home.url || siteUrl) : []),
    ...CONTACT_PATHS.map((p) => {
      try {
        return new URL(p, siteUrl).toString();
      } catch {
        return null;
      }
    }).filter(Boolean),
  ];

  const seen = new Set([siteUrl]);
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    if (tried.length > maxPages) break;
    const doc = await crawler.fetchDoc(url);
    tried.push({ url, ok: Boolean(doc.ok), reason: doc.ok ? null : doc.reason });
    if (!doc.ok) continue;
    const found = extractContacts(doc.text);
    if (found.complete) return { ok: true, contacts: found, url: doc.url || url, tried };
  }
  return { ok: false, reason: 'no phone or email on the site pages we are allowed to read', tried };
}

/** Write the requirement onto the lead, in place, once a contact has been found. */
export function applyRequirement(lead, { answer, contacts, contactUrl, site, articleUrl, todayIsoDate = todayIso() }) {
  const haystack = `${answer.requirement || ''} ${answer.quantity || ''} ${lead.name}`;
  const quantity = answer.quantity ? bestQuantity(answer.quantity) || { phrase: answer.quantity, kg: null, kgPerDay: null } : bestQuantity(haystack);
  const headline = mentionsHeadlineCommodity(haystack);

  lead.kind = 'requirement';
  lead.phone = lead.phone || contacts.phone;
  lead.email = lead.email || contacts.email;
  lead.website = lead.website || site;
  lead.why_now = tidy(
    answer.deadline ? `requirement reported, closes ${answer.deadline}` : `requirement reported: ${answer.requirement || lead.why_now || 'opening or expansion'}`,
    120
  );
  lead.extra = {
    ...lead.extra,
    requirement: answer.requirement ? tidy(answer.requirement, 200) : tidy(lead.name, 200),
    quantity: quantity ? quantity.phrase : null,
    quantityKg: quantity ? quantity.kg ?? null : null,
    quantityKgPerDay: quantity ? quantity.kgPerDay ?? null : null,
    quantityFit: quantityFit(quantity && quantity.kg ? quantity : null, { headline }),
    mentionsHeadline: headline,
    deadline: answer.deadline,
    whyNowDate: answer.deadline || lead.extra?.whyNowDate || null,
    contact_name: contacts.name || answer.contactHint || null,
    contact_phone: contacts.phone,
    contact_email: contacts.email,
    contactComplete: true,
    contactFoundOn: contactUrl,
    document_url: articleUrl,
    organisation: answer.organisation || lead.name,
    opening: {
      promptVersion: answer.promptVersion || null,
      confidence: answer.confidence,
      site,
      siteFrom: answer.siteFrom || null,
      evidence: answer.evidence || [],
      at: new Date().toISOString(),
    },
  };
  if (answer.deadline) lead.extra.whyNowDate = answer.deadline;
  return lead;
}

/** Record on a signal that we looked for a contact and did not find one. */
export function markNoContact(lead, { reason, answer = null, promptVersion = null }) {
  lead.extra = {
    ...lead.extra,
    contactComplete: false,
    contactNotFound: tidy(reason, 200),
    requirement: answer && answer.requirement ? tidy(answer.requirement, 200) : lead.extra?.requirement || null,
    quantity: answer && answer.quantity ? answer.quantity : lead.extra?.quantity || null,
    deadline: answer && answer.deadline ? answer.deadline : lead.extra?.deadline || null,
    opening: {
      promptVersion,
      confidence: answer ? answer.confidence : null,
      site: answer && answer.site ? answer.site : null,
      evidence: answer ? answer.evidence || [] : [],
      at: new Date().toISOString(),
    },
  };
  return lead;
}

/**
 * What the deterministic readers get out of an article on their own.
 *
 * This is the input to the "model only when needed" rule for requirement
 * extraction: three facts, read with no network and no money, and the model is
 * asked only when all three come back empty.
 */
export function deterministicReads(text, { todayIsoDate = todayIso() } = {}) {
  const quantity = bestQuantity(text);
  const deadline = findDeadline(text, { todayIsoDate });
  return {
    quantity: quantity ? quantity.phrase : null,
    deadline: deadline ? deadline.deadline : null,
    contacts: extractContacts(text),
  };
}

/**
 * The whole lane, over the leads a run already holds.
 *
 * Returns counts and never throws: a signal whose article cannot be fetched, or
 * whose answer cannot be read, keeps every value it had.
 */
export async function upgradeSignals(
  leads,
  { runner, crawler, chain = NO_CHAIN, settings, todayIsoDate = todayIso(), fetchImpl = globalThis.fetch, log = () => {} }
) {
  const prompt = loadPrompt('requirement');
  const chosen = selectSignals(leads, { limit: OPENINGS.maxPerRun, promptVersion: prompt.version });
  const out = {
    considered: chosen.length,
    linksResolved: 0,
    linksUnresolved: 0,
    articlesRead: 0,
    articlesSkipped: 0,
    extracted: 0,
    notNeeded: 0,
    requirementsSeen: 0,
    sitesTried: 0,
    contactsFound: 0,
    upgraded: 0,
    stopped: null,
  };

  for (const lead of chosen) {
    // Read the publisher, not Google. The feed's link points at
    // news.google.com/rss/articles/..., which Google's own robots.txt refuses
    // to everybody; the publisher's page is the thing the item is about and the
    // thing we are allowed to read, under that publisher's robots.txt.
    const link = await resolveNewsLink(lead.source_url, { fetchImpl, robotsFor: crawler.robotsFor });
    if (!link.ok) {
      out.linksUnresolved += 1;
      out.articlesSkipped += 1;
      markNoContact(lead, {
        reason: `the news item could not be resolved to the publisher's own page: ${link.reason}`,
        promptVersion: prompt.version,
      });
      chain.add('openings.link_unresolved', { leadId: lead.id, url: lead.source_url, via: link.via, reason: link.reason });
      continue;
    }
    if (link.via !== 'direct') out.linksResolved += 1;

    const article = await crawler.fetchDoc(link.url);
    if (!article.ok) {
      out.articlesSkipped += 1;
      chain.add('openings.article_skipped', {
        leadId: lead.id,
        url: link.url,
        publisher: link.host || null,
        resolvedVia: link.via,
        reason: article.reason,
      });
      continue;
    }
    out.articlesRead += 1;
    chain.add('openings.article_read', {
      leadId: lead.id,
      publisher: link.host || null,
      resolvedVia: link.via,
      url: article.url,
      chars: article.text.length,
    });

    // Model only when needed - and here it is always needed while there is text
    // to read. This page belongs to a newspaper, not to the buyer: it may say
    // that a hospital is opening a 1,000-bed campus, but the only email on it is
    // the reporter's and the only site it links is the paper's own. The model is
    // asked who has the requirement and where their own website is, and the
    // contact is then read off THAT site. A run of this lane before the rule was
    // written upgraded three signals off the article text alone and put a
    // journalist's address and a PR agency's address in the digest as the
    // buyer's contact. Both were real addresses. Neither was the buyer.
    const found = deterministicReads(article.text, { todayIsoDate });
    const decision = needsModel('requirement', lead, {
      hasText: Boolean(article.text),
      needsOrganisation: true,
      deterministic: { quantity: found.quantity, deadline: found.deadline, contact: false },
    });
    if (!decision.needed) {
      out.notNeeded += 1;
      runner.notNeeded({ purpose: 'requirement', leadId: lead.id, reason: decision.reason });
      const read = {
        isRequirement: true,
        confidence: null,
        requirement: lead.name,
        organisation: lead.name,
        quantity: found.quantity,
        deadline: found.deadline,
        evidence: [],
        promptVersion: null,
        readBy: 'the deterministic readers, with no model call',
      };
      // No contact is taken off this page whatever the readers found on it: a
      // phone number on a newspaper's article is the newspaper's.
      markNoContact(lead, {
        reason: decision.reason,
        answer: read,
        promptVersion: null,
      });
      continue;
    }

    const answer = await runner.ask({
      purpose: 'requirement',
      prompt,
      input: requirementInput({ headline: lead.name, city: lead.city, url: article.url, text: article.text }),
      maxTokens: REQUIREMENT_MAX_TOKENS,
      jsonMode: true,
      parse: parseRequirement,
    });
    if (!answer.ok) {
      if (answer.reason === 'budget') {
        out.stopped = 'budget';
        break;
      }
      continue;
    }
    out.extracted += 1;
    const value = { ...answer.value, promptVersion: prompt.version };

    const gate = settings && typeof settings.minConfidence === 'number' ? settings.minConfidence : 0.7;
    if (!value.isRequirement || value.confidence < gate) {
      markNoContact(lead, {
        reason: value.isRequirement
          ? `the model read a requirement at ${value.confidence} confidence, below the ${gate} gate`
          : 'the article states no requirement to buy produce',
        answer: value,
        promptVersion: prompt.version,
      });
      chain.add('openings.not_a_requirement', {
        leadId: lead.id,
        isRequirement: value.isRequirement,
        confidence: value.confidence,
      });
      continue;
    }
    out.requirementsSeen += 1;

    const site = siteFromArticle(value, { html: article.html, articleUrl: article.url });
    if (!site.ok) {
      markNoContact(lead, { reason: site.reason, answer: value, promptVersion: prompt.version });
      chain.add('openings.no_site', { leadId: lead.id, organisation: value.organisation, reason: site.reason });
      continue;
    }
    out.sitesTried += 1;
    value.siteFrom = site.from;

    const contact = await findContactOnSite(site.url, { crawler });
    chain.add('openings.contact_search', {
      leadId: lead.id,
      organisation: value.organisation,
      site: site.url,
      pages: contact.tried.length,
      found: Boolean(contact.ok),
      reason: contact.ok ? null : contact.reason,
    });
    if (!contact.ok) {
      markNoContact(lead, { reason: contact.reason, answer: value, promptVersion: prompt.version });
      continue;
    }
    out.contactsFound += 1;

    applyRequirement(lead, {
      answer: value,
      contacts: contact.contacts,
      contactUrl: contact.url,
      site: site.url,
      articleUrl: article.url,
      todayIsoDate,
    });
    out.upgraded += 1;
    chain.add('openings.upgraded', {
      leadId: lead.id,
      organisation: value.organisation,
      requirement: lead.extra.requirement,
      deadline: value.deadline,
      contactPhone: Boolean(contact.contacts.phone),
      contactEmail: Boolean(contact.contacts.email),
      confidence: value.confidence,
    });
    log(`openings: ${lead.id} upgraded to a requirement (${value.organisation})`);
  }

  return out;
}

/**
 * The openings lane is a stage, not a fetch: it upgrades signals the news source
 * already found, and it needs the model runner the pipeline builds. `--sources
 * openings` switches the stage on; this function exists so the source table is
 * complete and returns nothing on its own.
 */
export async function fetch() {
  return {
    candidates: [],
    detail: {
      note: 'the openings lane runs in the model stage, after dedup - see upgradeSignals() in this file',
      licence: OPENINGS.licence,
      noticeCap: INSTITUTIONS.maxNoticeTextChars,
    },
  };
}
