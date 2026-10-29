// End to end: two Slack workspaces (fake), two adapters, one shared channel, no intermediary.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, IntertieNode } from '@intertie/core';
import { SlackAdapter } from '../src/index.ts';
import { FakeSlack, type Team } from './fake-slack.ts';
import { freePort, until } from '../../core/test/helpers.ts';

const slack = new FakeSlack();
let A: Team, B: Team, a: SlackAdapter, b: SlackAdapter;
const CA = 'CACME', CB = 'CGLOBEX';

async function adapter(t: Team): Promise<SlackAdapter> {
  const port = await freePort();
  const org = `localhost:${port}`;
  t.eventsUrl = `http://${org}/slack/events`;
  const ad = new SlackAdapter({
    node: { org, endpoint: `http://${org}/intertie`, keys: [generateKey('k1')], devInsecure: true, displayName: t.id, retryBaseMs: 20, retryCapMs: 200, pullWaitS: 1 },
    slack: { botToken: t.token, signingSecret: t.signingSecret, apiUrl: slack.apiUrl },
  });
  await ad.start(port);
  return ad;
}

const settle = () => until(() => slack.idle() && a.isIdle() && b.isIdle(), 8000, 'everything idle');
const settled = async () => { for (let i = 0; i < 3; i++) { await settle(); await new Promise((r) => setTimeout(r, 20)); } };
const remote = (t: Team, ch: string) => slack.messages(t, ch).filter((m) => m.bot_id && m.username);

before(async () => {
  await slack.start();
  A = slack.addTeam('ACME', { UANA: { name: 'Ana', admin: true }, UAL: { name: 'Al' } }, [CA, 'COTHER']);
  B = slack.addTeam('GLOBEX', { UGAIL: { name: 'Gail', admin: true }, UGUS: { name: 'Gus' } }, [CB]);
  a = await adapter(A);
  b = await adapter(B);
});
after(async () => { await a.stop(); await b.stop(); await slack.stop(); });

