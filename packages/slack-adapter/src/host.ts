// SlackHost: one always-on service that runs the Intertie Slack app for MANY workspaces, installed with
// "Add to Slack" (OAuth v2). It runs on the hosting party's side, normally the vendor whose tool is on
// the other end, and each installed workspace becomes its own Intertie org (own name, key, database).
// It is not a public service for everyone: one operator per instance (see docs/slack-oauth.md).
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { escapeHtml, IntertieError, loadOrCreateKey, type Logger } from '@intertie/core';
import { SlackAdapter, type SlashPayload } from './adapter.ts';
import { SlackApi } from './slack-api.ts';
import { SocketModeClient, type Envelope } from './socket-mode.ts';

export const BOT_SCOPES = [
  'channels:history', 'channels:read', 'channels:join', 'groups:history', 'groups:read', 'chat:write',
  'chat:write.customize', 'reactions:read', 'reactions:write', 'files:read', 'files:write', 'users:read', 'commands',
];

export interface SlackHostOptions {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  /** Optional: receive events over one Socket Mode connection instead of HTTP (OAuth still needs HTTPS). */
  appToken?: string;
  /** Public https base, e.g. https://connect.vendor.example. OAuth redirect: <base>/slack/oauth/callback. */
  publicBase: string;
  /** Each workspace's org is `<team id, lowercased>.<orgSuffix>`, e.g. t0abc.connect.vendor.example. */
  orgSuffix: string;
  /** 32-byte key (base64) for encrypting bot tokens at rest. */
  tokenKey: string;
  stateDir: string;
  apiUrl?: string;
  authorizeUrl?: string;
  devInsecure?: boolean;
  log?: Logger;
  /** Intertie endpoint scheme+port as seen from outside, for dev (e.g. http://{org}). Default https://{org}. */
  endpointFor?: (org: string) => string;
  /** Test knobs for the per-workspace nodes. */
  nodeTuning?: { retryBaseMs?: number; retryCapMs?: number; pullWaitS?: number };
}

interface WorkspaceRow { team_id: string; team_name: string; org: string; token_enc: string; installed_at: string }

