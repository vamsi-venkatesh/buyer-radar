// A small, deliberately generic scorer. It knows nothing about leads, segments
// or this particular prompt: it takes labelled cases, takes what came back, and
// counts. The radar's later evaluations - a scoring change, a different
// provider, a second prompt - should be able to reuse it unchanged.

/**
 * Compare one predicted value with its label.
 *
 * Everything is compared as a trimmed string, with null, undefined and the
 * empty string treated as the same "no answer", because a prompt that returns
 * null and a prompt that omits the field are equally right or equally wrong.
 */
export function matches(expected, actual) {
  const norm = (v) => (v === null || v === undefined || v === '' ? null : String(v).trim());
  return norm(expected) === norm(actual);
}

/**
 * Score a set of results against their labels.
 *
 * cases:   [{ id, expect: { field: value }, ... }]
 * results: [{ id, ok, value: { field: value }, reason, inputTokens, outputTokens, costInr, ms, cacheHit }]
 *
 * A case with no usable answer counts as wrong for every field. That is the
 * honest reading: a prompt that fails to answer has not got the answer right.
 */
export function scoreCases({ cases, results, fields }) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const perField = Object.fromEntries(fields.map((f) => [f, { correct: 0, answered: 0, wrong: [] }]));
  const perCase = [];
  let valid = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costInr = 0;
  let ms = 0;
  let cacheHits = 0;

  for (const c of cases) {
    const r = byId.get(c.id) || { ok: false, reason: 'no result' };
    if (r.ok) valid += 1;
    inputTokens += r.inputTokens || 0;
    outputTokens += r.outputTokens || 0;
    costInr += r.costInr || 0;
    ms += r.ms || 0;
    if (r.cacheHit) cacheHits += 1;

    const row = { id: c.id, ok: Boolean(r.ok), reason: r.reason || null, fields: {} };
    for (const f of fields) {
      const actual = r.ok && r.value ? r.value[f] : undefined;
      const hit = r.ok && matches(c.expect[f], actual);
      row.fields[f] = { expected: c.expect[f] ?? null, actual: actual ?? null, correct: hit };
      if (r.ok) perField[f].answered += 1;
      if (hit) perField[f].correct += 1;
      else perField[f].wrong.push({ id: c.id, expected: c.expect[f] ?? null, actual: actual ?? null });
    }
    perCase.push(row);
  }

  const n = cases.length;
  return {
    n,
    validAnswers: valid,
    jsonValidityRate: n ? round(valid / n) : 0,
    accuracy: Object.fromEntries(fields.map((f) => [f, n ? round(perField[f].correct / n) : 0])),
    correct: Object.fromEntries(fields.map((f) => [f, perField[f].correct])),
    wrong: Object.fromEntries(fields.map((f) => [f, perField[f].wrong])),
    allFieldsCorrect: perCase.filter((c) => c.ok && fields.every((f) => c.fields[f].correct)).length,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      meanInput: n ? Math.round(inputTokens / n) : 0,
      meanOutput: n ? Math.round(outputTokens / n) : 0,
    },
    costInr: round4(costInr),
    meanMs: n ? Math.round(ms / n) : 0,
    cacheHits,
    perCase,
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** A short markdown summary. Numbers only; no interpretation is added here. */
export function toMarkdown(summary, meta = {}) {
  const fields = Object.keys(summary.accuracy);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `# ${meta.title || 'Evaluation'}`,
    '',
    `- Date: ${meta.date || new Date().toISOString().slice(0, 10)}`,
    `- Lane: **${meta.lane || 'unknown'}**${meta.laneNote ? ` - ${meta.laneNote}` : ''}`,
    `- Provider / model: ${meta.provider || '-'} / ${meta.model || '-'}`,
    `- Prompt version: ${meta.promptVersion || '-'}`,
    `- Cases: ${summary.n} (all synthetic, written for this harness)`,
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| JSON validity | ${pct(summary.jsonValidityRate)} (${summary.validAnswers}/${summary.n}) |`,
    ...fields.map((f) => `| ${f} accuracy | ${pct(summary.accuracy[f])} (${summary.correct[f]}/${summary.n}) |`),
    `| every field correct | ${summary.allFieldsCorrect}/${summary.n} |`,
    `| mean input tokens | ${summary.tokens.meanInput} |`,
    `| mean output tokens | ${summary.tokens.meanOutput} |`,
    `| total cost | Rs ${summary.costInr} |`,
    `| cache hits | ${summary.cacheHits} |`,
    '',
  ];

  for (const f of fields) {
    if (!summary.wrong[f].length) continue;
    lines.push(`## ${f}: ${summary.wrong[f].length} wrong`, '');
    lines.push('| Case | Expected | Answered |', '| --- | --- | --- |');
    for (const w of summary.wrong[f]) lines.push(`| ${w.id} | ${w.expected ?? '-'} | ${w.actual ?? '-'} |`);
    lines.push('');
  }

  if (meta.note) lines.push('---', '', meta.note, '');
  return lines.join('\n');
}
