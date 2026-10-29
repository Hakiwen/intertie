#!/bin/sh
# Two-Slack demo on one machine: adapters A (:8711) and B (:8712) in dev mode (loopback only).
#   scripts/demo.sh up        start both adapters in the background (logs in state/{a,b}/adapter.log)
#   scripts/demo.sh link [#channel]   share #channel (default #intertie-demo) from A, accept it in B
#   scripts/demo.sh status    show links on both sides
#   scripts/demo.sh transcript   write docs/demo/transcript-*.md from both adapter logs
#   scripts/demo.sh down      stop both adapters
set -eu
cd "$(dirname "$0")/.."
CLI="node packages/slack-adapter/src/cli.ts"
chan="${2:-#intertie-demo}"

case "${1:-}" in
  up)
    for s in a b; do
      [ -f ".env.$s" ] || { echo "missing .env.$s; run scripts/setup-env.sh $s" >&2; exit 1; }
      mkdir -p "state/$s"; chmod 700 "state/$s"
      if [ -f "state/$s/pid" ] && kill -0 "$(cat "state/$s/pid")" 2>/dev/null; then echo "$s already running"; continue; fi
      nohup $CLI serve --env ".env.$s" --dev-insecure >> "state/$s/adapter.log" 2>&1 &
      echo $! > "state/$s/pid"
      echo "started adapter $s (pid $!)"
    done
    sleep 2
    for s in a b; do tail -n 3 "state/$s/adapter.log"; done
    ;;
  link)
    invite=$($CLI share "$chan" --state state/a)
    echo "A shared $chan; invite: ${invite%/*}/…"
    $CLI accept "$invite" "$chan" --state state/b
    ;;
  status)
    for s in a b; do echo "== $s"; $CLI status --state "state/$s"; done
    ;;
  transcript)
    node scripts/demo-transcript.ts ${2:+--since "$2"}
    ;;
  down)
    for s in a b; do
      if [ -f "state/$s/pid" ]; then kill "$(cat "state/$s/pid")" 2>/dev/null && echo "stopped $s" || true; rm -f "state/$s/pid"; fi
    done
    ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
