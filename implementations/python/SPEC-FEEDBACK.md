# Spec feedback from an independent Python implementation

Written while implementing Intertie v0.1 from `spec/` and `docs/decisions/0003-signatures.md`
only. Nothing under `packages/` was read. The conformance runner was used only as a black
box. **[runner]** marks items where the spec text alone did not say what the runner
expected, and I learned the expectation from a runner failure message.

Each item gives the file and section, what was unclear, and what I chose.

> **Resolution (2026-10-29, project side).** Items 1–6, 8–19, 21–30 and 32 are now
> answered in the spec text (spec/README.md changelog, "0.1 clarifications"). There is
> no wire change.
>
> Three items exposed **bugs in the reference implementation**, which are fixed with
> regression tests:
> - **#20:** a full batch could exceed the 1 MiB body limit and wedge a peer. The home
>   now splits batches by size, and inline files are capped at 512 KiB per event.
> - **#22:** a former peer's pull leaked the latest `seq`; it is now capped at its
>   leave.
> - **#28:** an over-long name returned `invalid_event`; it now returns `too_large`.
>
> Two runner items are fixed: **#33** (pull-only subjects now claim `peer-pull`) and
> **#34** (the summary counts skips separately).
>
> On **#31**, the rate-limit guidance is a SHOULD with example numbers. On **#7** and
> **#20**, the trade-offs are noted.

## Signatures (core.md §4)

1. **core.md §4, verification step 6.** "its configured endpoint base plus the received
   path and query". The endpoint base usually has a path (`…/intertie`), and the received
   path already starts with it, so read literally the path is doubled. *Chose:* the
   scheme and authority of the configured endpoint, plus the raw request-target. Suggest
   saying "scheme and authority".
2. **core.md §4, step 1.** "has a `sig1` member whose component list is exactly…". Read
   literally, this allows other members, extra parameters, other parameter orders and
   SF whitespace. conformance.md's security suite expects "extra members" to be
   rejected. *Chose:* fully strict. `Signature-Input` and `Signature` must each be
   exactly one `sig1` member, with the parameters exactly in profile order and nothing
   else. Suggest stating that the whole header value must match the profile.
3. **core.md §4.** The nonce length ("at least 16 random bytes") is stated only as a
   sender rule. The verification steps never check it and give no code for it.
   **[runner]** expects `401 bad_signature` for a short nonce. *Chose:* check it in step 1,
   accepting base64url with or without padding. Suggest adding it to step 1.
4. **core.md §4, step 4.** No code is given for a malformed `keyid` (no `#`, empty parts,
   or an org that isn't a valid name), and none for discovery failures (redirect,
   oversize, wrong `org`, bad version, network error). *Chose:* `unknown_key` for all of
   them, which the runner agrees with. Suggest saying "any failure to resolve → `unknown_key`".
5. **core.md §3 + §4.** "re-fetch once if `kid` is missing, at most once per 60 s per
   org". It is unclear whether the 60 s counts from *any* fetch, or only from the last
   unknown-kid re-fetch. If it counts from any fetch, a rotation within 60 s of first
   contact fails. *Chose:* from the last unknown-kid re-fetch.
6. **core.md §4.** "when the request has a body": it is not said whether a POST with
   `Content-Length: 0` has a body. *Chose:* no body, so no `content-digest` component.
7. **core.md §4 and §3.** Responses are unsigned. Over loopback dev mode that means a
   pulled event's integrity rests on nothing. This is already noted in ADR 0003, and
   I'm listing it only for completeness.

## Discovery and versioning (core.md §3, §10)

8. **core.md §3 + §10.** "Compatible when majors match", but "during 0.x a minor bump
   MAY break compatibility". It is unclear what a 0.1 implementation should accept:
   `0.0`? `0.2`? *Chose:* accept `0.N` for N ≥ 1, and reject any other major (the runner's
   `security.downgrade.version` passes). Suggest a rule for 0.x.
9. **core.md §3.** The discovery-fetch rules say HTTPS, but they don't say what scheme dev
   mode uses for the `/.well-known` fetch of a `host:port` org. *Chose:* in dev mode, `http`
   for discovery and endpoints, loopback only.

## Lifecycle (core.md §6)

10. **core.md §6, Accept.** Only "invalid token → `404 invalid_invite`" has a code. A
    binding mismatch, an accept by the home itself, an expired or used token and a
    closed channel have none. *Chose:* `404 invalid_invite` for all of them (no oracle).
11. **core.md §6.** "A repeat accept … returns the same channel" doesn't say which
    `seq`: the current one, or the original pre-join one. *Chose:* the original
    (`join seq − 1`), so a peer that lost the first response still pulls from its join.
12. **core.md §6, Remove.** Leave says the leaver receives its own `peer.leave`. Remove
    doesn't say whether the removed peer receives it. *Chose:* yes, delivery stops after
    its `peer.leave` in both cases (the runner checks "removal delivered").
