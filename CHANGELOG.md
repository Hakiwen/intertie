# Changelog

## Unreleased

- `@intertie/teams-adapter`: Microsoft Teams as a participant.
  - Azure Bot (single-tenant) with resource-specific consent.
  - Bot Framework JWT verification (signature, issuer, audience, expiry, `serviceUrl`
    claim, endorsement, connector host allowlist).
  - Threads, edits, deletes, reactions (as far as Teams allows), inline images, and
    `<at>` mentions.
  - App package generator, validated against Microsoft's v1.25 schema.
  - `spec/teams-mapping.md`.
- Shared Markdown ⇄ HTML conversion moved into core.
- Slack "Add to Slack" multi-workspace host (`intertie-slack host`):
  - OAuth v2 install with a signed state;
  - per-workspace Intertie identity, key and database;
  - bot tokens sealed with AES-256-GCM, bound to the team id;
  - uninstall handling;
  - a distributed manifest, deploy recipes (container, Fly.io, systemd), and
    `docs/slack-oauth.md`.
- Dev mode accepts `<name>.localhost:<port>` org names.

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
