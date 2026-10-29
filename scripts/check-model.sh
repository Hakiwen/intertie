#!/bin/sh
# Model-checks spec/model/IntertieChannel.tla with TLC.
#  - IntertieChannel.cfg: the protocol as specified; TLC must find NO error.
#  - Bug*.cfg: a defence from the 2026-10-29 review switched off; TLC MUST find the violation
#    (proves the properties are not vacuous).
# Needs Java 11+ on PATH (or $JAVA). Downloads tla2tools.jar once into .cache/ and checks its hash.
set -eu
cd "$(dirname "$0")/.."
JAR=.cache/tla2tools-1.7.4.jar
SHA=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
JAVA=${JAVA:-java}
mkdir -p .cache
if [ ! -f "$JAR" ]; then
  curl -fsSL -o "$JAR.part" https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
  mv "$JAR.part" "$JAR"
fi
echo "$SHA  $JAR" | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -) >/dev/null || { echo "tla2tools.jar checksum mismatch" >&2; rm -f "$JAR"; exit 1; }
cd spec/model
run() { "$JAVA" -XX:+UseParallelGC -cp "../../$JAR" tlc2.TLC -workers auto -deadlock -cleanup -config "$1.cfg" IntertieChannel.tla; }
fail=0
echo "== IntertieChannel (expect: no error)"
out=$(run IntertieChannel 2>&1) || true
echo "$out" | grep -E "distinct states found|No error|violated|Error:" | tail -4
echo "$out" | grep -q "Model checking completed. No error has been found." || { echo "FAIL: the protocol model has a violation" >&2; fail=1; }
for bug in BugPreJoinRead BugInviteReuse; do
  echo "== $bug (expect: a violation)"
  out=$(run "$bug" 2>&1) || true
  echo "$out" | grep -E "is violated|distinct states found" | head -2
  echo "$out" | grep -q "is violated" || { echo "FAIL: $bug was not caught; the property is vacuous" >&2; fail=1; }
done
exit $fail
