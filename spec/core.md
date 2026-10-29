# Intertie Core, v0.1

Status: draft, 2026-10-29. License: CC-BY-4.0.

Intertie lets two or more organizations share a chat channel. Each organization runs its
own implementation. Messages move directly between those implementations over signed
HTTPS. Nobody else is in the path.

Core is everything an implementation MUST do. It is small on purpose: a competent
developer with an LLM should be able to implement it in an afternoon. Everything else
is an optional capability (`capabilities.md`).

The key words MUST, SHOULD and MAY are used as in RFC 2119.

---

## 1. Model in one paragraph

An **org** is a DNS name (`acme.com`) that publishes a small JSON document at
`https://acme.com/.well-known/intertie`. The document gives the org's **endpoint** URL
and its Ed25519 public **keys**.

A **channel** has exactly one **home** org (the org that shared it) and one or more
**peer** orgs. Home and peers are the **participants**. The home is always a
participant, never a third party.

- Peers **submit** events to the home.
- The home assigns each event the next number in the channel's **sequence**
  (`seq` = 1, 2, 3, …) and delivers it to every peer.
- Peers that cannot accept inbound HTTPS **pull** instead.

With two orgs, this is a direct line between them.

```
   globex.com (peer)                       acme.com (home)                    initech.com (peer)
   ───────────────── submit (no seq) ───▶  assigns seq=42  ── deliver seq=42 ──▶  ─────────────────
   ◀────────────── deliver seq=42 ───────  (its own users                      ◀── pull since=41 ──
                                            post directly)                         (pull-only peer)
```

---

## 2. Names and identifiers

- **Org name**: a lowercase DNS name, in A-label form, with no port and no trailing dot.
  Examples: `acme.com`, `connect.acme.com`. Subdomains are allowed, and an org may use
  one to keep Intertie off its apex domain. Dev mode (§10) also allows `host:port`.
- **User id**: `<local>@<org>`, for example `u-81f2@globex.com`.
  - `<local>` is 1–128 characters from `[A-Za-z0-9._-]`.
  - It is opaque and stable, and it MUST NOT be an email address.
- **Channel id**: `<local>@<home-org>`, for example `c-7f3a@acme.com`.
  - The home chooses it.
  - It is globally unique because it carries the home's name.
- **Event id**: chosen by the creator. It is 16–64 characters from `[A-Za-z0-9_-]`
  with at least 128 bits of randomness, for example a UUIDv4 or ULID with the hyphens
  kept.
  - It is unique within a channel.
  - It doubles as the **idempotency key**.

---

## 3. Discovery

`GET https://<org>/.well-known/intertie` returns `application/json`:

```json
{
  "intertie": "0.1",
  "org": "acme.com",
  "display_name": "Acme Corp",
  "endpoint": "https://connect.acme.com/intertie",
  "keys": [
    { "kty": "OKP", "crv": "Ed25519", "kid": "2026-10", "x": "Lpu9z83fzu-5HYAtdZ5FwLap-Q99ORClUeavSmIZyOE" }
  ],
  "delivery": "push",
  "capabilities": ["threads", "reactions"],
  "limits": { "max_body_bytes": 1048576 },
  "contact": "mailto:security@acme.com"
}
```

Field rules:

| field | rule |
|---|---|
| `intertie` | Protocol version, `major.minor`. This document is `0.1`. |
| `org` | MUST equal the name the document was fetched for. If it doesn't, reject the document. |
| `endpoint` | Absolute `https` URL with no query and no fragment. It MAY be on another host, which is how delegation works. Paths in §6–§7 are appended to it. |
| `keys` | One or more Ed25519 public keys as JWKs (RFC 8037). `x` is base64url without padding. `kid` is 1–64 chars from `[A-Za-z0-9._-]`. |
| `delivery` | `"push"` (default) or `"pull"`. See §7. |
| `capabilities` | Optional capabilities the org supports (`capabilities.md`). Core is implied. |
| `limits`, `contact` | Optional. |

