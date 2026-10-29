// Discovery documents (spec/core.md §3).
import type { KeyObject } from 'node:crypto';
import { IntertieError } from './errors.ts';
import { isOrgName, KID_RE } from './ids.ts';
import { safeFetch } from './net.ts';
import { importPublic, type PublicJwk } from './signing.ts';

export const PROTOCOL_VERSION = '0.1';
export const WELL_KNOWN_PATH = '/.well-known/intertie';

export interface DiscoveryDoc {
  intertie: string;
  org: string;
  display_name?: string;
  endpoint: string;
  keys: PublicJwk[];
  delivery?: 'push' | 'pull';
  capabilities?: string[];
  limits?: { max_body_bytes?: number; max_file_bytes?: number };
  contact?: string;
}

export function discoveryUrl(org: string, devInsecure = false): string {
  return `${devInsecure && !org.includes('.') ? 'http' : 'https'}://${org}${WELL_KNOWN_PATH}`;
}

/** Validate a fetched document against the rules in spec/core.md §3. Throws on failure. */
export function validateDiscovery(doc: unknown, org: string, devInsecure = false): DiscoveryDoc {
  const d = doc as DiscoveryDoc;
  const bad = (m: string): never => { throw new IntertieError('unknown_key', `discovery for ${org}: ${m}`); };
  if (!d || typeof d !== 'object') bad('not an object');
  if (typeof d.intertie !== 'string' || !/^\d+\.\d+$/.test(d.intertie)) bad('bad intertie version');
  if (d.intertie.split('.')[0] !== PROTOCOL_VERSION.split('.')[0]) bad(`incompatible major ${d.intertie}`);
  if (d.org !== org) bad(`org field is ${JSON.stringify(d.org)}`);
  if (!isOrgName(org, devInsecure)) bad('invalid org name');
  let ep: URL;
  try { ep = new URL(d.endpoint); } catch { return bad('endpoint is not a URL'); }
  if (ep.search || ep.hash) bad('endpoint must not have query or fragment');
  if (ep.protocol !== 'https:' && !(devInsecure && ep.protocol === 'http:')) bad('endpoint must be https');
  if (!Array.isArray(d.keys) || d.keys.length === 0) bad('no keys');
  for (const k of d.keys) {
    if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || !KID_RE.test(k.kid ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(k.x ?? '')) {
      bad(`bad key ${JSON.stringify(k.kid)}`);
    }
  }
  if (d.delivery !== undefined && d.delivery !== 'push' && d.delivery !== 'pull') bad('bad delivery');
  return { ...d, endpoint: d.endpoint.replace(/\/+$/, '') };
}

interface CacheEntry { doc: DiscoveryDoc; expires: number; keys: Map<string, KeyObject> }

export interface DiscoveryClientOptions {
  devInsecure?: boolean;
  /** Override fetching (tests, or orgs served by this same process). */
  fetchDoc?: (org: string) => Promise<{ doc: unknown; maxAge?: number }>;
  now?: () => number;
}

/** Fetches and caches discovery documents, with the refetch-on-unknown-kid rule. */
export class DiscoveryClient {
  private cache = new Map<string, CacheEntry>();
  private lastRefresh = new Map<string, number>();
  private inflight = new Map<string, Promise<CacheEntry>>();
  private o: DiscoveryClientOptions;
  constructor(o: DiscoveryClientOptions = {}) { this.o = o; }

  private now(): number { return this.o.now ? this.o.now() : Date.now(); }

  private async load(org: string): Promise<CacheEntry> {
    let doc: unknown;
    let maxAge: number | undefined;
    if (this.o.fetchDoc) {
      ({ doc, maxAge } = await this.o.fetchDoc(org));
    } else {
      const res = await safeFetch(discoveryUrl(org, this.o.devInsecure), {
        timeoutMs: 10_000, maxBytes: 64 * 1024, devInsecure: this.o.devInsecure,
        headers: { accept: 'application/json' },
      });
      if (res.status !== 200) throw new IntertieError('unknown_key', `discovery for ${org}: HTTP ${res.status}`);
      try { doc = JSON.parse(res.body.toString('utf8')); } catch { throw new IntertieError('unknown_key', `discovery for ${org}: bad JSON`); }
      const cc = /max-age=(\d+)/.exec(String(res.headers['cache-control'] ?? ''));
      if (cc) maxAge = Number(cc[1]);
    }
    const valid = validateDiscovery(doc, org, this.o.devInsecure);
    const ttl = Math.min(Math.max(maxAge ?? 3600, 60), 86_400) * 1000;
    const keys = new Map(valid.keys.map((k) => [k.kid, importPublic(k)]));
    const entry = { doc: valid, expires: this.now() + ttl, keys };
    this.cache.set(org, entry);
    return entry;
  }

  private entry(org: string, force = false): Promise<CacheEntry> {
    const hit = this.cache.get(org);
    if (hit && !force && hit.expires > this.now()) return Promise.resolve(hit);
    const running = this.inflight.get(org);
    if (running) return running;
    const p = this.load(org).finally(() => this.inflight.delete(org));
    this.inflight.set(org, p);
    return p;
  }

  async get(org: string): Promise<DiscoveryDoc> {
    return (await this.entry(org)).doc;
  }

  /** Key lookup for verifyRequest: refetches at most once per 60 s per org on a miss. */
  async key(org: string, kid: string, refresh: boolean): Promise<KeyObject | null> {
    if (refresh) {
      const last = this.lastRefresh.get(org) ?? 0;
      if (this.now() - last < 60_000) return null;
      this.lastRefresh.set(org, this.now());
      try { return (await this.entry(org, true)).keys.get(kid) ?? null; } catch { return null; }
    }
    try { return (await this.entry(org)).keys.get(kid) ?? null; } catch { return null; }
  }

  forget(org: string): void { this.cache.delete(org); }
}
