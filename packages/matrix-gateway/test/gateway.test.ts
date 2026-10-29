// Matrix gateway end to end against the fake homeserver: appservice mode, bot mode, and Slack ⇄ Matrix.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, IntertieNode, type IntertieEvent } from '@intertie/core';
import { MatrixGateway } from '../src/index.ts';
import { FakeHomeserver } from './fake-homeserver.ts';
import { freePort, until } from '../../core/test/helpers.ts';

const cleanup: (() => Promise<void>)[] = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

async function nativeOrg(name: string) {
  const port = await freePort();
  const org = `localhost:${port}`;
  const node = new IntertieNode({ org, endpoint: `http://${org}/intertie`, keys: [generateKey('k1')], devInsecure: true, displayName: name, retryBaseMs: 20, retryCapMs: 200, pullWaitS: 1 });
  await node.listen(port);
  node.start();
  cleanup.push(() => node.stop());
  const got: IntertieEvent[] = [];
  node.onEvent((e) => { got.push(e); });
  return { node, got, user: (local: string, n = local) => ({ id: `${local}@${org}`, name: n }) };
}

const bodyOf = (e: IntertieEvent) => e.body as Record<string, any>;

test('appservice mode: ghosts, threads, edits, redactions, reactions, files, loop prevention', async () => {
  const hs = new FakeHomeserver();
  await hs.start();
  cleanup.push(() => hs.stop());
  const port = await freePort();
  const org = `localhost:${port}`;
  const reg = hs.registerAppService(`http://${org}`);
  const alice = hs.addUser('alice', 'Alice');
  const carol = hs.addUser('carol', 'Carol');
  const room = hs.createRoom(alice.id, 'support');
  hs.rooms.get(room)!.members.set(carol.id, 'join');
  const gw = new MatrixGateway({
    node: { org, endpoint: `http://${org}/intertie`, keys: [generateKey('k1')], devInsecure: true, retryBaseMs: 20, retryCapMs: 200, pullWaitS: 1 },
    matrix: { homeserver: hs.base, mode: 'appservice', asToken: reg.asToken, hsToken: reg.hsToken, serverName: hs.serverName },
  });
  await gw.start(port);
  cleanup.push(() => gw.stop());
  const settle = async () => { for (let i = 0; i < 3; i++) { await until(() => hs.idle() && gw.isIdle() && nat.node.isIdle(), 8000, 'idle'); await new Promise((r) => setTimeout(r, 20)); } };
  const nat = await nativeOrg('Globex');

  // A room admin invites the bot; it joins by itself. A non-moderator cannot share.
  hs.invite(room, alice.id, hs.botId);
  await until(() => hs.rooms.get(room)!.members.get(hs.botId) === 'join', 3000, 'bot joined');
  hs.text(room, carol.id, '!intertie share');
  await settle();
  assert.match(hs.timeline(room).at(-1)!.content.body, /Only room moderators/);
  hs.text(room, alice.id, '!intertie share');
  await settle();
  const invite = /(intertie:\S+)/.exec(hs.timeline(room).at(-1)!.content.body)![1];
  const ch = await nat.node.accept(invite);
  await settle();
  assert.ok(hs.timeline(room).some((e) => e.content.body?.includes('joined this shared room')));

  // Matrix → Intertie, with formatting and a pill.
  const a1 = hs.text(room, alice.id, 'hello world @Carol', { format: 'org.matrix.custom.html', formatted_body: 'hello <strong>world</strong> <a href="https://matrix.to/#/@carol:hs.test">Carol</a>' });
  await settle();
  const m1 = nat.got.find((e) => e.type === 'message.create')!;
  assert.equal(bodyOf(m1).text, 'hello **world** @Carol');
  assert.equal(m1.sender!.name, 'Alice');
  assert.match(m1.sender!.id, /^alice-[0-9a-f]{8}@localhost:\d+$/);
  assert.equal(bodyOf(m1).mentions[0].name, 'Carol');

  // Intertie → Matrix: the remote user becomes a ghost with their own display name.
  const r1 = await nat.node.send(ch.id, { type: 'message.create', sender: nat.user('gail', 'Gail'), body: { text: 'on it, **Alice** <script>', thread: m1.id } });
  await settle();
  const gEv = hs.messages(room).find((e) => e.content.body === 'on it, **Alice** <script>')!;
  assert.ok(gEv.sender.startsWith('@intertie_'), `sent by ghost ${gEv.sender}`);
  assert.equal(hs.users.get(gEv.sender)!.displayname, `Gail (${nat.node.org})`);
  assert.equal(gEv.content.formatted_body, 'on it, <strong>Alice</strong> &lt;script&gt;');
  assert.equal(gEv.content['m.relates_to'].rel_type, 'm.thread');
  assert.equal(gEv.content['m.relates_to'].event_id, a1);

  // A pill to a ghost mentions the remote person by their own Intertie id.
  hs.text(room, alice.id, 'ping Gail', { format: 'org.matrix.custom.html', formatted_body: `ping <a href="https://matrix.to/#/${gEv.sender}">Gail (${nat.node.org})</a>` });
  await settle();
  const ping = nat.got.filter((e) => e.type === 'message.create' && e.origin === gw.node.org).at(-1)!;
  assert.equal(bodyOf(ping).mentions[0].id, `gail@${nat.node.org}`);

  // A Matrix thread reply maps back into the same Intertie thread.
  hs.text(room, alice.id, 'thanks', { 'm.relates_to': { rel_type: 'm.thread', event_id: a1, is_falling_back: true, 'm.in_reply_to': { event_id: gEv.event_id } } });
  await settle();
  assert.equal(bodyOf(nat.got.filter((e) => e.type === 'message.create').at(-1)!).thread, m1.id);

  // Edits both ways.
  hs.edit(room, alice.id, a1, 'hello everyone');
  await nat.node.send(ch.id, { type: 'message.edit', sender: nat.user('gail', 'Gail'), body: { target: r1.id, text: 'on it (ETA 5m)' } });
  await settle();
  assert.equal(bodyOf(nat.got.find((e) => e.type === 'message.edit' && e.origin === gw.node.org)!).text, 'hello everyone');
  const editEv = hs.timeline(room).find((e) => e.content['m.relates_to']?.rel_type === 'm.replace' && e.sender === gEv.sender)!;
  assert.equal(editEv.content['m.new_content'].body, 'on it (ETA 5m)');
  assert.equal(editEv.content['m.relates_to'].event_id, gEv.event_id);

  // Reactions: remote reactions are real reactions by each ghost; local ones map back.
  await nat.node.send(ch.id, { type: 'reaction.add', sender: nat.user('gail', 'Gail'), body: { target: m1.id, emoji: '👀' } });
  await nat.node.send(ch.id, { type: 'reaction.add', sender: nat.user('gus', 'Gus'), body: { target: m1.id, emoji: '👀' } });
  await settle();
  const rx = hs.timeline(room).filter((e) => e.type === 'm.reaction' && e.content['m.relates_to'].event_id === a1);
  assert.equal(rx.length, 2);
  assert.equal(new Set(rx.map((e) => e.sender)).size, 2, 'two different ghosts');
  await nat.node.send(ch.id, { type: 'reaction.remove', sender: nat.user('gus', 'Gus'), body: { target: m1.id, emoji: '👀' } });
  const aliceRx = hs.react(room, alice.id, gEv.event_id, '🎉');
  await settle();
  assert.equal(hs.timeline(room).filter((e) => e.type === 'm.reaction' && e.content['m.relates_to'].event_id === a1).length, 1);
  assert.ok(nat.got.some((e) => e.type === 'reaction.add' && bodyOf(e).emoji === '🎉' && bodyOf(e).target === r1.id));
  hs.redact(room, alice.id, aliceRx);
  await settle();
  assert.ok(nat.got.some((e) => e.type === 'reaction.remove' && bodyOf(e).emoji === '🎉'));

  // Files both ways.
  const bytes = Buffer.from('%PDF-1.7 pretend');
  hs.send(room, alice.id, { msgtype: 'm.file', body: 'invoice.pdf', filename: 'invoice.pdf', url: hs.upload(bytes, 'application/pdf'), info: { mimetype: 'application/pdf', size: bytes.length } });
  await settle();
  const fEv = nat.got.find((e) => bodyOf(e).files)!;
  assert.deepEqual(await nat.node.fetchFile(fEv, bodyOf(fEv).files[0]), bytes);
  const big = Buffer.alloc(300 * 1024, 1);
  await nat.node.send(ch.id, { type: 'message.create', sender: nat.user('gail', 'Gail'), body: { text: '', files: [nat.node.storeFile(ch.id, big, { name: 'dump.bin', mime: 'application/octet-stream' })] } });
  await settle();
  const fileMsg = hs.messages(room).find((e) => e.content.msgtype === 'm.file' && e.content.body === 'dump.bin')!;
  assert.deepEqual(hs.media.get(fileMsg.content.url.split('/').pop())!.bytes, big);

  // Deletes both ways.
  await nat.node.send(ch.id, { type: 'message.delete', body: { target: r1.id } });
  hs.redact(room, alice.id, a1);
  await settle();
  assert.ok(!hs.timeline(room).some((e) => e.event_id === gEv.event_id), 'ghost message redacted');
  assert.ok(nat.got.some((e) => e.type === 'message.delete' && bodyOf(e).target === m1.id));

  // Users on other servers are not vouched for; ghosts and the bot never echo back.
  const bob = hs.addUser('bob', 'Bob', 'other.test');
  hs.rooms.get(room)!.members.set(bob.id, 'join');
  const before = nat.got.filter((e) => e.type === 'message.create').length;
  hs.text(room, bob.id, 'from another server');
  await settle();
  assert.equal(nat.got.filter((e) => e.type === 'message.create').length, before);
  assert.ok(hs.timeline(room).some((e) => e.content.body?.includes('only vouches for users on hs.test')));
  const creates = nat.got.filter((e) => e.type === 'message.create' && e.origin === gw.node.org).length;
  assert.equal(creates, 4, 'exactly the four Matrix-side messages (hello, ping, thanks, file) crossed over');

  // Encrypted rooms are refused.
  const enc = hs.createRoom(alice.id, 'secret', { encrypted: true });
  hs.invite(enc, alice.id, hs.botId);
  await settle();
  hs.text(enc, alice.id, '!intertie share');
  await settle();
  assert.match(hs.timeline(enc).at(-1)!.content.body, /end-to-end encrypted/);
});

