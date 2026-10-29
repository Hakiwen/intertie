# Intertie ↔ Microsoft Teams mapping, v0.1

Status: draft, 2026-10-29. License: CC-BY-4.0. This document is informative and
describes `packages/teams-adapter`. The Microsoft platform behaviour it relies on was
checked against Microsoft Learn in October 2026; links are at the end.

## The shape

The **adapter** is a Teams app backed by an **Azure Bot**: a single-tenant
registration, since Azure no longer creates multi-tenant bots. One participant installs
it in **its own** team. To the shared channel it is an ordinary Intertie org; to Teams
it is a bot. It holds credentials only for its own bot registration, so no third party
is involved.

**Inbound.** The Bot Framework sends activities to the bot's messaging endpoint
(`POST /api/messages`). Every request carries an RS256 JWT, and the adapter checks all
of the following before acting on it:

- the signature, against the Bot Framework OpenID keys;
- `iss = https://api.botframework.com`;
- `aud` = the app id;
- `exp`/`nbf`, with 5 minutes of skew allowed;
- the `serviceUrl` claim equals the activity's `serviceUrl`;
- the key is endorsed for `msteams`;
- `serviceUrl` is a known connector host, so a forged activity can't make the bot send
  its token elsewhere;
- the tenant is the adapter's own tenant.

Unlike Slack's Socket Mode, there is **no outbound-only option**: the messaging endpoint
must be reachable over public HTTPS. The adapter serves it on its own listener, separate
from the Intertie endpoint and the loopback-only admin API.

**Outbound.** The Bot Framework Connector REST API with a client-credentials token
(cached):

- a new thread is `POST /v3/conversations` with `isGroup` and the channel;
- a thread reply goes to `…/conversations/{channel};messageid={root}/activities`;
- edits use `PUT` and deletes use `DELETE` on `/activities/{id}`.

**Consent.** The app requests resource-specific consent (RSC) for one team, approved by
that team's owner at install time, with no tenant-wide Graph grant:

- `ChannelMessage.Read.Group`: receive **all** user messages in the team's channels,
  not only @mentions;
- `ChannelSettings.Read.Group`: channel names;
- `TeamMember.Read.Group`: the roster.

**Identifiers:**

| Intertie | Teams |
|---|---|
| user id | `<Entra aadObjectId>@<org>` |
| sender name | `from.name` |
| message ⇄ event | a local table: event id ⇄ (activity id, thread conversation id) |
| thread | the channel conversation id's `;messageid=<root>` suffix |

## Teams → Intertie

