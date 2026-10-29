#!/usr/bin/env node
// intertie-matrix: run the Matrix gateway, generate an appservice registration, manage shared rooms.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadAdminToken, loadOrCreateKey, makeLogger, readAdmin, saveAdmin } from '@intertie/core';
import { MatrixGateway, type GatewayOptions } from './gateway.ts';
import { deviceLogin, resolveHomeserver, SessionFile } from './oauth.ts';
import { MatrixApi } from './matrix-api.ts';
import { existsSync } from 'node:fs';

const USAGE = `intertie-matrix: share Matrix rooms with other organizations over Intertie

  intertie-matrix registration --server-name example.org --url http://127.0.0.1:8731 [--out DIR]
      writes DIR/registration.yaml (give it to your homeserver) and DIR/.env.matrix (mode 600)
  intertie-matrix login --homeserver matrix.org [--state DIR]
      bot mode, OAuth device login: prints a link and code to approve as the bot account; the
      session (self-refreshing tokens) is saved to DIR/matrix-session.json, mode 600
  intertie-matrix serve   [--env FILE] [--port N] [--state DIR] [--dev-insecure] [--verbose]
  intertie-matrix share   <!room:server> [--state DIR]       prints an invite string
  intertie-matrix accept  <invite> <!room:server> [--state DIR]
  intertie-matrix unshare <!room:server> [--state DIR]
  intertie-matrix status  [--state DIR]

Environment: MATRIX_HOMESERVER, MATRIX_MODE (appservice|bot),
  appservice: MATRIX_AS_TOKEN, MATRIX_HS_TOKEN, MATRIX_SERVER_NAME [, MATRIX_BOT_LOCALPART]
  bot:        a session from 'intertie-matrix login' (preferred), or MATRIX_ACCESS_TOKEN
  MATRIX_ALLOWED_USERS (comma list: only these users' messages are shared; use it on public servers),
  MATRIX_LOCAL_SERVERS (comma list of servers whose users this org vouches for), MATRIX_ADMINS,
  INTERTIE_ORG, INTERTIE_ENDPOINT, INTERTIE_PORT, INTERTIE_DISPLAY_NAME, INTERTIE_CONTACT, INTERTIE_STATE_DIR.
In a shared room, moderators can also use: !intertie share | accept <invite> | status | unshare`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string' }, port: { type: 'string' }, state: { type: 'string' }, 'dev-insecure': { type: 'boolean' },
    verbose: { type: 'boolean' }, homeserver: { type: 'string' }, 'server-name': { type: 'string' }, url: { type: 'string' }, out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.env) process.loadEnvFile(values.env);
const env = process.env;
const dev = values['dev-insecure'] === true;
const port = Number(values.port ?? env.INTERTIE_PORT ?? 8731);

function stateDir(org: string): string {
  return resolve(values.state ?? env.INTERTIE_STATE_DIR ?? `./state/matrix-${org.replace(/[^A-Za-z0-9.-]/g, '_')}`);
}

function config(): { opts: GatewayOptions; dir: string } {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
  const org = env.INTERTIE_ORG ?? (dev ? `localhost:${port}` : need('INTERTIE_ORG'));
  const dir = stateDir(org);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = (env.MATRIX_MODE ?? 'appservice') as 'appservice' | 'bot';
  const sessionPath = join(dir, 'matrix-session.json');
  const session = mode === 'bot' && !env.MATRIX_ACCESS_TOKEN && existsSync(sessionPath) ? new SessionFile(sessionPath) : undefined;
  return {
    dir,
    opts: {
      node: {
        org, endpoint: env.INTERTIE_ENDPOINT ?? `${dev ? 'http' : 'https'}://${org}/intertie`, keys: [loadOrCreateKey(dir)],
        devInsecure: dev, displayName: env.INTERTIE_DISPLAY_NAME, contact: env.INTERTIE_CONTACT,
        store: join(dir, 'intertie.sqlite'), log: makeLogger(dir, values.verbose),
      },
      matrix: {
        homeserver: session?.session.homeserver ?? need('MATRIX_HOMESERVER'), mode,
        asToken: env.MATRIX_AS_TOKEN, hsToken: env.MATRIX_HS_TOKEN, serverName: env.MATRIX_SERVER_NAME,
        botLocalpart: env.MATRIX_BOT_LOCALPART, accessToken: session ?? env.MATRIX_ACCESS_TOKEN,
        allowedUsers: env.MATRIX_ALLOWED_USERS ? env.MATRIX_ALLOWED_USERS.split(',').map((s) => s.trim()) : undefined,
        localServers: env.MATRIX_LOCAL_SERVERS ? env.MATRIX_LOCAL_SERVERS.split(',').map((s) => s.trim()) : undefined,
        admins: env.MATRIX_ADMINS ? env.MATRIX_ADMINS.split(',').map((s) => s.trim()) : undefined,
      },
      adminToken: loadAdminToken(dir) ?? undefined,
    },
  };
}

