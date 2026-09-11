# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-11

First public release. The engine had been running as a private deployment for a
Bengaluru fresh-produce supplier; this release generalises it so it runs for any
produce supplier from one configuration file.

### Added

- **The demand lane.** Buyers who have *posted a requirement*: institutional
  tender and notice pages (59 registered bodies), supplier-registration routes
  (22 buyers, Mondays only), the APEDA exporter directory, a flagged GeM client,
  and a stage that upgrades a news signal into a requirement with a contact.
- **The directory lane.** OpenStreetMap business listings via Overpass, Google
  News RSS signals, Agmarknet mandi prices, and a captcha-aware CPPP client that
  records a block rather than working around one.
- **Deterministic scoring** with published bands and worked examples
  (`docs/scoring.md`), dedup on normalised phone then name plus city, and a merge
  that never overwrites a status or a note.
- **A gated model stage.** `needsModel()` decides before every call; answers are
  cached on the prompt version, spend is capped per day in rupees and persisted,
  and every call, cache hit, refusal and skip is receipted.
- **Sealed evidence bundles** for runs, status changes, webhook batches and
  out-of-run tool calls, with the hash recipe published and `tools/verify.mjs` to
  check them.
- **A typed tool registry** with JSON Schema validation before the handler runs,
  owner-only gates on the two writing tools, and receipts for calls and refusals.
- **An MCP server** over stdio, JSON-RPC 2.0, no dependencies, defaulting to a
  read-only agent actor.
- **The owner's dashboard**: server-rendered HTML, no framework, no client-side
  JavaScript, mobile-first, one bearer token, and no unauthenticated mode.
- **A WhatsApp webhook** with constant-time HMAC verification over the exact
  bytes received, idempotency on message id, owner-only commands, and a privacy
  rule that records a non-owner message without its text.
- **Delivery to the owner only** - SMTP over implicit TLS with a dependency-free
  client, and the WhatsApp Cloud API. No channel can reach a buyer.
- **A weekly report**, a scheduler with no system cron in it, and a Docker image
  that runs both services.
- **An evaluation harness**: 30 labelled synthetic pages, a stub model for when
  there is no key, and a provider-agnostic scorer.
- **`npm run demo`** - the whole product in one command, with the network
  replaced by synthetic fixtures and nothing else changed.
- **`npm run validate`** - checks the client profile, the registries and the
  prompt versions, and fails on a committed key or token.
- Six architecture decision records in `docs/adr/`.

### Known limitations

These are in the roadmap and are stated here so nobody discovers them by
surprise.

- The openings lane resolves nothing today: every id in Google's current RSS feed
  is the opaque post-2024 form and carries no publisher URL. The resolver is
  correct; the supply is missing.
- 44 of the 59 registry entries did not answer when last probed, and 12 more
  published nothing matching the example catalogue. The probe records the cause
  for each.
- The GeM lane's parser is written against a response shape documented as assumed
  and never observed. It is off by default.
- The prices in `config/llm-prices.json` were written from prior knowledge, not
  fetched from a provider's pricing page. They are a cap, not an invoice.
- The evaluation is 30 synthetic cases. It is a smoke test, not a benchmark.
