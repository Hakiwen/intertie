// Minimal Slack Web API client: form-encoded POSTs, 429 handling, no SDK.

export class SlackError extends Error {
  readonly error: string;
  constructor(method: string, error: string) { super(`${method}: ${error}`); this.error = error; }
}

export interface SlackApiOptions {
  token: string;
  /** Default https://slack.com/api. Tests point it at a fake. */
  baseUrl?: string;
}

export class SlackApi {
  private token: string;
  readonly baseUrl: string;
  constructor(o: SlackApiOptions) {
    this.token = o.token;
    this.baseUrl = (o.baseUrl ?? 'https://slack.com/api').replace(/\/+$/, '');
  }

  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, token = this.token): Promise<T> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { ...(token && token !== 'none' ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        redirect: 'error',
      });
      if (res.status === 429 && attempt < 5) {
        const wait = Number(res.headers.get('retry-after') ?? '1');
        await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000));
        continue;
      }
      const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok: boolean; error?: string };
      if (!json.ok) throw new SlackError(method, json.error ?? 'unknown_error');
      return json as T;
    }
  }

  /** Download a private Slack file (url_private_download) with the bot token. */
  async download(url: string, maxBytes: number): Promise<Buffer> {
    const u = new URL(url);
    const api = new URL(this.baseUrl);
    // Only ever send the token to Slack itself (or the configured API host, for tests).
    if (!(u.protocol === 'https:' && (u.hostname === 'files.slack.com' || u.hostname.endsWith('.slack.com'))) && u.host !== api.host) {
      throw new Error(`refusing to send the Slack token to ${u.host}`);
    }
    const res = await fetch(u, { headers: { authorization: `Bearer ${this.token}` }, redirect: 'error' });
    if (!res.ok) throw new Error(`file download HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > maxBytes) throw new Error('file too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('file too large');
    return buf;
  }

  /** Upload a file into a channel via the external-upload flow (files.upload is retired). */
  async uploadFile(o: { channel: string; threadTs?: string; filename: string; bytes: Buffer; title?: string; initialComment?: string }): Promise<void> {
    const r = await this.call<{ upload_url: string; file_id: string }>('files.getUploadURLExternal', { filename: o.filename, length: o.bytes.length });
    const up = await fetch(r.upload_url, { method: 'POST', body: new Uint8Array(o.bytes), redirect: 'error' });
    if (!up.ok) throw new Error(`file upload HTTP ${up.status}`);
    await this.call('files.completeUploadExternal', {
      files: [{ id: r.file_id, title: o.title ?? o.filename }],
      channel_id: o.channel, thread_ts: o.threadTs, initial_comment: o.initialComment,
    });
  }
}
