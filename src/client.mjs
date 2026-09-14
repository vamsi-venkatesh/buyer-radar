// The client profile: every fact about the supplier this radar runs for.
//
// The engine holds no business facts of its own. Names, products, capacity,
// cities, catalogue, keywords and the lines the owner reads out all come from
// here, so the same code runs for any produce supplier by editing one file.
//
//   config/client.json          your deployment. Git-ignored. Used when present.
//   config/client.example.json  the worked example, and the fallback.
//
// A missing config/client.json is not an error - the example is a complete,
// runnable profile - but a malformed one is, and it fails at load with the
// field named rather than half-configuring the pipeline.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');
const CLIENT_FILE = path.join(CONFIG_DIR, 'client.json');
const EXAMPLE_FILE = path.join(CONFIG_DIR, 'client.example.json');

function read(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`client profile ${path.basename(file)} could not be read: ${err.message}`);
  }
}

function need(obj, field, file) {
  const value = field.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  if (value === undefined || value === null) {
    throw new Error(`client profile ${path.basename(file)} is missing ${field}`);
  }
  return value;
}

/**
 * Load and validate a client profile. `source` is the file it came from, so the
 * dashboard and the run summary can say which profile is in force rather than
 * leaving the operator to guess.
 */
export function loadClient({ file = existsSync(CLIENT_FILE) ? CLIENT_FILE : EXAMPLE_FILE } = {}) {
  const raw = read(file);

  need(raw, 'business.name', file);
  need(raw, 'business.headline', file);
  need(raw, 'capacity.kgPerDayMax', file);
  need(raw, 'catalogue.items', file);
  need(raw, 'openers.bySegment', file);

  const cities = {};
  for (const [key, city] of Object.entries(raw.cities || {})) {
    if (key.startsWith('_')) continue;
    if (!Array.isArray(city.bbox) || city.bbox.length !== 4) {
      throw new Error(`client profile ${path.basename(file)}: city ${key} needs a 4-number bbox`);
    }
    cities[key] = { key, ...city };
  }
  if (!Object.keys(cities).length) {
    throw new Error(`client profile ${path.basename(file)} configures no cities`);
  }

  const items = Object.entries(raw.catalogue.items)
    .filter(([id]) => !id.startsWith('_'))
    .map(([id, item]) => ({
      id,
      label: item.label || id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' '),
      commodity: item.commodity ?? null,
      approx: Boolean(item.approx),
    }));

  const business = { owner: 'the owner', homeCity: '', contactEmail: '', ...raw.business };
  const digest = { title: 'Buyer Radar', maxChars: 1500, topN: 10, ...raw.digest };
  digest.sections = { requirements: 6, buyers: 6, registrations: 4, ...(raw.digest || {}).sections };
  // The combined morning digest carries every city inside the same character
  // cap, so the buyer count is per city rather than overall.
  digest.combined = { requirements: 6, buyersPerCity: 2, registrations: 4, ...(raw.digest || {}).combined };

  return {
    source: file,
    isExample: file === EXAMPLE_FILE,
    business,
    digest,
    capacity: {
      headlineCommodity: 'garlic',
      headlineCommodityWords: ['garlic'],
      headlineCommodityKgPerDay: raw.capacity.kgPerDayMax,
      kgPerDayMin: 0,
      ...raw.capacity,
    },
    cities,
    catalogue: { items },
    keywords: { requirement: [], tender: [], marketplace: [], ...raw.keywords },
    // The words the publisher-feed and openings lanes tier a signal by. Every
    // list is optional: src/lib/profile.mjs falls back to the engine's own,
    // which are properties of the trade rather than of this supplier.
    signals: {
      procurement: [],
      opening: [],
      venue: [],
      ...raw.signals,
      near: { requirement: 140, awareness: 90, ...((raw.signals || {}).near || {}) },
    },
    newsQueries: raw.newsQueries || [],
    openers: {
      requirement: 'We can quote for {what}.',
      requirementFallback: 'We can quote for your posted requirement.',
      registration: 'You buy {what} - can we register as a supplier?',
      registrationFallback: 'Can we register as a supplier?',
      ...raw.openers,
    },
    excludePatterns: ((raw.excludeSegments || {}).patterns || []).filter((p) => typeof p === 'string'),
  };
}

export const CLIENT = loadClient();

export { CLIENT_FILE, EXAMPLE_FILE };