/** AES-256-GCM with the team id as associated data: a token row cannot be swapped onto another workspace. */
export function sealToken(key: Buffer, teamId: string, token: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(teamId));
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function openToken(key: Buffer, teamId: string, sealed: string): string {
  const b = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(Buffer.from(teamId));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

export class SlackHost {
  private o: SlackHostOptions;
  private key: Buffer;
  private db: DatabaseSync;
  private ws = new Map<string, SlackAdapter>();      // team id → adapter
  private byOrg = new Map<string, SlackAdapter>();   // org (Host header) → adapter
  private server?: Server;
  private socket?: SocketModeClient;
  readonly api: SlackApi;

  constructor(o: SlackHostOptions) {
    this.o = o;
    this.key = Buffer.from(o.tokenKey, 'base64');
    if (this.key.length !== 32) throw new Error('tokenKey must be 32 bytes, base64');
    mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(o.stateDir, 'host.sqlite'));
    this.db.exec(`create table if not exists workspaces(team_id text primary key, team_name text not null, org text not null unique,
      token_enc text not null, installed_at text not null)`);
    this.api = new SlackApi({ token: 'none', baseUrl: o.apiUrl });
  }

  orgFor(teamId: string): string { return `${teamId.toLowerCase()}.${this.o.orgSuffix}`; }
  workspaces(): { team_id: string; team_name: string; org: string; installed_at: string }[] {
    return this.db.prepare('select team_id, team_name, org, installed_at from workspaces order by installed_at').all() as never;
  }
  adapter(teamId: string): SlackAdapter | undefined { return this.ws.get(teamId); }
  isIdle(): boolean { return [...this.ws.values()].every((a) => a.isIdle()); }

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    for (const row of this.db.prepare('select * from workspaces').all() as unknown as WorkspaceRow[]) {
      await this.spawn(row).catch((e) => this.log('warn', 'workspace failed to start', { team: row.team_id, err: String(e) }));
    }
    this.server = createServer((req, res) => { void this.route(req, res); });
    await new Promise<void>((r) => this.server!.listen(port, host, r));
    if (this.o.appToken) {
      this.socket = new SocketModeClient({ appToken: this.o.appToken, baseUrl: this.o.apiUrl, onEnvelope: (e) => this.onEnvelope(e), log: (m, d) => this.log('info', m, d) });
      await this.socket.start();
    }
  }

  async stop(): Promise<void> {
    this.socket?.stop();
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>((r) => this.server!.close(() => r())); }
    for (const a of this.ws.values()) await a.stop();
  }

  private async spawn(row: WorkspaceRow): Promise<SlackAdapter> {
    const dir = join(this.o.stateDir, 'ws', row.team_id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const endpoint = this.o.endpointFor ? this.o.endpointFor(row.org) : `https://${row.org}/intertie`;
    const a = new SlackAdapter({
      node: { org: row.org, endpoint, keys: [loadOrCreateKey(dir)], displayName: row.team_name, devInsecure: this.o.devInsecure, store: join(dir, 'intertie.sqlite'), log: this.o.log, ...this.o.nodeTuning },
      slack: { botToken: openToken(this.key, row.team_id, row.token_enc), apiUrl: this.o.apiUrl, signingSecret: this.o.signingSecret },
    });
    await a.startEmbedded();
    this.ws.set(row.team_id, a);
    this.byOrg.set(row.org, a);
    return a;
  }

  // ───────────────────────── OAuth v2 install ─────────────────────────

  /** A signed, expiring `state` (CSRF protection without a session store). */
  private state(): string {
    const body = Buffer.from(JSON.stringify({ exp: Date.now() + 10 * 60_000, n: randomBytes(9).toString('base64url') })).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(`state:${body}`).digest('base64url')}`;
  }
  private checkState(s: string | null): boolean {
    if (!s) return false;
    const [body, mac] = s.split('.');
    const want = createHmac('sha256', this.key).update(`state:${body}`).digest('base64url');
    if (!mac || !safeEqual(mac, want)) return false;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')).exp > Date.now(); } catch { return false; }
  }
  installUrl(): string {
    const u = new URL(this.o.authorizeUrl ?? 'https://slack.com/oauth/v2/authorize');
    u.searchParams.set('client_id', this.o.clientId);
    u.searchParams.set('scope', BOT_SCOPES.join(','));
    u.searchParams.set('redirect_uri', `${this.o.publicBase}/slack/oauth/callback`);
    u.searchParams.set('state', this.state());
    return u.toString();
  }

  private async oauthCallback(url: URL, res: ServerResponse): Promise<void> {
    const page = (status: number, title: string, msg: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font:16px system-ui;max-width:40em;margin:3em auto;padding:0 1em"><h1>${escapeHtml(title)}</h1><p>${msg}</p>`);
    };
    if (url.searchParams.get('error')) return page(400, 'Not installed', `Slack said: ${escapeHtml(url.searchParams.get('error')!)}`);
    if (!this.checkState(url.searchParams.get('state'))) return page(400, 'Not installed', 'This install link expired or was not issued here. Start again from the install page.');
    const code = url.searchParams.get('code');
    if (!code) return page(400, 'Not installed', 'Missing code.');
    const r = await this.api.call<{ access_token: string; token_type: string; team: { id: string; name: string }; bot_user_id: string; enterprise?: { id: string } | null }>('oauth.v2.access', {
      client_id: this.o.clientId, client_secret: this.o.clientSecret, code, redirect_uri: `${this.o.publicBase}/slack/oauth/callback`,
    }, 'none').catch((e) => { throw new IntertieError('bad_request', `oauth.v2.access failed: ${e.message}`); });
    if (r.token_type !== 'bot' || !r.access_token.startsWith('xoxb-')) throw new IntertieError('bad_request', 'expected a bot token');
    const row: WorkspaceRow = { team_id: r.team.id, team_name: r.team.name.slice(0, 80), org: this.orgFor(r.team.id), token_enc: sealToken(this.key, r.team.id, r.access_token), installed_at: new Date().toISOString() };
    this.db.prepare(`insert into workspaces values (?,?,?,?,?) on conflict(team_id) do update set team_name = excluded.team_name, token_enc = excluded.token_enc`)
      .run(row.team_id, row.team_name, row.org, row.token_enc, row.installed_at);
    const old = this.ws.get(row.team_id);
    if (old) { await old.stop(); this.ws.delete(row.team_id); }
    await this.spawn(row);
    this.log('audit', 'slack.install', { team: row.team_id, org: row.org });
    return page(200, 'Installed', `Intertie is installed in <b>${escapeHtml(row.team_name)}</b>. In the Slack channel you want to share, type <code>/intertie accept &lt;invite&gt;</code> with the invite you were given, or <code>/intertie share</code> to create one. This workspace's Intertie name is <code>${escapeHtml(row.org)}</code>.`);
  }

  private async uninstall(teamId: string): Promise<void> {
    const a = this.ws.get(teamId);
    if (a) {
      for (const l of a.status().links) await a.unshare(l.slack_channel).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      await a.stop();
      this.ws.delete(teamId);
      this.byOrg.delete(a.node.org);
    }
    this.db.prepare('delete from workspaces where team_id = ?').run(teamId);
    this.log('audit', 'slack.uninstall', { team: teamId });
  }

  // ───────────────────────── routing ─────────────────────────

  private onEnvelope(e: Envelope): Record<string, unknown> | void {
    const team = e.payload?.team_id as string | undefined;
    if (e.type === 'events_api') { void this.dispatchEvent(team, e.payload.event, e.payload.event_id); return; }
    if (e.type === 'slash_commands' && team) { void this.ws.get(team)?.handleSlashCommand(e.payload as SlashPayload); }
  }

  private async dispatchEvent(team: string | undefined, event: Record<string, any>, eventId: string): Promise<void> {
    if (!team) return;
    if (event?.type === 'app_uninstalled' || event?.type === 'tokens_revoked') return this.uninstall(team);
    this.ws.get(team)?.handleSlackEvent(event, eventId);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://host');
    try {
      if (req.method === 'GET' && url.pathname === '/slack/install') { res.writeHead(302, { location: this.installUrl() }).end(); return; }
      if (req.method === 'GET' && url.pathname === '/slack/oauth/callback') return await this.oauthCallback(url, res);
      if (req.method === 'POST' && (url.pathname === '/slack/events' || url.pathname === '/slack/commands')) return await this.slackHttp(req, res, url.pathname);
      // Intertie traffic: route by Host to that workspace's org (each has its own key and database).
      const host = String(req.headers.host ?? '').toLowerCase();
      const a = this.byOrg.get(host);
      if (!a) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'not_found', message: 'unknown org' } })); return; }
      return await a.node.handle(req, res);
    } catch (e) {
      this.log('warn', 'host request failed', { path: url.pathname, err: String(e) });
      if (!res.headersSent) res.writeHead(e instanceof IntertieError ? e.status : 500).end();
    }
  }

  private async slackHttp(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const body = await readAll(req, 1024 * 1024);
    const ts = String(req.headers['x-slack-request-timestamp'] ?? '');
    const sig = String(req.headers['x-slack-signature'] ?? '');
    const ok = Math.abs(Date.now() / 1000 - Number(ts)) < 300 &&
      safeEqual(sig, 'v0=' + createHmac('sha256', this.o.signingSecret).update(`v0:${ts}:${body.toString('utf8')}`).digest('hex'));
    if (!ok) { res.writeHead(401).end(); return; }
    if (path === '/slack/commands') {
      const p = Object.fromEntries(new URLSearchParams(body.toString('utf8'))) as unknown as SlashPayload & { team_id: string };
      res.writeHead(200).end();
      void this.ws.get(p.team_id)?.handleSlashCommand(p);
      return;
    }
    const j = JSON.parse(body.toString('utf8'));
    if (j.type === 'url_verification') { res.writeHead(200, { 'content-type': 'text/plain' }).end(String(j.challenge)); return; }
    res.writeHead(200).end();
    if (j.type === 'event_callback') void this.dispatchEvent(j.team_id, j.event, j.event_id);
  }

  private log(level: 'info' | 'warn' | 'audit', msg: string, data?: Record<string, unknown>): void { this.o.log?.(level, msg, data); }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readAll(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > max) { req.destroy(); reject(new Error('too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
