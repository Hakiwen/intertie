# Matrix setup

The gateway links a Matrix room to an Intertie shared channel. It runs in one of two
modes:

- **Appservice mode** is for an org that runs its own homeserver.
- **Bot mode** is for an org that only has an account on someone else's homeserver.

The event mapping is in [`spec/matrix-mapping.md`](../spec/matrix-mapping.md).

## The demo: a matrix.org room, bot mode (about 10 minutes)

The demo needs **two** Matrix accounts:

- **you**: an existing account, or a new one;
- **a bot account** for the gateway.

Both can live on matrix.org, and the gateway needs nothing installed on a homeserver.
Account creation includes an email check and a captcha, so it has to be done by a
person.

1. **Create the bot account** (3 min). Open a private or incognito browser window, so
   you don't log yourself out. Go to <https://app.element.io> and choose
   **Create account**, keeping the server as **matrix.org**. Element sends you to
   matrix.org's account page:
   - pick a username such as `yourname-intertie`;
   - set a password;
   - confirm the email;
   - solve the captcha.

   Keep this window open; step 4 uses it.
2. **Create the demo room as yourself** (2 min). In your normal Element:
   1. Click **+** next to *Rooms*, then **New room**.
   2. Name it `intertie-demo`.
   3. Keep it **Private (invite only)**.
   4. **Turn OFF "Enable end-to-end encryption"**. This can't be changed after the room
      is created, and the gateway can't read encrypted rooms.
   5. Click **Create room**.
   6. Invite the bot: **Invite**, then `@yourname-intertie:matrix.org`.
3. **On the hub**, run the setup script:

   ```sh
   cd intertie
   scripts/setup-env.sh matrix
   ```

   It asks for **your own** Matrix id (for example `@ben:matrix.org`). Only that
   person's messages are shared, and only that person can run `!intertie` commands.
   Then it prints a link and a short code.
4. **Approve the login as the bot.** In the private window, where you are signed in as
   the bot, open the link and approve. You never copy a token: the gateway receives a
   session that refreshes itself (matrix.org access tokens only last a few hours), saved
   to `state/m/matrix-session.json` with mode 600.

The agent then starts it with the Slack adapters (`scripts/demo.sh up`, then
`scripts/demo.sh link`). The bot accepts the room invite by itself, and the room joins
workspace A's shared channel as a third participant.

If your homeserver doesn't offer OAuth login, use `scripts/setup-env.sh matrix-token`
instead. It asks for the bot's homeserver URL and access token, with hidden input.

## Appservice mode (recommended)

Remote people appear as real Matrix users (ghosts) with their own names, avatars and
reactions.

1. Generate the registration. Use your homeserver's `server_name`, and the URL at which
   the homeserver can reach the gateway:

   ```sh
   node packages/matrix-gateway/src/cli.ts registration --server-name example.org --url http://127.0.0.1:8731 --out ./state/matrix
   ```

   This writes `registration.yaml` and `.env.matrix`, both mode 600.
2. Register the gateway with the homeserver, then restart the homeserver:
   - **Synapse:** add the file under `app_service_config_files:` in `homeserver.yaml`.
   - **Conduit / conduwuit / continuwuity:** in the admin room, send
     `!admin appservices register` followed by the YAML in a code block (or add it to the
     config file, depending on the version).
3. Run the gateway:

   ```sh
   cat >> ./state/matrix/.env.matrix <<ENV
   MATRIX_HOMESERVER=http://127.0.0.1:8008
   INTERTIE_ORG=connect.example.org
   INTERTIE_CONTACT=mailto:security@example.org
   ENV
   node packages/matrix-gateway/src/cli.ts serve --env ./state/matrix/.env.matrix --port 8731
   ```

   Put HTTPS for `connect.example.org` in front of port 8731. Do it the same way as for
   the Slack adapter ([`slack-setup.md` Part 2](slack-setup.md#part-2-running-it-for-real)).
4. In an **unencrypted** room, invite `@intertie:example.org`. Then a moderator types
   `!intertie share` (it replies with an invite for the other org) or
   `!intertie accept <invite>`.

## Bot mode

1. Create a normal account for the gateway, for example `@acme-intertie:matrix.org`.
2. Set `MATRIX_MODE=bot` and run
   `node packages/matrix-gateway/src/cli.ts login --homeserver matrix.org`.
   Approve the printed link as the bot. This uses the OAuth device flow, and the session
   refreshes itself.
   - On homeservers without OAuth login, set `MATRIX_HOMESERVER` and
     `MATRIX_ACCESS_TOKEN` instead.
3. On a shared public server, set `MATRIX_ALLOWED_USERS` and `MATRIX_ADMINS` to your
   people's user ids. Only their messages are shared, and only they can run commands.
   On your own server, `MATRIX_LOCAL_SERVERS` (whole servers) is enough.
4. Invite the bot to the room and run `!intertie share` or `!intertie accept <invite>`.

Bot mode is lossier. Remote people show as `Name (org): text` from one account, and
their reactions collapse into one bot reaction per emoji.
