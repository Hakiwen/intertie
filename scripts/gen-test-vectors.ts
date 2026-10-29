// Regenerates spec/test-vectors/signature.json from a fixed seed. Run: node scripts/gen-test-vectors.ts
import { createHash, createPrivateKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { contentDigest, importPrivate, signatureBase, signRequest, type PrivateJwk } from '../packages/core/src/index.ts';

const seed = createHash('sha256').update('intertie test vector key v0.1').digest();
const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const jwk = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' }) as { x: string; d: string };
const key: PrivateJwk = { kty: 'OKP', crv: 'Ed25519', kid: 'test-1', x: jwk.x, d: jwk.d };
const signing = { keyid: 'globex.example#test-1', privateKey: importPrivate(key) };
const created = 1761764580;

const body = JSON.stringify({ events: [{ id: '01JBDXQ4M6V2S9K3Y8T7R5N0PA', type: 'message.create', channel: 'c-7f3a@acme.example', origin: 'globex.example', sender: { id: 'u-81f2@globex.example', name: 'Gail Ito' }, ts: '2026-10-29T19:03:00Z', body: { text: 'hello' } }] });
const postUrl = 'https://connect.acme.example/intertie/events';
const nonce = 'Qm9yZ2VzIHdhcyBoZXJlLCAyMDI2';
const post = signRequest({ method: 'POST', url: postUrl, body, key: signing, created, nonce });
const postParams = post['signature-input'].slice('sig1='.length);

const getUrl = 'https://connect.acme.example/intertie/channels/c-7f3a%40acme.example/events?since=41&limit=100&wait=0';
const nonce2 = 'bm9uY2UtZm9yLXRoZS1HRVQtdmVjdG9y';
const get = signRequest({ method: 'GET', url: getUrl, key: signing, created, nonce: nonce2 });
const getParams = get['signature-input'].slice('sig1='.length);

const out = {
  description: 'Intertie v0.1 signature test vectors. The key is public test material: never use it for anything real. Ed25519 is deterministic, so signatures must match byte for byte.',
  key: { ...key, seed_hex: seed.toString('hex') },
  post: {
    method: 'POST', url: postUrl, keyid: signing.keyid, created, nonce, body,
    content_digest: contentDigest(body),
    signature_base: signatureBase('POST', postUrl, contentDigest(body), postParams),
    signature_input: post['signature-input'], signature: post['signature'],
  },
  get: {
    method: 'GET', url: getUrl, keyid: signing.keyid, created, nonce: nonce2,
    signature_base: signatureBase('GET', getUrl, null, getParams),
    signature_input: get['signature-input'], signature: get['signature'],
  },
};
writeFileSync(new URL('../spec/test-vectors/signature.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(out.post.signature_base + '\n\n' + out.post.signature);
