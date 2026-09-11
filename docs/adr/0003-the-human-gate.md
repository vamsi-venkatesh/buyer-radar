# 3. Nothing reaches a buyer; the owner is the only sender

Status: accepted, 2026-09-11

## Context

A lead-finding service is one small step from an outbound-messaging service, and
that step is where this kind of product usually goes wrong. It is also where the
law is: unsolicited commercial messaging to Indian numbers is regulated, buyers
did not ask to hear from us, and a supplier's reputation in a city of a few
hundred restaurants is the whole business.

The temptation is real, because "we found 240 buyers" is much less impressive
than "we contacted 240 buyers". The second one is also how a supplier gets
blocked.

## Decision

There is **no channel in this codebase that can reach a lead**. Not throttled,
not behind a flag, not requiring approval - absent.

- The only outbound address is the owner's own, set by the owner, in the owner's
  own environment (`RADAR_TO`, `RADAR_TO_WA`).
- `owner.message`, the one tool that sends anything, **has no recipient field**.
  Making a buyer reachable means rewriting the tool, not configuring it.
- A lead's phone number is only ever printed for the owner to dial himself.
- Inbound is gated the same way: a WhatsApp message from any number other than
  the owner's is recorded and never answered, and the record keeps the sender,
  the type and the character count - not the text.
- The model composes an opener line. It is printed in the owner's morning list.
  Nothing sends it.

## Consequences

- The product's ceiling is what one person can act on in a morning, and the
  digest is capped accordingly. That is the intended shape.
- The tests prove the gate rather than describing it: an agent is refused
  `owner.message` and `leads.set_status`, the register is read off disk
  afterwards to show it did not move, and `owner.message` is shown to have no
  recipient field at all.
- Adding outbound later would be a different product with a different legal
  posture, and would start by reversing this decision explicitly.
