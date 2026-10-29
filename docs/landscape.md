# Landscape: shared channels between organizations

Status: Phase 0 memo, 2026-10-29. Facts were checked on that date. Items marked
"re-verified" were fetched fresh for this memo. The rest come from the project brief
and link to their primary source.

## The question

Can an organization that runs its *own* chat tool, maybe one vibe-coded in a week, get
a Slack Connect-style shared channel with another organization? The constraints:

1. The shared channel works with Slack. A Slack-only shop must be able to join.
2. **No intermediary.** Only the two (or N) participating organizations touch the
   messages. No third-party relay is allowed.
3. Communications are secure.
4. It is an open standard that others can implement and then claim conformance to.

## What exists

### Matrix: open federation, heavy, not Slack-native

- Each org runs a homeserver. Rooms span servers and no central party is needed.
  Architecturally this is the right shape.
- Real adoption is in the public sector and sovereignty deployments: France (Tchap),
  Germany (BwMessenger, healthcare TI-Messenger) and Sweden's eSam proposal.
  Rocket.Chat federates over Matrix
  ([Rocket.Chat blog](https://www.rocket.chat/blog/delivering-matrix-federation-as-a-built-in-standard)),
  and Mattermost added Matrix federation to Enterprise in 2026.
- **Slack interop is bridge-only, and it is shrinking.** The Matrix.org Foundation
  announced in November 2025 that it would retire its free hosted Slack bridge. It
  cited the cost and complexity of keeping up with a closed, proprietary platform
  ([matrix.org blog](https://matrix.org/blog/2025/11/removing-slack-bridge/)). The bridge
  was decommissioned on 2026-01-14 and the `matrix-appservice-slack` repo was archived on
  2026-01-22. The bridges page lists it as **Obsolete**. **mautrix-slack** (Beeper/tulir)
  is the only bridge marked Stable/Recommended
  ([bridges page](https://matrix.org/ecosystem/bridges/slack/)). *Re-verified.*
- Why it never took Slack's market:
  - Matrix is a full chat protocol: an event DAG, state resolution, room versions, and
    Olm/Megolm E2EE. A conformant homeserver takes person-years to build, and running
    one is a real ops commitment.
  - It is not a thin "connect my tool to yours" layer. To join, you adopt Matrix.
  - A bridge to Slack is usually *puppeting*: it acts as Slack users, or holds a
    Slack token on someone else's infrastructure. That is fragile against Slack's API
    and terms changes.

### IETF MIMI: the standards track, consumer-messenger-shaped

- MIMI (More Instant Messaging Interoperability) is driven by the EU Digital Markets
  Act and aimed at consumer messengers. As of mid-2026 its documents are still
  Internet-Drafts and none is an RFC: draft-ietf-mimi-protocol-06 (April 2026),
  -content-09 (July 2026), -arch, -room-policy
  ([datatracker](https://datatracker.ietf.org/wg/mimi/documents/)).
- **Its hub model is exactly the "no intermediary" shape we want.** Each room has a hub
  provider, and the hub is always *one of the participants' providers*, never a third
  party. The hub orders and fans out; followers send through it.
- MIMI is built on MLS (RFC 9420) and E2EE is assumed throughout. A Slack participant
  cannot do MLS. Whoever runs the Slack side would hold the MLS keys and post the
  plaintext into Slack, so the encryption buys nothing on that side while costing the
  whole implementation burden of MLS.
- Takeaway: borrow the concepts (the hub, participant identifiers, a content format
  with room for a future mapping), and don't wait for the RFCs.

### Mattermost Connected Workspaces: the closest product analog

- Mattermost-to-Mattermost shared channels on the Enterprise plan. One admin creates a
  connection, the other admin accepts, and then channels are shared. Messages,
  reactions and files sync
  ([docs](https://docs.mattermost.com/administration-guide/onboard/connected-workspaces)).
- It is proprietary to Mattermost. The flow (connect, accept, share a channel) is the
  UX we are specifying, made open.

### Microsoft Teams shared channels

- Built on Entra B2B direct connect. Both tenants must enable it, and it works with
  Teams only ([docs](https://learn.microsoft.com/entra/external-id/b2b-direct-connect-overview)).

### Slack Connect

- Slack-to-Slack only. The API is `conversations.inviteShared`,
  `conversations.acceptSharedInvite` and related calls
  ([docs](https://docs.slack.dev/apis/slack-connect/)).
- Slack **shut its IRC and XMPP gateways on 2018-05-15**. It said shared channels,
  threads and reactions could not be carried over
  ([The Register](https://www.theregister.com/2018/03/09/slack_cuts_ties_to_irc_and_xmpp/)).
  Slack will not speak an open federation protocol, because its network effect is the
  moat.

### Intermediary bridge SaaS (what Ben rejects)

- Mio, SlackBridge, Sameroom (now 8x8), and self-hosted Matterbridge. A third party (or
  one box) holds tokens for both sides and relays traffic. In the SaaS case, that third
  party sees everything and is a single point of control: precisely the shape Ben
  rejects.

### Other things considered

- **XMPP** (MUC, s2s federation) is open and federated, with DNS-named identities and
  dialback/TLS. It is the closest prior art for "an org is a DNS name". In practice it
  is a full IM protocol with a long tail of XEPs, and it has no Slack path since 2018.
- **ActivityPub** is federated and HTTP-signed, which is also prior art for signed
  server-to-server POSTs. But it is modelled as public social publishing, not private
  bilateral channels: it has no channel ordering and no membership semantics.
- **Email/webhooks.** Many orgs fake shared channels with shared inboxes or a webhook
  pair. Neither has identity, ordering, edits or threads.

## Slack constraints that shape the design

- **Slack cannot be a native peer.** The only possible Slack interoperability is a
  Slack app that the Slack org installs *in its own workspace*:
  - Outbound, it posts with `chat:write.customize` so remote users show their own name
    and avatar.
  - Inbound, it receives the Events API or Socket Mode.
- That app is an **adapter, not an intermediary**, because one of the two parties
  operates it. Two deployment models are first-class:
  1. **Self-hosted adapter.** The Slack org runs it, as one process.
  2. **Counterparty-hosted adapter.** The org with the internal tool hosts it, and the
     Slack org installs "the vendor's Slack app" scoped to the shared channel. Still two
     parties, no third.
- **Rate limits (re-verified).** On 2025-05-29 Slack cut `conversations.history` and
  `conversations.replies` for non-Marketplace, commercially distributed apps to 1
  request/minute with `limit` ≤ 15. The cut applied immediately to new apps and
  installs, and reached existing installs of unlisted distributed apps on 2026-03-03.
  **"Internal customer-built applications are not impacted by these changes."**
  ([changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps)).
  The adapter is event-driven (Events API or Socket Mode, plus `chat.postMessage`) and
  **never polls history**. That makes it unaffected in both deployment models.
- **API Terms (new finding, flagged for Ben).** The same 2025-05-29 terms update
  restricts *third parties* from bulk-exporting Slack data, keeping persistent copies or
  indexes of it, or using it with LLMs
  ([tos-updates](https://docs.slack.dev/changelog/2025/05/29/tos-updates),
  [2025-10-13 clarification](https://docs.slack.dev/changelog/2025/10/13/api-terms-update),
  [Hunton summary](https://www.hunton.com/insights/legal/salesforce-locks-down-slack-data-time-to-review-your-slack-api-terms)).
  - Self-hosted mode is clean: the customer's own app moves the customer's own messages
    to a party the customer chose. That is the same thing Slack Connect does.
  - Counterparty-hosted ("vendor-hosted") mode makes the counterparty a "third party"
    app developer under Slack's terms, and the counterparty's tool stores what it
    receives. Per-message relay is not bulk export.
  - **Decision (Ben, 2026-10-29): "I'm ok with the flag, if the customers deal with
    the terms."** Both modes are documented as complete, first-class paths, with
    self-hosted listed first. The vendor-hosted section carries one plain note: the
    Slack org that installs the app is responsible for its own compliance with Slack's
    API Terms.

### What an adapter cannot do that Slack Connect does

These go in the docs, plainly:

- **No true shared membership.** Remote users are rendered as bot posts with a custom
  username and avatar. They are not Slack users, so Slack shows "APP" badges, and
  remote users can't be DMed, @-mentioned natively, or seen in the member list.
- **No native presence** and no Slack-side profile cards.
- **Slack admin controls** (Connect policies, approved-org lists, DLP, eDiscovery
  holds) don't see the remote org as an org. They see one app.
- Only the remote *author* can edit or delete a remote user's message on the Slack
  side, and only through the adapter.
- **Slack Huddles and canvases** don't carry.

## Is there already an open, lightweight, Slack-compatible, no-intermediary protocol?

**No.** Matrix and XMPP are open and intermediary-free, but heavy and not
Slack-compatible except through bridges, and the main hosted Slack bridge was just
retired. MIMI is not finished, is MLS-mandatory, and has no Slack story. Mattermost,
Teams and Slack each have the feature, but each only within its own product. The
bridge SaaS products are Slack-compatible but are exactly the intermediary.

**Why nothing has filled the gap until now:** there was no demand side. Before LLM
coding, almost no org ran its own chat tool. Orgs either bought Slack/Teams or ran an
existing server product (Mattermost, Rocket.Chat, Element) whose vendor built shared
channels as an upsell. A cheap internal tool that wants to talk to a customer's Slack
is a 2025–26 phenomenon. That is the "why now".

**Should we make it popular?** Yes, if it stays small. The bet is that adoption follows
implementation cost:

- **Core in an afternoon** with an LLM is achievable if Core is HTTPS + JSON + one
  signature scheme + four event types.
- The Slack adapter is the wedge. Every Slack workspace becomes reachable on day one.

## Decision record: a new small protocol, not a Matrix or MIMI profile

**Decision.** Specify Intertie as a new, deliberately small server-to-server protocol:

- Borrow MIMI's hub model (home = participant-hub), XMPP/Matrix's DNS-named org
  identity, and RFC 9421 signatures.
- Keep a clean mapping path to MIMI, so a future Intertie↔MIMI or Intertie↔Matrix
  gateway, run by one of the parties, is an adapter like the Slack one.

**Why not a Matrix profile:**

- Matrix federation can't be subset into "an afternoon". Even a minimal Matrix
  federation peer must:
  - verify server keys,
  - accept PDUs into a room DAG,
  - run state resolution v2,
  - handle room versions and auth rules,
  - backfill.
  Dropping any of these makes the peer non-conformant, and real homeservers will reject
  or desync with it.
- A Matrix-flavoured profile that isn't real Matrix would be a new protocol anyway, one
  wearing a confusing name.
- Matrix's Slack path is the thing that just got retired. Leaning on it buys no Slack
  compatibility.

**Why not a MIMI profile:**

- MIMI is not stable yet: the drafts are still churning in 2026.
- MLS is mandatory in MIMI, and an MLS client is not an afternoon. On the Slack side the
  E2EE is moot, because the adapter sees plaintext.
- MIMI targets consumer messengers under the DMA. Its policy model (room-policy) is far
  bigger than what two companies sharing #acme-support need.

**What we gain:**

- An implementer-sized spec (target: Core reads in 20 minutes).
- A first-class Slack story.
- Conformance levels a directory can advertise.

**What we give up:**

- Another protocol in the world (the xkcd 927 risk).
- No E2EE in v0.
- We own the maintenance.

### Where I disagree with the brief, or would sharpen it

1. **The real product is the Slack adapter, not the spec.** No org will implement a
   protocol to talk to zero peers. The spec only matters because the adapter makes
   every Slack workspace a peer. So adapter quality (setup in ten minutes, a faithful
   mapping, no history polling) deserves at least as much care as spec elegance, and
   the conformance suite should test adapters too.
2. **Plan a Matrix gateway as a *later* deliverable rather than ignore Matrix.** The
   orgs that already federate (public sector, Rocket.Chat, Mattermost Enterprise) are
   the ones most culturally aligned with "no intermediary". An Intertie↔Matrix
   appservice, run by one of the parties, would give them reach into Intertie peers and
   vice versa. This is the same adapter pattern as Slack, and it is a cheap way to
   avoid being seen as a competing island.
   *Update 2026-10-29: Ben asked for it, and it is being built as
   `packages/matrix-gateway` (`spec/matrix-mapping.md`).*
3. **Don't over-promise E2EE.** We are not making a weaker Matrix, and the docs should
   say so. The security story is authenticated, integrity-protected, TLS-only,
   domain-bound transport between exactly the participants. That is the same trust
   model as Slack Connect, where Slack itself sees everything; we are strictly better
   because no vendor sits in the middle. MLS stays on the roadmap for native-to-native
   channels only.
4. **Counterparty-hosted mode carries Slack terms risk** (see above). I proposed ranking
   self-hosted first until the terms question was settled. Ben settled it: both modes
   are first-class, and the Slack org owns its own terms compliance.
5. **Pull fallback should be in v0.1, as a capability, not optional-later.** Many
   internal tools run behind a VPN with no inbound HTTPS. For them, a pull peer
   (`GET …/events?since=`) is the difference between "can join" and "can't". It is
   cheap to specify because home already keeps the per-channel sequence.

## Name

**Intertie.** In power systems, an intertie is a direct interconnection between two
independent grids, owned and operated by the two utilities themselves, with no grid in
between. Checks run on 2026-10-29:

- GitHub: no repo named intertie with more than 2 stars. `Hakiwen/intertie` was free.
- npm: `intertie` is free.
- `intertie.dev`: RDAP 404 (unregistered). `intertie.org` was registered in 2005, and
  `.dev` is the target.
- A web search found no software product or protocol named Intertie. The term is
  generic in the energy sector.

Rejected candidates: entente (npm taken; a JS testing framework), tieline (Tieline is
a broadcast-audio codec brand, plus a dev-tools repo), palaver (an IRC client and push
service, so a chat collision), parley (a popular Rust text-layout crate; npm taken),
sideband (a Reticulum messaging app with about 1.9k stars, so a chat collision), treaty
(Elysia's Eden Treaty; npm taken), confab, tandem, dovetail (all crowded), crossroom,
cochannel, interroom, concordat, crosstie (free, but weaker or awkward). Details:
`docs/decisions/0001-name.md`.
