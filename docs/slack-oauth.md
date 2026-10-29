# "Add to Slack": one service, many workspaces

The single-workspace adapter ([`slack-setup.md`](slack-setup.md)) asks each Slack org to
create an app and hand over tokens. The **host** removes those steps. One distributed
Slack app gets an **Add to Slack** button, and installing it takes one click. This is
the natural shape for a vendor whose own tool speaks Intertie and whose customers are on
Slack.

## Where it runs (Ben's question)

**On the hosting party's side, which is normally the vendor with the internal tool. It
runs as one always-on service.**

- **One process, many workspaces.** Every workspace that clicks *Add to Slack* gets:
  - its own bot token, stored encrypted;
  - its own Intertie identity (`<team-id>.connect.vendor.example`), with its own
    signing key and its own database.
  The host routes Intertie traffic by `Host` header, so workspaces never share state.
- **It needs a public HTTPS URL**, for three things:
  - the OAuth redirect: `https://connect.vendor.example/slack/oauth/callback`;
  - the Slack Events API and slash commands: `/slack/events` and `/slack/commands`;
  - each workspace's Intertie endpoint and `/.well-known/intertie`, on
    `<team>.connect.vendor.example`. That needs a **wildcard** DNS record and
    certificate: `*.connect.vendor.example`.
- **Socket Mode is optional for inbound events.** Set `SLACK_APP_TOKEN` and the host
  receives every workspace's events over one outbound connection. OAuth and peers still
  need the public HTTPS URL.
- **Tokens at rest** are encrypted:
  - with AES-256-GCM, under `SLACK_TOKEN_KEY`, a 32-byte key you generate and keep in your
    secret store;
  - with the team id as associated data, so a token row cannot be moved to another
    workspace.
  Bot tokens are never logged.
- **Workspace isolation:**
  - each workspace has its own Intertie name, key, SQLite database and rate limits;
  - Slack events are routed by `team_id`;
  - a workspace only ever relays its own users. Slack Connect guests from other
    workspaces are not relayed (see `spec/slack-mapping.md`).
- **Uninstall.** When Slack sends `app_uninstalled` or `tokens_revoked`, that workspace
  leaves or closes its shared channels, and its token is deleted.

### What we do not do

**We do not run a public instance of this for everyone.** A single host that every
company installs, run by a third party, would hold every workspace's tokens and see every
shared message. That would recreate exactly the intermediary model that Intertie
exists to avoid. The host is software you run for **your own** relationships: a vendor
runs it for its customers, an organization runs it for itself. Every instance has
one operator, and that operator is a participant.

> **Slack API terms:** the Slack org that installs the app is responsible for its own
> compliance with Slack's API Terms.

## Setting it up (about 20 minutes)

1. **Create the app.** At <https://api.slack.com/apps>, choose **Create New App → From a
   manifest**. Paste
   [`packages/slack-adapter/manifest.distributed.yaml`](../packages/slack-adapter/manifest.distributed.yaml)
   with `connect.vendor.example` replaced by your host.
   - Then go to **Manage Distribution → Activate Public Distribution**. A Marketplace
     listing isn't required for "Add to Slack" links.
   - Note the **Client ID**, **Client Secret** and **Signing Secret** (Basic
     Information).
2. **DNS and TLS.** Point `connect.vendor.example` and `*.connect.vendor.example` at the
   host, with certificates for both.
3. **Run it.** The environment it needs:

   ```sh
   SLACK_CLIENT_ID=… SLACK_CLIENT_SECRET=… SLACK_SIGNING_SECRET=…
   SLACK_TOKEN_KEY=$(openssl rand -base64 32)          # keep it: losing it means reinstalling every workspace
   INTERTIE_PUBLIC_BASE=https://connect.vendor.example
   INTERTIE_ORG_SUFFIX=connect.vendor.example
   node packages/slack-adapter/src/cli.ts host --port 8700
   ```

4. **Share the install link** with customers: `https://connect.vendor.example/slack/install`.
   After installing, a customer's admin types `/intertie accept <invite>` in the channel
   to share. Alternatively, they type `/intertie share` there and you accept the invite
   on your side.

## Deploy recipes

These are in [`deploy/`](../deploy/). Zero runtime dependencies make them small. They
are templates: they have not yet been run end to end on each platform.

| where | how |
|---|---|
| **Container** (any host) | `docker build -f deploy/Dockerfile -t intertie .`, then `docker run -p 8700:8700 --env-file host.env -v intertie-state:/state intertie`. Put TLS in front. |
| **Fly.io** | `deploy/fly.toml`: an always-on machine, a volume for `/state`, `fly certs add` for the host and the wildcard, and secrets with `fly secrets set`. |
| **Small VM** | `deploy/intertie-slack-host.service` (systemd, sandboxed), with Caddy or nginx terminating TLS for the host and the wildcard. |

Back up `/state`: it holds the encrypted tokens, every workspace's Intertie signing key,
and the channel databases. Losing a workspace's key changes its identity, and its
partners will have to re-accept.
