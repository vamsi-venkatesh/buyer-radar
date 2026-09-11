// npm run demo - the whole product in one command, with no network and no keys.
//
// This is not a mock of the pipeline. It is the pipeline: the same source
// modules, the same normalisation, the same dedup, the same rules, the same
// digest renderer, the same receipt chain, the same webhook handler and the same
// dashboard. The only thing replaced is the network, which answers out of
// demo/fixtures.mjs instead of the live web.
//
// Everything it produces is therefore real output over synthetic input. No
// business, phone number, price, tender or article in it exists, and the demo
// says so on the page.
//
//   npm run demo              seed, run, and serve on http://127.0.0.1:4710
//   npm run demo -- --seed    seed and run, print the digest, do not serve
//   RADAR_PORT=5000 npm run demo

import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { overpassBody, newsBody, agmarknetBody, institutionBody, SYNTHETIC } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, '.store');
const PORT = Number(process.env.RADAR_PORT || 4710);
const WA_APP_SECRET = 'demo-app-secret-not-a-real-one';
const OWNER_WA = '919800000099';

// --------------------------------------------------------------- the network
//
// One function stands in for the whole internet. Anything the demo did not
// anticipate fails loudly rather than reaching a real service by accident: a
// demo that quietly makes a live request is not a demo.

const seen = [];

