#!/bin/sh
# Generates SBOMs from package-lock.json with npm's built-in `npm sbom` (no extra tools), into dist/sbom/:
#   intertie-<pkg>-<ver>.{cdx,spdx}.json      runtime dependencies of each published package
#   intertie-workspace-<ver>.{cdx,spdx}.json  everything in the lockfile, dev tooling included (the build environment)
# File names follow the CycloneDX/SPDX patterns so scanners (OSV-Scanner) recognise them.
set -eu
cd "$(dirname "$0")/.."
ver=$(node -p "require('./package.json').version")
out=dist/sbom
rm -rf "$out"; mkdir -p "$out"
for pkg in core slack-adapter matrix-gateway conformance; do
  npm sbom --sbom-format cyclonedx --sbom-type library --omit dev --workspace "@intertie/$pkg" > "$out/intertie-$pkg-$ver.cdx.json"
  npm sbom --sbom-format spdx --sbom-type library --omit dev --workspace "@intertie/$pkg" > "$out/intertie-$pkg-$ver.spdx.json"
done
npm sbom --sbom-format cyclonedx --sbom-type application > "$out/intertie-workspace-$ver.cdx.json"
npm sbom --sbom-format spdx --sbom-type application > "$out/intertie-workspace-$ver.spdx.json"
node -e '
const fs = require("fs"), dir = process.argv[1];
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".cdx.json"))) {
  const b = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
  const third = (b.components || []).filter((c) => !String(c.purl || "").startsWith("pkg:npm/%40intertie/"));
  console.log(`${f}: ${(b.components || []).length} components, ${third.length} third-party`);
}' "$out"