test('bot mode: one account on someone else’s homeserver, via /sync', async () => {
  const hs = new FakeHomeserver();
  await hs.start();
  cleanup.push(() => hs.stop());
  const alice = hs.addUser('alice', 'Alice');
  const bot = hs.addUser('intertie-bot', 'Intertie');
  const room = hs.createRoom(alice.id, 'partners');
  const port = await freePort();
  const org = `localhost:${port}`;
  const gw = new MatrixGateway({
    node: { org, endpoint: `http://${org}/intertie`, keys: [generateKey('k1')], devInsecure: true, retryBaseMs: 20, retryCapMs: 200, pullWaitS: 1 },
    matrix: { homeserver: hs.base, mode: 'bot', accessToken: bot.token },
  });
  await gw.start(port);
  cleanup.push(() => gw.stop());
  const nat = await nativeOrg('Globex');
  const settle = async () => { for (let i = 0; i < 3; i++) { await until(() => gw.isIdle() && nat.node.isIdle(), 8000, 'idle'); await new Promise((r) => setTimeout(r, 150)); } };
  await new Promise((r) => setTimeout(r, 200)); // initial sync
  hs.invite(room, alice.id, bot.id);
  await until(() => hs.rooms.get(room)!.members.get(bot.id) === 'join', 5000, 'bot joined via sync invite');
  const { invite } = await gw.share(room);
  const ch = await nat.node.accept(invite);
  await settle();

  hs.text(room, alice.id, 'hi from matrix');
  await settle();
  assert.equal(bodyOf(nat.got.find((e) => e.type === 'message.create')!).text, 'hi from matrix');
  await nat.node.send(ch.id, { type: 'message.create', sender: nat.user('gail', 'Gail'), body: { text: 'hi **back**' } });
  await settle();
  const m = hs.messages(room).find((e) => e.sender === bot.id && e.content.body?.includes('hi **back**'))!;
  assert.equal(m.content.body, `Gail (${nat.node.org}): hi **back**`);
  assert.equal(m.content.formatted_body, `<strong>Gail (${nat.node.org})</strong>: hi <strong>back</strong>`);
  assert.equal(m.content['com.beeper.per_message_profile'].displayname, `Gail (${nat.node.org})`);
  const target = nat.got.find((e) => e.type === 'message.create')!.id;
  await nat.node.send(ch.id, { type: 'reaction.add', sender: nat.user('gail'), body: { target, emoji: '👍' } });
  await nat.node.send(ch.id, { type: 'reaction.add', sender: nat.user('gus'), body: { target, emoji: '👍' } });
  await settle();
  assert.equal(hs.timeline(room).filter((e) => e.type === 'm.reaction').length, 1, 'one bot reaction, reference-counted');
  assert.equal(nat.got.filter((e) => e.type === 'message.create' && e.origin === gw.node.org).length, 1, 'bot posts are not echoed');
});