Fetching rules (see also `security.md` §SSRF):

- The fetch MUST use HTTPS, MUST NOT follow redirects (treat any 3xx as failure), and
  MUST time out after 10 s and stop reading after 64 KiB.
- Cache the document according to `Cache-Control: max-age`, clamped to the range
  [60 s, 24 h]. If there is no header, cache for 1 h.
- If a signature names an unknown `kid`, re-fetch the document, but at most once per
  60 s per org. The 60 s window counts from the last such unknown-`kid` re-fetch, not
  from ordinary cache fills.
- In dev mode (§10), `host:port` and `*.localhost:port` orgs are fetched over `http`.
  This is allowed on loopback only.

---

## 4. Signed requests

**Every** request to an endpoint, GET or POST, MUST carry an HTTP Message Signature
(RFC 9421). This section is a fixed profile of RFC 9421, so the signature base can be
built in about 30 lines without a library. The reasoning is in
`docs/decisions/0003-signatures.md`.

Covered components: `"@method" "@target-uri"`, followed by `"content-digest"` when the
request has a body. No other components may appear, and they must appear in that order.

Request headers:

```
Content-Type: application/json
Content-Digest: sha-256=:<base64 SHA-256 of the exact body bytes>:
Signature-Input: sig1=("@method" "@target-uri" "content-digest");created=1761764580;keyid="globex.com#2026-10";alg="ed25519";nonce="Qm9yZ2VzIHdhcyBoZXJl";tag="intertie"
Signature: sig1=:<base64 Ed25519 signature over the signature base>:
```

- `Content-Digest` follows RFC 9530. It uses standard base64 with padding, between colons.
- The `Signature-Input` parameters are, in this order:
  - `created`: Unix seconds.
  - `keyid`: `"<org>#<kid>"`.
  - `alg`: `"ed25519"`.
  - `nonce`: at least 16 random bytes, base64url.
  - `tag`: `"intertie"`.
- The label is always `sig1`.

**Signature base.** The base is these lines joined by `\n`, with no trailing newline:

```
"@method": POST
"@target-uri": https://connect.acme.com/intertie/events
"content-digest": sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:
"@signature-params": ("@method" "@target-uri" "content-digest");created=1761764580;keyid="globex.com#2026-10";alg="ed25519";nonce="Qm9yZ2VzIHdhcyBoZXJl";tag="intertie"
```

- `@method` is uppercase.
- `@target-uri` is the full URI as sent: scheme, host, any non-default port, path and
  query.
- The `@signature-params` value is everything after `sig1=` in `Signature-Input`,
  **copied verbatim**.
- The signature is plain Ed25519 (RFC 8032) over the UTF-8 bytes of the base.

**Verification.** The receiver MUST perform all of these checks, in order. Any failure
means 401 with the error code in brackets.

1. The **whole** `Signature-Input` value is exactly one `sig1` member in the profile's
   form, and nothing else:
   - the exact component list;
   - the parameters `created;keyid;alg;nonce;tag`, in that order;
   - `alg="ed25519"` and `tag="intertie"`;
   - a nonce of at least 16 bytes (22 base64url characters).

   `Signature` is exactly one `sig1` member. Extra members, labels, parameters or
   components are refused, and so is a `keyid` that is not
   `<valid org name>#<kid>`. [`bad_signature`]
2. `|now − created| ≤ 300 s`. [`stale_signature`]
3. The `nonce` has not been seen for this `keyid` in the last 600 s. [`replayed`]
4. Split `keyid` at its last `#` into `org` and `kid`. Resolve `org` (§3) and find
   `kid`, re-fetching once if it's missing. Any failure to resolve is `unknown_key`:
   network error, redirect, oversize document, wrong `org` field, incompatible version,
   or missing `kid`. [`unknown_key`]
