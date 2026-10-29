#!/bin/sh
# Demo on one machine, dev mode (loopback only): Slack adapters A (:8711, the home) and B (:8712),
# plus the Matrix gateway M (:8713) when .env.matrix exists, and the Teams adapter T (:8714 Intertie,
# :8715 Bot Framework endpoint on loopback) when .env.teams exists. T needs TEAMS_PUBLIC_URL (in
# .env.teams): the https URL your tunnel publishes for 127.0.0.1:8715; Azure's messaging endpoint is
# $TEAMS_PUBLIC_URL/api/messages. Fan-out goes through the home.
#   scripts/demo.sh up        start both adapters in the background (logs in state/{a,b}/adapter.log)
#   scripts/demo.sh link [#channel]   share #channel (default #intertie-demo) from A, accept it in B
#                                     (and in the Matrix room named intertie-demo, if M is running)
#   scripts/demo.sh status    show links on both sides
#   scripts/demo.sh transcript   write docs/demo/transcript-*.md from both adapter logs
#   scripts/demo.sh down      stop both adapters
set -eu
cd "$(dirname "$0")/.."
CLI="node packages/slack-adapter/src/cli.ts"
MCLI="node packages/matrix-gateway/src/cli.ts"
TCLI="node packages/teams-adapter/src/cli.ts"
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
    if [ -f .env.matrix ]; then
      mkdir -p state/m; chmod 700 state/m
      if [ -f state/m/pid ] && kill -0 "$(cat state/m/pid)" 2>/dev/null; then echo "m already running"; else
        nohup $MCLI serve --env .env.matrix --dev-insecure >> state/m/adapter.log 2>&1 &
        echo $! > state/m/pid
        echo "started matrix gateway m (pid $!)"
      fi
    fi
    if [ -f .env.teams ]; then
      mkdir -p state/t; chmod 700 state/t
      if [ -f state/t/pid ] && kill -0 "$(cat state/t/pid)" 2>/dev/null; then echo "t already running"; else
        nohup $TCLI serve --env .env.teams --dev-insecure >> state/t/adapter.log 2>&1 &
        echo $! > state/t/pid
        echo "started teams adapter t (pid $!): Bot Framework endpoint 127.0.0.1:8715, publish it at \$TEAMS_PUBLIC_URL"
      fi
    fi
    sleep 2
    for s in a b m t; do [ -f "state/$s/adapter.log" ] && tail -n 3 "state/$s/adapter.log"; done; true
    ;;
  link)
    invite=$($CLI share "$chan" --state state/a)
    echo "A shared $chan; invite: ${invite%/*}/…"
    $CLI accept "$invite" "$chan" --state state/b
    if [ -f state/m/pid ] && kill -0 "$(cat state/m/pid)" 2>/dev/null; then
      invite2=$($CLI share "$chan" --state state/a)
      $MCLI accept "$invite2" "${MATRIX_ROOM:-intertie-demo}" --state state/m
    fi
    if [ -f state/t/pid ] && kill -0 "$(cat state/t/pid)" 2>/dev/null; then
      invite3=$($CLI share "$chan" --state state/a)
      $TCLI accept "$invite3" "${TEAMS_CHANNEL:-intertie-demo}" --state state/t
    fi
    ;;
  status)
    for s in a b; do echo "== $s"; $CLI status --state "state/$s"; done
    [ -f state/m/admin.json ] && { echo "== m"; $MCLI status --state state/m; }
    [ -f state/t/admin.json ] && { echo "== t"; $TCLI status --state state/t; }; true
    ;;
  transcript)
    node scripts/demo-transcript.ts ${2:+--since "$2"}
    ;;
  down)
    for s in a b m t; do
      if [ -f "state/$s/pid" ]; then kill "$(cat "state/$s/pid")" 2>/dev/null && echo "stopped $s" || true; rm -f "state/$s/pid"; fi
    done
    ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
