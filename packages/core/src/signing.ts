// RFC 9421 HTTP Message Signatures, Intertie fixed profile (spec/core.md §4).
import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes,
  sign as edSign, verify as edVerify, type KeyObject,
} from 'node:crypto';
import { IntertieError } from './errors.ts';

export interface PublicJwk { kty: 'OKP'; crv: 'Ed25519'; kid: string; x: string }
export interface PrivateJwk extends PublicJwk { d: string }

export interface SigningKey {
  /** `<org>#<kid>` */
  keyid: string;
  privateKey: KeyObject;
}

export const SIGNATURE_WINDOW_S = 300;
export const NONCE_TTL_S = 600;

export function generateKey(kid: string): PrivateJwk {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { kty: 'OKP', crv: 'Ed25519', kid, x: jwk.x, d: jwk.d };
}

export function publicJwk(k: PrivateJwk | PublicJwk): PublicJwk {
  return { kty: 'OKP', crv: 'Ed25519', kid: k.kid, x: k.x };
}

export function importPrivate(k: PrivateJwk): KeyObject {
  return createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x, d: k.d }, format: 'jwk' });
}

export function importPublic(k: PublicJwk): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' });
}

/** RFC 9530 Content-Digest value for a body. */
export function contentDigest(body: Uint8Array | string): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

function components(hasBody: boolean): string {
  return hasBody ? '("@method" "@target-uri" "content-digest")' : '("@method" "@target-uri")';
}

/** The exact signature base (spec/core.md §4). */
export function signatureBase(method: string, targetUri: string, digest: string | null, params: string): string {
  const lines = [`"@method": ${method.toUpperCase()}`, `"@target-uri": ${targetUri}`];
  if (digest !== null) lines.push(`"content-digest": ${digest}`);
  lines.push(`"@signature-params": ${params}`);
  return lines.join('\n');
}

export interface SignOptions {
  method: string;
  url: string;
  body?: Uint8Array | string | null;
  key: SigningKey;
  /** For tests and vectors. */
  created?: number;
  nonce?: string;
}

/** Returns the headers to add to the request. */
export function signRequest(o: SignOptions): Record<string, string> {
  const hasBody = o.body != null && o.body.length > 0;
  const created = o.created ?? Math.floor(Date.now() / 1000);
  const nonce = o.nonce ?? randomBytes(16).toString('base64url');
  const params = `${components(hasBody)};created=${created};keyid="${o.key.keyid}";alg="ed25519";nonce="${nonce}";tag="intertie"`;
  const headers: Record<string, string> = {};
  let digest: string | null = null;
  if (hasBody) {
    digest = contentDigest(o.body!);
    headers['content-digest'] = digest;
  }
  const base = signatureBase(o.method, o.url, digest, params);
  const sig = edSign(null, Buffer.from(base, 'utf8'), o.key.privateKey).toString('base64');
  headers['signature-input'] = `sig1=${params}`;
  headers['signature'] = `sig1=:${sig}:`;
  return headers;
}

/** Parsed `Signature-Input: sig1=...`. */
export interface ParsedSigInput {
  params: string;
  components: string;
  created: number;
  keyid: string;
  alg: string;
  nonce: string;
  tag: string;
}

