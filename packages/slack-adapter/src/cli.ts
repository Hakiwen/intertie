#!/usr/bin/env node
// intertie-slack: run the Slack adapter, and manage shared channels on a running one.
import { parseArgs } from 'node:util';
import { SlackAdapter } from './adapter.ts';
import { readAdmin, saveAdmin, serveConfig } from './config.ts';

const USAGE = `intertie-slack: share Slack channels with other organizations over Intertie

  intertie-slack serve   [--env FILE] [--port N] [--state DIR] [--dev-insecure] [--verbose]
  intertie-slack share   <slack-channel-id> [--state DIR]        prints an invite string
  intertie-slack accept  <invite> <slack-channel-id> [--state DIR]
  intertie-slack unshare <slack-channel-id> [--state DIR]
  intertie-slack status  [--state DIR]
  intertie-slack discovery [--env FILE] [--port N] [--dev-insecure]  prints /.well-known/intertie

Environment (or --env FILE): SLACK_BOT_TOKEN, SLACK_APP_TOKEN (Socket Mode) or
SLACK_SIGNING_SECRET (Events API), INTERTIE_ORG, INTERTIE_ENDPOINT, INTERTIE_PORT,
INTERTIE_DISPLAY_NAME, INTERTIE_CONTACT, INTERTIE_STATE_DIR, INTERTIE_ADMIN_USERS.
Inside Slack, admins can also use /intertie share | accept <invite> | status | unshare.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string' }, port: { type: 'string' }, state: { type: 'string' },
    'dev-insecure': { type: 'boolean' }, verbose: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});
const [cmd, ...args] = positionals;
if (values.env) process.loadEnvFile(values.env);
const flags = {
  port: values.port ? Number(values.port) : undefined, devInsecure: values['dev-insecure'],
  state: values.state, verbose: values.verbose,
};

async function admin(path: string, body?: unknown): Promise<unknown> {
  const cfgState = flags.state ?? process.env.INTERTIE_STATE_DIR ?? guessState();
  const a = readAdmin(cfgState);
  const r = await fetch(`http://127.0.0.1:${a.port}/admin/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json() as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

function guessState(): string {
  const cfg = serveConfigSafe();
  if (!cfg) throw new Error('pass --state DIR (or --env FILE so the state dir can be derived)');
  return cfg.stateDir;
}

function serveConfigSafe() {
  try { return serveConfig({ SLACK_BOT_TOKEN: 'unused', ...process.env }, flags); } catch { return null; }
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'serve': {
      const cfg = serveConfig(process.env, flags);
      const adapter = new SlackAdapter(cfg.adapter);
      await adapter.start(cfg.port, cfg.host);
      saveAdmin(cfg.stateDir, { token: adapter.adminToken, port: adapter.adminPort });
      const mode = cfg.adapter.slack.appToken ? 'socket mode' : `events API at ${cfg.adapter.node.endpoint.replace(/\/intertie$/, '')}/slack/events`;
      process.stderr.write(`intertie-slack: org ${adapter.node.org} · endpoint ${adapter.node.endpoint} · listening ${cfg.host}:${cfg.port} · ${mode}${flags.devInsecure ? ' · DEV-INSECURE (loopback only)' : ''}\n`);
      const shutdown = () => { void adapter.stop().then(() => process.exit(0)); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }
    case 'share': {
      if (!args[0]) throw new Error('usage: intertie-slack share <slack-channel-id>');
      const r = await admin('share', { slack_channel: args[0] }) as { channel: string; invite: string };
      console.log(r.invite);
      process.stderr.write(`shared channel ${r.channel}; give the invite above to the other org's admin (single use, 7 days)\n`);
      return;
    }
    case 'accept': {
      if (!args[0] || !args[1]) throw new Error('usage: intertie-slack accept <invite> <slack-channel-id>');
      console.log(JSON.stringify(await admin('accept', { invite: args[0], slack_channel: args[1] })));
      return;
    }
    case 'unshare':
      if (!args[0]) throw new Error('usage: intertie-slack unshare <slack-channel-id>');
      console.log(JSON.stringify(await admin('unshare', { slack_channel: args[0] })));
      return;
    case 'status':
      console.log(JSON.stringify(await admin('status'), null, 2));
      return;
    case 'discovery': {
      const cfg = serveConfig({ SLACK_BOT_TOKEN: 'unused', ...process.env }, flags);
      const a = new SlackAdapter(cfg.adapter);
      console.log(JSON.stringify(a.node.discoveryDocument(), null, 2));
      return;
    }
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && !values.help) process.exitCode = 2;
  }
}

main().catch((e) => { process.stderr.write(`intertie-slack: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
