// OPT-IN: runs only against a real homeserver. Bot mode needs no homeserver config:
//   MATRIX_IT_HOMESERVER=https://hs.example MATRIX_IT_BOT_TOKEN=… MATRIX_IT_USER_TOKEN=… \
//   node --test packages/matrix-gateway/test/integration.test.ts
// The two tokens belong to two accounts on that homeserver (the gateway's bot, and a human stand-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, IntertieNode, type IntertieEvent } from '@intertie/core';
import { MatrixApi, MatrixGateway } from '../src/index.ts';
import { freePort, until } from '../../core/test/helpers.ts';

const hsUrl = process.env.MATRIX_IT_HOMESERVER, botToken = process.env.MATRIX_IT_BOT_TOKEN, userToken = process.env.MATRIX_IT_USER_TOKEN;

test('real homeserver, bot mode: a message each way', { skip: !(hsUrl && botToken && userToken) && 'set MATRIX_IT_HOMESERVER, MATRIX_IT_BOT_TOKEN, MATRIX_IT_USER_TOKEN' }, async () => {
  const user = new MatrixApi({ homeserver: hsUrl!, token: userToken! });
  const bot = new MatrixApi({ homeserver: hsUrl!, token: botToken! });
  const botId = (await bot.whoami()).user_id;
  const { room_id: room } = await user.req<{ room_id: string }>('POST', '/_matrix/client/v3/createRoom', { name: `intertie-it-${Date.now()}`, preset: 'private_chat', invite: [botId] });
  const pg = await freePort(), pn = await freePort();
  const gw = new MatrixGateway({
    node: { org: `localhost:${pg}`, endpoint: `http://localhost:${pg}/intertie`, keys: [generateKey('k1')], devInsecure: true },
    matrix: { homeserver: hsUrl!, mode: 'bot', accessToken: botToken!, localServers: [botId.slice(botId.indexOf(':') + 1)] },
  });
  await gw.start(pg);
  const nat = new IntertieNode({ org: `localhost:${pn}`, endpoint: `http://localhost:${pn}/intertie`, keys: [generateKey('k1')], devInsecure: true });
  await nat.listen(pn); nat.start();
  const got: IntertieEvent[] = [];
  nat.onEvent((e) => { got.push(e); });
  try {
    await bot.join(room);
    const { invite } = await gw.share(room);
    const ch = await nat.accept(invite);
    await user.send(room, 'm.room.message', `it-${Date.now()}`, { msgtype: 'm.text', body: 'hello from a real homeserver' });
    await until(() => got.some((e) => (e.body as { text?: string }).text === 'hello from a real homeserver'), 30_000, 'message reaches the native peer');
    await nat.send(ch.id, { type: 'message.create', sender: { id: `n@${nat.org}`, name: 'Native' }, body: { text: 'and back' } });
    await until(async () => {
      const r = await user.req<{ chunk: { content: { body?: string } }[] }>('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages`, undefined, { query: { dir: 'b', limit: '20' } });
      return r.chunk.some((e) => e.content.body?.endsWith('and back'));
    }, 30_000, 'reply visible in Matrix');
    assert.ok(true);
  } finally {
    await gw.stop(); await nat.stop();
    await user.leave(room).catch(() => undefined);
  }
});
