# Intertie specification, v0.1 (draft)

Text in this directory is licensed CC-BY-4.0 (see `LICENSE`).

Read in this order:

1. [`core.md`](core.md): everything an implementation MUST do (about a 20-minute read).
2. [`security.md`](security.md): threat model and required defences.
3. [`capabilities.md`](capabilities.md): optional features: threads, reactions, files,
   mentions, members.
4. [`conformance.md`](conformance.md): levels, roles, the runner, signed reports.
5. [`slack-mapping.md`](slack-mapping.md): how the Slack adapter maps every event
   (informative).

Machine-readable:

- [`schemas/`](schemas/): JSON Schema (2020-12) for the discovery document and events.
- [`test-vectors/`](test-vectors/): a fixed key, a request, and its exact signature base
  and signature, for checking an implementation's signing code.

## Design in five lines

- An org is a DNS name with `/.well-known/intertie` → endpoint + Ed25519 keys.
- HTTPS + JSON; every request carries an RFC 9421 signature in a fixed profile.
- A channel has a **home** (the org that shared it) that sequences and fans out; peers
  submit to it.
- Delivery is at-least-once over push, with a pull fallback every home serves.
- Core = message create/edit/delete (thread replies shown at least inline), plus
  lifecycle. Everything else is a capability.

## Changelog

- 0.1 (2026-10-29): first draft.
