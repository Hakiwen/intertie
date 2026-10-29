// Teams adapter against the fake Teams/Bot Framework: auth, the full event mapping, commands, and Slack ⇄ Teams.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { generateKey, IntertieNode, type IntertieEvent } from '@intertie/core';
import { TeamsAdapter, teamsReactionToEmoji } from '../src/index.ts';
import { FakeTeams } from './fake-teams.ts';
import { SlackAdapter } from '../../slack-adapter/src/index.ts';
import { FakeSlack } from '../../slack-adapter/test/fake-slack.ts';
import { freePort, until } from '../../core/test/helpers.ts';

const cleanup: (() => Promise<void>)[] = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

async function teamsAdapter(t: FakeTeams, admins: string[] = []) {
  const port = await freePort(), tport = await freePort();
  const org = `localhost:${port}`;
  const ad = new TeamsAdapter({
    node: { org, endpoint: `http://${org}/intertie`, keys: [generateKey('k1')], devInsecure: true, retryBaseMs: 20, retryCapMs: 200, pullWaitS: 1 },
    teams: { appId: t.appId, appPassword: t.appPassword, tenantId: t.tenant, loginBase: t.base, openIdConfigUrl: t.openIdConfigUrl, serviceHosts: (h) => h.startsWith('127.0.0.1:'), admins },
  });
  await ad.start(port, tport);
  t.botUrl = `http://127.0.0.1:${tport}/api/messages`;
  cleanup.push(() => ad.stop());
  return ad;
}

async function nativeOrg() {
  const port = await freePort();
  const org = `localhost:${port}`;
  const node = new IntertieNode({ org, endpoint: `http://${org}/intertie`, keys: [generateKey('k1')], devInsecure: true, retryBaseMs: 20, retryCapMs: 200, pullWaitS: 1, capabilities: ['threads', 'reactions', 'files', 'mentions'] });
  await node.listen(port);
  node.start();
  cleanup.push(() => node.stop());
  const got: IntertieEvent[] = [];
  node.onEvent((e) => { got.push(e); });
  return { node, got, user: (l: string, n = l) => ({ id: `${l}@${org}`, name: n }) };
}
const body = (e: IntertieEvent) => e.body as Record<string, any>;

test('inbound activities must carry a valid Bot Framework JWT', async () => {
  const t = new FakeTeams(); await t.start(); cleanup.push(() => t.stop());
  await teamsAdapter(t);
  t.addUser('aad-ann', 'Ann');
  const act = { type: 'message', id: '1', channelId: 'msteams', serviceUrl: t.serviceUrl, conversation: { id: t.channel('x') }, from: { id: '29:aad-ann', aadObjectId: 'aad-ann' }, text: 'hi' };
  assert.equal(await t.deliver(act, 'not-a-jwt'), 401);
  assert.equal(await t.deliver(act, t.jwt({ aud: 'someone-else' })), 401);
  assert.equal(await t.deliver(act, t.jwt({ iss: 'https://evil.example' })), 401);
  assert.equal(await t.deliver(act, t.jwt({ serviceUrl: 'https://evil.example/' })), 401, 'serviceUrl claim must match the activity');
  assert.equal(await t.deliver(act, t.jwt({ exp: Math.floor(Date.now() / 1000) - 3600 })), 401);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal(await t.deliver(act, t.jwt({ key: privateKey })), 401, 'forged signature');
  assert.equal(await t.deliver({ ...act, channelId: 'webchat' }, t.jwt()), 403, 'key not endorsed for this channel');
  assert.equal(await t.deliver({ ...act, serviceUrl: 'https://attacker.example/', }, t.jwt({ serviceUrl: 'https://attacker.example/' })), 403, 'connector host allowlist');
  assert.equal(await t.deliver(act, t.jwt()), 200);
});

