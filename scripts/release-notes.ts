// Prints release notes for a tag: artifacts, checksums, and how to verify them.
import { readFileSync } from 'node:fs';
const tag = process.argv[2] ?? 'v?';
const sums = readFileSync(new URL('../dist/release/SHA256SUMS', import.meta.url), 'utf8').trim();
console.log(`Intertie ${tag}

Artifacts: the four package tarballs (\`npm pack\`) and a source archive of the tagged tree. Each has
a CycloneDX and an SPDX SBOM generated from the lockfile, SLSA build provenance, and an SBOM
attestation per format, all signed keylessly with Sigstore by this repository's release workflow.
(GitHub's automatic "Source code" downloads cannot be attested; use \`intertie-${tag.slice(1)}-src.tar.gz\`.)

## Verify

\`\`\`sh
gh attestation verify intertie-core-${tag.slice(1)}.tgz --owner Hakiwen
gh attestation verify intertie-core-${tag.slice(1)}.tgz --owner Hakiwen --predicate-type https://cyclonedx.org/bom
gh attestation verify intertie-core-${tag.slice(1)}.tgz --owner Hakiwen --predicate-type https://spdx.dev/Document/v2.3
sha256sum -c SHA256SUMS
\`\`\`

See SECURITY.md for details.

## SHA-256

\`\`\`
${sums}
\`\`\`
`);
