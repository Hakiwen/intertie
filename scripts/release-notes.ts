// Prints release notes for a tag: artifacts, checksums, and how to verify them.
import { readFileSync } from 'node:fs';
const tag = process.argv[2] ?? 'v?';
const sums = readFileSync(new URL('../dist/release/SHA256SUMS', import.meta.url), 'utf8').trim();
console.log(`Intertie ${tag}

Package tarballs (\`npm pack\`), each with a CycloneDX and SPDX SBOM, SLSA build provenance and an
SBOM attestation, signed keylessly with Sigstore from this repository's GitHub Actions.

## Verify

\`\`\`sh
gh attestation verify intertie-core-${tag.slice(1)}.tgz --owner Hakiwen
gh attestation verify intertie-core-${tag.slice(1)}.tgz --owner Hakiwen --predicate-type https://cyclonedx.org/bom
sha256sum -c SHA256SUMS
\`\`\`

See SECURITY.md for details.

## SHA-256

\`\`\`
${sums}
\`\`\`
`);