| Teams activity | Intertie | notes |
|---|---|---|
| `message` (top-level) | `message.create` | The `text/html` attachment (or `text`) is converted to Markdown. `<at>` mentions become `@Name` plus `mentions`, and the bot's own mention is dropped. |
| `message` in a thread (`;messageid=<root>` ≠ `id`) | `message.create` + `thread` | The thread root's event id. |
| `message` with `reference` attachments | a `📎 [name](url)` line | Channel files live in SharePoint and opening them needs access in this tenant (see below). |
| `messageUpdate` / `editMessage` | `message.edit` | Delivered for all scopes. |
| `messageUpdate` / `undeleteMessage` | ignored | Intertie has no undelete. |
| `messageDelete` / `softDeleteMessage` | `message.delete` | A Teams user deleting a **remote** message (the bot's post) is local moderation and is not propagated. |
| `messageReaction` (`reactionsAdded` / `reactionsRemoved`) | `reaction.add` / `reaction.remove` | Only for reactions **on the bot's posts**, that is, on remote messages. Classic types map `like`→👍, `heart`→❤️, `laugh`→😆, `surprised`→😮, `sad`→😢, `angry`→😠. Hex code-point types (`1f440_eyes`) map to their emoji. |
| `conversationUpdate` | none | The adapter learns channels from it (and from any message). |
| `@Intertie share \| accept \| status \| unshare` | admin command | Accepted only from aadObjectIds in `TEAMS_ADMINS`. The CLI and the loopback admin API always work. |
| messages from other bots | never delivered by Teams | So the adapter's own posts never echo back. |

## Intertie → Teams

| Intertie | Teams | notes |
|---|---|---|
| `message.create` | a bot message with HTML `text`: **`<b>Name</b> <i>(org)</i><br>`** then the body | Markdown → HTML is built from escaped text only. Mentions of this tenant's users become `<at>Name</at>` plus a mention entity, which is a real notification. |
| … + `thread` | a reply in that thread | If the root is unknown, a new thread with a "↳" prefix. |
| … + `files` | PNG, JPEG or GIF images ≤ 1 MiB are attached inline. Other files get a note line. | Uploading to SharePoint needs Graph `Files` permissions, which is a later capability. |
| `message.edit` | `PUT` the bot's message | Only possible for remote messages, because bots cannot edit users' messages. |
| `message.delete` | `DELETE` the bot's message | A remote delete of a **Teams user's** message (home moderation) cannot be applied, because bots cannot delete users' messages. It is logged. |
| `reaction.add` / `reaction.remove` | an *italic footer* on the bot's message, e.g. `🎉 2 · 👀 1`, kept up to date | Bots cannot add reactions in Teams. |
| `peer.*`, `channel.*` | a notice from the bot | `channel.close` unlinks the channel. |

## What cannot map

These are stated plainly, because they are the honest difference from Teams'
own shared channels:

1. **No author impersonation.** Every remote message is visibly *the bot*, with the
   person's name and org in a byline. There is no per-message display name or avatar
   (Slack's `chat:write.customize` has no Teams equivalent), so remote avatars are not
   shown.
2. **Reactions are half-visible.**
   - Teams tells bots only about reactions on the **bot's own** messages, so reactions by
     Teams users on *their colleagues'* messages never leave Teams.
   - Bots cannot react at all, so remote reactions appear as a footer line.
3. **Bots cannot edit or delete users' messages.** A home org's moderation delete of a
   Teams user's message is not applied in Teams.
4. **Files are by reference.**
   - Teams channel files are SharePoint links that require access in the Teams tenant.
   - Remote files other than small images are announced, not copied, until a Graph-based
     SharePoint upload capability exists.
5. **Public endpoint required.** Teams calls the bot. There is no Socket-Mode-style
   outbound connection, so the operator must publish one HTTPS path, behind a reverse
   proxy or a tunnel.
6. **Consent and policy quirks:**
   - RSC is granted per team by its owner.
   - Tenants can block custom app upload (Teams admin center → Setup policies).
   - Private channels and shared channels ("Teams Connect") have their own membership
     and app rules; the bot must be added where the channel lives. Shared channels can
     include people from other tenants, and the adapter **only relays activities whose
     tenant is its own**.
   - Messages from other bots and workflows are never delivered to bots, so they don't
     cross.
7. **Undelete** in Teams is not carried over. Intertie has no undelete.
8. **Meetings, calls, Loop components, cards with actions, polls and approvals** don't
   carry.

## References (checked 2026-10)

- Receive all channel messages with RSC:
  <https://learn.microsoft.com/microsoftteams/platform/agents-in-teams/enable-receive-all-chat-messages>
- Conversation events (reactions only on agent messages):
  <https://learn.microsoft.com/microsoftteams/platform/bots/how-to/conversations/subscribe-to-conversation-events>
- Edit, soft-delete and undelete activities, and update/delete of bot messages:
  <https://learn.microsoft.com/microsoftteams/platform/bots/build-conversational-capability>
- Bot Connector authentication:
  <https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication>
- Proactive messages and channel threads:
  <https://learn.microsoft.com/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages>
- Azure Bot single-tenant requirement:
  <https://learn.microsoft.com/azure/bot-service/abs-quickstart>