5. If the request has a body, `Content-Digest` matches the bytes received. A request
   "has a body" when it carries one or more bytes; `Content-Length: 0` is no body.
   [`bad_digest`]
6. Rebuild the base and verify it. For `@target-uri`, use the receiver's own external
   view of the URI: the **scheme and authority** of its configured endpoint, followed by
   the raw request-target (the path and query exactly as received).
   [`bad_signature`]

Step 3 checks the nonce. Remember it only after step 6 succeeds, so forged requests cost
no memory.

After these checks pass, the request is from **`org`**. This is the authenticated org,
and the rest of Core relies only on it. Responses are not signed: TLS authenticates
them.

**Key rotation.** To rotate a key:

1. Add the new key to `keys`.
2. Start signing with it.
3. Keep the old key listed for at least 24 h plus the document's `max-age`.
4. Remove the old key.

To revoke a key, remove it at once. Receivers will drop it when their cache expires,
which is why a `max-age` of 1 h or less is RECOMMENDED.

---

## 5. Events

Everything that happens in a channel is an **event**:

```json
{
  "id": "01JBDXQ4M6V2S9K3Y8T7R5N0PA",
  "type": "message.create",
  "channel": "c-7f3a@acme.com",
  "origin": "globex.com",
  "sender": { "id": "u-81f2@globex.com", "name": "Gail Ito", "avatar": "https://globex.com/a/81f2.png" },
  "ts": "2026-10-29T19:03:00Z",
  "seq": 42,
  "body": { "text": "Hi **Acme**, the export job failed again: `E_TIMEOUT`." }
}
```

| field | rule |
|---|---|
| `id` | §2. Idempotency key. |
| `type` | One of the types below, or a capability or extension type. |
| `channel` | The channel id. |
| `origin` | The org that created the event. |
| `sender` | The acting user. `id` MUST belong to `origin` (it ends in `@<origin>`). `name` is 1–80 chars. `avatar` is an optional `https` URL of 2048 chars or fewer, fetchable without credentials. Control events by the org itself MAY omit `sender`. |
| `ts` | When the origin created the event: RFC 3339 UTC. Use it for display only. Order comes from `seq`. |
| `seq` | Set by the home only. Absent on submissions. |
| `body` | Depends on the type. |

### Core event types

| type | who may create it | body |
|---|---|---|
| `message.create` | any participant | `text` (required; MAY be empty only when `files` is present), `thread` (optional: the id of a top-level `message.create` in this channel) |
| `message.edit` | the message's origin; the sender must equal the original sender | `target` (the message id), `text` |
| `message.delete` | the message's origin, or the home (moderation) | `target` |
| `peer.join` | home only | `org`, `display_name` |
| `peer.leave` | home, or a peer about itself | `org`, `reason` (`"left"`, `"removed"`, `"unreachable"` or `"closed"`) |
| `channel.update` | home only | `name` and/or `topic` (each optional, 1–80 / 0–250 chars) |
| `channel.close` | home only | `reason` (optional, free text) |

**Text.**

- `text` is Markdown in the GFM-MIMI profile (draft-ietf-mimi-content §GFM-MIMI):
  GitHub-flavoured Markdown with no raw HTML.
- It is at most 16,000 characters long.
- Senders SHOULD use only these constructs:
  - paragraphs and line breaks,
  - `*em*`, `**strong**`, `~~strike~~`,
  - `` `code` `` spans and fenced code blocks,
  - `>` quotes and `-`/`1.` lists,
  - `[label](https://…)` links.
- Receivers MAY render text as plain text. That is conformant: Markdown degrades to
  readable text, which is why it was chosen
  (`docs/decisions/0004-text-format.md`).
- Receivers MUST NOT interpret raw HTML.
- Receivers MUST render only `https:`, `http:` and `mailto:` links as links.

**Threads are in Core's data model.** A receiver that doesn't render threads MUST still
show a reply, for example top-level with a "↳ reply" marker, and MUST NOT drop it.
Native thread rendering is the `threads` capability.

