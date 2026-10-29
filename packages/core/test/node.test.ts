import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { IntertieNode, type IntertieEvent } from '../src/index.ts';
import { devNode, settle, until, user } from './helpers.ts';

const nodes: IntertieNode[] = [];
after(async () => { await Promise.all(nodes.map((n) => n.stop())); });
async function make(name: string, extra = {}) { const n = await devNode(name, extra); nodes.push(n); return n; }

function recorder(n: IntertieNode) {
  const seen: IntertieEvent[] = [];
  n.onEvent((ev) => { seen.push(ev); });
  return seen;
}

test('two orgs: invite, accept, messages both ways in one order', async () => {
  const acme = await make('Acme');
  const globex = await make('Globex');
  const atA = recorder(acme), atG = recorder(globex);
  const ch = acme.createChannel({ name: 'acme-globex' });
  const joined = await globex.accept(acme.createInvite(ch.id));
  assert.equal(joined.id, ch.id);
  assert.equal(joined.role, 'peer');

  await acme.send(ch.id, { type: 'message.create', sender: user(acme, 'ana', 'Ana'), body: { text: 'Hi **Globex**' } });
  await globex.send(ch.id, { type: 'message.create', sender: user(globex, 'gail', 'Gail'), body: { text: 'hello from globex' } });
  await settle(acme, globex);

  const types = (l: IntertieEvent[]) => l.map((e) => `${e.seq}:${e.type}`);
  assert.deepEqual(types(atA), ['1:peer.join', '2:message.create', '3:message.create']);
  assert.deepEqual(types(atG), types(atA), 'peer sees exactly the home order');
  assert.equal(globex.channel(ch.id)!.seq, 3);
  assert.equal(acme.channel(ch.id)!.participants[0].org, globex.org);
});

test('edits, deletes, threads and their authorization', async () => {
  const acme = await make('Acme');
  const globex = await make('Globex');
  const atG = recorder(globex);
  const ch = acme.createChannel({ name: 'support' });
  await globex.accept(acme.createInvite(ch.id));
  const gail = user(globex, 'gail', 'Gail');
  const ana = user(acme, 'ana', 'Ana');
  const rejected: string[] = [];
  globex.onRejected((_ev, err) => rejected.push(err.code));

  const root = await globex.send(ch.id, { type: 'message.create', sender: gail, body: { text: 'export failed' } });
  await settle(acme, globex);
  await acme.send(ch.id, { type: 'message.create', sender: ana, body: { text: 'looking', thread: root.id } });
  await globex.send(ch.id, { type: 'message.edit', sender: gail, body: { target: root.id, text: 'export failed (again)' } });
  // Acme may not edit Gail's message, but as home may delete it (moderation).
  await settle(acme, globex);
  await assert.rejects(acme.send(ch.id, { type: 'message.edit', sender: ana, body: { target: root.id, text: 'x' } }), { code: 'not_author' });
  const anaMsg = await acme.send(ch.id, { type: 'message.create', sender: ana, body: { text: 'mine' } });
  await settle(acme, globex);
  // Globex may not delete Acme's message.
  await globex.send(ch.id, { type: 'message.delete', body: { target: anaMsg.id } });
  // A reply to a reply is not a thread root.
  const reply = atG.find((e) => e.type === 'message.create' && (e.body as { thread?: string }).thread)!;
  await globex.send(ch.id, { type: 'message.create', sender: gail, body: { text: 'nested', thread: reply.id } });
  await settle(acme, globex);
  assert.deepEqual(rejected, ['not_author', 'invalid_event']);
  await acme.send(ch.id, { type: 'message.delete', body: { target: root.id } });
  await settle(acme, globex);
  assert.deepEqual(atG.map((e) => e.type), ['peer.join', 'message.create', 'message.create', 'message.edit', 'message.create', 'message.delete']);
});

