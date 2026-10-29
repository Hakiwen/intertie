#!/bin/sh
# Installs the packed release tarballs into an empty project and exercises them as a consumer would.
set -eu
rel="$(cd "$(dirname "$0")/.." && pwd)/dist/release"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
npm init -y >/dev/null
npm install --no-audit --no-fund "$rel"/intertie-core-*.tgz "$rel"/intertie-slack-adapter-*.tgz "$rel"/intertie-matrix-gateway-*.tgz "$rel"/intertie-conformance-*.tgz >/dev/null
cat > smoke.mjs <<'JS'
import { generateKey, importPrivate, signRequest, verifyRequest, NonceCache, importPublic, PROTOCOL_VERSION } from '@intertie/core';
import { toMrkdwn } from '@intertie/slack-adapter';
import { mdToHtml } from '@intertie/matrix-gateway';
import { jcs } from '@intertie/conformance';
const k = generateKey('k1');
const url = 'https://a.example/intertie/events', body = Buffer.from('{}');
const h = signRequest({ method: 'POST', url, body, key: { keyid: 'a.example#k1', privateKey: importPrivate(k) } });
const r = await verifyRequest({ method: 'POST', url, headers: h, body, nonces: new NonceCache(), resolveKey: async () => importPublic(k) });
if (r.org !== 'a.example' || toMrkdwn('**x**') !== '*x*' || !mdToHtml('**x**').html.includes('strong') || jcs({ b: 1, a: 2 }) !== '{"a":2,"b":1}') throw new Error('smoke failed');
console.log(`ok: protocol ${PROTOCOL_VERSION}, sign/verify, slack + matrix formatting, jcs`);
JS
node smoke.mjs
npx --no-install intertie-slack help | head -1
npx --no-install intertie-matrix help | head -1
npx --no-install intertie-conformance help | head -1
