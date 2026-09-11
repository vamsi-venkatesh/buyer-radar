# 4. A blocked source is recorded as blocked, never worked around

Status: accepted, 2026-09-11

## Context

Most of the interesting data about who buys vegetables sits behind terms that
forbid collecting it, a captcha, or a login. IndiaMART, JustDial, LinkedIn,
Zomato and Swiggy all have exactly the data this product wants and all forbid
taking it. The government tender portal shows its listings only after a captcha.

Every one of those has a technical workaround. Using one would make the numbers
larger this week and the product unusable as a business.

## Decision

- **robots.txt is read before the first page of every host and obeyed**, matched
  on our own User-Agent token, and the User-Agent carries a contact address.
- A captcha, a login or a rate limit is a **stop**, and the run records
  `source.blocked` with the exact reason. It is never solved, never bypassed,
  and never filled in with a fabricated row.
- Sources whose terms forbid this collection are **not implemented**, and the
  README names them so nobody adds one by accident.
- Pacing is per host and conservative: one request per two to three seconds, one
  fetch of any URL per run, documents capped at 2 MB, pages at 300 KB.
- Licence travels with the data. Every OpenStreetMap row carries `licence:
  "ODbL"` and the attribution string, and anything published from it must carry
  that attribution too.

## Consequences

- The demand lane found very little on the day it was built, and the README says
  so with the numbers. A lane that looked productive by ignoring a robots rule
  would be worth less than an empty one.
- Two refusals in the shipped registry are robots.txt refusals on tender pages we
  would otherwise read. They stay refused.
- Some sources are shipped behind a flag, parsing a response shape documented as
  **assumed and never observed**, rather than shipped as if they had been tested
  against the real thing.
