// Bot Framework plumbing for Teams, with no SDK: single-tenant client-credentials tokens (bot →
// connector), JWT verification of inbound activities (connector → bot), and the Connector REST API.
// Follows learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication.
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export interface BotFrameworkOptions {
  appId: string;
  appPassword: string;
  tenantId: string;
  /** Overridable for tests. */
  loginBase?: string;          // https://login.microsoftonline.com
  openIdConfigUrl?: string;    // https://login.botframework.com/v1/.well-known/openidconfiguration
  /** Hosts the connector may live on. serviceUrl from an activity must match one (token exfiltration guard). */
  serviceHosts?: (host: string) => boolean;
  now?: () => number;
}

export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const ISSUER = 'https://api.botframework.com';
const SKEW_S = 300;

export function defaultServiceHosts(host: string): boolean {
  return host === 'smba.trafficmanager.net' || host.endsWith('.botframework.com') || host.endsWith('.teams.microsoft.com')
    || host.endsWith('.teams.microsoft.us') || host.endsWith('.infra.gcc.teams.microsoft.com');
}

const b64url = (s: string) => Buffer.from(s, 'base64url');

export class BotFramework {
  private o: BotFrameworkOptions;
  private token?: { value: string; exp: number };
  private keys?: { at: number; byKid: Map<string, { key: KeyObject; endorsements: string[] }> };
  private lastKeyRefresh = 0;
  constructor(o: BotFrameworkOptions) { this.o = o; }
  private now(): number { return this.o.now ? this.o.now() : Date.now(); }

  // ───────── bot → connector ─────────

  async accessToken(): Promise<string> {
    if (this.token && this.token.exp - 300_000 > this.now()) return this.token.value;
    const url = `${this.o.loginBase ?? 'https://login.microsoftonline.com'}/${encodeURIComponent(this.o.tenantId)}/oauth2/v2.0/token`;
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.o.appId, client_secret: this.o.appPassword, scope: 'https://api.botframework.com/.default' }),
    });
    const j = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !j.access_token) throw new Error(`token request failed: ${j.error ?? res.status}`);
    this.token = { value: j.access_token, exp: this.now() + (j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  checkServiceUrl(serviceUrl: string): URL {
    const u = new URL(serviceUrl);
    if (u.protocol !== 'https:' && !(this.o.serviceHosts && u.protocol === 'http:')) throw new AuthError(403, 'serviceUrl must be https');
    if (!(this.o.serviceHosts ?? defaultServiceHosts)(u.host)) throw new AuthError(403, `serviceUrl host ${u.host} is not a Bot Framework connector`);
    return u;
  }

  /** Call the Connector REST API (POST/PUT/DELETE {serviceUrl}/v3/...). */
  async connector<T = any>(serviceUrl: string, method: string, path: string, body?: unknown): Promise<T> {
    const base = this.checkServiceUrl(serviceUrl).toString().replace(/\/+$/, '');
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${path}`, {
        method, redirect: 'error',
        headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`connector ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  // ───────── connector → bot ─────────

  private async signingKeys(force: boolean): Promise<Map<string, { key: KeyObject; endorsements: string[] }>> {
    if (this.keys && !force && this.now() - this.keys.at < 24 * 3600_000) return this.keys.byKid;
    const cfgRes = await fetch(this.o.openIdConfigUrl ?? 'https://login.botframework.com/v1/.well-known/openidconfiguration', { redirect: 'error' });
    const cfg = await cfgRes.json() as { jwks_uri: string; issuer?: string };
    const jwks = await (await fetch(cfg.jwks_uri, { redirect: 'error' })).json() as { keys: { kid: string; kty: string; n: string; e: string; endorsements?: string[] }[] };
    const byKid = new Map<string, { key: KeyObject; endorsements: string[] }>();
    for (const k of jwks.keys ?? []) {
      if (k.kty !== 'RSA') continue;
      byKid.set(k.kid, { key: createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' }), endorsements: k.endorsements ?? [] });
    }
    this.keys = { at: this.now(), byKid };
    return byKid;
  }

  /** Verify an inbound request's bearer JWT against the activity (all seven checks of the doc, plus endorsement). */
  async verifyInbound(authorization: string | undefined, activity: { serviceUrl?: string; channelId?: string }): Promise<void> {
    const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? '');
    if (!m) throw new AuthError(401, 'missing or malformed bearer token');
    let header: { alg?: string; kid?: string }, claims: { iss?: string; aud?: string; nbf?: number; exp?: number; serviceurl?: string; serviceUrl?: string };
    try { header = JSON.parse(b64url(m[1]).toString('utf8')); claims = JSON.parse(b64url(m[2]).toString('utf8')); } catch { throw new AuthError(401, 'token is not JSON'); }
    if (header.alg !== 'RS256') throw new AuthError(401, 'alg must be RS256');
    let keys = await this.signingKeys(false);
    let k = header.kid ? keys.get(header.kid) : undefined;
    if (!k && this.now() - this.lastKeyRefresh > 60_000) {
      this.lastKeyRefresh = this.now();
      keys = await this.signingKeys(true);
      k = header.kid ? keys.get(header.kid) : undefined;
    }
    if (!k) throw new AuthError(401, 'unknown signing key');
    if (!cryptoVerify('RSA-SHA256', Buffer.from(`${m[1]}.${m[2]}`), k.key, b64url(m[3]))) throw new AuthError(401, 'bad signature');
    if (claims.iss !== ISSUER) throw new AuthError(401, 'wrong issuer');
    if (claims.aud !== this.o.appId) throw new AuthError(401, 'wrong audience');
    const t = this.now() / 1000;
    if (typeof claims.exp !== 'number' || t > claims.exp + SKEW_S) throw new AuthError(401, 'token expired');
    if (typeof claims.nbf === 'number' && t < claims.nbf - SKEW_S) throw new AuthError(401, 'token not yet valid');
    const claimed = claims.serviceurl ?? claims.serviceUrl;
    if (!claimed || claimed !== activity.serviceUrl) throw new AuthError(401, 'serviceUrl claim does not match the activity');
    if (activity.channelId && !k.endorsements.includes(activity.channelId)) throw new AuthError(403, `key not endorsed for channel ${activity.channelId}`);
    this.checkServiceUrl(activity.serviceUrl!);
  }
}
