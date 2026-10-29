// Identifier syntax (spec/core.md §2).
import { createHash, randomBytes } from 'node:crypto';

export const LOCAL_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const EVENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Lowercase DNS name in A-label form: labels of 1-63 chars, no leading/trailing hyphen.
const DNS_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEV_RE = /^(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/;

export function isOrgName(s: string, devInsecure = false): boolean {
  if (DNS_RE.test(s) && s.includes('.')) return true;
  return devInsecure && DEV_RE.test(s);
}

/** A 128-bit random id, base64url (22 chars). */
export function newId(): string {
  return randomBytes(16).toString('base64url');
}

/** A deterministic event id derived from an external key (e.g. a Slack event_id). */
export function derivedId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('base64url').slice(0, 22);
}

/** Split `local@org` at the LAST `@`. Returns null if malformed. */
export function parseScoped(id: string): { local: string; org: string } | null {
  const at = id.lastIndexOf('@');
  if (at <= 0 || at === id.length - 1) return null;
  const local = id.slice(0, at);
  if (!LOCAL_RE.test(local)) return null;
  return { local, org: id.slice(at + 1) };
}

export function orgOf(id: string): string | null {
  return parseScoped(id)?.org ?? null;
}

export function scoped(local: string, org: string): string {
  return `${local}@${org}`;
}

/** Invite strings look like `intertie:acme.com/<token>`. */
export function formatInvite(home: string, token: string): string {
  return `intertie:${home}/${token}`;
}

export function parseInvite(s: string): { home: string; token: string } | null {
  const m = /^(?:intertie:)?([^/\s]+)\/([A-Za-z0-9_-]{16,128})$/.exec(s.trim());
  return m ? { home: m[1], token: m[2] } : null;
}
