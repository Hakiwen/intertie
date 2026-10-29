#!/bin/bash
# Listing the Python implementation on the registry as py.intertie.dev. See deploy/wellknown/README.md.
#   scripts/py-listing.sh init   create the persistent identity (key stays in state/py-listing/, mode 600)
#                                and write the durable discovery document into deploy/wellknown/py.intertie.dev/
#   scripts/py-listing.sh run    with the tunnels live (py.intertie.dev → 127.0.0.1:8740,
#                                runner.intertie.dev → 127.0.0.1:8790), run the conformance suite against
#                                https://py.intertie.dev, sign the reports with py's key, verify them
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
S=$ROOT/state/py-listing; mkdir -p "$S"; chmod 700 "$S"
PYDIR=$ROOT/implementations/python; PY="$PYDIR/.venv/bin/python"
ORG=py.intertie.dev; RUNNER=runner.intertie.dev; PYPORT=8740; RPORT=8790
SITE=$ROOT/deploy/wellknown/$ORG
TOKEN=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
start_py() {
  (cd "$PYDIR" && INTERTIE_ADMIN_TOKEN=$TOKEN exec "$PY" -m intertie_py serve --port $PYPORT --org $ORG \
    --endpoint "https://$ORG/intertie" --display-name "intertie-py" --db "$S/py.sqlite") > "$S/py.log" 2>&1 &
  PYPID=$!; trap 'kill $PYPID 2>/dev/null || true' EXIT
  for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PYPORT/.well-known/intertie" >/dev/null && return 0; sleep 0.1; done
  echo "python impl did not start" >&2; exit 1
}
case "${1:-}" in
  init)
    start_py
    mkdir -p "$SITE/.well-known"
    curl -sf "http://127.0.0.1:$PYPORT/.well-known/intertie" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s),null,2)))" > "$SITE/.well-known/intertie"
    # The signing key for reports, exported from the implementation's own seed (never committed).
    node -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      const seed = Buffer.from(db.prepare(\"select v from meta where k='seed'\").get().v, 'hex');
      const doc = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
      const k = doc.keys[0];
      require('fs').writeFileSync(process.argv[3], JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid: k.kid, x: k.x, d: seed.toString('base64url') }) + '\n', { mode: 0o600 });
    " "$S/py.sqlite" "$SITE/.well-known/intertie" "$S/key.jwk"
    chmod 600 "$S/key.jwk" "$S/py.sqlite"
    echo "identity ready: $ORG (key in $S/key.jwk, mode 600); durable discovery document: $SITE/.well-known/intertie"
    ;;
  run)
    [ -f "$S/key.jwk" ] || { echo "run init first" >&2; exit 1; }
    start_py
    OUT=$S/reports; mkdir -p "$OUT"
    CID=$(cd "$PYDIR" && INTERTIE_ADMIN_TOKEN=$TOKEN "$PY" -m intertie_py admin --port $PYPORT create-channel conformance | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).channel.id")
    INV=$(cd "$PYDIR" && INTERTIE_ADMIN_TOKEN=$TOKEN "$PY" -m intertie_py admin --port $PYPORT invite "$CID" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).invite")
    node packages/conformance/src/cli.ts home --invite "$INV" --org $RUNNER --endpoint "https://$RUNNER/intertie" --port $RPORT --implementation intertie-py --out "$OUT/home.json"
    node packages/conformance/src/cli.ts sign "$OUT/home.json" --key "$S/key.jwk" --keyid "$ORG#$(node -pe "require('$S/key.jwk').kid")" --out "$OUT/home.signed.json"
    node packages/conformance/src/cli.ts verify "$OUT/home.signed.json"
    echo "signed report: $OUT/home.signed.json → copy to the registry as reports/intertie-py.json (see deploy/wellknown/README.md)"
    ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
