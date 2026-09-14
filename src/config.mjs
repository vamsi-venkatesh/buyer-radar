// Buyer Radar - static configuration.
//
// Two kinds of value live here and the split is deliberate. Engine settings -
// endpoints, pacing, caps, licences - are properties of the source and are the
// same for every deployment. Business facts - who the supplier is, what he
// sells, which cities, which words make a notice worth opening - come from the
// client profile (src/client.mjs) and are not in this file at all.
//
// Nothing here sends a message to anyone. All values are local knobs.

import { CLIENT } from './client.mjs';

export { CLIENT };

export const USER_AGENT = process.env.RADAR_USER_AGENT || CLIENT.business.userAgent;

// City table, from the client profile. bbox = [south, west, north, east] in
// WGS84 degrees.
export const CITIES = CLIENT.cities;

// Overpass category groups. One HTTP request per city per group, 2 s pause between requests.
export const OVERPASS_GROUPS = [
  {
    key: 'food_service',
    selectors: [
      ['amenity', 'restaurant'],
      ['amenity', 'food_court'],
      ['craft', 'caterer'],
    ],
  },
  { key: 'hospitality', selectors: [['tourism', 'hotel']] },
  {
    key: 'trade',
    selectors: [
      ['shop', 'wholesale'],
      ['shop', 'greengrocer'],
      ['shop', 'supermarket'],
    ],
  },
  { key: 'industry', selectors: [['industrial', 'food']] },
];

export const OVERPASS = {
  endpoint: 'https://overpass-api.de/api/interpreter',
  timeout: 60, // seconds, passed into the Overpass QL [timeout:] setting
  pauseMs: 2000, // pause between requests
  retryPauseMs: 20000, // Overpass hands out query slots; on 429 wait for one
  maxRetries: 2,
  httpTimeoutMs: 180000,
  maxPerGroup: 400, // client-side cap per city per group, applied after contactability sort
  licence: 'ODbL',
  attribution: 'Data (c) OpenStreetMap contributors, ODbL 1.0',
};

export const CPPP = {
  base: 'https://eprocure.gov.in/eprocure/app',
  // Listing surfaces tried in order. Every one of these is checked for a captcha gate.
  pages: [
    'FrontEndLatestActiveTenders',
    'FrontEndTendersByOrganisation',
    'FrontEndAdvancedSearch',
  ],
  keywords: CLIENT.keywords.tender,
  pauseMs: 3000, // 1 request per 3 s
  httpTimeoutMs: 60000,
  licence: 'Government of India public tender listing',
};

export const NEWS = {
  base: 'https://news.google.com/rss/search',
  params: { hl: 'en-IN', gl: 'IN', ceid: 'IN:en' },
  pauseMs: 1500,
  httpTimeoutMs: 45000,
  maxPerQuery: 20,
  licence: 'Google News RSS (headline + link only)',
  // {city} is substituted with the city display name.
  queries: CLIENT.newsQueries,
};

export const AGMARKNET = {
  endpoint: 'https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070',
  resourceId: '9ef84268-d588-465a-a308-a864a43d0070',
  // Every distinct Agmarknet commodity the catalogue maps onto, and every state
  // the configured cities sit in. Both derive from the client profile, so adding
  // a city or a catalogue item needs no change here.
  commodities: [...new Set(CLIENT.catalogue.items.map((i) => i.commodity).filter(Boolean))].sort(),
  states: [...new Set(Object.values(CLIENT.cities).map((c) => c.agmarknetState).filter(Boolean))],
  pauseMs: 1000,
  httpTimeoutMs: 45000,
  limit: 50,
  licence: 'data.gov.in (Government Open Data Licence - India)',
};

// The supplier's own facts, used only to compose a plain opener line locally
// and to tell the model who it is writing for. Nothing here reaches a buyer.
export const BUSINESS = CLIENT.business;

export const DIGEST = { maxChars: CLIENT.digest.maxChars, topN: CLIENT.digest.topN };

// Share of --limit each contributing source is guaranteed before the remaining
// slots are filled by global score. Without this, the highest-scoring source
// (map listings, which carry phone numbers) takes every slot and the news and
// tender lanes never reach the register at all.
export const RUN = { reservePerSource: 0.2 };

export const EVIDENCE_SCHEMA = 'vvdex.evidence-bundle/v1';

// ---------------------------------------------------------------- demand lane
//
// The sources above find buyers. These find *requirements*: a body that has
// publicly posted what it needs, how much of it, by when, and who to call. A
// directory entry is a phone number; a requirement is a reason to use it.

// Words that make a notice title worth opening. Matched case-insensitively
// against the link text and the href. Note that one of these is a matching
// keyword only - no copy this project generates ever uses that wording.
export const REQUIREMENT_KEYWORDS = CLIENT.keywords.requirement;

export const INSTITUTIONS = {
  // Both are paths relative to the project root. The registry is overridable so
  // a deployment can keep its own list outside this tree, and so the demo can
  // point the lane at a synthetic one.
  registry: process.env.RADAR_INSTITUTIONS_REGISTRY || 'config/institutional-buyers.json',
  probeFile: process.env.RADAR_INSTITUTIONS_PROBE || 'config/institutional-buyers.probe.json',
  keywords: REQUIREMENT_KEYWORDS,
  pauseMs: 3000, // 1 request per 3 s per host, enforced by the crawler
  httpTimeoutMs: 30000,
  maxBytes: 2 * 1024 * 1024, // 2 MB per notice document
  maxNoticesPerEntry: 4, // how many matching notices are followed per body
  maxNoticeTextChars: 20000,
  concurrency: 6, // distinct hosts crawled at once; the per-host pause stands
  licence:
    'Public tender and notice pages published by each body on its own website. Read, not republished: the digest carries the title, the stated requirement and a link back to the source document.',
};