13. **core.md §6, Close.** "rejects further submissions with `409 channel_closed`". It
    is unclear whether this is an HTTP 409 for the whole request or a per-event
    rejection in `results`, and where it sits in the §7.1 check order. *Chose:*
    per-event, right after check 2 (participant). The runner did not exercise this.

## Events and delivery (core.md §5, §7)

14. **core.md §7.1 "At the home" vs §5.** Check 4 says edits and deletes "target a known
    message" (→ `not_author`). §5 says "An edit or delete whose target is unknown is
    accepted and ignored". *Chose:* the home rejects an unknown target with
    `not_author`, and peers accept it and ignore it. Suggest scoping the §5 sentence to
    receivers of sequenced events.
15. **core.md §7.1.** An event *with* a `seq`, sent to the home of its own channel, isn't
    covered. The text only says that an event without `seq` is a submission.
    **[runner]** expects `invalid_event` (I first returned `not_home`).
16. **core.md §7.1.** An event *without* a `seq`, pushed to a peer for a channel it is a
    peer of. Check 1 read literally ("not one this org homes") gives `unknown_channel`.
    **[runner]** expects `invalid_event` or `not_home`. *Chose:* `not_home`.
17. **core.md §7.1.** The check order 1–6 doesn't place structural validation
    (`invalid_event`: bad id, missing fields), or the `threads` root check (which
    capabilities.md says gives `invalid_event`). *Chose:* structural checks first, the
    thread-root check last.
18. **core.md §7.1 "At a peer".** For a held (gap) event, it says "accepts the event, holds
    it", but not which status to return. *Chose:* `accepted` with its `seq`.
19. **core.md §7.1 + §5.** It isn't said whether the home sequences unknown or extension
    event types from peers. *Chose:* yes (envelope checks only). The runner's
    `core.ext.unknown-type` expects `accepted`.
20. **core.md §7.2 + §9.** A batch of 100 events, each with 16,000 characters of text,
    exceeds the 1 MiB body limit. The spec doesn't say to split batches by size.
    *Chose:* the home splits pushes to stay under the receiver's body limit.
21. **core.md §7.3.** It doesn't say whether an out-of-range `limit`/`wait`, a negative
    `since` or a non-integer value is clamped or rejected, or what `since` defaults to.
    *Chose:* `400 bad_request`, and `since` defaults to 0.
22. **core.md §7.3.** The response `seq` is "latest seq in the channel", even for a
    former peer, which leaks activity after it left. Followed literally.
23. **core.md §7.3.** Percent-encoding of `{channel}` is shown only for `@`. Dev-mode
    channel ids contain `:` (`c-x@localhost:9484`). *Chose:* encode every reserved
    character when sending, and percent-decode the segment when receiving. Because
    `@target-uri` is "as sent", both forms verify.
24. **core.md §7.3.** It isn't said whether a former peer's pull that is already
    caught up to its `peer.leave` should honour `wait`. *Chose:* answer at once (empty).

## Errors and limits (core.md §8, §9)

25. **core.md §9.** A body with more than 100 events: `400 bad_request` or
    `413 too_large`? **[runner]** expects `400 bad_request`.
26. **core.md §8.** There are no codes for an unknown path or a wrong method.
    **[runner]** expects `405` (it accepted the code `bad_request`). *Chose:*
    `404`/`405` with code `bad_request`.
27. **core.md §9.** "characters" is undefined: Unicode code points (Python `len`) or
    UTF-16 code units (JS `length`)? They differ for emoji and other astral characters,
    so two implementations can disagree on `too_large` at the 16,000 boundary. *Chose:*
    code points. Suggest saying which.
28. **core.md §9 vs §5.** An over-long `sender.name` is `too_large` (§9 lists it), and an
    empty one is `invalid_event`. The split is reasonable but implicit.

## Capabilities

29. **capabilities.md `reactions`** says `emoji` is "max 32 bytes".
    `schemas/event.schema.json` has `maxLength: 64` (characters). *Chose:* 32 UTF-8
    bytes. Also, the home's validation of a reaction's `target` isn't specified.
    *Chose:* not validated.
30. **schemas/event.schema.json.** `message.create` doesn't encode "text MAY be empty
    only when `files` is present". `$defs/text` has `minLength: 1`, but it is used only by
    `message.edit`.

## Security (security.md)

31. **security.md, Threats table.** "Per-org rate limits (`429` + `Retry-After`)" gives
    no numbers and no indication whether it is MUST or SHOULD. *Chose:* a token bucket
    per authenticated org (50 req/s, burst 500), applied after signature verification.
32. **security.md §SSRF.** When DNS returns a mix of allowed and refused addresses, it
    isn't said whether to refuse the whole name or connect only to the allowed ones.
    *Chose:* connect only to addresses that passed the check.

## Runner / report (not spec, but noticed)

33. A pull-only subject's report says `"roles": ["peer-push"]`. I expected `peer-pull`
    (conformance.md, roles table).
34. Skipped checks are reported as `"pass": true, "skipped": true`, and the printed
    "N/N" summary counts them as passes.