// Accepts exactly our profile; any other shape is bad_signature (spec/core.md §4 step 1).
const SIG_INPUT_RE = /^sig1=(\((?:"[^"]+"(?: "[^"]+")*)?\))((?:;[a-z]+=(?:[0-9]+|"[^"\\]*"))*)$/;

export function parseSignatureInput(header: string | undefined): ParsedSigInput {
  if (!header) throw new IntertieError('bad_signature', 'missing Signature-Input');
  const m = SIG_INPUT_RE.exec(header.trim());
  if (!m) throw new IntertieError('bad_signature', 'Signature-Input must contain exactly one sig1 member');
  const params: Record<string, string> = {};
  for (const p of m[2].split(';').slice(1)) {
    const eq = p.indexOf('=');
    params[p.slice(0, eq)] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  const created = Number(params.created);
  if (!Number.isInteger(created)) throw new IntertieError('bad_signature', 'created missing');
  if (params.alg !== 'ed25519') throw new IntertieError('bad_signature', 'alg must be ed25519');
  if (params.tag !== 'intertie') throw new IntertieError('bad_signature', 'tag must be intertie');
  if (!params.keyid || !params.nonce) throw new IntertieError('bad_signature', 'keyid and nonce required');
  if (params.nonce.length < 22) throw new IntertieError('bad_signature', 'nonce too short');
  return {
    params: m[1] + m[2], components: m[1], created, keyid: params.keyid,
    alg: params.alg, nonce: params.nonce, tag: params.tag,
  };
}

export function splitKeyid(keyid: string): { org: string; kid: string } {
  const i = keyid.lastIndexOf('#');
  if (i <= 0 || i === keyid.length - 1) throw new IntertieError('bad_signature', 'keyid must be <org>#<kid>');
  return { org: keyid.slice(0, i), kid: keyid.slice(i + 1) };
}

/** A nonce cache keyed by keyid (spec/core.md §4 step 3). */
export class NonceCache {
  private seen = new Map<string, number>();
  private lastSweep = 0;
  private max: number;
  constructor(max = 200_000) { this.max = max; }
  private sweep(nowS: number): void {
    if (nowS - this.lastSweep <= 60 && this.seen.size < this.max) return;
    for (const [k, exp] of this.seen) if (exp < nowS) this.seen.delete(k);
    // Still full of live entries: drop the oldest (insertion order). Only verified requests get here.
    while (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value!);
    this.lastSweep = nowS;
  }
  /** True if the nonce was seen for this keyid within the TTL. */
  has(keyid: string, nonce: string, nowS: number): boolean {
    const exp = this.seen.get(`${keyid} ${nonce}`);
    return exp !== undefined && exp >= nowS;
  }
  /** Remember a nonce. Call only after the signature verified, so forged requests cost no memory. */
  remember(keyid: string, nonce: string, nowS: number): void {
    this.sweep(nowS);
    this.seen.set(`${keyid} ${nonce}`, nowS + NONCE_TTL_S);
  }
  /** Check-and-remember in one step (tests and simple callers). */
  check(keyid: string, nonce: string, nowS: number): boolean {
    if (this.has(keyid, nonce, nowS)) return false;
    this.remember(keyid, nonce, nowS);
    return true;
  }
}

export interface VerifyOptions {
  method: string;
  /** The receiver's own external view of the target URI. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array | null;
  /** Resolve a public key; called with refresh=true once on a miss. */
  resolveKey: (org: string, kid: string, refresh: boolean) => Promise<KeyObject | null>;
  nonces: NonceCache;
  nowS?: number;
  /** Reject keyids whose org is not a valid org name before any lookup (no fetches for junk). */
  isValidOrg?: (org: string) => boolean;
}

function header(h: VerifyOptions['headers'], name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

/** Verify an inbound request. Returns the authenticated org. Throws IntertieError. */
export async function verifyRequest(o: VerifyOptions): Promise<{ org: string; kid: string }> {
  const input = parseSignatureInput(header(o.headers, 'signature-input'));
  const hasBody = o.body != null && o.body.length > 0;
  if (input.components !== components(hasBody)) {
    throw new IntertieError('bad_signature', `covered components must be ${components(hasBody)}`);
  }
  const now = o.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - input.created) > SIGNATURE_WINDOW_S) throw new IntertieError('stale_signature');
  const { org, kid } = splitKeyid(input.keyid);
  if (o.isValidOrg && !o.isValidOrg(org)) throw new IntertieError('bad_signature', 'keyid org is not a valid org name');
  if (o.nonces.has(input.keyid, input.nonce, now)) throw new IntertieError('replayed');
  let key = await o.resolveKey(org, kid, false);
  if (!key) key = await o.resolveKey(org, kid, true);
  if (!key) throw new IntertieError('unknown_key', `no key ${input.keyid}`);
  let digest: string | null = null;
  if (hasBody) {
    const got = header(o.headers, 'content-digest');
    digest = contentDigest(o.body!);
    if (got !== digest) throw new IntertieError('bad_digest');
  }
  const sigHeader = header(o.headers, 'signature') ?? '';
  const sm = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(sigHeader.trim());
  if (!sm) throw new IntertieError('bad_signature', 'Signature must be sig1=:<base64>:');
  const base = signatureBase(o.method, o.url, digest, input.params);
  if (!edVerify(null, Buffer.from(base, 'utf8'), key, Buffer.from(sm[1], 'base64'))) {
    throw new IntertieError('bad_signature');
  }
  o.nonces.remember(input.keyid, input.nonce, now);
  return { org, kid };
}
