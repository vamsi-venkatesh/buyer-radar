# Security policy

## Reporting a vulnerability

Report privately, not as a public issue.

- Open a **private vulnerability report** through GitHub Security Advisories on
  this repository, or
- email **vamsi@vamsivenkatesh.com** with `buyer-radar` in the subject.

Please include what you found, how to reproduce it, and what an attacker gets.
Expect an acknowledgement within seven days. If a fix is needed, the advisory is
published with the release that carries it, and you are credited unless you ask
otherwise.

Do not test against anybody else's deployment, and do not test against the live
third-party sources this software reads.

## Supported versions

This project is at `0.1.0` and only the latest release is supported.

## What this software treats as a secret

Everything below comes from the environment and never from a file in this
repository. `.env.example` carries names and comments only, and `npm run
validate` fails the build on a committed key, token or private key.

| Secret | Used for |
| --- | --- |
| `RADAR_OWNER_TOKEN` | The dashboard's only credential |
| `WA_APP_SECRET` | Verifying every inbound webhook body |
| `WA_TOKEN`, `WA_VERIFY_TOKEN` | The WhatsApp Cloud API |
| `RADAR_SMTP_URL` | SMTP submission, password inside the URL |
| `DATABASE_URL` | Postgres, password inside the URL |
| `DEEPSEEK_API_KEY`, `LLM_API_KEY` | The model provider |
| `DATA_GOV_IN_KEY` | Mandi prices |

An API key is redacted out of every recorded URL before it reaches a receipt, a
log line or a stored row. An SMTP password is never printed, including in the
error raised when a URL cannot be parsed. A WhatsApp token is only ever put in a
request header.

## The security posture, stated plainly

- **The dashboard refuses to start without `RADAR_OWNER_TOKEN`.** There is no
  unauthenticated mode to fall back to. The token is compared constant-time and
  held in an `HttpOnly; SameSite=Strict` cookie.
- **It is a bearer credential.** Put a TLS reverse proxy in front of it; the
  compose file binds the port to `127.0.0.1` so that this is the obvious thing to
  do. Over plain HTTP the token crosses the network in the clear.
- **The webhook is the one route the owner token does not guard**, because Meta
  cannot present one. What stands in its place is an HMAC-SHA256 signature over
  the exact bytes received, compared constant-time. **With `WA_APP_SECRET` unset
  the route answers `503` and accepts nothing.**
- **Receipts are tamper-evident, not tamper-proof.** Anybody who can write the
  bundle can rewrite the chain and reseal it. That is stated in
  `docs/adr/0002-receipts-and-the-hash-recipe.md` rather than implied away.
- **The container runs as the non-root `node` user.**
- **No outbound path can reach a lead.** That is a safety property as much as a
  security one, and the tests prove it rather than describing it.

## Out of scope

- Denial of service against a deployment you control.
- Anything requiring an attacker who already has write access to the host, the
  environment or the evidence bundles.
- The absence of an external anchor for the receipt chain. It is a known,
  documented limitation, not a vulnerability report.