test('Teams ⇄ native org: messages, threads, mentions, edits, deletes, reactions, files, injection', async () => {
  const t = new FakeTeams(); await t.start(); cleanup.push(() => t.stop());
  const ad = await teamsAdapter(t);
  const nat = await nativeOrg();
  const settle = async () => { for (let i = 0; i < 3; i++) { await until(() => t.idle() && ad.isIdle() && nat.node.isIdle(), 8000, 'idle'); await new Promise((r) => setTimeout(r, 20)); } };
  t.addUser('aad-ann', 'Ann'); t.addUser('aad-bo', 'Bo');
  const C = t.channel('support');
  await t.install(C);
  await settle();
  const { invite } = await ad.share('support');
  const ch = await nat.node.accept(invite);
  await settle();
  assert.ok(t.botMessages(C).some((m) => m.html.includes('joined this shared channel')));

  // Teams → Intertie: HTML to Markdown, @mention of a colleague.
  await t.post(C, 'aad-bo', 'hello'); // Bo has spoken once, so the adapter knows Bo's Teams id
  const m1 = await t.post(C, 'aad-ann', '<p>Export <strong>failed</strong> again, <at>Bo</at></p>', { mentions: [{ aad: 'aad-bo' }] });
  await settle();
  const e1 = nat.got.filter((e) => e.type === 'message.create' && e.origin !== nat.node.org).at(-1)!;
  assert.equal(body(e1).text, 'Export **failed** again, @Bo');
  assert.deepEqual(body(e1).mentions, [{ id: `aad-bo@${ad.node.org}`, name: 'Bo' }]);
  assert.equal(e1.sender!.name, 'Ann');

  // Intertie → Teams: a byline (bots cannot post as someone else), escaped HTML, a real <at> mention, in the thread.
  const r1 = await nat.node.send(ch.id, { type: 'message.create', sender: nat.user('gail', 'Gail'), body: { text: 'on it **Bo** <script>x</script> @Bo', thread: e1.id, mentions: [{ id: `aad-bo@${ad.node.org}`, name: 'Bo' }] } });
  await settle();
  const b1 = t.botMessages(C).at(-1)!;
  assert.equal(b1.root, m1, 'posted into the thread of the Teams message');
  assert.equal(b1.html, `<b>Gail</b> <i>(${nat.node.org})</i><br>on it <strong>Bo</strong> &lt;script&gt;x&lt;/script&gt; <at>Bo</at>`);
  assert.deepEqual(b1.entities, [{ type: 'mention', text: '<at>Bo</at>', mentioned: { id: '29:aad-bo', name: 'Bo' } }]);

  // A Teams reply in the thread maps back to the Intertie thread.
  await t.post(C, 'aad-bo', 'thanks', { root: m1 });
  await settle();
  assert.equal(body(nat.got.filter((e) => e.type === 'message.create' && e.origin !== nat.node.org).at(-1)!).thread, e1.id);

  // Edits both ways.
  await t.edit(C, 'aad-ann', m1, '<p>Export failed (fixed now)</p>');
  await nat.node.send(ch.id, { type: 'message.edit', sender: nat.user('gail', 'Gail'), body: { target: r1.id, text: 'done' } });
  await settle();
  assert.equal(body(nat.got.find((e) => e.type === 'message.edit' && e.origin !== nat.node.org)!).text, 'Export failed (fixed now)');
  assert.equal(t.messages(C).find((m) => m.id === b1.id)!.html, `<b>Gail</b> <i>(${nat.node.org})</i><br>done`);

  // Reactions: Teams users react on the bot's post (a remote message); remote reactions show as a footer.
  await t.react(C, 'aad-ann', b1.id, 'like');
  await t.react(C, 'aad-bo', b1.id, '1f440_eyes');
  await settle();
  const rx = nat.got.filter((e) => e.type === 'reaction.add' && e.origin !== nat.node.org).map((e) => body(e).emoji);
  assert.deepEqual(rx, ['👍', '👀']);
  await nat.node.send(ch.id, { type: 'reaction.add', sender: nat.user('gail'), body: { target: r1.id, emoji: '🎉' } });
  await nat.node.send(ch.id, { type: 'reaction.add', sender: nat.user('gus'), body: { target: r1.id, emoji: '🎉' } });
  await settle();
  assert.ok(t.messages(C).find((m) => m.id === b1.id)!.html.endsWith('<br><i>🎉 2</i>'));

  // Files: a small image goes inline; other files become a note.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  await nat.node.send(ch.id, { type: 'message.create', sender: nat.user('gail', 'Gail'), body: { text: 'screens', files: [nat.node.storeFile(ch.id, png, { name: 'a.png', mime: 'image/png' }), nat.node.storeFile(ch.id, Buffer.from('log'), { name: 'b.log', mime: 'text/plain' })] } });
  await settle();
  const fm = t.botMessages(C).at(-1)!;
  assert.equal((fm.attachments as { contentUrl: string }[])[0].contentUrl, `data:image/png;base64,${png.toString('base64')}`);
  assert.match(fm.html, /b\.log \(3 bytes\): files from other organizations are not copied into Teams yet/);

  // Teams file reference → a link line.
  await t.post(C, 'aad-ann', 'report', { attachments: [{ contentType: 'reference', contentUrl: 'https://tenant.sharepoint.com/x.xlsx', name: 'x.xlsx' }] });
  await settle();
  assert.match(body(nat.got.filter((e) => e.type === 'message.create' && e.origin !== nat.node.org).at(-1)!).text, /📎 \[x\.xlsx\]\(https:\/\/tenant\.sharepoint\.com\/x\.xlsx\)/);

  // Deletes both ways.
  await nat.node.send(ch.id, { type: 'message.delete', body: { target: r1.id } });
  await t.remove(C, 'aad-ann', m1);
  await settle();
  assert.ok(t.messages(C).every((m) => m.id !== b1.id), 'bot post deleted');
  assert.ok(nat.got.some((e) => e.type === 'message.delete' && body(e).target === e1.id));
  // Exactly one token request for all those calls (cached).
  assert.equal(t.tokensIssued, 1);
});

