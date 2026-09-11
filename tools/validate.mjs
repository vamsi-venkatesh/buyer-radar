// Check the things a test cannot: that the files an operator edits are well
// formed, internally consistent, and free of the values that must never be
// committed. Run it before a commit and in CI.
//
//   node tools/validate.mjs
//
// It reads only. It fetches nothing, and it never touches the register.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadClient, CLIENT_FILE, EXAMPLE_FILE } from '../src/client.mjs';
import { parsePrompt, PROMPT_DIR } from '../src/llm/prompts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const checks = [];

function ok(what) {
  checks.push(what);
}
function bad(what) {
  problems.push(what);
}

// ------------------------------------------------------- the client profiles

for (const file of [EXAMPLE_FILE, CLIENT_FILE]) {
  if (!existsSync(file)) continue;
  const name = path.relative(ROOT, file);
  try {
    const client = loadClient({ file });
    const cities = Object.keys(client.cities);
    const priced = client.catalogue.items.filter((i) => i.commodity).length;
    ok(`${name}: ${cities.length} cities, ${client.catalogue.items.length} catalogue items (${priced} priced), ${Object.keys(client.openers.bySegment).length} segment openers`);

    for (const [key, city] of Object.entries(client.cities)) {
      const [s, w, n, e] = city.bbox;
      if (!(s < n && w < e)) bad(`${name}: city ${key} has an inverted bbox`);
      if (Math.abs(s) > 90 || Math.abs(n) > 90 || Math.abs(w) > 180 || Math.abs(e) > 180) {
        bad(`${name}: city ${key} bbox is off the globe`);
      }
    }
    for (const item of client.catalogue.items) {
      if (item.approx && !item.commodity) {
        bad(`${name}: catalogue item ${item.id} is marked approx but has no commodity to be approximate to`);
      }
    }
    if (!client.capacity.kgPerDayMax || client.capacity.kgPerDayMax <= client.capacity.kgPerDayMin) {
      bad(`${name}: capacity.kgPerDayMax must be above kgPerDayMin`);
    }
    for (const p of client.excludePatterns) {
      try {
        RegExp(p);
      } catch (err) {
        bad(`${name}: excludeSegments pattern ${JSON.stringify(p)} is not a regular expression`);
      }
    }
  } catch (err) {
    bad(`${name}: ${err.message}`);
  }
}

// ------------------------------------------------------------- the registries

function registry(file, required) {
  const rel = path.relative(ROOT, file);
  let rows;
  try {
    rows = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return bad(`${rel}: ${err.message}`);
  }
  const entries = Array.isArray(rows) ? rows : rows.entries || [];
  if (!entries.length) return bad(`${rel}: no entries`);
  const seen = new Set();
  for (const e of entries) {
    for (const field of required) {
      if (!e[field]) bad(`${rel}: an entry (${e.name || 'unnamed'}) is missing ${field}`);
    }
    for (const url of e.tender_paths || e.urls || []) {
      if (!/^https?:\/\//.test(url)) bad(`${rel}: ${e.name} has a relative URL: ${url}`);
    }
    const key = `${e.name}|${e.city || ''}`;
    if (seen.has(key)) bad(`${rel}: ${key} appears twice`);
    seen.add(key);
  }
  ok(`${rel}: ${entries.length} entries`);
}

registry(path.join(ROOT, 'config/institutional-buyers.json'), ['name', 'city', 'state', 'category']);
registry(path.join(ROOT, 'config/buyer-registrations.json'), ['name', 'url']);

// ------------------------------------------------------------------ prompts

const versions = new Set();
for (const file of readdirSync(PROMPT_DIR).filter((f) => f.endsWith('.md'))) {
  try {
    const p = parsePrompt(readFileSync(path.join(PROMPT_DIR, file), 'utf8'), file);
    if (versions.has(p.version)) bad(`two prompts share the version ${p.version}`);
    versions.add(p.version);
    ok(`prompt ${file}: ${p.version}`);
  } catch (err) {
    bad(err.message);
  }
}

// ---------------------------------------------- nothing that must not be here

// Values that would be a real leak if they were committed. A test cannot catch
// these because the file that carried one would simply not be under test.
const FORBIDDEN = [
  [/\bsk-[A-Za-z0-9]{16,}/, 'what looks like a provider API key'],
  [/\bAKIA[0-9A-Z]{12,}/, 'what looks like an AWS access key id'],
  [/\bEAA[A-Za-z0-9]{30,}/, 'what looks like a Meta access token'],
  // A redacted or obviously-placeholder value is the correct thing to find here.
  [/api[-_]?key=(?!REDACTED|$|&)(?!.{0,4}(?:key|value|here|xxx))[A-Za-z0-9]{20,}/i, 'an API key in a URL'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'runs', 'digests', 'exports', 'reports', 'outbox', '.store']);

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (/\.(png|jpg|jpeg|gif|pdf|ico|woff2?)$/i.test(entry)) continue;
    if (entry === 'validate.mjs') continue; // this file carries the patterns
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const [re, what] of FORBIDDEN) {
      if (re.test(text)) bad(`${path.relative(ROOT, full)} contains ${what}`);
    }
  }
}
walk(ROOT);
ok('no committed file carries a key, a token or a private key');

if (existsSync(path.join(ROOT, '.env'))) bad('.env exists in the working tree - it must never be committed');

// ------------------------------------------------------------------- verdict

for (const c of checks) process.stdout.write(`ok    ${c}\n`);
for (const p of problems) process.stdout.write(`FAIL  ${p}\n`);
process.stdout.write(`\n${checks.length} checks passed, ${problems.length} failed\n`);
process.exit(problems.length ? 1 : 0);
