// Minimal Matrix client-server API client (v3 + authenticated media). No SDK.
// The homeserver URL comes from the operator's config, so it is trusted (it is often on localhost).

export class MatrixError extends Error {
  readonly status: number;
  readonly errcode: string;
  constructor(status: number, errcode: string, message: string) { super(`${errcode}: ${message}`); this.status = status; this.errcode = errcode; }
}

/** A token that can renew itself (OAuth sessions); a plain string never changes. */
export interface TokenSource { token(): Promise<string>; refresh(): Promise<string> }

export interface MatrixApiOptions {
  homeserver: string;
  token: string | TokenSource;
  /** Application Service mode: act as this user via identity assertion (?user_id=). */
  asUser?: string;
}

const enc = encodeURIComponent;

export class MatrixApi {
  readonly hs: string;
  private auth: string | TokenSource;
  private asUser?: string;
  constructor(o: MatrixApiOptions) { this.hs = o.homeserver.replace(/\/+$/, ''); this.auth = o.token; this.asUser = o.asUser; }

  private bearer(): Promise<string> { return typeof this.auth === 'string' ? Promise.resolve(this.auth) : this.auth.token(); }
  /** On an expired token, renew once (OAuth sessions only). */
  private async renew(status: number, errcode?: string): Promise<boolean> {
    if (typeof this.auth === 'string' || status !== 401 || (errcode && errcode !== 'M_UNKNOWN_TOKEN')) return false;
    await this.auth.refresh();
    return true;
  }

  /** A client acting as another user under the same AS token. */
  as(userId: string): MatrixApi { return new MatrixApi({ homeserver: this.hs, token: this.auth, asUser: userId }); }

  async req<T = any>(method: string, path: string, body?: unknown, o: { query?: Record<string, string>; raw?: Uint8Array; contentType?: string; timeoutMs?: number } = {}): Promise<T> {
    const u = new URL(this.hs + path);
    for (const [k, v] of Object.entries(o.query ?? {})) u.searchParams.set(k, v);
    if (this.asUser) u.searchParams.set('user_id', this.asUser);
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(u, {
        method,
        headers: { authorization: `Bearer ${await this.bearer()}`, ...(body !== undefined || o.raw ? { 'content-type': o.contentType ?? 'application/json' } : {}) },
        body: o.raw ? new Uint8Array(o.raw) : body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
      });
      if (res.status === 429 && attempt < 5) {
        const j = await res.json().catch(() => ({})) as { retry_after_ms?: number };
        await new Promise((r) => setTimeout(r, Math.min(j.retry_after_ms ?? 1000, 30_000)));
        continue;
      }
      const j = await res.json().catch(() => ({})) as T & { errcode?: string; error?: string };
      if (!res.ok && !renewed && await this.renew(res.status, j.errcode)) { renewed = true; continue; }
      if (!res.ok) throw new MatrixError(res.status, j.errcode ?? `HTTP_${res.status}`, j.error ?? '');
      return j;
    }
  }

  whoami(): Promise<{ user_id: string }> { return this.req('GET', '/_matrix/client/v3/account/whoami'); }

  send(room: string, type: string, txn: string, content: unknown): Promise<{ event_id: string }> {
    return this.req('PUT', `/_matrix/client/v3/rooms/${enc(room)}/send/${enc(type)}/${enc(txn)}`, content);
  }
  redact(room: string, eventId: string, txn: string, reason?: string): Promise<{ event_id: string }> {
    return this.req('PUT', `/_matrix/client/v3/rooms/${enc(room)}/redact/${enc(eventId)}/${enc(txn)}`, reason ? { reason } : {});
  }
  join(roomIdOrAlias: string): Promise<{ room_id: string }> { return this.req('POST', `/_matrix/client/v3/join/${enc(roomIdOrAlias)}`, {}); }
  invite(room: string, userId: string): Promise<unknown> { return this.req('POST', `/_matrix/client/v3/rooms/${enc(room)}/invite`, { user_id: userId }); }
  leave(room: string): Promise<unknown> { return this.req('POST', `/_matrix/client/v3/rooms/${enc(room)}/leave`, {}); }
  state<T = any>(room: string, type: string, key = ''): Promise<T> { return this.req('GET', `/_matrix/client/v3/rooms/${enc(room)}/state/${enc(type)}/${enc(key)}`); }
  profile(userId: string): Promise<{ displayname?: string; avatar_url?: string }> { return this.req('GET', `/_matrix/client/v3/profile/${enc(userId)}`); }
  setDisplayName(userId: string, name: string): Promise<unknown> { return this.req('PUT', `/_matrix/client/v3/profile/${enc(userId)}/displayname`, { displayname: name }); }
  setAvatar(userId: string, mxc: string): Promise<unknown> { return this.req('PUT', `/_matrix/client/v3/profile/${enc(userId)}/avatar_url`, { avatar_url: mxc }); }

  /** AS mode: register a ghost user in the AS namespace. Already-existing users are fine. */
  async registerGhost(localpart: string): Promise<void> {
    await this.req('POST', '/_matrix/client/v3/register', { type: 'm.login.application_service', username: localpart, inhibit_login: true }).catch((e: MatrixError) => {
      if (e.errcode !== 'M_USER_IN_USE') throw e;
    });
  }

  upload(bytes: Uint8Array, filename: string, contentType: string): Promise<{ content_uri: string }> {
    return this.req('POST', '/_matrix/media/v3/upload', undefined, { raw: bytes, contentType, query: { filename } });
  }

  /** Download mxc:// media: authenticated media first (Matrix 1.11), legacy endpoint as fallback. */
  async download(mxc: string, maxBytes: number): Promise<{ bytes: Buffer; contentType: string }> {
    const m = /^mxc:\/\/([^/]+)\/([A-Za-z0-9_-]+)$/.exec(mxc);
    if (!m) throw new Error(`bad mxc URI ${mxc}`);
    for (const path of [`/_matrix/client/v1/media/download/${enc(m[1])}/${enc(m[2])}`, `/_matrix/media/v3/download/${enc(m[1])}/${enc(m[2])}`]) {
      const u = new URL(this.hs + path);
      if (this.asUser) u.searchParams.set('user_id', this.asUser);
      let res = await fetch(u, { headers: { authorization: `Bearer ${await this.bearer()}` }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
      if (res.status === 401 && await this.renew(401)) res = await fetch(u, { headers: { authorization: `Bearer ${await this.bearer()}` }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
      if (res.status === 404 && path.includes('/v1/')) continue;
      if (!res.ok) throw new MatrixError(res.status, `HTTP_${res.status}`, 'media download failed');
      if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new Error('file too large');
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error('file too large');
      return { bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
    }
    throw new Error('media not found');
  }

  sync(since: string | undefined, timeoutMs: number, filter: unknown): Promise<any> {
    return this.req('GET', '/_matrix/client/v3/sync', undefined, {
      query: { ...(since ? { since } : {}), timeout: String(timeoutMs), filter: JSON.stringify(filter) },
      timeoutMs: timeoutMs + 30_000,
    });
  }
}
