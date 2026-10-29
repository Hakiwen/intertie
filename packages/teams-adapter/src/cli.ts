#!/usr/bin/env node
// intertie-teams: run the Teams adapter, build its Teams app package, manage shared channels.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { loadAdminToken, loadOrCreateKey, makeLogger, readAdmin, saveAdmin } from '@intertie/core';
import { appPackage } from './app-package.ts';
import { TeamsAdapter } from './adapter.ts';

const USAGE = `intertie-teams: share Microsoft Teams channels with other organizations over Intertie

  intertie-teams package [--env FILE] [--out FILE] [--manifest-version 1.25]
      builds the Teams app package (manifest + icons, zip) for TEAMS_APP_ID and TEAMS_PUBLIC_URL
  intertie-teams serve   [--env FILE] [--dev-insecure] [--verbose]
      Intertie endpoint on INTERTIE_PORT; the Bot Framework messaging endpoint (/api/messages) on
      TEAMS_PORT, loopback, to be published by your reverse proxy or tunnel at TEAMS_PUBLIC_URL
  intertie-teams share   <channel name | 19:…@thread.tacv2> [--state DIR]   prints an invite
  intertie-teams accept  <invite> <channel> [--state DIR]
  intertie-teams unshare <channel> [--state DIR]
  intertie-teams status  [--state DIR]

Environment: TEAMS_APP_ID, TEAMS_TENANT_ID, TEAMS_APP_PASSWORD (client secret), TEAMS_PUBLIC_URL
(the public https base that Teams calls at /api/messages), INTERTIE_* as for the other adapters.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { env: { type: 'string' }, out: { type: 'string' }, 'manifest-version': { type: 'string' }, 'dev-insecure': { type: 'boolean' }, state: { type: 'string' }, verbose: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
});
if (values.env) process.loadEnvFile(values.env);
const env = process.env;

const dev = values['dev-insecure'] === true;
const port = Number(env.INTERTIE_PORT ?? 8714);
const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
const org = () => env.INTERTIE_ORG ?? (dev ? `localhost:${port}` : need('INTERTIE_ORG'));
const stateDir = () => resolve(values.state ?? env.INTERTIE_STATE_DIR ?? `./state/teams-${org().replace(/[^A-Za-z0-9.-]/g, '_')}`);

async function admin(path: string, body?: unknown): Promise<unknown> {
  const a = readAdmin(stateDir());
  const r = await fetch(`http://127.0.0.1:${a.port}/admin/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json() as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

async function main(): Promise<void> {
  const [cmd, ...args] = positionals;
  if (cmd === 'serve') {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ad = new TeamsAdapter({
      node: {
        org: org(), endpoint: env.INTERTIE_ENDPOINT ?? `${dev ? 'http' : 'https'}://${org()}/intertie`, keys: [loadOrCreateKey(dir)], devInsecure: dev,
        displayName: env.INTERTIE_DISPLAY_NAME, contact: env.INTERTIE_CONTACT, store: join(dir, 'intertie.sqlite'), log: makeLogger(dir, values.verbose),
      },
      teams: {
        appId: need('TEAMS_APP_ID'), appPassword: need('TEAMS_APP_PASSWORD'), tenantId: need('TEAMS_TENANT_ID'),
        admins: env.TEAMS_ADMINS ? env.TEAMS_ADMINS.split(',').map((s) => s.trim()) : undefined,
      },
      adminToken: loadAdminToken(dir) ?? undefined,
    });
    const teamsPort = Number(env.TEAMS_PORT ?? port + 1);
    await ad.start(port, teamsPort, env.INTERTIE_LISTEN_HOST ?? '127.0.0.1');
    saveAdmin(dir, { token: ad.adminToken, port: ad.adminPort });
    process.stderr.write(`intertie-teams: org ${ad.node.org} · intertie 127.0.0.1:${port} · bot endpoint 127.0.0.1:${teamsPort}/api/messages (publish as ${env.TEAMS_PUBLIC_URL ?? '?'}/api/messages)${dev ? ' · DEV-INSECURE' : ''}\n`);
    const shutdown = () => { void ad.stop().then(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }
  if (cmd === 'share') { if (!args[0]) throw new Error('usage: share <channel>'); console.log((await admin('share', { teams_channel: args[0] }) as { invite: string }).invite); return; }
  if (cmd === 'accept') { if (!args[1]) throw new Error('usage: accept <invite> <channel>'); console.log(JSON.stringify(await admin('accept', { invite: args[0], teams_channel: args[1] }))); return; }
  if (cmd === 'unshare') { if (!args[0]) throw new Error('usage: unshare <channel>'); console.log(JSON.stringify(await admin('unshare', { teams_channel: args[0] }))); return; }
  if (cmd === 'status') { console.log(JSON.stringify(await admin('status'), null, 2)); return; }
  if (cmd === 'package') {
    const appId = env.TEAMS_APP_ID, pub = env.TEAMS_PUBLIC_URL;
    if (!appId || !/^[0-9a-f-]{36}$/i.test(appId)) throw new Error('TEAMS_APP_ID (the Azure Bot Microsoft App ID, a GUID) is required');
    if (!pub || !pub.startsWith('https://')) throw new Error('TEAMS_PUBLIC_URL (https://…) is required');
    const out = resolve(values.out ?? `${env.INTERTIE_STATE_DIR ?? './state/teams'}/intertie-teams.zip`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, appPackage({ appId, host: new URL(pub).host, manifestVersion: values['manifest-version'] }));
    process.stderr.write(`wrote ${out}: upload it in Teams → Apps → Manage your apps → Upload an app\n`);
    return;
  }
  console.log(USAGE);
  if (cmd && !values.help) process.exitCode = 2;
}

main().catch((e) => { process.stderr.write(`intertie-teams: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
