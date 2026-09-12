// Model only when needed.
//
// Every model call costs money and every model call is a place the pipeline
// could be told something that is not true. The rules below are the whole
// policy: a pure function, no I/O, no store, no clock, asked before each call
// and answered with a reason either way. A "no" is receipted as
// `llm.not_needed` so a run that spent nothing can still show what it decided
// and why - a skip with no record is indistinguishable from a stage that never
// ran.
//
// The rules, in the words of the README:
//
//   enrich      needed only if (the source gave no usable segment, OR the size
//               is unknown AND the lead's score is within ENRICH_CUTOFF_BAND
//               points of the digest cut-off, OR a requirement is missing its
//               deadline) AND there is page or article text to read AND the
//               cache does not already hold the answer.
//   opener      needed only for a lead the digest will actually show AND that
//               has at least one concrete fact to build a line on.
//   requirement needed only when the text uses procurement wording at all, AND
//               the deterministic readers found no quantity, no deadline and no
//               contact in the notice text - and ALWAYS for a publisher's
//               article, which names no buyer and no buyer's site whatever a
//               regex reads off it.

import { DIGEST_SECTIONS } from '../config.mjs';
import { hasRequirementWording } from '../lib/profile.mjs';

export const PURPOSES = ['enrich', 'opener', 'requirement'];

/**
 * How close to the digest cut-off a lead has to be for its size to be worth
 * paying to learn. A lead 40 points clear of the cut-off is in the digest
 * whatever the model says, and one 40 points below it is not.
 */
export const ENRICH_CUTOFF_BAND = 10;

/** A segment the source did not really give us. Both mean "nobody has said". */
function segmentUnknown(lead) {
  const s = lead && (lead.segment_source || lead.segment);
  return !s || s === 'other';
}

function llmOf(lead) {
  return (lead && lead.extra && lead.extra.llm) || {};
}

/**
 * The facts an opener can be built on, in the order the opener prompt would
 * use them. An empty list means the model would be writing from the business
 * name alone, which the rule-based opener already does for free.
 */
export function concreteFacts(lead) {
  const llm = llmOf(lead);
  const extra = (lead && lead.extra) || {};
  const facts = [];
  if (Array.isArray(llm.evidence) && llm.evidence.length) facts.push('an evidence quote from their own page');
  if (llm.pageTitle) facts.push('the title of their website');
  if (extra.requirement) facts.push('the requirement text on the notice');
  if (extra.quantity || llm.quantity) facts.push('a stated quantity');
  if (extra.deadline || llm.deadline) facts.push('a stated deadline');
  return facts;
}

/**
 * The score at which each digest section stops. A lead below the cut-off is not
 * going to be shown today whatever the model reads off its page.
 *
 * Computed from the leads the run already holds, so it is the real boundary and
 * not a guess: sort each section's leads by score and take the score of the last
 * one that fits. A section with fewer leads than its cap has no cut-off - every
 * lead in it is shown - and that is returned as 0.
 */
export function digestCutoffs(leads, { sections = DIGEST_SECTIONS } = {}) {
  const scoreOf = (l) => Number(l.score) || 0;
  const band = (kinds, cap) => {
    const list = (leads || []).filter((l) => kinds.includes(l.kind)).map(scoreOf).sort((a, b) => b - a);
    return list.length > cap ? list[cap - 1] : 0;
  };
  return {
    requirement: band(['requirement'], sections.requirements ?? 6),
    buyer: band(['buyer', 'tender', 'signal'], sections.buyers ?? 6),
  };
}

/** The cut-off that applies to one lead. */
export function cutoffFor(lead, cutoffs) {
  if (!cutoffs) return 0;
  return lead && lead.kind === 'requirement' ? cutoffs.requirement : cutoffs.buyer;
}

/**
 * Should the model be asked about this lead, for this purpose?
 *
 * Returns { needed, reason } and never throws. `reason` is written to be read
 * in a receipt by somebody who was not here when the run happened, so it names
 * the rule that decided, not the branch that was taken.
 */
export function needsModel(purpose, lead = null, ctx = {}) {
  if (!PURPOSES.includes(purpose)) {
    return { needed: false, reason: `unknown purpose ${JSON.stringify(purpose)}` };
  }

  if (purpose === 'enrich') {
    if (ctx.cacheHit) return { needed: false, reason: 'the cache already holds an answer for this exact page and prompt version' };
    if (!ctx.hasText) return { needed: false, reason: 'there is no page or article text to read' };

    const reasons = [];
    if (segmentUnknown(lead)) reasons.push('the source gave no segment beyond "other"');

    const size = llmOf(lead).size;
    if (!size || size === 'unknown') {
      const cutoff = Number(ctx.cutoff) || 0;
      const score = Number(lead && lead.score) || 0;
      const gap = Math.abs(score - cutoff);
      if (cutoff > 0 && gap <= ENRICH_CUTOFF_BAND) {
        reasons.push(`the size is unknown and the score ${score} is ${gap} from the digest cut-off ${cutoff}`);
      }
    }

    if (lead && lead.kind === 'requirement' && !((lead.extra || {}).deadline)) {
      reasons.push('the requirement carries no closing date');
    }

    if (!reasons.length) {
      return {
        needed: false,
        reason: 'the source already gave a segment, the size cannot change what the digest shows, and nothing is missing a deadline',
      };
    }
    return { needed: true, reason: reasons.join('; ') };
  }

  if (purpose === 'opener') {
    if (!ctx.inDigest) return { needed: false, reason: 'the digest is not showing this lead today' };
    const facts = concreteFacts(lead);
    if (!facts.length) {
      return { needed: false, reason: 'there is no concrete fact to write a line on, so the rule opener is used' };
    }
    return { needed: true, reason: `the digest shows this lead and it carries ${facts.join(', ')}` };
  }

  // requirement
  const d = ctx.deterministic || {};
  if (!ctx.hasText) return { needed: false, reason: 'there is no notice text to read' };

  // The hard pre-check, ahead of every rule below it including the article
  // rule. A text that never says tender, RFQ, EOI, supply of, empanelment or
  // any other word on the client's requirement list does not contain a posted
  // requirement, and a model cannot find one in it. The first real run of the
  // openings lane spent 34 calls on 12 expansion stories to be told this 12
  // times. The words come from src/lib/profile.mjs.
  if (typeof ctx.text === 'string' && !hasRequirementWording(ctx.text)) {
    return { needed: false, reason: 'no procurement wording' };
  }

  // A notice is published by the body that wants the vegetables, so everything
  // on it - the quantity, the closing date, the officer's number - is that
  // body's own. A news article is not: it is published by a newspaper, about
  // somebody else. Nothing a regex can do to an article tells us which
  // organisation has the requirement or where its own website is, and the phone
  // number on the page belongs to the newsroom. That is a model's job, and no
  // amount of deterministic reading replaces it.
  if (ctx.needsOrganisation) {
    return {
      needed: true,
      reason: 'the page is a publisher article: it may state a requirement, but nothing on it names the buyer or the buyer\'s own website',
    };
  }

  const found = [];
  if (d.quantity) found.push('a quantity');
  if (d.deadline) found.push('a closing date');
  if (d.contact) found.push('a contact');
  if (found.length) {
    return { needed: false, reason: `the deterministic readers already found ${found.join(', ')} in the notice text` };
  }
  return { needed: true, reason: 'the deterministic readers found no quantity, no closing date and no contact in the notice text' };
}
