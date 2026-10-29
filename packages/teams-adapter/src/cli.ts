#!/usr/bin/env node
// intertie-teams: run the Teams adapter, build its Teams app package, manage shared channels.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { appPackage } from './app-package.ts';

const USAGE = `intertie-teams: share Microsoft Teams channels with other organizations over Intertie

  intertie-teams package [--env FILE] [--out FILE] [--manifest-version 1.25]
      builds the Teams app package (manifest + icons, zip) for TEAMS_APP_ID and TEAMS_PUBLIC_URL
  intertie-teams serve   [--env FILE] [--dev-insecure]        (see docs/teams-setup.md)
  intertie-teams share | accept | unshare | status            admin, like intertie-slack

Environment: TEAMS_APP_ID, TEAMS_TENANT_ID, TEAMS_APP_PASSWORD (client secret), TEAMS_PUBLIC_URL
(the public https base that Teams calls at /api/messages), INTERTIE_* as for the other adapters.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { env: { type: 'string' }, out: { type: 'string' }, 'manifest-version': { type: 'string' }, 'dev-insecure': { type: 'boolean' }, state: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});
if (values.env) process.loadEnvFile(values.env);
const env = process.env;

async function main(): Promise<void> {
  const [cmd] = positionals;
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
