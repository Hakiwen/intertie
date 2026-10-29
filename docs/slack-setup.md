# Slack setup

There are two parts:

- **Part 1** is the two-workspace demo. It takes about ten minutes.
- **Part 2** is how an organization runs the adapter for real.

## Part 1: the demo, two Slack workspaces on one machine

You need two Slack workspaces where you are an admin. A brand-new free workspace works,
and so does one existing workspace plus one new one. The same app manifest is used in
both, and each workspace gets its own copy of the app.

### 1. Create the second workspace (2 min, skip it if you have two)

Go to <https://slack.com/get-started#/createnew> and create a workspace, for example
"Intertie Demo B". Free is fine.

### 2. In each workspace, create the app from the manifest (3 min each)

1. Open <https://api.slack.com/apps> and click **Create New App**, then **From a manifest**.
2. Pick the workspace and click **Next**.
3. Select the **YAML** tab. Replace everything with the contents of
   [`packages/slack-adapter/manifest.yaml`](../packages/slack-adapter/manifest.yaml).
4. Click **Next**, then **Create**.
5. On **Basic Information**, scroll to **App-Level Tokens** and click **Generate Token and
   Scopes**.
   - Name it `socket` and add the scope `connections:write`.
   - Click **Generate**, and keep that `xapp-…` token for step 3.
6. In the left sidebar, open **Install App** and click **Install to *workspace***, then
   **Allow**.
   - Keep the **Bot User OAuth Token** (`xoxb-…`) for step 3.
7. In Slack, create a **public** channel named `#intertie-demo`. The app joins it by itself.

Then do the same in the other workspace.

### 3. Hand the tokens to the hub, without pasting them anywhere else (1 min)

In a terminal on the hub, run:

```sh
cd ~/lifeos/projects/shared-channels
scripts/setup-env.sh a     # workspace A: paste xoxb-…, then xapp-… (input is hidden)
scripts/setup-env.sh b     # workspace B
```

This writes `.env.a` and `.env.b` with mode 600. Both files are gitignored, and the
tokens are never printed. **Don't** paste tokens into chat, notes or messages.

That's all for setup. The agent then starts both adapters and links the channels
(`scripts/demo.sh up && scripts/demo.sh link`). You can also do the linking yourself
in Slack:

- in workspace A's `#intertie-demo`, type `/intertie share`;
- copy the invite it shows you (only you see it);
- in workspace B's `#intertie-demo`, type `/intertie accept <invite>`.

### 4. Try it, and take the screenshots (5 min)

[`docs/demo/checklist.md`](demo/checklist.md) has the sequence: messages, a thread,
an edit, a delete, reactions and a file, in both directions.

## Part 2: running it for real

### Self-hosted (recommended)

The Slack org runs the adapter itself, so its Slack token never leaves its
infrastructure.

1. Create the app from the manifest in your workspace (Part 1, step 2).
2. Pick your Intertie name: a domain you control, for example `connect.example.com`.
3. Run the adapter behind HTTPS. The adapter speaks plain HTTP on `127.0.0.1`, so
   terminate TLS in front of it with Caddy, nginx, a cloud load balancer, or a tunnel
   such as Cloudflare Tunnel or Tailscale Funnel. Then run:

   ```sh
   INTERTIE_ORG=connect.example.com \
   INTERTIE_CONTACT=mailto:security@example.com \
   SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… \
   node packages/slack-adapter/src/cli.ts serve --port 8701
   ```

   Route `https://connect.example.com/` to `127.0.0.1:8701`. That covers both
   `/.well-known/intertie` and `/intertie/*`.
4. **Optional: use your apex domain as the identity.** To be `example.com` while
   running on `connect.example.com`:
   - set `INTERTIE_ORG=example.com` and
     `INTERTIE_ENDPOINT=https://connect.example.com/intertie`;
   - publish the output of `intertie-slack discovery` at
     `https://example.com/.well-known/intertie`.
5. Keep `state/` private. It holds the signing key (`key.json`, mode 600), the database
   and the audit log.

**Events API instead of Socket Mode.** In the app settings:

- turn Socket Mode off;
- set the event and slash-command request URLs to `https://connect.example.com/slack/events`
  and `https://connect.example.com/slack/commands`;
- set `SLACK_SIGNING_SECRET` in place of `SLACK_APP_TOKEN`.

### Counterparty-hosted

The org whose tool is *not* Slack (say, the vendor) hosts the adapter, and the Slack
org installs the vendor's app. That still involves only two parties, but **the vendor
then holds the Slack org's bot token**. That is a real grant of trust, and it may also
make the vendor a "third party" under Slack's API Terms (see
[`docs/landscape.md`](landscape.md)). Self-hosting is the better default.

### What your Slack users will see

- Remote people appear as app posts showing their name, their org and their avatar, for
  example "Gail Ito (globex.com) APP".
- Threads, edits, deletes, reactions and files are mirrored in both directions.
- Not everything a native Slack Connect channel does carries over. The full list of
  differences is in
  [`spec/slack-mapping.md` § What cannot map](../spec/slack-mapping.md#what-cannot-map).
  The main ones:
  - you can't DM remote people;
  - reactions by remote people all show as the app;
  - `@here` and `@channel` never cross between orgs.