**Edits and deletes.**

- When a receiver applies an edit, it replaces the displayed text.
- When a receiver applies a delete, it MUST stop displaying the content. It SHOULD
  purge the stored content, subject to its own legal holds.
- A purged `message.create` keeps its place in the log as
  `body: { "text": "", "deleted": true }`, keeping `thread` if it had one. A home that
  has purged content serves that shell when peers pull. Receivers treat it as deleted.
- A **receiver of sequenced events** accepts and ignores an edit or delete whose target
  it doesn't know. The **home** rejects such a submission (§7.1, check 4).

**Unknown types and fields.** Receivers MUST ignore event types and body fields they
don't understand, and MUST still accept the event.

---

## 6. Lifecycle

**Invite.** The home creates an invite token: at least 128 random bits, base64url,
single-use, expiring in at most 7 days by default. It hands the token to the peer org's
admin out of band, for example by email or by pasting it into a ticket, as an **invite
string**:

```
intertie:acme.com/q7VxM2b0Yt1kC6pZ8wR4nA
```

The home MAY bind an invite to one expected peer org.

**Accept.** The peer admin pastes the string into their implementation. The
implementation sends a signed request to `POST {home endpoint}/accept`:

```json
{ "token": "q7VxM2b0Yt1kC6pZ8wR4nA", "delivery": "push" }
```

The home checks three things:

- the token is valid, unexpired and unused;
- the authenticated org matches any binding;
- the authenticated org is not the home itself.

Then the home marks the token used, adds the org as a peer, and responds `200`:

```json
{ "channel": { "id": "c-7f3a@acme.com", "name": "acme-globex", "topic": "", "home": "acme.com",
               "peers": [ { "org": "globex.com", "display_name": "Globex" } ], "seq": 41 } }
```

After that, the home sequences a `peer.join` event, here as seq 42.

- The new peer receives events with `seq` greater than `channel.seq`. There is no
  history from before the join, and the home MUST enforce that on pull as well: it
  never returns a peer events from before its `peer.join`, whatever `since` asks for.
- A repeat accept from an org that is already an *active* peer returns the same
  channel and never `404`. A token is single-use in every other case, so an org that
  left or was removed needs a new invite.
  The `seq` returned is the original pre-join one (`join seq − 1`), so a peer that lost
  the first response still pulls from its join.
- Every other accept failure returns `404 invalid_invite`, deliberately with no detail:
  - an unknown, expired or used token;
  - a binding mismatch;
  - the home accepting its own invite;
  - a closed channel.

The peer's `delivery` value (§7) overrides the one in its discovery document for this
channel.

**Leave.** A peer submits `peer.leave` with `{ "org": <itself>, "reason": "left" }`.
The home sequences it, delivers it to all participants, the leaver included, and then
stops delivering to the leaver.

**Remove.** The home emits `peer.leave` with `reason: "removed"`. As with a leave, the
removed peer receives that event, and then delivery to it stops.

**Close (unshare).** The home emits `channel.close`, then rejects further submissions
per event (`results[].error`) with `channel_closed`. This check comes right after the
origin check (§7.1, check 3). It keeps the log available for pull for 7 days.

**Key revocation.** See §4. Revoking an org's last key effectively disconnects it from
every channel.

---

## 7. Delivery

### 7.1 POST {endpoint}/events

The one inbound path for events, in both directions. The body is `{ "events": [ … ] }`
with 1–100 events. The response is `200` with one result per event, in order:

```json
{ "results": [ { "id": "01JBDXQ4…", "status": "accepted", "seq": 42 },
               { "id": "01JBDXR9…", "status": "rejected", "error": { "code": "not_author", "message": "…" } } ] }
```

A status other than `200` means the receiver processed **none** of the events.

**At the home**, when an event has no `seq`, it is a submission. An event that carries a
`seq` and is sent to the home of its channel is rejected [`invalid_event`]. The home MUST
verify, in this order:

