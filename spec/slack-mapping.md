# Intertie ↔ Slack mapping, v0.1

Status: draft, 2026-10-29. License: CC-BY-4.0. This document is informative. It
describes what the reference Slack adapter (`packages/slack-adapter`) does, so that
other adapters behave the same way.

## The shape

The **adapter** is a Slack app that one participant installs in **its own** workspace.
To the rest of the channel it is an ordinary Intertie org: it has a discovery document,
keys and an endpoint. Toward Slack it is a bot:

- **Outbound** (Intertie → Slack): Web API calls `chat.postMessage`, `chat.update`,
  `chat.delete`, `reactions.add` and `reactions.remove`, plus the file upload calls.
- **Inbound** (Slack → Intertie): Events API, either over Socket Mode (no public URL
  needed) or over HTTPS request URLs (signed with the Slack signing secret).
- It **never** calls `conversations.history` or `conversations.replies`. The design
  doesn't depend on the history rate tier at all. See `docs/landscape.md`.

The adapter links each Slack channel to at most one Intertie channel, and only for
channels its admin explicitly links. It ignores events from every other channel.

**Vouching.** The org vouches only for its own workspace's people. If a linked channel
is *also* a Slack Connect channel, people from other workspaces (`user_team` or
`users.info.team_id` ≠ the app's team) are not relayed, and the channel is told why,
once. This is the Slack counterpart of the Matrix gateway's `localServers` rule.

**Escaping.** Every remote string the adapter posts goes through `&`/`<`/`>` escaping:
message text, display names in notices, org names and file names. This keeps remote
input from producing Slack markup.

**Identifiers:**

| Intertie | Slack |
|---|---|
| org | The adapter's configured org name, for example `connect.bigco.com` |
| user id | `<SlackUserId>@<org>`, for example `U07ABCDEF@connect.bigco.com` |
| sender name / avatar | `users.info` → `profile.display_name` or `real_name`; `profile.image_192`. Cached for 1 h. |
| message event id ↔ message | A local table `event id ⇄ (channel id, ts)`. Slack `ts` is the per-channel message key. |
| thread root | `thread_ts` ⇄ the root's event id |

**Scopes** (bot):

- reading the channel: `channels:history`, `groups:history`, `channels:read`,
  `groups:read`;
- posting as remote users: `chat:write`, `chat:write.customize`;
- reactions: `reactions:read`, `reactions:write`;
- files: `files:read`, `files:write`;
- profiles: `users:read`.

Socket Mode also needs an app-level token with `connections:write`.

**Bot events:** `message.channels`, `message.groups`, `reaction_added`,
`reaction_removed`, `member_joined_channel`, `member_left_channel`. See
`packages/slack-adapter/manifest.yaml`.

## Intertie → Slack

| Intertie event | Slack call | notes |
|---|---|---|
| `message.create` | `chat.postMessage { channel, text, username, icon_url, thread_ts?, unfurl_links:false, unfurl_media:false }` | `username` = `"<sender.name> (<origin>)"`, truncated to 80. `icon_url` = `sender.avatar`. `text` is converted from Markdown to mrkdwn (below). The returned `ts` is stored against the event id. |
| `message.create` with `thread` | the same, with `thread_ts` = the root's `ts` | If the root is unknown (it came before the link), post top-level with a "↳" prefix. |
| `message.edit` | `chat.update { channel, ts, text }` | The bot can update its own posts, and every remote message is a bot post. |
| `message.delete` | `chat.delete { channel, ts }` | |
| `reaction.add` | `reactions.add { channel, timestamp, name }` | `name` = the Slack shortcode for `emoji` (an emoji table), or the event's `name`. **Reference-counted**: the bot adds a reaction only once per emoji per message, however many remote users react. |
| `reaction.remove` | `reactions.remove` | Only when the last remote reactor for that emoji is gone. |
| `message.create` with `files` | `files.getUploadURLExternal` → upload → `files.completeUploadExternal { channel_id, thread_ts?, initial_comment }` | The file post shows as the app, not the remote user, because Slack's upload API has no `username`. The adapter sends the text first via `chat.postMessage`, then the files with `initial_comment: "↑ from <name> (<org>)"`. |
| `mentions` of a Slack user (id `U…@<this org>`) | `<@U…>` in the text | The Slack user gets a real notification. |
| `mentions` of a remote user | `@Name` as plain text | |
| `peer.join` / `peer.leave` / `channel.close` | `chat.postMessage` notice from the app | For example "globex.com joined this shared channel". On `channel.close` the link is removed. |
| `channel.update` | notice only | The adapter never renames the Slack channel. |
| `member.join` / `member.leave` | ignored (kept in local roster) | Slack can't show non-Slack users as members. |

### Markdown → Slack mrkdwn (inbound to Slack)

1. **Escape first:** `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`. A blockquote `>` at the
   start of a line is restored after escaping. This step is a security rule, not just
   formatting: without it a peer could send `<!channel>` or a fake `<@U…>`
   (`security.md`).
2. Outside code spans and fences:
   - `**x**` → `*x*`
   - `*x*` and `_x_` → `_x_`
   - `~~x~~` → `~x~`
   - `[label](url)` → `<url|label>`, only for `http`, `https` and `mailto`. Any other
     scheme is left as text.
3. Code spans and fences, `>` quotes and lists pass through unchanged.

### mrkdwn → Markdown (outbound from Slack)

| Slack | Intertie |
|---|---|
| `*x*` | `**x**` |
| `_x_` | `*x*` |
| `~x~` | `~~x~~` |
| `<https://u\|label>` | `[label](https://u)` |
| `<https://u>` | `https://u` |
| `<mailto:a@b\|a@b>` | `[a@b](mailto:a@b)` |
| `<@U123>` | `@Display Name`, plus a `mentions` entry `U123@<org>` |
| `<#C123\|name>` | `#name` |
| `<!here>`, `<!channel>`, `<!everyone>` | `@here` etc. as **plain text**. They are never propagated as pings (see `capabilities.md` § mentions). |
| `<!subteam^S1\|@team>` | `@team` |
| `&amp;` `&lt;` `&gt;` | `&` `<` `>` |

Literal Markdown characters typed in Slack (for example `**`) pass through and may
render as formatting on the other side. This is a known, accepted loss.

## Slack → Intertie

| Slack event | Intertie event | notes |
|---|---|---|
| `message` (no subtype, `thread_broadcast`, `file_share`, `me_message`) | `message.create` | `thread_ts` ≠ `ts` → `thread` = the root's event id. For `thread_broadcast`, the "also sent to channel" flag is lost. `file_share` → `files` (downloaded with the bot token from `url_private_download`; inline if ≤ 256 KiB, otherwise served from the adapter's `/files/…`). |
| `message` / `message_changed` | `message.edit` | `event.message.ts` → the target's event id. Ignored if the edited message is a bot post. |
| `message` / `message_deleted` | `message.delete` | Only for messages that came from Slack users. If a Slack admin deletes a *remote* user's message (a bot post), the deletion is a local moderation action: it is not propagated, and the adapter drops its mapping for that message. |
| `reaction_added` / `reaction_removed` | `reaction.add` / `reaction.remove` | `reaction` shortcode → `emoji` via the table; `name` = the shortcode. Skin-tone suffixes (`::skin-tone-2`) are kept in `name` and mapped to the toned emoji where the table has one. Custom emoji → `emoji: ":name:"`. |
| `member_joined_channel` / `member_left_channel` | `member.join` / `member.leave` | Only if the channel advertises `members`. |
| anything from this app's own bot (`bot_id` or `user` = the app's bot) | **dropped** | Loop prevention. Every remote message is one of our bot posts, and Slack echoes it as an event. |
| other subtypes (`channel_join`, `channel_topic`, `pinned_item`, `bot_message` from other apps, …) | dropped | Other bots' posts are not forwarded by default. They are configurable. |

