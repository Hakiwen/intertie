// Configuration from environment and flags. Secrets come only from the environment / env file.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadAdminToken, loadOrCreateKey, makeLogger } from '@intertie/core';
import type { AdapterOptions } from './adapter.ts';

export interface ServeConfig {
  adapter: AdapterOptions;
  port: number;
  host: string;
  stateDir: string;
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


export { loadAdminToken, readAdmin, saveAdmin } from '@intertie/core';
