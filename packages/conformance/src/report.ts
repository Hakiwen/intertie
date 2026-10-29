// Signed conformance reports (spec/conformance.md § Signed report): Ed25519 over RFC 8785 JCS.
import { sign, verify } from 'node:crypto';
import { DiscoveryClient, importPrivate, splitKeyid, type PrivateJwk } from '@intertie/core';

export interface TestResult { id: string; level: string; role: string; pass: boolean; skipped?: boolean; detail: string }

export interface Report {
  intertie_report: '0.1';
  subject: { org: string; endpoint: string; implementation?: string };
  runner: { name: string; version: string };
  date: string;
  claim: { roles: string[]; levels: string[] };
  results: TestResult[];
  passed: boolean;
  signature?: { keyid: string; alg: 'ed25519'; sig: string };
}

/** RFC 8785 JSON Canonicalization Scheme, for the JSON this report contains (no floats needed). */
export function jcs(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number');
    return JSON.stringify(v); // ES number serialization is what RFC 8785 specifies
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort((a, b) => cmpUtf16(a, b));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  throw new Error(`cannot canonicalize ${typeof v}`);
}

function cmpUtf16(a: string, b: string): number {
  // RFC 8785 sorts by UTF-16 code units, which is what JS string comparison does.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function signReport(r: Report, keyid: string, key: PrivateJwk): Report {
  const { signature: _drop, ...body } = r;
  const sig = sign(null, Buffer.from(jcs(body), 'utf8'), importPrivate(key)).toString('base64url');
  return { ...body, signature: { keyid, alg: 'ed25519', sig } };
}

/** Verify a report against the subject org's published key. */
export async function verifyReport(r: Report, o: { devInsecure?: boolean; discovery?: DiscoveryClient } = {}): Promise<{ ok: boolean; reason?: string }> {
  if (!r.signature) return { ok: false, reason: 'unsigned' };
  if (r.signature.alg !== 'ed25519') return { ok: false, reason: 'alg must be ed25519' };
  const { org, kid } = splitKeyid(r.signature.keyid);
  if (org !== r.subject.org) return { ok: false, reason: `signed by ${org}, subject is ${r.subject.org}` };
  const d = o.discovery ?? new DiscoveryClient({ devInsecure: o.devInsecure });
  const key = await d.key(org, kid, false) ?? await d.key(org, kid, true);
  if (!key) return { ok: false, reason: `key ${r.signature.keyid} not published` };
  const { signature, ...body } = r;
  const ok = verify(null, Buffer.from(jcs(body), 'utf8'), key, Buffer.from(signature.sig, 'base64url'));
  return ok ? { ok } : { ok, reason: 'bad signature' };
}