Events API delivery is at-least-once (`X-Slack-Retry-Num`). The adapter derives the
Intertie event id deterministically from the Slack `event_id`, so a Slack retry becomes
an Intertie `duplicate`.

## What cannot map

These are stated plainly, because they are the honest difference between an Intertie
adapter and Slack Connect:

1. **Remote users are not Slack users.** They appear as app posts with a custom name and
   avatar, and an "APP" badge. Slack users can't DM them, can't @-mention them natively
   (autocomplete doesn't know them), and can't see them in the member list or profile
   cards.
2. **No presence, typing, or read state**, in either direction.
3. **Reactions by remote users all appear as one reaction by the app.** Hovering shows
   the app, not "Gail and 2 others".
4. **Remote file posts appear as the app**, with an attribution comment.
5. **Slack-side moderation of remote messages is local only.**
6. **Slack admin features** (Connect policies, approved-org lists, DLP, retention
   policies, eDiscovery) see one app, not a remote org.
7. **Editing time limits and other workspace policies** apply only to Slack's own
   users. A remote user's edits always apply.
8. **Huddles, canvases, lists, workflows, Block Kit interactivity, polls, scheduled
   messages, pins and bookmarks** don't carry.
9. **History from before the link** is not sent. The adapter never reads history.
10. **Channel-wide pings** (`@here`, `@channel`) are never propagated in either
    direction.