0. The event is structurally valid (§5, the schemas). [`invalid_event`]
1. The channel is one this org homes. [`unknown_channel`]
2. The authenticated org is a current peer of the channel. [`not_participant`]
3. `origin` equals the authenticated org, and `sender.id` belongs to `origin`.
   [`bad_origin`]
   If the channel is closed, the event is rejected. [`channel_closed`]
4. The type is one a peer may create (§5). Edits and deletes target a known message
   with the same origin; edits also need the same sender. [`not_author`] An unknown
   target, and a thread root that isn't a top-level message, are rejected.
   [`invalid_event`] Unknown and extension types pass this check and are sequenced.
5. Duplicates are handled:
   - If the `id` was already sequenced *from the same origin*, the result is
     `duplicate` with the existing `seq`.
   - If it came from another origin, the event is rejected. [`id_conflict`]
6. Size limits (§9) hold. [`too_large`]

If all checks pass, the home assigns `seq = last + 1`, stores the event, returns
`accepted` with the new `seq`, and queues delivery to **every** peer, the origin
included. The origin uses that copy to learn its own event's position.

**At a peer**, events arrive with a `seq`. The peer MUST check two things:

- the authenticated org is the channel's home [`not_home`];
- the event carries a `seq` [`invalid_event`].

Then the peer applies events in `seq` order and treats an already-applied `seq` as a
`duplicate`.

- If it sees a gap (a `seq` greater than its last plus 1), it accepts the event (status
  `accepted`, with its `seq`), holds it, and fills the gap by pull (§7.3) before
  applying.

Right after a successful accept, a peer SHOULD pull once (§7.3) from `channel.seq`. A
push can arrive before the accept response is processed, and the peer answers that push
`unknown_channel`.
- The home may relay events from any origin. The peer trusts the home for ordering and
  relay (`security.md` §Trust).

### 7.2 Retries

Delivery is **at-least-once**. The event `id` and `seq` make it idempotent.

- The home delivers to each peer **serially and in `seq` order**, in batches of up to
  100 events.
- Retry rules:
  - Network errors, `5xx`, `408` and `429` are retried, honouring `Retry-After`.
  - Any other `4xx` is not retried.
  - Exception: when the home is delivering to a peer, every failure is retried with
    the same backoff, `4xx` included. Dropping deliveries would leave gaps, and a fixed
    misconfiguration should recover on its own. The 72 h dead rule below applies.
  - A peer whose submission gets any other `4xx` drops that submission and reports
    the failure to its user.
  - Backoff is exponential with jitter: 1 s, 2 s, 4 s, … capped at 5 min.
- Peers retry their submissions the same way.
- If a peer has accepted nothing for **72 h**, it is **dead**. The home stops pushing to
  it, and MAY remove it with `peer.leave` and `reason: "unreachable"`. If it isn't
  removed, it can catch up by pull.

### 7.3 GET {endpoint}/channels/{channel}/events?since={seq}&limit={n}&wait={s}

The pull fallback. Every home MUST serve it. `{channel}` is one path segment,
percent-encoded per RFC 3986, so `@` becomes `%40` and `:` becomes `%3A`. The home
decodes it.

Parameters:

- `since`: the last `seq` the caller has, default 0. The response returns events with
  a greater `seq`. A value that is not a non-negative integer is
  `400 bad_request`.
- `limit`: 1–100, default 100. Out-of-range values SHOULD be clamped.
- `wait`: optional, 0–30, clamped likewise. When there are no newer events, the home MAY hold the request
  open for up to `wait` seconds before answering with an empty list (long-poll).

The response is `200` with `{ "events": [ … ascending … ], "seq": <latest seq> }`.
For a former peer, `seq` is capped at its own `peer.leave`, so the response does not
reveal activity after it left. Its pulls don't wait.

- The caller MUST be a current participant [`not_participant`], or a former peer
  fetching events up to its own `peer.leave`.