test('the home rejects impersonation and non-participants', async () => {
  const acme = await make('Acme');
  const globex = await make('Globex');
  const mallory = await make('Mallory');
  const ch = acme.createChannel({ name: 'x' });
  await globex.accept(acme.createInvite(ch.id));
  const codes: string[] = [];
  globex.onRejected((_e, err) => codes.push(err.code));
  mallory.onRejected((_e, err) => codes.push(err.code));
  // Globex claims an Acme user as sender: structurally invalid (sender must belong to origin).
  await assert.rejects(globex.send(ch.id, { type: 'message.create', sender: { id: `ana@${acme.org}`, name: 'Ana' }, body: { text: 'hi' } }), { code: 'bad_origin' });
  // Mallory is not in the channel: fake a local peer channel row so it submits.
  mallory.store.insertChannel({ id: ch.id, home: acme.org, role: 'peer', name: 'x', topic: '', seq: 0, delivery: 'push', state: 'open', created: new Date().toISOString() });
  await mallory.send(ch.id, { type: 'message.create', sender: user(mallory, 'm'), body: { text: 'let me in' } });
  // An invite is single-use.
  const inv = acme.createInvite(ch.id);
  await (await make('Initech')).accept(inv);
  await assert.rejects(mallory.accept(inv), { code: 'invalid_invite' });
  // A bound invite only works for its org.
  await assert.rejects(mallory.accept(acme.createInvite(ch.id, { boundOrg: globex.org })), { code: 'invalid_invite' });
  await settle(acme, globex, mallory);
  assert.deepEqual(codes, ['not_participant']);
  assert.equal(acme.channel(ch.id)!.participants.length, 2);
});

test('three orgs: home fans out; a pull-only peer keeps up', async () => {
  const acme = await make('Acme');
  const globex = await make('Globex');
  const initech = await make('Initech', { delivery: 'pull' });
  const atI = recorder(initech);
  const ch = acme.createChannel({ name: 'tri' });
  await globex.accept(acme.createInvite(ch.id));
  await initech.accept(acme.createInvite(ch.id));
  assert.equal(acme.channel(ch.id)!.participants.find((p) => p.org === initech.org)!.delivery, 'pull');
  await globex.send(ch.id, { type: 'message.create', sender: user(globex, 'g'), body: { text: 'from globex' } });
  await initech.send(ch.id, { type: 'message.create', sender: user(initech, 'i'), body: { text: 'from initech' } });
  await until(() => atI.filter((e) => e.type === 'message.create').length === 2, 5000, 'pull peer receives');
  assert.deepEqual(new Set(atI.map((e) => e.origin)), new Set([acme.org, globex.org, initech.org]));
  assert.equal(initech.channel(ch.id)!.participants.length, 3, 'initech knows home + both peers');
});