function reply(body, contentType) {
  return new Response(body, { status: 200, headers: { 'Content-Type': contentType } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url || String(input);
  seen.push(url);

  if (url.includes('overpass-api.de')) {
    const query = String(init.body || '');
    const group = query.includes('industrial')
      ? 'industry'
      : query.includes('shop"="wholesale')
        ? 'trade'
        : query.includes('tourism')
          ? 'hospitality'
          : 'food_service';
    return reply(overpassBody(group), 'application/json');
  }

  if (url.includes('news.google.com/rss/search')) {
    return reply(newsBody(decodeURIComponent(url)), 'application/rss+xml');
  }

  if (url.includes('api.data.gov.in/resource/')) {
    const u = new URL(url);
    return reply(
      agmarknetBody(u.searchParams.get('filters[commodity]'), u.searchParams.get('filters[state]')),
      'application/json'
    );
  }

  if (/\/robots\.txt$/.test(url)) return reply('User-agent: *\nAllow: /\n', 'text/plain');

  const institution = institutionBody(url);
  if (institution !== null) return reply(institution, 'text/html; charset=utf-8');
  if (/\.example\.test\//.test(url)) return new Response('not found', { status: 404 });

  throw new Error(
    `the demo refuses to make a real request: ${url}\n` +
      'Add a fixture for it in demo/fixtures.mjs, or leave that source out of the demo run.'
  );
};

// The engine reads config and paths at import time, so these have to be set
// before src/ is imported at all.
process.env.RADAR_DATA_DIR = STORE;
process.env.RADAR_INSTITUTIONS_REGISTRY = 'demo/institutions.json';
process.env.RADAR_INSTITUTIONS_PROBE = 'demo/institutions.probe.json';
process.env.DATA_GOV_IN_KEY = 'demo-key-no-request-leaves-this-process';
process.env.RADAR_TO_WA = OWNER_WA;
process.env.WA_APP_SECRET = WA_APP_SECRET;
delete process.env.DATABASE_URL;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.LLM_API_KEY;

const { run } = await import('../src/run.mjs');
const { processWebhookBatch, verifySignature } = await import('../src/webhook.mjs');
const { openStore } = await import('../src/lib/store.mjs');
const { createServer } = await import('../src/dashboard/server.mjs');
const { setLeadStatus } = await import('../src/register.mjs');
const { RUNS_DIR } = await import('../src/lib/paths.mjs');
const { CLIENT } = await import('../src/client.mjs');

const quiet = () => {};

async function main() {
  const seedOnly = process.argv.includes('--seed');

  await rm(STORE, { recursive: true, force: true });
  await mkdir(STORE, { recursive: true });

  process.stdout.write(`\n  ${CLIENT.digest.title} demo\n`);
  process.stdout.write(`  ${SYNTHETIC}. Nothing here is real, and no request leaves this process.\n\n`);

  // 1. A real run of the real pipeline, over the synthetic web.
  const result = await run(
    {
      city: 'bengaluru',
      sources: ['institutions', 'overpass', 'news', 'agmarknet'],
      fetchSources: ['institutions', 'overpass', 'news', 'agmarknet'],
      stages: [],
      limit: 60,
      dry: false,
      deliver: [],
      noLlm: true,
    },
    { log: quiet }
  );

  const s = result.summary;
  process.stdout.write(`  run       ${result.runId}\n`);
  process.stdout.write(`  leads     ${s.leadsTotal} in the register, ${s.leadsWithPhone} with a phone\n`);
  process.stdout.write(`  demand    ${s.requirements} posted requirements, ${s.requirementsWithContact} with a contact\n`);
  process.stdout.write(`  digest    ${s.digestChars} characters\n`);
  process.stdout.write(`  receipts  ${result.bundle.receipts.length} in ${path.relative(process.cwd(), RUNS_DIR)}/${result.runId}.evidence.json\n`);
  process.stdout.write(`  hash      ${result.bundle.hash}\n`);

  // 2. One status change, so the register has history and a status receipt.
  const store = await openStore();
  try {
    const leads = await store.allLeads();
    if (leads.length) {
      const target = leads.find((l) => l.phone) || leads[0];
      const change = await setLeadStatus(store, {
        ref: target.id,
        status: 'contacted',
        note: 'rang the purchase manager, asked for the vegetable list',
      });
      process.stdout.write(`  status    ${target.name}: new -> contacted, receipt ${(change.bundle && change.bundle.hash ? change.bundle.hash : '').slice(0, 12) || 'written'}\n`);
    }
  } finally {
    await store.close();
  }

  // 3. One inbound WhatsApp message from the owner, signed as Meta signs it,
  //    through the real webhook handler: the reply is composed and the send is
  //    recorded as not sent, because no WhatsApp credentials exist here.
  const body = Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'demo',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: OWNER_WA, phone_number_id: 'demo' },
                messages: [
                  {
                    from: OWNER_WA,
                    id: `wamid.demo.${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'L1 contacted asked for their vegetable list' },
                  },
                ],
              },
            },
          ],
        },
      ],
    })
  );
  const signature = `sha256=${createHmac('sha256', WA_APP_SECRET).update(body).digest('hex')}`;
  const signatureOk = verifySignature(body, signature, WA_APP_SECRET);
  const tamperRejected = !verifySignature(Buffer.concat([body, Buffer.from(' ')]), signature, WA_APP_SECRET);
  const wa = await processWebhookBatch(body, { storeFactory: () => openStore() });
  process.stdout.write(
    `  webhook   ${wa.inbound} inbound, ${wa.replies.length} reply composed, ` +
      `signature ${signatureOk ? 'accepted' : 'REJECTED'}, a tampered body ${tamperRejected ? 'rejected' : 'ACCEPTED'}\n`
  );
  process.stdout.write(`  network   ${seen.length} requests, all answered from demo/fixtures.mjs\n`);

  process.stdout.write(`\n${result.digest.text}\n`);

  if (seedOnly) {
    process.stdout.write('\n  --seed given: not serving. Run `npm run demo` to open the dashboard.\n\n');
    return;
  }

  // 4. The owner's dashboard, on a token minted for this process only.
  const token = randomBytes(24).toString('hex');
  const server = createServer({ token });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  process.stdout.write(`\n  Dashboard: http://127.0.0.1:${PORT}/login?t=${token}\n`);
  process.stdout.write('  One-time token, this process only. Open the link once; the cookie does the rest.\n');
  process.stdout.write('  Pages: /  /leads  /leads?kind=requirement  /prices  /runs  /report/weekly\n');
  process.stdout.write('  Ctrl-C to stop. Everything you see is synthetic.\n\n');

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
