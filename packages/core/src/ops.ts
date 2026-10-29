// Operational helpers shared by the adapters and gateways: logging, key and admin-token files.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKey, type PrivateJwk } from './signing.ts';
import type { Logger } from './node.ts';

// Slack tokens, Matrix access/AS tokens, bearer tokens: never printed.
const SECRET_RE = /(xox[a-z]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|syt_[A-Za-z0-9_]+|mct_[A-Za-z0-9_]+)/g;

/** JSON-lines logger on stderr that never prints known token formats. Audit lines also go to audit.log. */
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
