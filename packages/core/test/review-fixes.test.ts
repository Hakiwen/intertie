// Regression tests for the 2026-10-29 security review findings.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, importPrivate, IntertieNode, NonceCache, signRequest, verifyRequest, safeFetch, type IntertieEvent } from '../src/index.ts';
import { devNode, settle, until, user } from './helpers.ts';

const nodes: IntertieNode[] = [];
after(async () => { await Promise.all(nodes.map((n) => n.stop())); });
async function make(name: string, extra = {}) { const n = await devNode(name, extra); nodes.push(n); return n; }

test('a late joiner cannot pull history from before its join', async () => {
  const acme = await make('Acme'), globex = await make('Globex'), initech = await make('Initech');
  const ch = acme.createChannel({ name: 'h' });
  await globex.accept(acme.createInvite(ch.id));
  await acme.send(ch.id, { type: 'message.create', sender: user(acme, 'a'), body: { text: 'SECRET pre-join' } });
  await initech.accept(acme.createInvite(ch.id));
  await settle(acme, globex, initech);
  const r = await (initech as unknown as { call: (m: string, u: string) => Promise<{ status: number; json: { events: IntertieEvent[] } }> })
    .call('GET', `${acme.endpoint}/channels/${encodeURIComponent(ch.id)}/events?since=0`);
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.json).includes('SECRET'), 'pre-join content leaked');
  assert.equal(r.json.events[0].type, 'peer.join');
});

test('deleted messages are purged from the home log', async () => {
  const acme = await make('Acme'), globex = await make('Globex');
  const ch = acme.createChannel({ name: 'p' });
  await globex.accept(acme.createInvite(ch.id));
  const m = await globex.send(ch.id, { type: 'message.create', sender: user(globex, 'g'), body: { text: 'oops password hunter2' } });
  await settle(acme, globex);
  await globex.send(ch.id, { type: 'message.edit', sender: user(globex, 'g'), body: { target: m.id, text: 'still hunter2' } });
  await globex.send(ch.id, { type: 'message.delete', body: { target: m.id } });
  await settle(acme, globex);
  for (const n of [acme, globex]) {
    const all = JSON.stringify(n.store.eventsSince(ch.id, 0, 100));
    assert.ok(!all.includes('hunter2'), `${n.org} still stores deleted text`);
  }
  // A purged shell still validates, so a later pull doesn't break.
  const initech = await make('Initech');
  await initech.accept(acme.createInvite(ch.id));
  await settle(acme, initech);
});

test('invites are single-use even for a removed org; a fresh invite rejoins and receives', async () => {
  const acme = await make('Acme'), globex = await make('Globex');
  const got: IntertieEvent[] = [];
  globex.onEvent((e) => { got.push(e); });
  const ch = acme.createChannel({ name: 'r' });
  const inv = acme.createInvite(ch.id);
  await globex.accept(inv);
  await settle(acme, globex);
  acme.removePeer(ch.id, globex.org);
  await settle(acme, globex);
  await assert.rejects(globex.accept(inv), { code: 'invalid_invite' });
  await globex.accept(acme.createInvite(ch.id));
  await acme.send(ch.id, { type: 'message.create', sender: user(acme, 'a'), body: { text: 'welcome back' } });
  await settle(acme, globex);
  assert.equal(globex.channel(ch.id)!.state, 'open');
  assert.ok(got.some((e) => (e.body as { text?: string }).text === 'welcome back'), 'rejoined peer receives new events');
});

test('forged requests cost no nonce memory and junk keyid orgs cause no fetch', async () => {
  const nonces = new NonceCache();
  let lookups = 0;
  const url = 'https://connect.acme.example/intertie/events';
  const body = Buffer.from('{}');
  for (let i = 0; i < 200; i++) {
    const h = signRequest({ method: 'POST', url, body, key: { keyid: 'evil.example#k', privateKey: importPrivate(generateKey('k')) } });
    await verifyRequest({ method: 'POST', url, headers: h, body, nonces, resolveKey: async () => { lookups++; return null; } }).catch(() => undefined);
  }
  assert.equal((nonces as unknown as { seen: Map<string, number> }).seen.size, 0);
  lookups = 0;
  const h = signRequest({ method: 'POST', url, body, key: { keyid: 'evil.example:6379#k', privateKey: importPrivate(generateKey('k')) } });
  await assert.rejects(verifyRequest({ method: 'POST', url, headers: h, body, nonces, resolveKey: async () => { lookups++; return null; }, isValidOrg: (o) => !o.includes(':') }), { code: 'bad_signature' });
  assert.equal(lookups, 0);
  // End to end: the node refuses such a keyid without any outbound fetch.
  const acme = await make('Acme');
  const r = await safeFetch(`${acme.endpoint}/events`, { method: 'POST', body, devInsecure: true, headers: { 'content-type': 'application/json', ...signRequest({ method: 'POST', url: `${acme.endpoint}/events`, body, key: { keyid: 'x.example/../admin?#k', privateKey: importPrivate(generateKey('k')) } }) } });
  assert.equal(r.status, 401);
  assert.match(r.body.toString(), /valid org name/);
});

test('independent-implementation feedback: batches fit the body limit; former peers learn nothing new; limit codes', async () => {
  const { fitBatch, validateEvent } = await import('../src/index.ts');
  const acme = await make('Acme'), globex = await make('Globex');
  const ch = acme.createChannel({ name: 'big' });
  await globex.accept(acme.createInvite(ch.id));
  await settle(acme, globex);
  // 100 maximum-size messages: one batch would be ~1.6 MB; the home must split by size.
  const got: string[] = [];
  globex.onEvent((e) => { if (e.type === 'message.create') got.push(e.id); });
  for (let i = 0; i < 100; i++) await acme.send(ch.id, { type: 'message.create', sender: user(acme, 'a'), body: { text: 'x'.repeat(16_000) } });
  await until(() => got.length === 100, 15_000, 'all 100 large messages delivered');
  const big = acme.store.eventsSince(ch.id, 0, 100);
  assert.ok(Buffer.byteLength(JSON.stringify({ events: fitBatch(big, undefined) })) <= 1024 * 1024);
  // A removed peer's pull reports a seq capped at its own removal.
  acme.removePeer(ch.id, globex.org);
  await settle(acme, globex);
  const leaveSeq = acme.store.participant(ch.id, globex.org)!.leave_seq!;
  await acme.send(ch.id, { type: 'message.create', sender: user(acme, 'a'), body: { text: 'after' } });
  const r = await (globex as unknown as { call: (m: string, u: string) => Promise<{ status: number; json: { seq: number } }> })
    .call('GET', `${acme.endpoint}/channels/${encodeURIComponent(ch.id)}/events?since=${leaveSeq}`);
  assert.equal(r.json.seq, leaveSeq);
  // Limits: over-long name → too_large; too much inline data in one event → too_large.
  const base = { id: '01JBDXQ4M6V2S9K3Y8T7R5N0PA', channel: 'c-1@acme.com', origin: 'globex.com', ts: '2026-10-29T19:03:00Z', type: 'message.create' };
  assert.throws(() => validateEvent({ ...base, sender: { id: 'u@globex.com', name: 'n'.repeat(81) }, body: { text: 'x' } }), { code: 'too_large' });
  const f = (i: number) => ({ id: `f${i}`, name: 'a', mime: 'x', size: 200 * 1024, sha256: 'A'.repeat(43), data: 'AA==' });
  assert.throws(() => validateEvent({ ...base, sender: { id: 'u@globex.com', name: 'n' }, body: { text: '', files: [f(1), f(2), f(3)] } }), { code: 'too_large' });
});
