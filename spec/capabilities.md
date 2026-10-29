# Intertie capabilities, v0.1

Status: draft, 2026-10-29. License: CC-BY-4.0.

A capability is optional. An org advertises the capabilities it supports in its
discovery document's `capabilities` list. Senders MAY use any capability in any
channel, because receivers that lack it ignore what they don't understand (Core §5).

Capabilities don't need to be negotiated, but they do help a UI. For example, an
implementation can hide the reaction button when the channel's other participants don't
list `reactions`.

Each capability below states what it is for and what it costs. Anything not listed
here is deliberately out of v0.1 (see the end of this document).

---

## `threads`

**Why it is optional:** every Core receiver already keeps thread replies, even if it
shows them inline (Core §5). This capability adds native thread rendering, plus the
ability to start replies.

**Rules:**

- `message.create` carries `body.thread`, which is the `id` of the thread root.
- The root MUST be a top-level `message.create` in the same channel. Replies to replies
  point at the root.
- The home rejects an unknown root or a nested root with `invalid_event`.
- If a root is deleted, its replies remain. A receiver MAY show the root as
  "deleted message".

---

## `reactions`

**Why:** reactions are the cheapest acknowledgement in support channels ("👀 on it").

New event types:

| type | body |
|---|---|
| `reaction.add` | `target` (a message id), `emoji` (one Unicode emoji, max 32 bytes), `name` (optional shortcode such as `"eyes"`, for custom emoji or as a fallback) |
| `reaction.remove` | the same fields as `reaction.add` |

**Rules:**

- The state is a set of (target, sender, emoji) triples, so add and remove are both
  idempotent.
- A custom emoji with no Unicode equivalent uses `emoji: ":<name>:"` and `name`.
  Receivers show the text.
- Only the reacting user's org may remove that user's reaction. The home enforces
  `origin` = the sender's org as it does for every event.

---

## `files`

**Why:** screenshots and logs are half of every support thread.

`message.create` MAY carry `body.files`, an array of 1–10 objects:

```json
{ "id": "f-2a91", "name": "export.log", "mime": "text/plain", "size": 18211,
  "sha256": "<base64url SHA-256 of the bytes>",
  "url": "https://connect.globex.com/intertie/files/f-2a91" }
```

A file is delivered in one of two ways:

- **By reference** (the normal case). `url` MUST be under the *origin's* declared
  endpoint.
  - Receivers fetch it with a **signed GET**: the same signature as Core §4, with no
    body.
  - The origin serves the file only to orgs that are, or were, participants in a
    channel whose log contains the file. Otherwise it answers `403 not_participant`.
  - The origin MUST keep serving the file for at least as long as the home keeps the
    event available for pull (7 days).
  - Receivers SHOULD copy the file into their own storage when they receive it.
- **Inline**, for files of 256 KiB or less: `data` (standard base64) replaces `url`.

**Rules for receivers:**

- Check `size` and `sha256`. On a mismatch, discard the file.
- Honour their own size cap. A file that's too big is shown as a link, not fetched.
- Treat every file as untrusted:
  - serve it to their own users with `Content-Disposition: attachment` and
    `X-Content-Type-Options: nosniff`;
  - never render `text/html`, `image/svg+xml` or other script-capable types inline.
- Advertise a cap with `limits.max_file_bytes`. The default is 25 MiB.

A file is fetched directly from the origin. When the origin is not the home, that is
still a participant-to-participant connection, so there is no intermediary.

---

## `mentions`

**Why:** a support channel needs "@Ana, can you look?", and the person mentioned on the
other side should actually get notified.

`message.create` and `message.edit` MAY carry `body.mentions`, an array of
`{ "id": "<user id>", "name": "<display name>" }`. The text contains `@<name>` at each
mention point.

A receiver that owns a mentioned id SHOULD notify that user natively. Other receivers
show the text as written.

There are no channel-wide mentions (`@here`, `@channel`) in v0.1, so an organization
cannot page another organization's whole team.

---

## `members`

**Why:** without it, a participant learns about remote users only when they speak.
`members` adds a per-user roster. Slack exposes one, through `member_joined_channel`.

New event types:

| type | body |
|---|---|
| `member.join` | `user`: `{ id, name, avatar? }`. The id MUST belong to `origin`. |
| `member.leave` | `user`: `{ id }` |

**Rules:**

- Each org announces only its own users.
- On `peer.leave`, receivers drop every member of that org.
- The roster is information only: a member has no extra rights. An org decides
  internally who may post.

---

## Not in v0.1, and why

| feature | why it is out |
|---|---|
| typing indicators | They are chatty: one event per keystroke burst, multiplied by the number of peers. They add little value across organizations, and Slack's API cannot show them for a bot. |
| read receipts and markers | They are a cross-organization privacy leak, because one org learns when the other's staff read messages. Revisit with an explicit opt-in. |
| presence | The same privacy concern, and Slack exposes it only per user, through polling. |
| home transfer | v1. It needs a two-phase handover of `seq` ownership. |
| history before join | v1. It needs a policy on what the home may disclose. |
| end-to-end encryption | A Slack participant sees plaintext anyway. The roadmap is MLS (RFC 9420) for native-to-native channels (`security.md`). |
| channel-wide mentions | Abuse risk (see `mentions`). |
| message pins, bookmarks, polls, rich cards | These are product features, not interoperability ones. They can be done as extensions (`acme.com/poll`). |
