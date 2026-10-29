#!/usr/bin/env node
// toy-chat: a tiny web chat that speaks Intertie natively, the "internal tool" stand-in.
// Local demo only: the web UI has no login, and the server binds to loopback.
//   node packages/toy-chat/src/server.ts --port 8721 --dev-insecure
import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { generateKey, IntertieError, IntertieNode, type IntertieEvent } from '@intertie/core';
import { PAGE } from './page.ts';

const { values } = parseArgs({ options: { port: { type: 'string' }, org: { type: 'string' }, endpoint: { type: 'string' }, state: { type: 'string' }, 'dev-insecure': { type: 'boolean' }, name: { type: 'string' } } });
const port = Number(values.port ?? 8721);
const dev = values['dev-insecure'] === true;
const org = values.org ?? (dev ? `localhost:${port}` : '');
if (!org) throw new Error('--org required outside --dev-insecure');
const state = values.state ?? `./state/toy-${port}`;
mkdirSync(state, { recursive: true, mode: 0o700 });
const keyFile = `${state}/key.json`;
if (!existsSync(keyFile)) writeFileSync(keyFile, JSON.stringify(generateKey('k1')), { mode: 0o600 });

const node = new IntertieNode({
  org, endpoint: values.endpoint ?? `${dev ? 'http' : 'https'}://${org}/intertie`, keys: [JSON.parse(readFileSync(keyFile, 'utf8'))],
  displayName: values.name ?? 'Toy Chat', capabilities: ['threads', 'reactions'], devInsecure: dev, store: `${state}/db.sqlite`,
});

// Server-sent events: every applied event goes to every open browser tab.
const tabs = new Set<import('node:http').ServerResponse>();
node.onEvent((ev) => { for (const t of tabs) t.write(`data: ${JSON.stringify(ev)}\n\n`); });

function history(channel: string): IntertieEvent[] {
  return node.store.eventsSince(channel, 0, 10_000);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const json = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b)); };
  try {
    if (url.pathname === '/' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:" }).end(PAGE); return; }
    if (!url.pathname.startsWith('/api/')) return void (await node.handle(req, res));
    // The chat UI API is for loopback browsers only.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return json(403, { error: 'loopback only' });
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      tabs.add(res);
      req.on('close', () => tabs.delete(res));
      return;
    }
    if (url.pathname === '/api/state') {
      return json(200, { org: node.org, channels: node.channels().map((c) => ({ ...c, events: history(c.id) })) });
    }
    const body = JSON.parse(await new Promise<string>((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s || '{}')); }));
    if (url.pathname === '/api/share') {
      const ch = node.createChannel({ name: String(body.name || 'shared').slice(0, 80) });
      return json(200, { channel: ch.id, invite: node.createInvite(ch.id) });
    }
    if (url.pathname === '/api/invite') return json(200, { invite: node.createInvite(body.channel) });
    if (url.pathname === '/api/accept') return json(200, { channel: (await node.accept(String(body.invite))).id });
    if (url.pathname === '/api/send') {
      const user = String(body.user || 'guest').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'guest';
      const ev = await node.send(body.channel, { type: body.type, sender: { id: `${user}@${node.org}`, name: String(body.name || user).slice(0, 80) }, body: body.body });
      return json(200, { id: ev.id, seq: ev.seq ?? null });
    }
    return json(404, { error: 'not found' });
  } catch (e) {
    return json(e instanceof IntertieError ? e.status : 500, { error: e instanceof IntertieError ? `${e.code}: ${e.message}` : String(e) });
  }
});

server.listen(port, '127.0.0.1', () => {
  node.start();
  process.stderr.write(`toy-chat: org ${node.org} · open http://127.0.0.1:${port}/${dev ? ' · DEV-INSECURE' : ''}\n`);
});
