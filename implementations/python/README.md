# intertie-py

A deliberately small, independent Python implementation of Intertie v0.1, written
from `spec/` alone (no reference-implementation code was read). It plays both roles:
**home** (invites, sequencing, fan-out push with retry, pull) and **peer** (push or
pull-only), with the `threads` and `reactions` capabilities.

Conformance (runner in `packages/conformance`, dev mode):

- home: 60/60 passed (2 skipped: `files`, https-only);
- peer-push: 14/14;
- peer-pull: 4/4 (10 push-only checks skipped).

CI runs all three on every push (`scripts/conformance-python.sh`).

## Layout

| file | what |
|---|---|
| `intertie_py/sig.py` | RFC 9421 fixed profile + Content-Digest (core §4) |
| `intertie_py/net.py` | SSRF-safe outbound HTTP (no redirects, checked-address connect), discovery + cache (core §3, security §SSRF) |
| `intertie_py/node.py` | protocol state and logic, both roles, sqlite store (core §5–§7) |
| `intertie_py/server.py` | `http.server` surface: `/.well-known/intertie`, `{endpoint}/accept`, `/events`, `/channels/{id}/events` |
| `intertie_py/admin.py` | admin JSON API + a replayed "what the UI shows" view (not protocol) |
| `intertie_py/__main__.py` | CLI |
| `SPEC-FEEDBACK.md` | every place the spec text did not settle a behaviour |

## Setup

```sh
cd implementations/python
python3 -m venv .venv && .venv/bin/pip install --require-hashes -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
```

## Run

```sh
INTERTIE_ADMIN_TOKEN=secret .venv/bin/python -m intertie_py serve --port 9484 --dev-insecure
```

Dev mode: org is `localhost:PORT`, endpoint `http://localhost:PORT/intertie`, and every
outbound connection must resolve to loopback. Outside dev mode you must pass `--org`
and an `https://` `--endpoint`; the process itself speaks plain HTTP and expects a
TLS-terminating proxy in front (its `@target-uri` view is the configured endpoint's
scheme and host plus the received path). Other flags: `--host` (bind, default
127.0.0.1), `--db FILE` (sqlite; default in-memory, so the key and state are lost on
exit), `--delivery push|pull`, `--display-name`, `--admin-token` (default: env
`INTERTIE_ADMIN_TOKEN`, else random and printed).

## Admin surface

`/admin/*` on the same port. It answers only loopback clients that send
`Authorization: Bearer <admin token>`. The CLI wraps it (`--port` or `--url`, `--token` or env):

```sh
A=".venv/bin/python -m intertie_py admin --port 9484"
$A create-channel acme-globex "optional topic"   # -> {"channel": {"id": "c-…@localhost:9484", …}}
$A invite 'c-…@localhost:9484' [ORG]             # -> {"invite": "intertie:localhost:9484/TOKEN"} (ORG binds it)
$A accept 'intertie:localhost:18890/TOKEN'       # join someone else's channel
$A post CHANNEL "hello" [--user u-1 --name Gail --thread ROOT_ID]
$A event CHANNEL message.edit '{"target":"ID","text":"fixed"}'
$A event CHANNEL reaction.add '{"target":"ID","emoji":"👀"}'
$A event CHANNEL peer.leave '{"org":"localhost:9484","reason":"left"}'     # peer: leave
$A event CHANNEL peer.leave '{"org":"localhost:9485","reason":"removed"}'  # home: remove
$A event CHANNEL channel.close '{}'                                          # home: close
$A channels
$A show CHANNEL     # channel row, peers, replayed messages, raw log
```

`post`/`event` act as the local org: the home sequences directly, and a peer submits
to the home (synchronously once, then retried in the background if retryable).

## Running the conformance runner against it

```sh
# home role
$A create-channel test; $A invite 'c-…@localhost:9484'
node packages/conformance/src/cli.ts home --invite 'intertie:localhost:9484/TOKEN' --dev-insecure --port 18790
# peer role: the runner prints an invite; then
$A accept 'intertie:localhost:18890/TOKEN'
```

## Not implemented / limits

- Capabilities `files`, `mentions` and `members` are not implemented and not advertised.
  Their events are still relayed and stored as unknown types.
- Nonce cache, discovery cache and rate-limit buckets live in memory. Restarting
  within 600 s reopens the replay window for nonces already seen.
- No home transfer, no history before join, no automatic `unreachable` removal (dead
  peers just stop being pushed to after 72 h and can catch up by pull).
- Retention: the log is kept forever (at least the 7 days the spec asks for).
- The admin API is a test harness, not a product UI. There is no audit log beyond stderr lines.
