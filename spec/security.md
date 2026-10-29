# Intertie security considerations, v0.1

Status: draft, 2026-10-29. License: CC-BY-4.0. These rules are normative where they use
MUST or SHOULD.

## Goals and non-goals

**Goals:**

1. **No intermediary.** Only the participants' own systems handle channel content.
2. **Authenticated orgs.** Every request is attributable to one DNS-named org.
3. **Integrity and confidentiality in transit.**
4. **Containment.** A malicious participant can disrupt only the channels it is part of,
   and can only speak as its own org.
5. **Safe defaults** for implementers who copy the reference implementation.

**Non-goals (v0.1):**

- **End-to-end encryption.** Each participant's server sees plaintext. Slack Connect
  has the same trust model, but with Slack Inc. as an extra party that sees everything;
  Intertie removes that party. When one side is a Slack workspace, Slack sees the
  plaintext no matter what the protocol does, so E2EE would be ceremony.
  **Roadmap:** MLS (RFC 9420) as a capability for channels where every participant is a
  native implementation, aligned with IETF MIMI.
- **Hiding metadata from the participants**, such as who talks to whom and when.
- **Protecting against a compromised participant's own server.** That server sees its
  own channels, by design.

## Trust model

- **Org identity = control of the DNS name**, demonstrated by serving the discovery
  document over HTTPS on it. This is the same root of trust as the Web PKI and as Matrix
  and XMPP server names. Anyone who can get a TLS certificate for `acme.com` can be
  Acme.
- **The home is trusted for ordering and relay** inside its channel. A malicious home
  can:
  - drop, delay or reorder events in the channel it homes;
  - **forge** events that claim another participant's origin, when relaying them to a
    third participant.
  In a two-party channel, forgery is meaningless: the only other party is the
  recipient, who knows what it sent. In N-party channels it is a real limit.
  - **Mitigation for v0.1:** peers SHOULD keep their own submission log. A peer that
    sees an event with its origin that it never submitted SHOULD alert its admin.
  - **v1 direction:** origin signatures on events, so third parties can verify relayed
    events end to end.
- **Peers are trusted only for their own org.** The home enforces that a peer submits
  only as itself (`origin` = the authenticated org; `sender` belongs to that org) and
  edits or deletes only its own messages (Core §7.1).

## Threats and required defences

| threat | defence |
|---|---|
| Passive or active network attacker | TLS 1.2+ is REQUIRED (TLS 1.3 RECOMMENDED), with certificate validation. There is no plaintext HTTP outside loopback dev mode. |
| Forged requests | An RFC 9421 Ed25519 signature on every request (Core §4). The key comes from the claimed org's own discovery document. |
| Replay | A ±300 s `created` window plus a nonce cache (≥ 600 s per `keyid`). Event-level idempotency (`id` and `seq`) makes any replay that gets through harmless. |
| Body tampering | `Content-Digest` is covered by the signature. |
| Key theft | Rotation and revocation by editing the discovery document (Core §4). Keep `max-age` ≤ 1 h. Keep private keys out of the repo and the logs, and readable only by the service. |
| Cross-org impersonation (Globex posts as an Acme user) | The home rejects a `sender.id` that does not end in `@<authenticated org>` (`bad_origin`). |
| Channel injection (an outsider posts) | The home rejects a non-peer (`not_participant`). A peer rejects deliveries that don't come from the channel's home (`not_home`). |
| Invite theft | Tokens have ≥ 128 bits, are single-use and expire (≤ 7 days by default). They can be bound to an org. The home shows the admin which org accepted, and the admin can remove that org. |
| SSRF via discovery or endpoints | See below. |
| Malicious content | See below. |
| Resource exhaustion | Size limits (Core §9), batch ≤ 100, per-org rate limits (`429` + `Retry-After`), long-poll `wait` ≤ 30 s, and dead-peer handling. |

### SSRF

An Intertie server makes outbound requests to URLs derived from attacker-supplied
input: org names, `endpoint`, avatar and file URLs. Implementations MUST follow all of
these rules:

- Connect only to these URLs:
  - `https://<org>/.well-known/intertie`;
  - the `endpoint` declared there, for every protocol call;
  - file URLs under that endpoint.
  Never connect to an arbitrary URL from an event body. Avatars are **not** fetched
  server-side. They are passed to the client to load (or to Slack, for `icon_url`). An
  implementation that proxies avatars MUST apply every rule below.
- **Never follow redirects.**
- Resolve DNS and refuse any of these targets:
  - loopback, private (RFC 1918), CGNAT (100.64/10) and link-local (169.254/16, which
    includes cloud metadata);
  - ULA (fc00::/7), unspecified, multicast and IPv4-mapped forms of all the above.
  Connect to the address you checked, so a second lookup can't swap in a different one
  (DNS rebinding). Dev mode (Core §10) is the only exception, and it only allows
  loopback.
- Use timeouts (10 s to connect, 30 s total, longer only for long-poll) and response
  size caps.

### Content

- Text is Markdown with **no raw HTML** (Core §5). Render with an HTML-escaping renderer
  and allow only these link schemes: `https:`, `http:`, `mailto:`.
- Never put remote text into another markup language unescaped. The Slack adapter MUST
  escape `&`, `<` and `>` before mapping to Slack mrkdwn. Otherwise a peer could inject
  `<!channel>` or a forged `<@U…>` mention. See `slack-mapping.md`.
- Files are untrusted (see `capabilities.md` § files).
- Display names are attacker-chosen. Implementations SHOULD show the org next to every
  remote name, for example "Gail Ito (globex.com)", so a peer cannot pass itself off as
  a local colleague. The Slack adapter puts the org in the `username`.

## Operational recommendations

- **Audit log.** Record every lifecycle action (invite created or accepted, peer
  join/leave/remove, close) and every rejected request (code and org), together with
  `keyid`, timestamp and request id. Don't log message bodies or credentials by
  default.
- **Admin visibility.** Show the admin, for each shared channel, the remote orgs and
  their `contact`. Give the admin a one-click unshare.
- **Data retention.** Each participant holds a copy of the channel under its own
  retention policy, as with email. Intertie requires the home to keep events available
  for pull for 7 days. Beyond that, it imposes no retention.
  - `message.delete` obliges receivers to stop displaying the content and asks them to
    purge it. It cannot force a remote participant to forget.
  - Implementations SHOULD state this to users when a channel is shared ("messages here
    are copied to globex.com").
- **Key storage.** Keep one key per deployment. Store it in the platform secret store
  if one exists, and never in the repository.

## Notes on the Slack adapter

- The adapter is a Slack app installed by one of the participants. It holds that
  workspace's bot token and nothing else. No party ever holds tokens for two
  organizations' Slack workspaces. That is exactly the difference between Intertie and
  an intermediary bridge.
- Slack tokens grant workspace-wide scopes. The adapter MUST act only on channels the
  workspace's admin has explicitly linked, and MUST ignore events from every other
  channel.
- Vendor-hosted mode: the counterparty runs the adapter and holds the Slack org's bot
  token. That is a deliberate grant of trust by the installing org. The admin consents
  to it by installing the vendor's app, and can revoke it by uninstalling. This does
  not make a third party: the vendor is a participant in the channel.
