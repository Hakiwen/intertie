#!/bin/bash
# Runs the conformance suite (home, peer-push, peer-pull) against the independent Python implementation.
# Needs implementations/python/.venv (python3 -m venv .venv && .venv/bin/pip install -r requirements.txt).
# Reports go to dist/conformance/. Exit status is non-zero if any non-skipped check fails.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
OUT=$ROOT/dist/conformance; mkdir -p "$OUT"
PYDIR=$ROOT/implementations/python
PY="$PYDIR/.venv/bin/python"
TOKEN=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
free() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
serve() { # port [extra args]
  (cd "$PYDIR" && INTERTIE_ADMIN_TOKEN=$TOKEN exec "$PY" -m intertie_py serve --port "$1" --dev-insecure "${@:2}") > "$OUT/py-$1.log" 2>&1 &
  pids+=($!)
  for _ in $(seq 1 50); do curl -sf "http://localhost:$1/.well-known/intertie" >/dev/null && return 0; sleep 0.1; done
  echo "python impl did not start on $1" >&2; return 1
}
admin() { (cd "$PYDIR" && INTERTIE_ADMIN_TOKEN=$TOKEN "$PY" -m intertie_py admin --port "$@"); }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(eval('JSON.parse(s)'+process.argv[1])))" "$1"; }

status=0
# Home role
P=$(free); serve "$P"
CID=$(admin "$P" create-channel conformance | json ".channel.id")
INV=$(admin "$P" invite "$CID" | json ".invite")
node packages/conformance/src/cli.ts home --invite "$INV" --dev-insecure --port "$(free)" --implementation "intertie-py" --out "$OUT/py-home.json" 2> "$OUT/py-home.txt" || status=1
tail -1 "$OUT/py-home.txt"; grep "✖" "$OUT/py-home.txt" || true

# Peer roles: the runner prints an invite; the implementation accepts it.
for mode in push pull; do
  P=$(free); serve "$P" --delivery "$mode"
  RUNNER_OUT="$OUT/py-peer-$mode.txt"
  rm -f "$RUNNER_OUT"; : > "$RUNNER_OUT"   # never read a previous run's invite
  node packages/conformance/src/cli.ts peer --dev-insecure --port "$(free)" --implementation "intertie-py" --out "$OUT/py-peer-$mode.json" > "$RUNNER_OUT" 2>&1 &
  RP=$!
  INV=""
  for _ in $(seq 1 100); do INV=$(grep -oE 'intertie:[^ ]+/[A-Za-z0-9_-]+' "$RUNNER_OUT" 2>/dev/null | head -1 || true); [ -n "$INV" ] && break; sleep 0.1; done
  [ -n "$INV" ] || { echo "runner printed no invite" >&2; exit 1; }
  echo "peer-$mode: invite $INV" >&2
  admin "$P" accept "$INV" >/dev/null || { echo "accept failed; runner said:" >&2; cat "$RUNNER_OUT" >&2; exit 1; }
  wait "$RP" || status=1
  echo "peer-$mode: $(tail -1 "$RUNNER_OUT")"; grep "✖" "$RUNNER_OUT" || true
done
exit $status
