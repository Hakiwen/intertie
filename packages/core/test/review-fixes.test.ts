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
