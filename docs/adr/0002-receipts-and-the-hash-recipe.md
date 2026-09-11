# 2. Every run seals a receipt chain, and the hash recipe is published

Status: accepted, 2026-09-11

## Context

The radar makes claims: this source returned 220 listings, this tender was
blocked by a captcha, this model call cost 7 paise, this lead's status changed on
Tuesday. Logs are not evidence - they are unordered, they are edited by whoever
holds the disk, and they are usually gone by the time anyone asks.

An operator - and an interviewer, and the owner's accountant - should be able to
check a claim without trusting the process that made it.

## Decision

Every run writes `runs/<runId>.evidence.json`: an ordered chain of receipts
(`run.created`, `source.fetched`, `source.blocked`, `leads.upserted`, the model
stage's receipts, `digest.rendered`, `digest.delivered` or `digest.not_sent`),
terminated by `evidence.sealed` carrying a hash.

The hash is `sha256` over, exactly:

```
schema + "\n" + receipts.length + "\n"
then, for each receipt in order: JSON.stringify(receipt) + "\n"
```

with `schema = "vvdex.evidence-bundle/v1"`. That recipe is published here and in
the README so anybody can recompute it in three lines of any language.
`node tools/verify.mjs <bundle>` does it and exits non-zero on a mismatch.

Status changes, webhook batches and out-of-run tool calls get their own bundles,
sealed the same way and verified by the same command.

## Consequences

- A number in the digest, on the dashboard or in this repository's documentation
  can be traced to the receipt that produced it.
- Receipts are append-only within a run and the chain is order-sensitive:
  removing or reordering one changes the hash.
- This is tamper-**evidence**, not tamper-proofing. Somebody who can write the
  file can rewrite the chain and reseal it. Defending against that needs an
  external anchor - a signature or a published hash - and that is deliberately
  out of scope here, and said so rather than implied away.
- Receipts must never carry a secret. An API key is redacted out of every
  recorded URL before it reaches the chain.
