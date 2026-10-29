// Outbound HTTP with the SSRF rules of spec/security.md §SSRF:
// no redirects, resolved-address checks pinned to the connection, timeouts, size caps.
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { IntertieError } from './errors.ts';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32],
] as const) blocked.addSubnet(net, bits, 'ipv6');

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

function unmap(addr: string): { addr: string; family: 'ipv4' | 'ipv6' } {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (m) return { addr: m[1], family: 'ipv4' };
  return { addr, family: isIP(addr) === 6 ? 'ipv6' : 'ipv4' };
}

/** True if the address is one we must never connect to (outside dev mode). */
export function isForbiddenAddress(address: string): boolean {
  const { addr, family } = unmap(address);
  return blocked.check(addr, family);
}

export function isLoopbackAddress(address: string): boolean {
  const { addr, family } = unmap(address);
  return loopback.check(addr, family);
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Loopback only, http allowed (spec/core.md §10). */
  devInsecure?: boolean;
  signal?: AbortSignal;
}

export interface FetchResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A guarded fetch: https only (http on loopback in dev mode), never follows redirects. */
export function safeFetch(url: string, o: FetchOptions = {}): Promise<FetchResult> {
  const u = new URL(url);
  const dev = o.devInsecure === true;
  if (u.protocol !== 'https:' && !(dev && u.protocol === 'http:')) {
    return Promise.reject(new IntertieError('unreachable', `refusing non-https URL ${u.origin}`));
  }
  const checkAddr = (a: string): string | null => {
    if (dev) return isLoopbackAddress(a) ? null : `dev mode allows loopback only, got ${a}`;
    return isForbiddenAddress(a) ? `forbidden address ${a}` : null;
  };
  // A lookup hook makes the check apply to the address actually connected to (no rebinding gap).
  const lookup = (hostname: string, options: object, cb: (...a: any[]) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return cb(err);
      const list = addresses as LookupAddress[];
      for (const a of list) {
        const why = checkAddr(a.address);
        if (why) return cb(new IntertieError('unreachable', why));
      }
      if ((options as { all?: boolean }).all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    const why = checkAddr(host);
    if (why) return Promise.reject(new IntertieError('unreachable', why));
  }
  const maxBytes = o.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const reqFn = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = reqFn(u, {
      method: o.method ?? 'GET',
      headers: { 'user-agent': 'intertie-ref/0.1', ...o.headers },
      lookup: lookup as never,
      timeout: timeoutMs,
      minVersion: 'TLSv1.2',
    } as never, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => {
        n += c.length;
        if (n > maxBytes) { req.destroy(new IntertieError('too_large', `response over ${maxBytes} bytes`)); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(total);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', reject);
    });
    const total = setTimeout(() => req.destroy(new IntertieError('unreachable', 'timeout')), timeoutMs);
    req.on('timeout', () => req.destroy(new IntertieError('unreachable', 'socket timeout')));
    req.on('error', (e) => { clearTimeout(total); reject(e instanceof IntertieError ? e : new IntertieError('unreachable', e.message)); });
    o.signal?.addEventListener('abort', () => req.destroy(new IntertieError('unreachable', 'aborted')), { once: true });
    if (o.body != null) req.end(o.body); else req.end();
  });
}