test('share and accept link the two Slack channels', async () => {
  assert.equal(await a.resolveChannel('#cacme'), CA);
  await assert.rejects(a.resolveChannel('#nope'), /no channel #nope/);
  const { invite } = await a.share('#cacme');
  assert.match(invite, /^intertie:localhost:\d+\/[A-Za-z0-9_-]+$/);
  await b.accept(invite, CB);
  await settled();
  assert.equal(a.status().links[0].participants[0], b.node.org);
  assert.ok(slack.messages(A, CA).some((m) => m.text.includes('joined this shared channel')));
  assert.ok(slack.messages(B, CB).some((m) => m.text.includes('now shared with')));
});

test('messages flow both ways with names, avatars and formatting', async () => {
  slack.userPost(A, CA, 'UANA', 'Hi *Globex*, see <https://docs.example/x|the docs> & ping <@UAL>');
  await settled();
  const [m] = remote(B, CB);
  assert.equal(m.username, `Ana (${a.node.org})`);
  assert.equal(m.icon_url, 'https://avatars.example/UANA.png');
  assert.equal(m.text, 'Hi *Globex*, see <https://docs.example/x|the docs> &amp; ping @Al');
  slack.userPost(B, CB, 'UGAIL', 'thanks _Ana_');
  await settled();
  assert.equal(remote(A, CA).at(-1)!.text, 'thanks _Ana_');
  assert.equal(remote(A, CA).at(-1)!.username, `Gail (${b.node.org})`);
  // Exactly one copy each way: the app's own posts are echoed by Slack and must be ignored.
  assert.equal(remote(A, CA).length, 1);
  assert.equal(remote(B, CB).length, 1);
});

test('threads, edits and deletes map to thread_ts, chat.update, chat.delete', async () => {
  const root = slack.userPost(A, CA, 'UANA', 'export job failed');
  await settled();
  const mirror = remote(B, CB).at(-1)!;
  // Gail replies in the thread of the mirrored message in Globex's Slack.
  const reply = slack.userPost(B, CB, 'UGAIL', 'on it', { thread_ts: mirror.ts });
  slack.parentMetadataChanged(B, CB, mirror.ts); // must not become an edit
  await settled();
  const replyInA = remote(A, CA).at(-1)!;
  assert.equal(replyInA.thread_ts, root, 'reply lands in the original thread in Acme');
  slack.userEdit(B, CB, reply, 'on it, ETA 5 min');
  await settled();
  assert.equal(slack.messages(A, CA).find((x) => x.ts === replyInA.ts)!.text, 'on it, ETA 5 min');
  assert.equal(slack.callsFor(A, 'chat.update').length, 1);
  slack.userDelete(A, CA, root);
  await settled();
  assert.ok(!slack.messages(B, CB).some((x) => x.ts === mirror.ts), 'mirror deleted in Globex');
  assert.equal(slack.callsFor(B, 'chat.update').length, 0, 'no edit loops');
});

test('reactions: remote users show as the app, reference-counted', async () => {
  const ts = slack.userPost(B, CB, 'UGAIL', 'deploying now');
  await settled();
  const mirror = remote(A, CA).at(-1)!;
  slack.userReact(A, CA, mirror.ts, 'UANA', 'eyes');
  slack.userReact(A, CA, mirror.ts, 'UAL', 'eyes');
  await settled();
  const orig = slack.messages(B, CB).find((x) => x.ts === ts)!;
  assert.deepEqual([...orig.reactions.get('eyes')!], [B.botUserId]);
  assert.equal(slack.callsFor(B, 'reactions.add').length, 1);
  slack.userReact(A, CA, mirror.ts, 'UANA', 'eyes', false);
  await settled();
  assert.equal(orig.reactions.get('eyes')!.size, 1, 'Al still reacts');
  slack.userReact(A, CA, mirror.ts, 'UAL', 'eyes', false);
  await settled();
  assert.equal(orig.reactions.get('eyes')!.size, 0);
  // Gail reacts on Ana's mirrored message in Globex: lands on Ana's original in Acme.
  const anaTs = slack.userPost(A, CA, 'UANA', 'shipped');
  await settled();
  slack.userReact(B, CB, remote(B, CB).at(-1)!.ts, 'UGAIL', 'tada');
  await settled();
  assert.ok(slack.messages(A, CA).find((x) => x.ts === anaTs)!.reactions.get('tada')!.has(A.botUserId));
});

test('files: small inline and large by signed reference', async () => {
  const small = Buffer.from('ERROR export timeout\n');
  const big = Buffer.alloc(400 * 1024, 0x61);
  slack.userPost(B, CB, 'UGAIL', 'logs attached', { files: [{ name: 'small.log', mimetype: 'text/plain', bytes: small }, { name: 'big.log', mimetype: 'text/plain', bytes: big }] });
  await settled();
  const uploaded = slack.messages(A, CA).filter((m) => m.files?.length).flatMap((m) => m.files!);
  assert.deepEqual(uploaded.map((f) => f.name), ['small.log', 'big.log']);
  assert.deepEqual(uploaded[0].bytes, small);
  assert.deepEqual(uploaded[1].bytes, big);
  assert.equal(remote(A, CA).at(-1)!.text, 'logs attached');
});

test('unlinked channels are never forwarded', async () => {
  const before = remote(B, CB).length;
  slack.userPost(A, 'COTHER', 'UANA', 'internal only: salaries');
  await settled();
  assert.equal(remote(B, CB).length, before);
});

test('a native Intertie org joins too, and cannot inject Slack markup', async () => {
  const port = await freePort();
  const org = `localhost:${port}`;
  const native = new IntertieNode({ org, endpoint: `http://${org}/intertie`, keys: [generateKey('k1')], devInsecure: true, retryBaseMs: 20, retryCapMs: 200 });
  await native.listen(port);
  native.start();
  try {
    const { invite, channel } = await a.share(CA);
    await native.accept(invite);
    await native.send(channel, { type: 'message.create', sender: { id: `mal@${org}`, name: 'Ana' }, body: { text: '<!channel> <@UANA> **urgent** [x](javascript:alert(1)) @Ana', mentions: [{ id: 'UANA@' + a.node.org, name: 'Ana' }] } });
    await until(() => remote(A, CA).some((m) => m.username?.includes(org)), 5000, 'native message in Slack A');
    const m = remote(A, CA).find((x) => x.username?.includes(org))!;
    assert.equal(m.username, `Ana (${org})`, 'the org is always shown next to the name');
    assert.equal(m.text, '&lt;!channel&gt; &lt;@UANA&gt; *urgent* [x](javascript:alert(1)) <@UANA>');
    await settled();
    assert.ok(remote(B, CB).some((x) => x.username === `Ana (${org})`), 'fanned out to Globex too');
    await native.leave(channel);
    await until(() => native.channel(channel)!.state === 'left', 5000, 'native left');
    await settled();
    assert.ok(slack.messages(A, CA).some((x) => x.text.includes(`*${org}* left`)));
  } finally { await native.stop(); }
});

test('slash command: non-admins are refused; admins get status', async () => {
  await (a as unknown as { onSlashCommand(p: object): Promise<void> }).onSlashCommand({ command: '/intertie', text: 'share', user_id: 'UAL', channel_id: 'COTHER' });
  assert.match(A.ephemeral.at(-1)!.text, /Only workspace admins/);
  await (a as unknown as { onSlashCommand(p: object): Promise<void> }).onSlashCommand({ command: '/intertie', text: 'status', user_id: 'UANA', channel_id: CA });
  assert.match(A.ephemeral.at(-1)!.text, /Shared channel `c-.*` \(home, open\)/);
});

test('the admin API is not reachable on the public endpoint port', async () => {
  const pub = await fetch(`http://${a.node.org}/admin/status`, { headers: { authorization: `Bearer ${a.adminToken}` } });
  assert.notEqual(pub.status, 200);
  const adm = await fetch(`http://127.0.0.1:${a.adminPort}/admin/status`, { headers: { authorization: `Bearer ${a.adminToken}` } });
  assert.equal(adm.status, 200);
  const bad = await fetch(`http://127.0.0.1:${a.adminPort}/admin/status`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.status, 401);
});

test('unshare closes the channel on both sides', async () => {
  await a.unshare(CA);
  await settled();
  assert.equal(a.status().links.length, 0);
  assert.equal(b.status().links.length, 0);
  assert.ok(slack.messages(B, CB).some((m) => m.text.includes('no longer shared')));
  const before = remote(B, CB).length;
  slack.userPost(A, CA, 'UANA', 'after unshare');
  await settled();
  assert.equal(remote(B, CB).length, before);
});
