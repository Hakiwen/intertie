// The headline interop case: a Slack workspace and a Matrix room share one channel, each side
// run by its own org, with nobody in between.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey } from '@intertie/core';
import { SlackAdapter } from '../../slack-adapter/src/index.ts';
import { FakeSlack } from '../../slack-adapter/test/fake-slack.ts';
import { MatrixGateway } from '../src/index.ts';
import { FakeHomeserver } from './fake-homeserver.ts';
import { freePort, until } from '../../core/test/helpers.ts';

const cleanup: (() => Promise<void>)[] = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

test('Slack ⇄ Matrix: messages, threads, edits, reactions, deletes', async () => {
  const slack = new FakeSlack(); await slack.start(); cleanup.push(() => slack.stop());
  const hs = new FakeHomeserver(); await hs.start(); cleanup.push(() => hs.stop());
  const T = slack.addTeam('ACME', { UANA: { name: 'Ana', admin: true } }, ['CSUP']);
  const ps = await freePort(), pm = await freePort();
  T.eventsUrl = `http://localhost:${ps}/slack/events`;
  const sa = new SlackAdapter({
    node: { org: `localhost:${ps}`, endpoint: `http://localhost:${ps}/intertie`, keys: [generateKey('k1')], devInsecure: true, retryBaseMs: 20, retryCapMs: 200 },
    slack: { botToken: T.token, signingSecret: T.signingSecret, apiUrl: slack.apiUrl },
  });
  await sa.start(ps); cleanup.push(() => sa.stop());
  const reg = hs.registerAppService(`http://localhost:${pm}`);
  const mia = hs.addUser('mia', 'Mia');
  const room = hs.createRoom(mia.id, 'acme-support');
  const mg = new MatrixGateway({
    node: { org: `localhost:${pm}`, endpoint: `http://localhost:${pm}/intertie`, keys: [generateKey('k1')], devInsecure: true, retryBaseMs: 20, retryCapMs: 200 },
    matrix: { homeserver: hs.base, mode: 'appservice', asToken: reg.asToken, hsToken: reg.hsToken, serverName: hs.serverName },
  });
  await mg.start(pm); cleanup.push(() => mg.stop());
  const settle = async () => { for (let i = 0; i < 3; i++) { await until(() => slack.idle() && hs.idle() && sa.isIdle() && mg.isIdle(), 8000, 'idle'); await new Promise((r) => setTimeout(r, 20)); } };

  hs.invite(room, mia.id, hs.botId);
  await until(() => hs.rooms.get(room)!.members.get(hs.botId) === 'join', 3000, 'bot joined');
  const { invite } = await sa.share('CSUP');
  await mg.accept(invite, room);
  await settle();

  const ts = slack.userPost(T, 'CSUP', 'UANA', 'Hi *Matrix* folks');
  await settle();
  const inMx = hs.messages(room).find((e) => e.content.body === 'Hi **Matrix** folks')!;
  assert.equal(hs.users.get(inMx.sender)!.displayname, `Ana (localhost:${ps})`);
  assert.equal(inMx.content.formatted_body, 'Hi <strong>Matrix</strong> folks');

  hs.text(room, mia.id, 'hello from Matrix', { 'm.relates_to': { rel_type: 'm.thread', event_id: inMx.event_id, is_falling_back: true, 'm.in_reply_to': { event_id: inMx.event_id } } });
  await settle();
  const inSlack = slack.messages(T, 'CSUP').find((m) => m.text === 'hello from Matrix')!;
  assert.equal(inSlack.username, `Mia (localhost:${pm})`);
  assert.equal(inSlack.thread_ts, ts, 'Matrix thread reply lands in the Slack thread');

  slack.userEdit(T, 'CSUP', ts, 'Hi *Matrix* friends');
  hs.react(room, mia.id, inMx.event_id, '👀');
  await settle();
  assert.ok(hs.timeline(room).some((e) => e.content['m.new_content']?.body === 'Hi **Matrix** friends'));
  assert.ok(slack.messages(T, 'CSUP').find((m) => m.ts === ts)!.reactions.get('eyes')?.has(T.botUserId));

  slack.userDelete(T, 'CSUP', ts);
  await settle();
  assert.ok(!hs.timeline(room).some((e) => e.event_id === inMx.event_id), 'deleted in Slack → redacted in Matrix');
});
