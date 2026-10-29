// The reference implementation must pass its own conformance suite, in both roles.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, IntertieNode } from '@intertie/core';
import { runHomeSuite, runPeerSuite, serveIdentity, signReport, verifyReport, jcs, type Identity, type Report } from '../src/index.ts';
import { freePort } from '../../core/test/helpers.ts';

const closers: (() => Promise<void>)[] = [];
after(async () => { for (const c of closers) await c(); });

async function ident(name: string): Promise<Identity> {
  const port = await freePort();
  const key = generateKey('k1');
  const node = new IntertieNode({ org: `localhost:${port}`, endpoint: `http://localhost:${port}/intertie`, keys: [key], devInsecure: true, displayName: name, retryBaseMs: 20, retryCapMs: 200, pullWaitS: 1, capabilities: ['threads', 'reactions', 'files'] });
  const { id, server } = await serveIdentity(node, key, port);
  closers.push(async () => { await node.stop(); server.closeAllConnections(); server.close(); });
  return id;
}

test('reference home passes the home suite', async () => {
  const subject = await ident('subject');
  const ch = subject.node.createChannel({ name: 'conf' });
  const { results } = await runHomeSuite({ invite: subject.node.createInvite(ch.id), r1: await ident('r1'), r2: await ident('r2'), spawn: () => ident('x'), devInsecure: true });
  const failed = results.filter((r) => !r.pass);
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 1));
  const sec = results.filter((r) => r.level === 'security' && !r.skipped);
  assert.ok(sec.length >= 20, `ran ${sec.length} security tests`);
  assert.ok(results.filter((r) => !r.skipped).length >= 55, `ran ${results.length}`);
});

test('reference peer passes the peer suite', async () => {
  const subject = await ident('subject');
  const { results, subjectOrg } = await runPeerSuite({
    home: await ident('home'), r2: await ident('r2'), devInsecure: true,
    onInvite: (inv) => { void subject.node.accept(inv); },
  });
  assert.equal(subjectOrg, subject.node.org);
  const failed = results.filter((r) => !r.pass);
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 1));
  assert.ok(results.filter((r) => !r.skipped).length >= 7);
});

test('a broken home fails the right tests', async () => {
  const subject = await ident('lax');
  // Break replay protection: forget every nonce.
  (subject.node as unknown as { nonces: object }).nonces = { has: () => false, remember: () => undefined };
  const ch = subject.node.createChannel({ name: 'lax' });
  const { results } = await runHomeSuite({ invite: subject.node.createInvite(ch.id), r1: await ident('r1'), devInsecure: true });
  assert.deepEqual(results.filter((r) => !r.pass).map((r) => r.id), ['core.sig.replay']);
});

test('reports are signed by the subject key and verifiable from its discovery document', async () => {
  const subject = await ident('signer');
  const report: Report = {
    intertie_report: '0.1', subject: { org: subject.node.org, endpoint: subject.node.endpoint }, runner: { name: 'x', version: '0' },
    date: '2026-10-29T20:00:00Z', claim: { roles: ['home'], levels: ['core'] }, results: [], passed: true,
  };
  const signed = signReport(report, `${subject.node.org}#${subject.key.kid}`, subject.key);
  assert.deepEqual(await verifyReport(signed, { devInsecure: true }), { ok: true });
  assert.equal((await verifyReport({ ...signed, passed: false }, { devInsecure: true })).ok, false);
  const other = generateKey('k1');
  assert.equal((await verifyReport(signReport(report, `${subject.node.org}#k1`, other), { devInsecure: true })).reason, 'bad signature');
});

test('JCS canonicalization (RFC 8785 examples)', () => {
  assert.equal(jcs({ b: 1, a: [true, null, 'x'], c: { z: 'é', y: -0 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":"é"}}');
  assert.equal(jcs({ '\u20ac': 1, '\r': 2, '\ufb33': 3, '1': 4, '\u00e9': 5 }), '{"\\r":2,"1":4,"\u00e9":5,"\u20ac":1,"\ufb33":3}');
});
