import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, capCandidates } from '../src/run.mjs';

test('parseArgs reads the documented invocation', () => {
  const opts = parseArgs(['--city', 'bengaluru', '--sources', 'overpass,news,cppp', '--limit', '200']);
  assert.deepEqual(opts, {
    city: 'bengaluru',
    sources: ['overpass', 'news', 'cppp'],
    limit: 200,
    dry: false,
    deliver: [],
    noLlm: false,
    // The demand lane added one more thing parseArgs has to say: which of the
    // named sources are fetches and which are stages that run inside the model
    // step. `openings` is the only stage today.
    stages: [],
    fetchSources: ['overpass', 'news', 'cppp'],
  });
});

test('parseArgs separates the openings stage from the fetch sources', () => {
  const opts = parseArgs(['--sources', 'news,openings,institutions']);
  assert.deepEqual(opts.stages, ['openings']);
  assert.deepEqual(opts.fetchSources, ['news', 'institutions']);
});

test('parseArgs still refuses a source that does not exist', () => {
  assert.throws(() => parseArgs(['--sources', 'news,nonesuch']), /unknown source: nonesuch/);
});

test('--no-llm is off by default and parses on its own', () => {
  assert.equal(parseArgs(['--city', 'bengaluru']).noLlm, false);
  assert.equal(parseArgs(['--city', 'bengaluru', '--no-llm']).noLlm, true);
  assert.equal(parseArgs(['--no-llm', '--dry']).dry, true);
});

test('parseArgs accepts --dry and normalises the city', () => {
  const opts = parseArgs(['--city', 'Chennai', '--sources', 'news', '--limit', '5', '--dry']);
  assert.equal(opts.city, 'chennai');
  assert.equal(opts.dry, true);
});

test('parseArgs refuses an unknown city, source, limit or flag', () => {
  assert.throws(() => parseArgs(['--city', 'paris']), /unknown city/);
  assert.throws(() => parseArgs(['--sources', 'indiamart']), /unknown source/);
  assert.throws(() => parseArgs(['--limit', '0']), /positive/);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

function lead(id, source, score, segment = 'restaurant') {
  return { id, source, score, segment };
}

test('the cap keeps every candidate when it is under the limit', () => {
  const leads = [lead('a', 'overpass', 80), lead('b', 'news', 40)];
  assert.equal(capCandidates(leads, 200).length, 2);
});

test('the cap reserves slots for a lower-scoring source', () => {
  const overpass = Array.from({ length: 150 }, (_, i) => lead(`o${i}`, 'overpass', 84));
  const news = Array.from({ length: 100 }, (_, i) => lead(`n${i}`, 'news', 40, 'hotel'));
  const sorted = [...overpass, ...news];

  const naive = sorted.slice(0, 100);
  assert.equal(naive.filter((l) => l.source === 'news').length, 0, 'a plain top-N cut drops news entirely');

  const capped = capCandidates(sorted, 100, 0.2);
  assert.equal(capped.length, 100);
  assert.equal(capped.filter((l) => l.source === 'news').length, 20, 'news keeps its reserved share');
  assert.equal(capped.filter((l) => l.source === 'overpass').length, 80);
});

test('the cap is deterministic', () => {
  const sorted = [
    ...Array.from({ length: 60 }, (_, i) => lead(`o${i}`, 'overpass', 84)),
    ...Array.from({ length: 60 }, (_, i) => lead(`n${i}`, 'news', 40)),
  ];
  const a = capCandidates(sorted, 50, 0.2).map((l) => l.id);
  const b = capCandidates(sorted, 50, 0.2).map((l) => l.id);
  assert.deepEqual(a, b);
});

test('the cap never returns more than the limit', () => {
  const sorted = Array.from({ length: 500 }, (_, i) => lead(`x${i}`, i % 3 === 0 ? 'news' : 'overpass', 100 - i));
  assert.equal(capCandidates(sorted, 37).length, 37);
});

test('--deliver parses, validates and defaults to no channel', () => {
  assert.deepEqual(parseArgs(['--city', 'bengaluru']).deliver, []);
  assert.deepEqual(
    parseArgs(['--city', 'bengaluru', '--deliver', 'email,whatsapp']).deliver,
    ['email', 'whatsapp']
  );
  assert.deepEqual(parseArgs(['--deliver', 'email']).deliver, ['email']);
  assert.throws(() => parseArgs(['--deliver', 'sms']), /unknown delivery channel: sms/);
});
