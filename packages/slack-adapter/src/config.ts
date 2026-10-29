// Configuration from environment and flags. Secrets come only from the environment / env file.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateKey, type PrivateJwk, type Logger } from '@intertie/core';
import type { AdapterOptions } from './adapter.ts';

export interface ServeConfig {
  adapter: AdapterOptions;
  port: number;
  host: string;
  stateDir: string;
}

const SECRET_RE = /(xox[a-z]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+)/g;

/** JSON-lines logger on stderr that never prints Slack tokens. Audit lines also go to audit.log. */
export function makeLogger(stateDir: string | null, verbose = false): Logger {
  return (level, msg, data) => {
    if (level === 'debug' && !verbose) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data }).replace(SECRET_RE, '[redacted]');
    process.stderr.write(line + '\n');
    if (level === 'audit' && stateDir) writeFileSync(join(stateDir, 'audit.log'), line + '\n', { flag: 'a', mode: 0o600 });
  };
}

export function loadOrCreateKey(stateDir: string): PrivateJwk {
  const p = join(stateDir, 'key.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const k = generateKey(new Date().toISOString().slice(0, 7));
  writeFileSync(p, JSON.stringify(k) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  return k;
}

export function serveConfig(env: NodeJS.ProcessEnv, flags: { port?: number; devInsecure?: boolean; state?: string; verbose?: boolean }): ServeConfig {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
  const dev = flags.devInsecure === true;
  const port = flags.port ?? Number(env.INTERTIE_PORT ?? 8701);
  const org = env.INTERTIE_ORG ?? (dev ? `localhost:${port}` : need('INTERTIE_ORG'));
  const endpoint = env.INTERTIE_ENDPOINT ?? (dev ? `http://${org}/intertie` : `https://${org}/intertie`);
  const stateDir = resolve(flags.state ?? env.INTERTIE_STATE_DIR ?? `./state/${org.replace(/[^A-Za-z0-9.-]/g, '_')}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = makeLogger(stateDir, flags.verbose);
  const adminToken = loadAdminToken(stateDir) ?? undefined;
  return {
    port, host: env.INTERTIE_LISTEN_HOST ?? '127.0.0.1', stateDir,
    adapter: {
      node: {
        org, endpoint, keys: [loadOrCreateKey(stateDir)], devInsecure: dev,
        displayName: env.INTERTIE_DISPLAY_NAME, contact: env.INTERTIE_CONTACT,
        delivery: env.INTERTIE_DELIVERY === 'pull' ? 'pull' : 'push',
        store: join(stateDir, 'intertie.sqlite'), log,
      },
      slack: {
        botToken: need('SLACK_BOT_TOKEN'), appToken: env.SLACK_APP_TOKEN || undefined,
        signingSecret: env.SLACK_SIGNING_SECRET || undefined, apiUrl: env.SLACK_API_URL || undefined,
        adminUsers: env.INTERTIE_ADMIN_USERS ? env.INTERTIE_ADMIN_USERS.split(',').map((s) => s.trim()) : undefined,
      },
      adminToken,
    },
  };
}

export function loadAdminToken(stateDir: string): string | null {
  const p = join(stateDir, 'admin.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { token: string }).token : null;
}

export function saveAdmin(stateDir: string, a: { token: string; port: number }): void {
  const p = join(stateDir, 'admin.json');
  writeFileSync(p, JSON.stringify(a) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function readAdmin(stateDir: string): { token: string; port: number } {
  const p = join(stateDir, 'admin.json');
  if (!existsSync(p)) throw new Error(`no running adapter state in ${stateDir} (start it with: intertie-slack serve)`);
  return JSON.parse(readFileSync(p, 'utf8'));
}