test('a peer that was down catches up in order, with no duplicates', async () => {
  const acme = await make('Acme');
  const globex = await make('Globex');
  const atG = recorder(globex);
  const ch = acme.createChannel({ name: 'down' });
  await globex.accept(acme.createInvite(ch.id));
  await settle(acme, globex);
  // Simulate an outage: the peer rejects everything at the HTTP layer.
  const realHandle = globex.handle.bind(globex);
  let down = true;
  (globex as unknown as { handle: typeof realHandle }).handle = async (req, res) => {
    if (down) { res.writeHead(503).end(); return; }
    return realHandle(req, res);
  };
  // The server captured the old handler; route through a flag instead.
  const server = (globex as unknown as { server: import('node:http').Server }).server;
  server.removeAllListeners('request');
  server.on('request', (req, res) => { void (globex as unknown as { handle: typeof realHandle }).handle(req, res); });
  for (let i = 1; i <= 5; i++) await acme.send(ch.id, { type: 'message.create', sender: user(acme, 'a'), body: { text: `m${i}` } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(atG.filter((e) => e.type === 'message.create').length, 0);
  down = false;
  await settle(acme, globex);
  assert.deepEqual(atG.filter((e) => e.type === 'message.create').map((e) => (e.body as { text: string }).text), ['m1', 'm2', 'm3', 'm4', 'm5']);
});

test('gap at a peer is filled by pull', async () => {
  const acme = await make('Acme');
  const globex = await make('Globex');
  const atG = recorder(globex);
  const ch = acme.createChannel({ name: 'gap' });
  await globex.accept(acme.createInvite(ch.id));
  await settle(acme, globex);
  // Sequence two events at the home without pushing (pretend the push of seq 2 was lost)...
  const p = acme.store.participant(ch.id, globex.org)!;
  acme.store.updateParticipant(ch.id, globex.org, { delivery: 'pull' });
  await acme.send(ch.id, { type: 'message.create', sender: user(acme, 'a'), body: { text: 'lost' } });
  acme.store.updateParticipant(ch.id, globex.org, { delivery: 'push', cursor: p.cursor + 1 });
  // ...then push seq 3 normally. The peer buffers it and pulls seq 2.
  await acme.send(ch.id, { type: 'message.create', sender: user(acme, 'a'), body: { text: 'next' } });
  await settle(acme, globex);
  assert.deepEqual(atG.filter((e) => e.type === 'message.create').map((e) => e.seq), [2, 3]);
});

test('files: inline and by reference with a signed fetch', async () => {
  const acme = await make('Acme');
  const globex = await make('Globex');
  const outsider = await make('Outsider');
  const atA = recorder(acme);
  const ch = acme.createChannel({ name: 'files' });
  await globex.accept(acme.createInvite(ch.id));
  const small = Buffer.from('small log');
  const big = Buffer.alloc(300 * 1024, 7);
  const f1 = globex.storeFile(ch.id, small, { name: 'a.log', mime: 'text/plain' });
  const f2 = globex.storeFile(ch.id, big, { name: 'b.bin', mime: 'application/octet-stream' });
  assert.ok(f1.data && !f1.url);
  assert.ok(f2.url && !f2.data);
  await globex.send(ch.id, { type: 'message.create', sender: user(globex, 'g'), body: { text: '', files: [f1, f2] } });
  await settle(acme, globex);
  const ev = atA.find((e) => e.type === 'message.create')!;
  const files = (ev.body as { files: typeof f1[] }).files;
  assert.deepEqual(await acme.fetchFile(ev, files[0]), small);
  assert.deepEqual(await acme.fetchFile(ev, files[1]), big);
  await assert.rejects(outsider.fetchFile(ev, files[1]), { code: 'not_participant' });
  await assert.rejects(acme.fetchFile(ev, { ...files[1], sha256: files[0].sha256 }), { code: 'invalid_event' });
});

test('leave, remove and close', async () => {
  const acme = await make('Acme');
  const globex = await make('Globex');
  const initech = await make('Initech');
  const atG = recorder(globex);
  const ch = acme.createChannel({ name: 'life' });
  await globex.accept(acme.createInvite(ch.id));
  await initech.accept(acme.createInvite(ch.id));
  await globex.leave(ch.id);
  await settle(acme, globex, initech);
  assert.equal(globex.channel(ch.id)!.state, 'left');
  assert.equal(acme.store.participant(ch.id, globex.org)!.state, 'left');
  const before = atG.length;
  await acme.send(ch.id, { type: 'message.create', sender: user(acme, 'a'), body: { text: 'after leave' } });
  acme.removePeer(ch.id, initech.org);
  await settle(acme, globex, initech);
  assert.equal(atG.length, before, 'leaver gets nothing after its leave');
  assert.equal(initech.channel(ch.id)!.state, 'left');
  acme.closeChannel(ch.id, 'done');
  await assert.rejects(acme.send(ch.id, { type: 'message.create', sender: user(acme, 'a'), body: { text: 'x' } }), { code: 'channel_closed' });
});
