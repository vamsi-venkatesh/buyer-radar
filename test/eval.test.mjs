import test from 'node:test';
import assert from 'node:assert/strict';

import { CASES, SYNTHETIC } from '../eval/llm/fixtures.mjs';
import { stubEnrich } from '../eval/llm/stub-model.mjs';
import { runEval } from '../eval/llm/run.mjs';
import { scoreCases, toMarkdown, matches } from '../eval/lib/score.mjs';
import { parseEnrich, SEGMENT_VALUES, SIZE_VALUES } from '../src/llm/enrich.mjs';

test('the fixture set is thirty labelled synthetic cases', () => {
  assert.equal(SYNTHETIC, true);
  assert.equal(CASES.length, 30);
  assert.equal(new Set(CASES.map((c) => c.id)).size, 30, 'every case id is unique');
  for (const c of CASES) {
    assert.ok(SEGMENT_VALUES.includes(c.expect.segment), `${c.id} has a real segment label`);
    assert.ok(SIZE_VALUES.includes(c.expect.size), `${c.id} has a real size label`);
    assert.ok(c.expect.deadline === null || /^\d{4}-\d{2}-\d{2}$/.test(c.expect.deadline));
    assert.ok(c.html.length > 80, `${c.id} carries a real page, not a stub`);
    assert.match(c.url, /example\.invalid/, 'every fixture URL is unresolvable on purpose');
  }
  assert.ok(CASES.some((c) => c.expect.deadline), 'some cases carry a deadline to find');
  assert.ok(CASES.some((c) => c.expect.size === 'unknown'), 'some cases have nothing to judge size on');
  assert.ok(CASES.filter((c) => c.expect.segment === 'other').length >= 2, 'some pages are not businesses at all');
});

test('the stub answers the same contract the pipeline parses', () => {
  for (const c of CASES) {
    const parsed = parseEnrich(stubEnrich(`Record name: ${c.name}\n\nPage text:\n${c.html}`));
    assert.equal(parsed.ok, true, `${c.id} produced a readable answer`);
  }
});

test('the scorer counts a missing answer as wrong on every field', () => {
  const cases = [{ id: 'a', expect: { segment: 'hotel', size: 'large' } }];
  const summary = scoreCases({ cases, results: [{ id: 'a', ok: false, reason: 'invalid' }], fields: ['segment', 'size'] });
  assert.equal(summary.jsonValidityRate, 0);
  assert.equal(summary.accuracy.segment, 0);
  assert.equal(summary.allFieldsCorrect, 0);
  assert.equal(matches(null, undefined), true, 'no answer and an explicit null are the same answer');
  assert.equal(matches('2026-09-24', '2026-09-24'), true);
});

test('the evaluation runs end to end on the stub lane and reports real numbers', async () => {
  const { summary, meta } = await runEval({ lane: 'stub', limit: 6, env: {} });
  assert.equal(meta.lane, 'stub');
  assert.match(meta.laneNote, /NOT the model/);
  assert.equal(summary.n, 6);
  assert.equal(summary.validAnswers, 6, 'every stub answer parsed');
  assert.ok(summary.accuracy.segment > 0 && summary.accuracy.segment <= 1);
  assert.ok(summary.tokens.meanInput > 0);

  const md = toMarkdown(summary, meta);
  assert.match(md, /JSON validity/);
  assert.match(md, /Lane: \*\*stub\*\*/);
});

test('the real lane refuses to pretend when there is no key', async () => {
  await assert.rejects(() => runEval({ lane: 'real', env: {} }), /needs a working provider/);
});