export const GEM = {
  base: 'https://bidplus.gem.gov.in',
  listPath: '/all-bids',
  dataPath: '/all-bids-data',
  keywords: CLIENT.keywords.marketplace,
  pauseMs: 3000,
  httpTimeoutMs: 30000,
  pageSize: 10,
  licence: 'Government e Marketplace public bid listing (bidplus.gem.gov.in)',
  // Off unless GEM_ENABLED=true. The endpoint did not answer this machine at
  // all (see the README), so the client ships tested against a documented
  // assumed response shape rather than silently shipping an unverified fetch.
  enabledEnv: 'GEM_ENABLED',
};

export const OPENINGS = {
  // The lanes whose signals this stage upgrades. `news` is the Google News
  // headline lane; `publishers` is the direct-feed lane, whose signals already
  // carry the publisher's own article URL and therefore need no resolving.
  signalSources: ['news', 'publishers'],
  // A signal has to say something about demand before it is worth a model
  // call. These are matched against the headline.
  triggers:
    /\b(open(?:s|ed|ing)?|launch(?:es|ed|ing)?|expan(?:d|ds|ded|sion)|tender|canteen|mess|hostel|contract|supply|inaugurat)/i,
  maxPerRun: 12, // signals considered per run
  // Articles read - and therefore model calls made - by this lane in one run.
  // The first real run of this lane on a deployment read 12 articles over 34
  // calls and found no requirement in any of them, because all 12 were opening
  // stories. The tiers stop most of that; this is the ceiling under them, and
  // OPENINGS_MAX_READS moves it without a code change.
  maxReads: 6,
  contactPathsTried: 4,
  licence: 'Google News RSS (headline + link only), then the organisation\'s own website',
};

/** The per-run article-read cap, from OPENINGS_MAX_READS, or the default above. */
export function openingsMaxReads(env = process.env) {
  const raw = env && env.OPENINGS_MAX_READS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return OPENINGS.maxReads;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return OPENINGS.maxReads;
  return Math.floor(n);
}

// Direct publisher feeds - the openings lane's article supply.
//
// The news lane finds headlines through Google News, and Google's article links
// are a path its own robots.txt refuses to everybody. A publisher's own feed has
// neither problem: the item links at the publisher's own article page, which we
// then read under that publisher's robots.txt like any other page.
export const PUBLISHERS = {
  registry: 'config/publisher-feeds.json',
  probeFile: 'config/publisher-feeds.probe.json',
  pauseMs: 3000, // 1 request per 3 s per host, enforced by the source
  httpTimeoutMs: 30000,
  maxBytes: 4 * 1024 * 1024, // a city desk's feed with full-text descriptions
  maxPerFeed: 8, // matching items carried per feed per run
  maxItemAgeDays: 45, // an item older than this is history, not a lead
  concurrency: 6, // distinct hosts fetched at once; the per-host pause stands
  licence:
    "Each publisher's own RSS/Atom feed, fetched directly. The feed gives the headline, the link and the summary; the article itself is read from the publisher's own page under that publisher's robots.txt.",
};

export const REGISTRATIONS = {
  registry: 'config/buyer-registrations.json',
  // Emitted once a week, on Mondays, not every morning - a supplier-onboarding
  // page does not change daily and a daily repeat would train the owner to skip
  // the section.
  weekday: 1,
  pauseMs: 3000,
  httpTimeoutMs: 30000,
  licence: 'Public supplier-registration pages published by each buyer',
};

export const EXPORTERS = {
  // APEDA's registered-exporter directory and the FSSAI licence search. Both are
  // probed once; whichever is reachable without a login or a captcha is read,
  // and whichever is not is recorded as blocked with the exact reason.
  apeda: {
    name: 'APEDA registered exporter directory',
    urls: [
      'https://agriexchange.apeda.gov.in/IndianProductExporter/Exporter_Search.aspx',
      'https://apeda.gov.in/apedawebsite/trade_promotion/Exporter_Directory.htm',
    ],
  },
  fssai: {
    name: 'FSSAI licence and registration search',
    urls: ['https://foscos.fssai.gov.in/consumer/fboSearch'],
  },
  pauseMs: 3000,
  httpTimeoutMs: 30000,
  licence: 'Government of India public registries (APEDA, FSSAI)',
};

/**
 * What the supplier can actually fill, used by the requirement score. A number
 * the owner cannot supply is not a better lead for being bigger.
 *
 * `headlineCommodityKgPerDay` is the ceiling for the one line he is set up for;
 * the min/max pair is the comfortable daily range across the rest of the
 * catalogue. Outside it a requirement is either too small to be worth a quote or
 * too big to serve alone, and both score below one that lands inside it.
 */
export const CAPACITY = CLIENT.capacity;

// Section caps for the digest. The WhatsApp cap in DIGEST.maxChars still holds;
// these decide what competes for the space inside it.
export const DIGEST_SECTIONS = CLIENT.digest.sections;

// Section caps for the ONE combined digest a morning pass sends after the last
// city. The same character cap in DIGEST.maxChars applies to the whole thing, so
// the buyer count is per city rather than overall: five cities at two buyers
// each is ten buyer blocks, which is what a single message can carry beside the
// requirements and the price block.
export const DIGEST_COMBINED = CLIENT.digest.combined;