- The home MUST keep events available for pull for at least **7 days**.

**Pull-only peers.** A peer whose effective `delivery` is `"pull"` receives no pushes.
It polls (long-polling with `wait` is RECOMMENDED) and submits with `POST`, which is
outbound only. So **v0.1 does not require peers to accept inbound connections. Homes
must.**

### 7.4 Ordering guarantee

All participants see the same events in the same order: the home's `seq`. A
participant's own submissions appear in that order only once they are sequenced. Before
that, an implementation MAY show them as "sending".

---

## 8. Errors

Non-`200` responses carry `{ "error": { "code": "<code>", "message": "<human text>" } }`.

| HTTP | codes |
|---|---|
| 400 | `bad_request` (including more than 100 events in a batch), `invalid_event` |
| 401 | `bad_signature`, `stale_signature`, `replayed`, `unknown_key`, `bad_digest` |
| 403 | `not_participant`, `not_home`, `bad_origin`, `not_author` |
| 404 | `unknown_channel`, `invalid_invite`, `not_found` (unknown path) |
| 405 | `bad_request` (wrong method on a known path; a `404` is also acceptable) |
| 409 | `channel_closed`, `id_conflict` |
| 413 | `too_large` |
| 429 | `rate_limited` (with `Retry-After`) |

Per-event rejections use the same codes inside `results[].error`.

---

## 9. Limits

| what | limit |
|---|---|
| request body | 1 MiB, or less if `limits.max_body_bytes` says so |
| events per batch | 100 |
| `text` | 16,000 characters |
| a batch | at most the receiver's body limit: senders split batches by size as well as count |
| `sender.name`, `display_name`, channel `name` | 80 characters |
| channel `topic` | 250 characters |
| discovery document | 64 KiB |

"Characters" means Unicode code points, not UTF-16 units or bytes. An over-long value is
`too_large`; an empty required value is `invalid_event`.

---

## 10. Versioning, extensions, dev mode

**Versioning.**

- `intertie` is `major.minor`. Minor versions only add things.
- Two implementations are compatible when their majors match.
- During `0.x`, a minor bump MAY break compatibility, and the changelog will say when
  it does. A `0.1` implementation accepts peers that advertise `0.y` for any `y ≥ 1`,
  and ignores whatever it doesn't understand.

**Unknown things are ignored.** Unknown fields, event types and capabilities MUST be
ignored and MUST NOT cause errors.

**Extensions** use names that contain a `/`, prefixed by a domain the author controls:
`acme.com/priority` as a body field, an event type, or a capability. Core and
registered capability names never contain `/`.

**Dev mode** (`--dev-insecure` in the reference implementation) relaxes two rules, for
local testing only:

- org names MAY be `localhost:port`, `<name>.localhost:port`, `127.0.0.1:port` or
  `[::1]:port`;
- discovery and endpoints MAY use `http` on loopback addresses.

Dev mode MUST be off by default. An implementation in dev mode MUST refuse non-loopback
addresses.

---

## Appendix A. A complete exchange

Acme shares `#acme-globex` with Globex.

1. An Acme admin creates an invite and sends `intertie:acme.com/q7Vx…` to Globex.
2. Globex resolves `acme.com/.well-known/intertie` and sends a signed request to
   `POST https://connect.acme.com/intertie/accept`. It gets back the channel, with
   `seq: 0`.
3. Acme sequences `peer.join {org: globex.com}` as seq 1 and pushes it to Globex.
4. Gail at Globex writes "hello". Globex submits `message.create` to Acme's `/events`,
   and Acme answers `accepted, seq 2`.
5. Acme pushes seq 2 to Globex, which records the seq, and Acme's own UI shows the
   message.
6. Ana at Acme replies in a thread. Acme creates the event locally as seq 3 and pushes
   it to Globex.
7. Gail edits her message. Globex submits `message.edit {target}`, which becomes seq 4.
