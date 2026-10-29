// Matrix OAuth 2.0 login for bot mode (Matrix spec "OAuth 2.0 API", i.e. MAS on matrix.org):
// dynamic client registration + device authorization grant (RFC 8628) + refresh tokens.
// The operator approves a code in a browser; no token is ever copied by hand. Access tokens on
// matrix.org live for hours, so the session refreshes itself and persists the new pair.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface AuthMetadata {
  issuer: string;
  token_endpoint: string;
  registration_endpoint?: string;
  device_authorization_endpoint?: string;
  revocation_endpoint?: string;
  grant_types_supported?: string[];
}

export interface Session {
  homeserver: string;
  client_id: string;
  token_endpoint: string;
  access_token: string;
  refresh_token?: string;
  /** Unix ms; absent when the server did not say. */
  expires_at?: number;
  device_id: string;
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

async function json<T>(res: Response, what: string): Promise<T> {
  const j = await res.json().catch(() => ({})) as T & { error?: string; error_description?: string };
  if (!res.ok) throw Object.assign(new Error(`${what}: ${j.error ?? res.status}${j.error_description ? ` (${j.error_description})` : ''}`), { oauthError: j.error });
  return j;
}

/** Resolve a server name or URL to the client-server API base URL (via /.well-known/matrix/client). */
export async function resolveHomeserver(input: string): Promise<string> {
  const base = /^https?:\/\//.test(input) ? input.replace(/\/+$/, '') : `https://${input}`;
  try {
    const r = await fetch(`${base}/.well-known/matrix/client`, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const j = await r.json() as { 'm.homeserver'?: { base_url?: string } };
      if (j['m.homeserver']?.base_url) return j['m.homeserver'].base_url.replace(/\/+$/, '');
    }
  } catch { /* fall through */ }
  return base;
}

export async function authMetadata(homeserver: string): Promise<AuthMetadata> {
  const r = await fetch(`${homeserver}/_matrix/client/v1/auth_metadata`, { signal: AbortSignal.timeout(10_000) });
  if (r.status === 404) throw new Error(`${homeserver} does not offer OAuth 2.0 login; use an access token (MATRIX_ACCESS_TOKEN) instead`);
  return json<AuthMetadata>(r, 'auth_metadata');
}

export async function registerClient(meta: AuthMetadata): Promise<string> {
  if (!meta.registration_endpoint) throw new Error('the server does not support dynamic client registration');
  const r = await fetch(meta.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Intertie gateway', client_uri: 'https://intertie.dev/', application_type: 'native',
      grant_types: [DEVICE_GRANT, 'refresh_token'], response_types: [], token_endpoint_auth_method: 'none',
    }),
  });
  return (await json<{ client_id: string }>(r, 'client registration')).client_id;
}

const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });

function scopes(deviceId: string, stable: boolean): string {
  return stable
    ? `urn:matrix:client:api:* urn:matrix:client:device:${deviceId}`
    : `urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${deviceId}`;
}

/** The device authorization grant. `prompt` shows the operator where to approve. */
export async function deviceLogin(homeserver: string, prompt: (p: { url: string; code: string; expiresIn: number }) => void, o: { pollMs?: number } = {}): Promise<Session> {
  const meta = await authMetadata(homeserver);
  if (!meta.device_authorization_endpoint || !(meta.grant_types_supported ?? [DEVICE_GRANT]).includes(DEVICE_GRANT)) throw new Error('the server does not support the device authorization grant');
  const clientId = await registerClient(meta);
  const deviceId = `INTERTIE${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  let auth: { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number } | undefined;
  for (const stable of [true, false]) {
    try {
      auth = await json(await fetch(meta.device_authorization_endpoint, form({ client_id: clientId, scope: scopes(deviceId, stable) })), 'device authorization');
      break;
    } catch (e) { if ((e as { oauthError?: string }).oauthError !== 'invalid_scope' || !stable) throw e; }
  }
  prompt({ url: auth!.verification_uri_complete ?? auth!.verification_uri, code: auth!.user_code, expiresIn: auth!.expires_in });
  let interval = (o.pollMs ?? (auth!.interval ?? 5) * 1000);
  const deadline = Date.now() + auth!.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const res = await fetch(meta.token_endpoint, form({ grant_type: DEVICE_GRANT, device_code: auth!.device_code, client_id: clientId }));
    const j = await res.json().catch(() => ({})) as { error?: string; access_token?: string; refresh_token?: string; expires_in?: number };
    if (j.error === 'authorization_pending') continue;
    if (j.error === 'slow_down') { interval += 5000; continue; }
    if (!res.ok || !j.access_token) throw new Error(`device login failed: ${j.error ?? res.status}`);
    return {
      homeserver, client_id: clientId, token_endpoint: meta.token_endpoint, device_id: deviceId,
      access_token: j.access_token, refresh_token: j.refresh_token,
      ...(j.expires_in ? { expires_at: Date.now() + j.expires_in * 1000 } : {}),
    };
  }
  throw new Error('device login expired before it was approved');
}

/** A session persisted to a mode-600 file that refreshes its access token when needed. */
export class SessionFile {
  readonly path: string;
  session: Session;
  private refreshing?: Promise<string>;
  constructor(path: string) {
    if (!existsSync(path)) throw new Error(`no Matrix session at ${path}; run: intertie-matrix login`);
    this.path = path;
    this.session = JSON.parse(readFileSync(path, 'utf8'));
  }
  static save(path: string, s: Session): void {
    writeFileSync(path, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  /** A token that is valid for at least another minute (refreshing early if we know the expiry). */
  async token(): Promise<string> {
    const s = this.session;
    if (s.expires_at && s.refresh_token && s.expires_at - Date.now() < 60_000) return this.refresh();
    return s.access_token;
  }

  /** Exchange the refresh token. Concurrent callers share one refresh (MAS rotates refresh tokens). */
  refresh(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const s = this.session;
      if (!s.refresh_token) throw new Error('the Matrix access token expired and there is no refresh token; run: intertie-matrix login');
      const r = await fetch(s.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id }));
      const j = await json<{ access_token: string; refresh_token?: string; expires_in?: number }>(r, 'token refresh');
      this.session = { ...s, access_token: j.access_token, refresh_token: j.refresh_token ?? s.refresh_token, ...(j.expires_in ? { expires_at: Date.now() + j.expires_in * 1000 } : {}) };
      SessionFile.save(this.path, this.session);
      return j.access_token;
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
}
