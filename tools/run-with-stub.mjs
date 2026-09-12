// Run the whole pipeline against the stub model instead of a paid one.
//
// The demand lane's openings step needs a model: a news signal only becomes a
// requirement once something has read the article. With no DEEPSEEK_API_KEY in
// the environment there is no model, so this wires the evaluation stub in its
// place and leaves everything else exactly as a real run: the same sources, the
// same crawler, the same real network, the same store, the same digest.
//
//   node tools/run-with-stub.mjs --city bengaluru --sources news,openings --limit 200
//
// This is a proof harness and is never the daily run. Nothing here is imported
// by src/. The receipts say the model was the stub, because it was.

import { parseArgs, run, openingsLine } from '../src/run.mjs';
import { stubAnswer } from '../eval/llm/stub-model.mjs';

const STUB_MODEL = 'stub/keyword-reader';

/** An OpenAI-shaped chat response, so the real client parses it unchanged. */
function stubResponse(body) {
  const messages = JSON.parse(body).messages || [];
  const content = stubAnswer(messages);
  const payload = {
    id: 'stub',
    model: STUB_MODEL,
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  };
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** Model calls go to the stub; every other request is the real network. */
function routingFetch(real = globalThis.fetch) {
  return async (url, init = {}) => {
    const href = typeof url === 'string' ? url : url.url || String(url);
    if (/\/chat\/completions$/.test(href)) return stubResponse(init.body);
    return real(url, init);
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const env = {
    ...process.env,
    LLM_PROVIDER: 'deepseek',
    // Not a key. The routing fetch above never reaches a provider, and the
    // client only requires the value to be non-empty before it calls.
    DEEPSEEK_API_KEY: 'stub-no-network',
    LLM_MODEL: STUB_MODEL,
    LLM_ENABLED: 'true',
  };
  const result = await run(opts, { env, fetchImpl: routingFetch() });
  process.stdout.write(`${result.digest.text}\n`);
  const s = result.summary;
  process.stderr.write(`\n--- stub run ---\nmodel        ${STUB_MODEL} (no paid call was made)\n`);
  process.stderr.write(`requirements ${s.requirements ?? 0} (${s.requirementsWithContact ?? 0} with a contact)\n`);
  if (s.openings) {
    process.stderr.write(`openings     ${openingsLine(s.openings)}\n`);
    process.stderr.write(`openings     ${JSON.stringify(s.openings)}\n`);
  }
  process.stderr.write(`digest       ${s.digestChars} chars\nbundle hash  ${result.bundle.hash}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
