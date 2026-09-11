# 1. The rules decide the score; the model is asked only when it would change one

Status: accepted, 2026-09-11

## Context

Every lead the radar finds has to be ordered, because the owner reads ten of them
over one cup of tea and not two hundred. Something has to do the ordering.

A language model is the obvious tool and the wrong one. It is not reproducible,
it is not free, it cannot be audited a week later, and a score that moves because
a provider shipped a new checkpoint is not a score. The owner also has to be able
to ask "why is this one first" and get an answer, and "the model thought so" is
not an answer he can act on.

But some leads genuinely cannot be ordered without reading prose. A listing that
says only `industrial=food` could be a spice mill or a bottling plant. A tender
notice states its quantity in a sentence, not a field.

## Decision

Scoring is a pure function of the lead record, written down in
[docs/scoring.md](../scoring.md), band by band, with the points.

The model runs as a separate stage that writes **facts**, never scores:
`segment_model`, `size`, `deadline`, `confidence`, evidence quotes and an opener
line. `scoreLead()` reads those under a confidence gate of 0.7 and applies its
own rules to them. The source-derived segment is never overwritten; both are
kept and a disagreement is visible on the register.

The stage is asked for at all only when `needsModel(purpose, lead, ctx)` says a
call could change the outcome - the rules are in `src/llm/needs.mjs` and in
[the README](../../README.md#model-policy). Every skip is receipted with its
reason, so "we did not call" is as visible as "we called".

## Consequences

- With no API key, with `LLM_ENABLED=false`, or with `--no-llm`, every score is
  exactly what it would otherwise have been. The model is genuinely optional.
- The cost of a run is bounded by a rule, not by a token budget alone.
- A prompt change cannot silently move yesterday's ranking, because yesterday's
  ranking was produced by the rules.
- The cost is a second segment field and the explaining of it. That is the right
  trade: the disagreement between a map tag and the page's own words is useful
  information, and hiding it behind one number would throw it away.
