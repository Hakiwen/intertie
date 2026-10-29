import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  contentDigest, generateKey, importPrivate, importPublic, NonceCache, signRequest, verifyRequest,
  type PrivateJwk,
} from '../src/index.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../spec/test-vectors/signature.json', import.meta.url), 'utf8'));

test('test vector: signature base and signature match the spec bytes', () => {
  const v = vectors.post;
  const key = { keyid: v.keyid, privateKey: importPrivate(vectors.key as PrivateJwk) };
  const h = signRequest({ method: v.method, url: v.url, body: v.body, key, created: v.created, nonce: v.nonce });
  assert.equal(h['content-digest'], v.content_digest);
  assert.equal(h['signature-input'], v.signature_input);
  assert.equal(h['signature'], v.signature); // Ed25519 is deterministic
});

test('test vector: GET has no content-digest component', () => {
  const v = vectors.get;
  const key = { keyid: v.keyid, privateKey: importPrivate(vectors.key as PrivateJwk) };
  const h = signRequest({ method: 'GET', url: v.url, key, created: v.created, nonce: v.nonce });
  assert.equal(h['content-digest'], undefined);
  assert.equal(h['signature-input'], v.signature_input);
  assert.equal(h['signature'], v.signature);
});

function setup() {
  const jwk = generateKey('k1');
  const key = { keyid: 'acme.com#k1', privateKey: importPrivate(jwk) };
  const pub = importPublic(jwk);
  const resolveKey = async (org: string, kid: string) => (org === 'acme.com' && kid === 'k1' ? pub : null);
  return { key, resolveKey, nonces: new NonceCache() };
}

const url = 'https://connect.globex.com/intertie/events';
const body = Buffer.from('{"events":[]}');

test('verify accepts a good request and returns the org', async () => {
  const s = setup();
  const headers = signRequest({ method: 'POST', url, body, key: s.key });
  const r = await verifyRequest({ method: 'POST', url, headers, body, resolveKey: s.resolveKey, nonces: s.nonces });
  assert.deepEqual(r, { org: 'acme.com', kid: 'k1' });
});

const rejects = async (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: { code?: string }) => { assert.equal(e.code, code); return true; });

test('verify rejects tampering, staleness, replay, unknown keys', async () => {
  const s = setup();
  const now = Math.floor(Date.now() / 1000);
  const v = (headers: Record<string, string>, o: { body?: Buffer; url?: string; method?: string } = {}) =>
    verifyRequest({ method: o.method ?? 'POST', url: o.url ?? url, headers, body: o.body ?? body, resolveKey: s.resolveKey, nonces: s.nonces, nowS: now });

  await rejects(v(signRequest({ method: 'POST', url, body, key: s.key }), { body: Buffer.from('{"events":[1]}') }), 'bad_digest');
  const h = signRequest({ method: 'POST', url, body, key: s.key });
  await rejects(v({ ...h, 'content-digest': contentDigest('{"events":[1]}') }, { body: Buffer.from('{"events":[1]}') }), 'bad_signature');
  await rejects(v(signRequest({ method: 'POST', url, body, key: s.key }), { url: 'https://evil.example/intertie/events' }), 'bad_signature');
  await rejects(v(signRequest({ method: 'POST', url, body, key: s.key }), { method: 'PUT' }), 'bad_signature');
  await rejects(v(signRequest({ method: 'POST', url, body, key: s.key, created: now - 301 })), 'stale_signature');
  const once = signRequest({ method: 'POST', url, body, key: s.key, created: now });
  await v(once);
  await rejects(v(once), 'replayed');
  const other = { keyid: 'acme.com#k2', privateKey: importPrivate(generateKey('k2')) };
  await rejects(v(signRequest({ method: 'POST', url, body, key: other })), 'unknown_key');
  const forged = { keyid: 'acme.com#k1', privateKey: importPrivate(generateKey('k1')) };
  await rejects(v(signRequest({ method: 'POST', url, body, key: forged })), 'bad_signature');
  await rejects(v({ ...signRequest({ method: 'POST', url, body, key: s.key }), 'signature-input': 'sig1=("@method");created=1;keyid="acme.com#k1";alg="ed25519";nonce="aaaaaaaaaaaaaaaaaaaaaa";tag="intertie"' }), 'bad_signature');
  const noDigest = signRequest({ method: 'POST', url, body: null, key: s.key });
  await rejects(v(noDigest), 'bad_signature'); // a body is present but not covered
});
