# Intertie conformance, v0.1

Status: draft, 2026-10-29. License: CC-BY-4.0.

## Levels

A conformance claim names a protocol version, one or more **roles**, and a set of
**levels**. Each level is a capability name, plus `core`.

| level | meaning |
|---|---|
| `core` | Core §2–§10. This includes edits, deletes, thread replies shown at least inline, and serving the pull endpoint when acting as home. |
| `threads` | Native thread rendering and origination (`capabilities.md`). |
| `reactions` | `reaction.add` / `reaction.remove`. |
| `files` | Sends and serves files by reference and inline; fetches with signed GETs. |
| `mentions` | Emits mentions and maps them to native notifications. |
| `members` | Announces its own roster and tracks remote rosters. |
| `security` | Refuses the adversarial requests in the runner's security suite. Examples: signature-profile downgrades (alg, tag, label, extra members or components), forged and cross-org keys, future timestamps, short nonces, query tampering, malformed keyids, discovery redirects or oversize or wrong-org documents, protocol-major downgrades, id conflicts, path traversal, malformed bodies, and pre-join or replayed reads. It also handles key rotation. **Registry listings are expected to claim `security`.** |

| role | meaning |
|---|---|
| `home` | Can share channels: issue invites, sequence events, fan out, serve pull. |
| `peer-push` | Can join channels and accept pushed deliveries. |
| `peer-pull` | Can join channels as a pull-only peer (no inbound HTTPS). |

Example claim: `intertie 0.1 · home, peer-push · core, threads, reactions`.

There are no separate "Edits" or "Pull" levels. Edits are Core, because a shared
channel where nobody can fix a typo is not one. Serving pull is Core for homes, because
it is a few lines over the log the home already keeps, and it lets every peer recover
from gaps. Pull-only *operation* is the `peer-pull` role. See
`docs/decisions/0005-core-scope.md`.

## Machine-readable capability list

The discovery document's `capabilities` array is the claim of record for levels. An
implementation MUST NOT list a capability it does not meet.

## The conformance runner

`packages/conformance` is a CLI that drives an implementation **as a peer and as a
home**. It runs its own short-lived org (a key plus a discovery document) and executes
a test plan grouped by level. Each test is a named check with a pass/fail result and
evidence (the request, the response status and the error code).

The runner checks the negative paths as hard as the positive ones:

- bad signatures,
- stale `created`,
- replayed nonces,
- digest mismatches,
- a non-participant posting,
- a peer impersonating another org,
- an edit of somebody else's message,
- oversize bodies.

These are the checks that keep the network safe.

## Signed report

The runner emits a JSON report:

```json
{
  "intertie_report": "0.1",
  "subject": { "org": "acme.com", "endpoint": "https://connect.acme.com/intertie", "implementation": "acme-chat 3.2" },
  "runner": { "name": "@intertie/conformance", "version": "0.1.0" },
  "date": "2026-10-29T20:00:00Z",
  "claim": { "roles": ["home", "peer-push"], "levels": ["core", "threads"] },
  "results": [ { "id": "core.sig.rejects-stale", "level": "core", "role": "home", "pass": true, "detail": "401 stale_signature" } ],
  "passed": true,
  "signature": { "keyid": "acme.com#2026-10", "alg": "ed25519", "sig": "<base64url>" }
}
```

The report is signed by **the subject org's own key**, the one it publishes in its
discovery document:

- `sig` is Ed25519 over the RFC 8785 (JCS) canonical JSON of the report *without* the
  `signature` member.
- Anyone can verify it by fetching `https://<subject.org>/.well-known/intertie` and
  finding `kid`.

This is **self-certification**:

- The signature proves that the org that controls `acme.com` asserts these results. It
  doesn't prove that a neutral party observed them.
- The registry (a separate repository) lists such reports.
- A hosted verifier, which re-runs the suite against the endpoint and countersigns, is
  a possible later addition. It would be optional and modelled on ACME CAs, and it would
  never be in any message path.