test('@Intertie commands: only configured admins; share replies in the thread', async () => {
  const t = new FakeTeams(); await t.start(); cleanup.push(() => t.stop());
  const ad = await teamsAdapter(t, ['aad-owner']);
  t.addUser('aad-owner', 'Olive'); t.addUser('aad-guest', 'Gus');
  const C = t.channel('partners');
  await t.install(C);
  await t.post(C, 'aad-guest', 'share', { mentionBot: true });
  await until(() => t.botMessages(C).length === 1, 3000, 'refusal');
  assert.match(t.botMessages(C)[0].html, /Only configured admins/);
  await t.post(C, 'aad-owner', 'share', { mentionBot: true });
  await until(() => t.botMessages(C).length === 2, 3000, 'invite');
  assert.match(t.botMessages(C)[1].html, /<code>intertie:localhost:\d+\/[A-Za-z0-9_-]+<\/code>/);
  assert.equal(ad.status().links.length, 1);
});

test('reaction types map to emoji', () => {
  assert.equal(teamsReactionToEmoji('like'), '👍');
  assert.equal(teamsReactionToEmoji('1f440_eyes'), '👀');
  assert.equal(teamsReactionToEmoji('1f44d_1f3fd_thumbsup'), '👍🏽');
  assert.equal(teamsReactionToEmoji('custom-party'), ':custom-party:');
});

test('Slack ⇄ Teams: a Slack workspace and a Teams channel share one channel', async () => {
  const slack = new FakeSlack(); await slack.start(); cleanup.push(() => slack.stop());
  const t = new FakeTeams(); await t.start(); cleanup.push(() => t.stop());
  const S = slack.addTeam('ACME', { UANA: { name: 'Ana', admin: true } }, ['CSUP']);
  const ps = await freePort();
  S.eventsUrl = `http://localhost:${ps}/slack/events`;
  const sa = new SlackAdapter({
    node: { org: `localhost:${ps}`, endpoint: `http://localhost:${ps}/intertie`, keys: [generateKey('k1')], devInsecure: true, retryBaseMs: 20, retryCapMs: 200 },
    slack: { botToken: S.token, signingSecret: S.signingSecret, apiUrl: slack.apiUrl },
  });
  await sa.start(ps); cleanup.push(() => sa.stop());
  const ta = await teamsAdapter(t);
  const settle = async () => { for (let i = 0; i < 3; i++) { await until(() => slack.idle() && t.idle() && sa.isIdle() && ta.isIdle(), 8000, 'idle'); await new Promise((r) => setTimeout(r, 20)); } };
  t.addUser('aad-tom', 'Tom');
  const C = t.channel('acme-support');
  await t.install(C);
  const { invite } = await sa.share('CSUP');
  await ta.accept(invite, 'acme-support');
  await settle();

  const ts = slack.userPost(S, 'CSUP', 'UANA', 'Hi *Teams* folks');
  await settle();
  const inTeams = t.botMessages(C).find((m) => m.html.includes('Teams'))!;
  assert.equal(inTeams.html, `<b>Ana</b> <i>(localhost:${ps})</i><br>Hi <strong>Teams</strong> folks`);

  await t.post(C, 'aad-tom', '<p>hello from <em>Teams</em></p>', { root: inTeams.id });
  await settle();
  const inSlack = slack.messages(S, 'CSUP').find((m) => m.username?.startsWith('Tom'))!;
  assert.equal(inSlack.text, 'hello from _Teams_');
  assert.equal(inSlack.thread_ts, ts, 'the Teams thread reply lands in the Slack thread');

  await t.react(C, 'aad-tom', inTeams.id, 'heart');
  slack.userEdit(S, 'CSUP', ts, 'Hi *Teams* friends');
  await settle();
  assert.ok(slack.messages(S, 'CSUP').find((m) => m.ts === ts)!.reactions.get('heart')?.has(S.botUserId));
  assert.ok(t.messages(C).find((m) => m.id === inTeams.id)!.html.includes('Hi <strong>Teams</strong> friends'));

  slack.userDelete(S, 'CSUP', ts);
  await settle();
  assert.ok(!t.messages(C).some((m) => m.id === inTeams.id), 'deleted in Slack → deleted in Teams');
});
