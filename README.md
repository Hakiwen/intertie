# Intertie

**An open protocol for shared channels between organizations, with no intermediary.**

Slack Connect's superpower is the network effect: a vendor and a customer share a
channel across companies. Intertie makes that an open standard, so an org running its
own chat tool (bought, self-hosted, or vibe-coded last week) can share channels with any
other implementation, **including Slack workspaces**, through an adapter that one of the
two parties runs. Messages flow only between the participating organizations.

- **Identity**: an org is a DNS name; keys and endpoint at `https://<name>/.well-known/intertie`.
- **Transport**: HTTPS + JSON, every request signed (Ed25519).
- **Channels**: the org that shares a channel is its *home*; it orders events and fans
  them out to peers. Two orgs means a direct line. No third party, ever.
- **Slack**: Slack can't be a native peer, so a Slack org installs the Intertie Slack app
  in its own workspace. That app is an adapter run by a participant, not a relay.

Status: **pre-v0.1, private draft.**

| Path | What |
|---|---|
| `docs/landscape.md` | What exists (Matrix, MIMI, Slack Connect, Mattermost, Teams), and why a new small protocol |
| `spec/` | The protocol specification (CC-BY-4.0) |
| `packages/` | Reference implementation, Slack adapter, conformance runner (Apache-2.0) |
| `docs/decisions/` | Decision records |

## License
Code: [Apache-2.0](LICENSE). Specification text under `spec/`: [CC-BY-4.0](spec/LICENSE).
