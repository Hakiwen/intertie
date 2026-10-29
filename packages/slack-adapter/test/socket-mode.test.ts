// The Socket Mode path (what the two-Slack demo uses), against the fake Slack's WebSocket.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, IntertieNode, type IntertieEvent } from '@intertie/core';
import { SlackAdapter } from '../src/index.ts';
import { FakeSlack } from './fake-slack.ts';
import { freePort, until } from '../../core/test/helpers.ts';

const cleanup: (() => Promise<void>)[] = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

test('socket mode: slash-command share, messages both ways, reconnect', async () => {
  const slack = new FakeSlack();
  await slack.start();
  cleanup.push(() => slack.stop());
  const T = slack.addTeam('SOCK', { UADM: { name: 'Admin', admin: true } }, ['CS']);
  T.appToken = 'xapp-fake-SOCK';
  const port = await freePort();
  const org = `localhost:${port}`;
  const ad = new SlackAdapter({
    node: { org, endpoint: `http://${org}/intertie`, keys: [generateKey('k1')], devInsecure: true, retryBaseMs: 20, retryCapMs: 200 },
    slack: { botToken: T.token, appToken: T.appToken, apiUrl: slack.apiUrl },
  });
  await ad.start(port);
  cleanup.push(() => ad.stop());
  await until(() => !!T.socket, 3000, 'socket connected');

  slack.slash(T, 'CS', 'UADM', 'share');
  await until(() => T.ephemeral.some((e) => e.text.includes('intertie:')), 3000, 'invite reply');
  const invite = /`(intertie:[^`]+)`/.exec(T.ephemeral.at(-1)!.text)![1];

  const p2 = await freePort();
  const native = new IntertieNode({ org: `localhost:${p2}`, endpoint: `http://localhost:${p2}/intertie`, keys: [generateKey('k1')], devInsecure: true, retryBaseMs: 20, retryCapMs: 200 });
  await native.listen(p2);
  native.start();
  cleanup.push(() => native.stop());
  const got: IntertieEvent[] = [];
  native.onEvent((e) => { got.push(e); });
  const ch = await native.accept(invite);

  slack.userPost(T, 'CS', 'UADM', 'hello over socket mode');
  await until(() => got.some((e) => e.type === 'message.create'), 3000, 'native receives');
  assert.equal((got.find((e) => e.type === 'message.create')!.body as { text: string }).text, 'hello over socket mode');

  slack.disconnect(T);
  await new Promise((r) => setTimeout(r, 150));
  await native.send(ch.id, { type: 'message.create', sender: { id: `n@${native.org}`, name: 'Nat' }, body: { text: 'and back' } });
  await until(() => slack.messages(T, 'CS').some((m) => m.text === 'and back'), 3000, 'Slack receives');
  slack.userPost(T, 'CS', 'UADM', 'after reconnect');
  await until(() => got.filter((e) => e.type === 'message.create').length === 3, 3000, 'events still flow after reconnect');
});
