# Matrix setup

The gateway links a Matrix room to an Intertie shared channel. It runs in one of two
modes:

- **Appservice mode** is for an org that runs its own homeserver.
- **Bot mode** is for an org that only has an account on someone else's homeserver.

The event mapping is in [`spec/matrix-mapping.md`](../spec/matrix-mapping.md).

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

1. Create a normal account for the gateway, for example `@acme-intertie:matrix.org`, and
   get its access token.
2. Set `MATRIX_MODE=bot`, `MATRIX_HOMESERVER=https://matrix-client.matrix.org` and
   `MATRIX_ACCESS_TOKEN=…`.
3. Set `MATRIX_LOCAL_SERVERS` to the servers whose users your org vouches for. In bot
   mode on a shared server, also set `MATRIX_ADMINS` to your people's user ids. Only
   those users' messages are shared, and only they can run commands.
4. Invite the bot to the room and run `!intertie share` or `!intertie accept <invite>`.

Bot mode is lossier. Remote people show as `Name (org): text` from one account, and
their reactions collapse into one bot reaction per emoji.
