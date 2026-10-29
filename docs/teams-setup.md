# Microsoft Teams setup

The Teams adapter makes a channel in a team a participant in an Intertie shared channel.
For example, Slack workspace A, a Matrix room and a Teams channel can all share one
conversation. The Teams org (or the org it shares with) runs the adapter. No one else
does.

How it works, and what does not carry over, is in
[`spec/teams-mapping.md`](../spec/teams-mapping.md).

## What you need (one-time)

- **A Microsoft 365 tenant with Teams where you are an admin.** Any of these works:
  - an existing business tenant;
  - a *Microsoft 365 Business Basic* trial;
  - a Microsoft 365 Developer Program sandbox, if your account qualifies (eligibility
    is restricted as of 2026).
- **An Azure subscription in that same tenant.** The free Azure account is enough: the
  bot uses the free F0 tier.
- **Custom apps allowed** in the tenant (step 1).

## Part 1: the demo (about 20 minutes, most of it Microsoft portals)

### 1. Allow custom apps (2 min, only if your tenant blocks them)

In the [Teams admin center](https://admin.teams.microsoft.com):

1. Go to **Teams apps → Manage apps → Actions → Org-wide app settings**. Turn on
   **Let users interact with custom apps**.
2. Go to **Teams apps → Setup policies → Global (Org-wide default)**. Turn on
   **Upload custom apps**.

Policy changes can take a while to apply: usually minutes, sometimes hours.

### 2. Create the bot in Azure (5 min)

1. In the [Azure portal](https://portal.azure.com), choose **Create a resource**, search
   for **Azure Bot**, then **Create**.
2. Fill in the form:

   | field | value |
   |---|---|
   | Bot handle | e.g. `intertie-demo` |
   | Pricing tier | **F0 (free)** |
   | Type of App | **Single Tenant** (Azure no longer creates multi-tenant bots) |
   | Creation type | **Create new Microsoft App ID** |

   Then **Review + create**, then **Create**.
3. Open the new resource and go to **Settings → Configuration**. Note the
   **Microsoft App ID** and the **App Tenant ID**.
4. On the same page, click **Manage Password**. That opens the app registration's
   **Certificates & secrets**. Choose **New client secret**, then **Add**, then copy the
   **Value** column. It is shown only once.
5. Back in **Configuration**, set the **Messaging endpoint** to the public URL the agent
   gives you, followed by `/api/messages`. See step 4.
6. Go to **Settings → Channels**. Add **Microsoft Teams**, accept the terms, and click
   **Apply**.

### 3. Hand the credentials to the hub, without pasting them anywhere else (1 min)

```sh
cd intertie
scripts/setup-env.sh teams
```

It asks for four values:

- the App ID;
- the Tenant ID;
- the client secret (input is hidden);
- the public URL from step 4.

It writes `.env.teams` (mode 600, gitignored) and builds the app package
**`state/t/intertie-teams.zip`**. Don't paste the secret into chat, notes or messages.

### 4. The public URL

Teams delivers messages by calling the adapter over HTTPS from Microsoft's cloud. Unlike
Slack's Socket Mode, there is no outbound-only option. For the demo, the adapter runs a
**separate listener that serves only `/api/messages`**, and that listener is published
through a tunnel. Every request on it must carry a valid Microsoft-signed JWT. The
Intertie endpoint and the admin API stay on loopback.

*Which tunnel to use on the hub is an open decision. The agent will tell you the URL.*

### 5. Install the app in a team (3 min)

1. In Teams, go to **Apps → Manage your apps → Upload an app → Upload a custom app**, and
   choose `intertie-teams.zip`.
2. Choose **Add to a team**, pick a team, and pick the channel to use (for example a new
   channel `intertie-demo`).
3. Teams lists the permissions the app requests. These are *resource-specific*: they
   apply to this team only, and no tenant-wide approval is needed.
   - **Read this team's channel messages.** Without this, the bot only sees
     @mentions.
   - **Read this team's channel settings.** Used for channel names.
   - **Read this team's members.** Used to know who may share a channel.

   Approve them.

The agent then links the channel to the shared channel: `scripts/demo.sh link` adds Teams
as a fourth participant. You can also do it yourself in the channel:
`@Intertie accept <invite>`.

## Part 2: running it for real

Teams, unlike Slack, always needs a public HTTPS endpoint. Microsoft calls it.

- **Self-hosted** (the Teams org runs it). Use the same two steps as Part 1, but run the
  adapter on your own infrastructure behind HTTPS, for example
  `https://connect.example.com/api/messages`. Then set:
  - `INTERTIE_ORG=connect.example.com`;
  - the endpoint;
  - `TEAMS_PUBLIC_URL=https://connect.example.com`.
- **Vendor-hosted** (the org on the other side runs it). The vendor creates the Azure Bot
  in **its own** tenant: Azure now creates only single-tenant bots, and that bot can
  still be installed in other tenants through direct app distribution. The vendor then
  ships the app package, and the Teams org's admin uploads it to the team.
  > **Microsoft terms:** the organization that installs the app in its tenant is
  > responsible for its own compliance with Microsoft's terms and its tenant's app
  > policies.
- Tenants may restrict custom apps (step 1). In that case an admin publishes the app to
  the org's catalog through **Teams admin center → Teams apps → Manage apps → Upload new
  app**, and team owners add it from there.
