// SlackHost: "Add to Slack" OAuth, many workspaces in one process, each its own Intertie org.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackHost, openToken, sealToken } from '../src/index.ts';
import { FakeSlack } from './fake-slack.ts';
import { freePort, until } from '../../core/test/helpers.ts';

const cleanup: (() => Promise<void>)[] = [];
after(async () => { for (const f of cleanup.reverse()) await f(); });

test('tokens are sealed per workspace (AES-GCM, team id bound)', () => {
  const k = randomBytes(32);
  const s = sealToken(k, 'T1', 'xoxb-secret');
  assert.equal(openToken(k, 'T1', s), 'xoxb-secret');
  assert.throws(() => openToken(k, 'T2', s), 'a sealed token cannot be moved to another workspace');
  assert.ok(!s.includes('xoxb'));
});

test('two workspaces install via OAuth into one host and share a channel', async () => {
  const slack = new FakeSlack(); await slack.start(); cleanup.push(() => slack.stop());
  const W1 = slack.addTeam('TACME', { UANA: { name: 'Ana', admin: true } }, ['C1']);
  const W2 = slack.addTeam('TGLOBEX', { UGAIL: { name: 'Gail', admin: true } }, ['C2']);
  const port = await freePort();
  const stateDir = mkdtempSync(join(tmpdir(), 'slackhost-'));
  const host = new SlackHost({
    clientId: slack.app.clientId, clientSecret: slack.app.clientSecret, signingSecret: slack.app.signingSecret,
    publicBase: `http://localhost:${port}`, orgSuffix: 'localhost', tokenKey: randomBytes(32).toString('base64'), stateDir,
    apiUrl: slack.apiUrl, authorizeUrl: `${slack.base}/oauth/v2/authorize`, devInsecure: true,
    endpointFor: (org) => `http://${org}/intertie`, nodeTuning: { retryBaseMs: 20, retryCapMs: 200, pullWaitS: 1 },
  });
  // Dev org names carry the port: <team>.localhost:<port>.
  (host as unknown as { orgFor: (t: string) => string }).orgFor = (t) => `${t.toLowerCase()}.localhost:${port}`;
  await host.start(port);
  cleanup.push(() => host.stop());
  for (const t of [W1, W2]) { t.signingSecret = slack.app.signingSecret; t.eventsUrl = `http://localhost:${port}/slack/events`; }

  // The "Add to Slack" flow: install link → Slack (simulated) → callback with code + state.
  const install = async (t: typeof W1) => {
    const r = await fetch(`http://localhost:${port}/slack/install`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location')!);
    assert.equal(loc.searchParams.get('client_id'), slack.app.clientId);
    assert.match(loc.searchParams.get('scope')!, /chat:write\.customize/);
    const cb = await fetch(`http://localhost:${port}/slack/oauth/callback?code=${slack.issueCode(t)}&state=${encodeURIComponent(loc.searchParams.get('state')!)}`);
    assert.equal(cb.status, 200, await cb.text());
  };
  await install(W1);
  await install(W2);
  // A forged or replayed-from-elsewhere state is refused.
  const bad = await fetch(`http://localhost:${port}/slack/oauth/callback?code=${slack.issueCode(W1)}&state=forged.state`);
  assert.equal(bad.status, 400);
  assert.deepEqual(host.workspaces().map((w) => w.org), [`tacme.localhost:${port}`, `tglobex.localhost:${port}`]);

  // Tokens are not stored in the clear; each workspace has its own key and database.
  const raw = readFileSync(join(stateDir, 'host.sqlite'));
  assert.ok(!raw.includes(Buffer.from('xoxb-')), 'no plaintext token at rest');
  assert.deepEqual(readdirSync(join(stateDir, 'ws')).sort(), ['TACME', 'TGLOBEX']);

  // Each workspace is a distinct org: discovery by Host.
  const d1 = await (await fetch(`http://tacme.localhost:${port}/.well-known/intertie`)).json() as { org: string; keys: { x: string }[] };
  const d2 = await (await fetch(`http://tglobex.localhost:${port}/.well-known/intertie`)).json() as { org: string; keys: { x: string }[] };
  assert.equal(d1.org, `tacme.localhost:${port}`);
  assert.notEqual(d1.keys[0].x, d2.keys[0].x);

  // Share between the two installed workspaces; messages flow through the same process, as two orgs.
  const a1 = host.adapter('TACME')!, a2 = host.adapter('TGLOBEX')!;
  const { invite } = await a1.share('C1');
  await a2.accept(invite, 'C2');
  const settle = () => until(() => slack.idle() && host.isIdle(), 8000, 'idle');
  await settle();
  slack.userPost(W1, 'C1', 'UANA', 'hello across workspaces');
  await settle();
  await until(() => slack.messages(W2, 'C2').some((m) => m.text === 'hello across workspaces'), 5000, 'delivered');
  assert.equal(slack.messages(W2, 'C2').find((m) => m.text === 'hello across workspaces')!.username, `Ana (tacme.localhost:${port})`);

  // Uninstall: the workspace leaves its channels and its token is dropped.
  slack.emitRaw(W2, { type: 'app_uninstalled' });
  await until(() => host.workspaces().length === 1, 5000, 'uninstalled');
  await until(() => a1.node.channel(a1.status().links[0].channel)!.participants.every((p) => p.state !== 'active'), 5000, 'peer left');
});
