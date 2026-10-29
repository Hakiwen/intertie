# Intertie

**An open protocol for shared channels between organizations, with no intermediary.**

Slack Connect's superpower is the network effect: a vendor and its customer share one
channel across two companies. Intertie makes that an open standard. Any org's chat tool
can share channels with any other implementation: bought, self-hosted, or vibe-coded
last week. That **includes Slack workspaces**, through a Slack app that one of the two
parties runs. Messages move only between the participating organizations.

```
 Acme's Slack ⇄ Intertie Slack adapter (run by Acme) ══ signed HTTPS ══ Globex's own chat tool
                                                         no one in between
```

- **An org is a DNS name.** Its endpoint and Ed25519 keys are published at
  `https://<name>/.well-known/intertie`.
- **Every request is signed**, with an RFC 9421 HTTP Message Signature in a fixed
  profile you can implement without a library. Requests use HTTPS and JSON.
- **The org that shares a channel is its *home*.** The home orders the events and fans
  them out to the other orgs. With two orgs, that's a direct line. A third party is
  never involved.
- **Core** covers messages, edits, deletes and thread replies, plus invite, accept,
  leave and close. Core reads in about 20 minutes. Threads, reactions, files, mentions
  and members are optional capabilities.
- **Slack** can't be a native peer, so the Slack org installs the Intertie app in its
  own workspace. Remote people show up with their name, avatar and org. The ways this
  differs from Slack Connect are listed in [`spec/slack-mapping.md`](spec/slack-mapping.md#what-cannot-map).

Status: **v0.1 draft, private.**

## Try it locally (no Slack needed)

You need Node ≥ 22.18. There are no runtime dependencies.

```sh
npm install && make check                   # typecheck + tests (two fake Slacks end to end, conformance)

# Two native orgs, each running the toy chat:
node packages/toy-chat/src/server.ts --port 8721 --dev-insecure --name Acme &
node packages/toy-chat/src/server.ts --port 8722 --dev-insecure --name Globex &
# Open http://127.0.0.1:8721. Click "Share a new channel" and copy the invite.
# Open http://127.0.0.1:8722 and paste the invite.
```

## Connect two Slack workspaces

Follow [`docs/slack-setup.md`](docs/slack-setup.md). It takes about ten minutes:

1. Create the app from [`manifest.yaml`](packages/slack-adapter/manifest.yaml) in each
   workspace.
2. Run `scripts/setup-env.sh a`, then `scripts/setup-env.sh b`.
3. Run `scripts/demo.sh up`, then `scripts/demo.sh link`.

Inside Slack, admins use `/intertie share`, `/intertie accept <invite>`,
`/intertie status` and `/intertie unshare`.

## Implement it

1. Read [`spec/core.md`](spec/core.md), then [`spec/security.md`](spec/security.md).
2. Check your signing code against
   [`spec/test-vectors/signature.json`](spec/test-vectors/signature.json). Ed25519 is
   deterministic, so your signatures must match byte for byte.
3. Validate your events against [`spec/schemas/`](spec/schemas/).
4. Run the conformance suite against your endpoint:

   ```sh
   node packages/conformance/src/cli.ts home --invite intertie:your.org/<token> --org <runner-name> --endpoint <runner-url> --out report.json
   node packages/conformance/src/cli.ts sign report.json --key your-key.json --keyid your.org#kid --out signed.json
   ```

   The runner needs a reachable HTTPS name of its own, for example through a tunnel.
   For local testing, pass `--dev-insecure` instead.

## Layout

| Path | What |
|---|---|
| [`spec/`](spec/) | The protocol: core, capabilities, security, conformance, Slack mapping, schemas, test vectors (CC-BY-4.0) |
| [`packages/core`](packages/core) | Reference engine: signing, discovery, SSRF-safe fetch, home/peer state machine, pull, files |
| [`packages/slack-adapter`](packages/slack-adapter) | The Slack app: Socket Mode or Events API, `/intertie`, admin CLI, manifest |
| [`packages/conformance`](packages/conformance) | Conformance runner for the home and peer roles; signed reports |
| [`packages/toy-chat`](packages/toy-chat) | A ~130-line native web chat, standing in for "your internal tool" |
| [`docs/landscape.md`](docs/landscape.md) | Matrix, MIMI, Slack Connect, Mattermost, Teams: what exists, and why a new small protocol |
| [`docs/decisions/`](docs/decisions/) | Decision records |

## License

Code is licensed [Apache-2.0](LICENSE), which includes a patent grant. The
specification text under `spec/` is licensed [CC-BY-4.0](spec/LICENSE).