async function admin(path: string, body?: unknown): Promise<unknown> {
  const dir = values.state ?? env.INTERTIE_STATE_DIR ?? config().dir;
  const a = readAdmin(dir);
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
  switch (cmd) {
    case 'registration': {
      const server = values['server-name'];
      if (!server) throw new Error('--server-name required (your homeserver\'s server_name)');
      const url = values.url ?? `http://127.0.0.1:${port}`;
      const as = randomBytes(32).toString('base64url'), hs = randomBytes(32).toString('base64url');
      const out = resolve(values.out ?? '.');
      mkdirSync(out, { recursive: true });
      const esc = server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reg = `# Intertie gateway: Matrix Application Service registration. Keep it secret.
id: intertie
url: ${url}
as_token: ${as}
hs_token: ${hs}
sender_localpart: intertie
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: '@intertie_.*:${esc}'
  aliases: []
  rooms: []
`;
      writeFileSync(join(out, 'registration.yaml'), reg, { mode: 0o600 });
      writeFileSync(join(out, '.env.matrix'), `MATRIX_MODE=appservice\nMATRIX_SERVER_NAME=${server}\nMATRIX_AS_TOKEN=${as}\nMATRIX_HS_TOKEN=${hs}\n# MATRIX_HOMESERVER=http://127.0.0.1:8008\n`, { mode: 0o600 });
      chmodSync(join(out, 'registration.yaml'), 0o600);
      chmodSync(join(out, '.env.matrix'), 0o600);
      process.stderr.write(`wrote ${join(out, 'registration.yaml')} and ${join(out, '.env.matrix')} (mode 600). Add the registration to your homeserver config and restart it.\n`);
      return;
    }
    case 'login': {
      const hs = await resolveHomeserver(values.homeserver ?? env.MATRIX_HOMESERVER ?? 'matrix.org');
      const org = env.INTERTIE_ORG ?? `localhost:${port}`;
      const dir = stateDir(org);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const s = await deviceLogin(hs, ({ url, code, expiresIn }) => {
        process.stderr.write(`\nSign in as the gateway's BOT account (not your own) and approve this login:\n\n  ${url}\n\n  code: ${code}   (expires in ${Math.round(expiresIn / 60)} min)\n\nWaiting for approval…\n`);
      });
      const path = join(dir, 'matrix-session.json');
      SessionFile.save(path, s);
      const who = await new MatrixApi({ homeserver: hs, token: new SessionFile(path) }).whoami();
      process.stderr.write(`logged in as ${who.user_id} on ${hs}; session saved to ${path} (mode 600, tokens refresh automatically)\n`);
      return;
    }
    case 'serve': {
      const { opts, dir } = config();
      const gw = new MatrixGateway(opts);
      await gw.start(port, env.INTERTIE_LISTEN_HOST ?? '127.0.0.1');
      saveAdmin(dir, { token: gw.adminToken, port: gw.adminPort });
      process.stderr.write(`intertie-matrix: org ${gw.node.org} · ${gw.mode} mode · listening 127.0.0.1:${port}${dev ? ' · DEV-INSECURE' : ''}\n`);
      const shutdown = () => { void gw.stop().then(() => process.exit(0)); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }
    case 'share': {
      if (!args[0]) throw new Error('usage: intertie-matrix share <!room:server>');
      const r = await admin('share', { room: args[0] }) as { invite: string };
      console.log(r.invite);
      return;
    }
    case 'accept':
      if (!args[1]) throw new Error('usage: intertie-matrix accept <invite> <!room:server>');
      console.log(JSON.stringify(await admin('accept', { invite: args[0], room: args[1] })));
      return;
    case 'unshare':
      if (!args[0]) throw new Error('usage: intertie-matrix unshare <!room:server>');
      console.log(JSON.stringify(await admin('unshare', { room: args[0] })));
      return;
    case 'status':
      console.log(JSON.stringify(await admin('status'), null, 2));
      return;
    default:
      console.log(USAGE);
      if (cmd && !values.help) process.exitCode = 2;
  }
}

main().catch((e) => { process.stderr.write(`intertie-matrix: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
