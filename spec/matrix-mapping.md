# Intertie ↔ Matrix mapping, v0.1

Status: draft, 2026-10-29. License: CC-BY-4.0. This document is informative. It
describes the reference gateway (`packages/matrix-gateway`).

## The shape

The **gateway** links one Matrix room to one Intertie channel. To the channel it is an
ordinary Intertie org, with its own discovery document, keys and endpoint. The
organization that runs it is a participant, never a third party. That makes it the same
pattern as the Slack adapter, and unlike a hosted bridge: the gateway holds credentials
for **its own** homeserver account(s) only.

There are two modes:

| | **Application Service** (preferred) | **Bot** (fallback) |
|---|---|---|
| For | orgs that run their own homeserver (Synapse, Conduit/conduwuit, Dendrite) | orgs that only hold an account on someone else's homeserver |
| Setup | `intertie-matrix registration` generates the registration file for the homeserver | one access token |
| Inbound | the homeserver pushes `PUT /_matrix/app/v1/transactions/{txnId}` (authenticated with `hs_token`) | `/sync` long-poll, with the position persisted |
| Remote users | **ghost users**, one per remote person (`@intertie_<hash>:server`), with display name `Name (org)` and avatar | the bot posts as `Name (org): text`, plus the `com.beeper.per_message_profile` content extension |
| Remote reactions | real reactions, each by the right ghost | one bot reaction per emoji, reference-counted |

**Identity:**

- A Matrix user `@alice:hs.example` becomes Intertie user `alice-<8 hex of sha256(mxid)>@<org>`.
  That form is readable, collision-free, and fits `[A-Za-z0-9._-]`.
- The display name comes from the Matrix profile.
- **Vouching:** a room can be federated, but the org only vouches for users on its own
  server(s) (`MATRIX_LOCAL_SERVERS`, which defaults to the gateway's own server). Messages
  from users on other servers are not forwarded. The room is told why, once.

**Admin:**

- Room moderators (power level ≥ 50, or the `MATRIX_ADMINS` list) run
  `!intertie share`, `!intertie accept <invite>`, `!intertie status` and
  `!intertie unshare`.
- Operators can use the local CLI or admin API instead.
- The bot auto-joins when a local user invites it.

## Intertie → Matrix

All sends use `PUT /rooms/{room}/send/{type}/it-<event id>`. Deriving the transaction id
from the Intertie event id makes the homeserver deduplicate retries.

| Intertie | Matrix | notes |
|---|---|---|
| `message.create` | `m.room.message` (`m.text`, `org.matrix.custom.html`) | The HTML is built from escaped text only (see Format). The message carries `m.mentions.user_ids` for mentioned local users. |
| `message.create` + `thread` | the same, plus `m.relates_to: {rel_type: m.thread, event_id: <root>, is_falling_back: true, m.in_reply_to: {event_id: <root>}}` | If the root is unknown, the message is posted top-level with a "↳" prefix. |
| `message.create` + `files` | `POST /_matrix/media/v3/upload`, then `m.room.message` with `m.file`, `m.image`, `m.video` or `m.audio` (`url`, `filename`, `info`) | Sent by the ghost, in the same thread. |
| `message.edit` | `m.room.message` with `body: "* …"`, `m.new_content`, and `m.relates_to: {rel_type: m.replace}` | Sent by the same ghost (or the bot), as Matrix requires. |
| `message.delete` | `PUT /rooms/{room}/redact/{event}/{txn}` | Redacted by the original author's ghost. The bot is the fallback, for the home's moderation deletes. |
| `reaction.add` | `m.reaction` with `m.relates_to: {rel_type: m.annotation, key: <emoji>}` | |
| `reaction.remove` | a redaction of that reaction event | |
| `peer.*`, `channel.*` | `m.notice` from the bot | `channel.close` unlinks the room. |
| `mentions` of a local Matrix user | a pill: `<a href="https://matrix.to/#/@user:server">Name</a>` | That user gets a real notification. |

## Matrix → Intertie

| Matrix | Intertie | notes |
|---|---|---|
| `m.room.message` (`m.text`, `m.notice`, `m.emote`) | `message.create` | Uses `formatted_body` when present (HTML → Markdown), otherwise `body`. The legacy reply fallback is stripped. `m.emote` becomes `*text*`. |
| … with `rel_type: m.thread` | `message.create` + `thread` | The root's Intertie id. |
| … with only `m.in_reply_to` (a rich reply, no thread) | `message.create`, top-level | Intertie has no reply-to-message relation, so the quote is lost. |
| `m.file`, `m.image`, `m.video`, `m.audio` (unencrypted `url`) | `message.create` + `files` | Downloaded through authenticated media (`/_matrix/client/v1/media/download`), with a legacy fallback. A Matrix 1.10 caption becomes the `text`. |
| `m.room.message` with `rel_type: m.replace` | `message.edit` | The text comes from `m.new_content`. |
| `m.reaction` (`m.annotation`) | `reaction.add` | `emoji` is the annotation `key`. |
| `m.room.redaction` of a message | `message.delete` | Both `redacts` placements are read (top-level, and `content.redacts` from room v11). |
| `m.room.redaction` of a reaction | `reaction.remove` | |
| events from the bot or any ghost | **dropped** | Loop prevention. |
| `m.room.encrypted` | dropped, with one notice | See below. |

### Format: Markdown ⇄ `org.matrix.custom.html`

- **Outbound.** The gateway escapes `& < > "` first. Then it emits only these tags:
  `<strong> <em> <del> <code> <pre> <blockquote> <br>`, and `<a href>` for `https`,
  `http` and `mailto` links and for matrix.to pills. A peer cannot inject HTML.
- **Inbound.** The gateway translates the same tags back to Markdown and keeps the text
  of every other tag, dropping the tag itself. It decodes HTML entities and removes
  `<mx-reply>` blocks.

## What cannot map

1. **End-to-end encrypted rooms.** The gateway cannot read them, so it refuses to share
   an encrypted room and drops `m.room.encrypted` events with a notice. Supporting E2EE
   would mean the gateway holding Megolm keys, and it would then see plaintext anyway.
   That is the same trust position as the Slack side, but it is not built yet.
2. **Users from other homeservers in a federated room** are not forwarded, because the
   org vouches only for its own servers. This is deliberate and configurable.
3. **Rich replies outside threads** arrive as plain top-level messages.
4. **Bot mode is lossy:**
   - remote people are one bot account with a name prefix (Matrix clients that
     understand per-message profiles render them better);
   - remote reactions collapse into one bot reaction per emoji;
   - only the bot can edit or redact.
5. **Avatars of Matrix users are not sent** to the channel. Matrix media now requires
   authentication, and Intertie avatars must be fetchable without credentials. A future
   option is a public avatar proxy on the gateway. Remote users' avatars do reach Matrix,
   uploaded to the ghost's profile in appservice mode.
6. **Room state** (name, topic, power levels, pinned events), **read receipts, typing
   and presence** do not cross, matching the Intertie v0.1 scope.
7. **Polls, location, stickers, voice messages and widgets** are not mapped. Stickers
   and voice messages could become files later.
8. **Edits of edits** follow Matrix semantics: the last `m.new_content` wins. Intertie
   carries each edit as a full replacement, so the two agree.
