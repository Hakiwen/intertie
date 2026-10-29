# Changelog

## v0.2.0 (2026-10-29)

The protocol is still v0.1. This release adds packages, fixes bugs, and makes the spec text
clearer. There is no wire-format change.

### What a second, independent implementation found

We had a separate implementation written in Python **from the spec text alone**, without
reading a line of the reference code (`implementations/python/`). It passes the full
conformance suite in every role, including the adversarial `security` level, and CI runs
that on every push. Building it surfaced 34 places where the spec text wasn't precise
enough. Three of them were **real bugs in our own reference implementation**:

1. **A busy channel could wedge a peer forever.** The home sent up to 100 events per
   delivery, but 100 maximum-size messages are about 1.6 MB, which is over the 1 MiB
   request limit. The peer rejected every attempt and the home retried the same batch
   indefinitely. The home now splits deliveries by size as well as count, and one
   event's inline files are capped at 512 KiB, so every event fits.
2. **A peer that left could still see the channel's activity.** A removed peer could
   still pull up to its own departure, but the response reported the channel's
   *latest* sequence number, leaking how much was said after it left. That number is
   now capped at its departure.
3. **Wrong error for an over-long name.** It returned `invalid_event` where the spec
   lists `too_large`.

The other 30 items are now answered in the spec text. Examples: exactly how strict the
signature header is, which URL is signed, which error code applies to each case, what
"characters" means, and how batches are sized. The full list is in
`implementations/python/SPEC-FEEDBACK.md`.

### Added

- **`@intertie/teams-adapter`**, which makes a Microsoft Teams channel a participant:
  - an Azure Bot (single-tenant) with resource-specific consent;
  - full Bot Framework JWT verification (signature, issuer, audience, expiry,
    `serviceUrl` claim, endorsement, connector-host allowlist, same tenant);
  - threads, edits, deletes, reactions (as far as Teams allows), `<at>` mentions and
    inline images;
  - an app package generator, validated against Microsoft's schema.

  Tested end to end with Slack. See `spec/teams-mapping.md`.
- **Slack "Add to Slack" host** (`intertie-slack host`), one service for many
  workspaces:
  - OAuth v2;
  - each workspace gets its own Intertie identity, key and database;
  - bot tokens sealed with AES-256-GCM;
  - uninstall handling;
  - deploy recipes;
  - `docs/slack-oauth.md`, which explains where it runs and why we don't run a public
    one.
- **The independent Python implementation** (`implementations/python/`), with CI
  conformance.
- **Conformance runner:** pull-only subjects report the `peer-pull` role, and the
  summary counts skipped checks separately.
- The Markdown ⇄ HTML conversion is shared in core. Dev mode accepts
  `<name>.localhost:<port>` org names.

### Fixed

- The three bugs above, plus a deeply nested JSON body in the Python implementation,
  which returned 500 instead of 400 on Python 3.13. The `security` suite caught it in CI.

## v0.1.0 (2026-10-29)

First release. The protocol is a v0.1 draft, and it may still change in breaking ways
before 1.0.

**Spec (`spec/`):**

- Core;
- capabilities: threads, reactions, files, mentions, members;
- security, conformance (levels, roles, signed reports);
- Slack and Matrix mappings;
- JSON Schemas;
- signature test vectors, cross-checked against Go's standard library;
- a TLA+ model of sequencing, delivery, pull and invites, checked with TLC.

**Packages:**

- `@intertie/core`: the reference engine (signing, discovery, SSRF-safe fetch, home and
  peer state machine, pull, files). Zero runtime dependencies.
- `@intertie/slack-adapter`: a Slack app run by a participant. It supports Socket Mode
  or the Events API, `/intertie`, an admin CLI and a manifest.
- `@intertie/matrix-gateway`: a Matrix room as a participant. It runs as an Application
  Service with ghost users, or as a bot with an OAuth device login and a
  self-refreshing session.
- `@intertie/conformance`: a runner for the home and peer roles, including the
  adversarial `security` level, with signed JCS reports.

**Supply chain:**

- SBOMs (CycloneDX + SPDX, from `npm sbom`), checked with an OSV scan;
- SLSA provenance and SBOM attestations for every release artifact, signed with Sigstore
  (see `SECURITY.md`).
