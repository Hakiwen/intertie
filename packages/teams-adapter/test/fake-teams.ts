// A fake Microsoft Teams + Bot Framework: OpenID/JWKS with endorsements, a client-credentials token
// endpoint, the Connector REST API (threads, replies, update, delete), and user actions that arrive at
// the bot as RS256-signed activities. Like Teams, it never delivers the bot's own messages back.
import { generateKeyPairSync, sign, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface TeamsMsg { id: string; channel: string; root: string; fromBot: boolean; from: string; html: string; deleted?: boolean; attachments?: unknown[]; entities?: unknown[] }

export class FakeTeams {
  server!: Server;
  base = '';
  readonly tenant = 'tenant-0000';
  readonly appId = '11111111-2222-3333-4444-555555555555';
  readonly appPassword = 'secret-value';
  botUrl = '';                  // the adapter's /api/messages
  msgs: TeamsMsg[] = [];
  calls: { method: string; path: string; body: any }[] = [];
  private seq = 1730228580000;
  private pending = 0;
  private priv: KeyObject;
  private kid = 'test-kid-1';
  private jwk: Record<string, unknown>;
  tokensIssued = 0;
  users = new Map<string, { teamsId: string; name: string }>(); // aad → …

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.priv = privateKey;
    this.jwk = { ...publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', endorsements: ['msteams'] };
  }
  get serviceUrl(): string { return `${this.base}/svc/`; }
  get openIdConfigUrl(): string { return `${this.base}/openid`; }
  idle(): boolean { return this.pending === 0; }

  async start(): Promise<void> {
    this.server = createServer((q, r) => { void this.handle(q, r); });
    await new Promise<void>((res) => this.server.listen(0, '127.0.0.1', res));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async stop(): Promise<void> { this.server.closeAllConnections(); await new Promise<void>((r) => this.server.close(() => r())); }

  addUser(aad: string, name: string): void { this.users.set(aad, { teamsId: `29:${aad}`, name }); }
  channel(name: string): string { return `19:${name}@thread.tacv2`; }
  messages(channel: string): TeamsMsg[] { return this.msgs.filter((m) => m.channel === channel && !m.deleted); }
  botMessages(channel: string): TeamsMsg[] { return this.messages(channel).filter((m) => m.fromBot); }

  /** A signed JWT the way the Bot Framework connector sends it. Overrides let tests forge bad ones. */
  jwt(o: { aud?: string; iss?: string; serviceUrl?: string; exp?: number; key?: KeyObject; kid?: string } = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: o.kid ?? this.kid })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss: o.iss ?? 'https://api.botframework.com', aud: o.aud ?? this.appId, nbf: now - 10, exp: o.exp ?? now + 3600, serviceurl: o.serviceUrl ?? this.serviceUrl })).toString('base64url');
    const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), o.key ?? this.priv).toString('base64url');
    return `${h}.${p}.${s}`;
  }

  /** Deliver an activity to the bot. Returns the HTTP status. */
  async deliver(activity: Record<string, unknown>, token = this.jwt()): Promise<number> {
    this.pending++;
    try {
      const r = await fetch(this.botUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(activity) });
      return r.status;
    } finally { this.pending--; }
  }

  private base_(aad: string, channel: string, conv: string) {
    const u = this.users.get(aad)!;
    return {
      channelId: 'msteams', serviceUrl: this.serviceUrl, timestamp: new Date().toISOString(),
      from: { id: u.teamsId, name: u.name, aadObjectId: aad },
      conversation: { id: conv, conversationType: 'channel', tenantId: this.tenant },
      recipient: { id: `28:${this.appId}`, name: 'Intertie' },
      channelData: { tenant: { id: this.tenant }, channel: { id: channel, name: channel.slice(3, channel.indexOf('@')) }, team: { id: '19:team@thread.tacv2' } },
    };
  }

  /** A user posts in a channel (top-level, or a reply in the thread of `root`). */
  async post(channel: string, aad: string, html: string, o: { root?: string; mentionBot?: boolean; mentions?: { aad: string }[]; attachments?: unknown[] } = {}): Promise<string> {
    const id = String(++this.seq);
    const root = o.root ?? id;
    this.msgs.push({ id, channel, root, fromBot: false, from: aad, html });
    const entities: unknown[] = [];
    let text = html;
    if (o.mentionBot) { text = `<at>Intertie</at> ${text}`; entities.push({ type: 'mention', text: '<at>Intertie</at>', mentioned: { id: `28:${this.appId}`, name: 'Intertie' } }); }
    for (const m of o.mentions ?? []) { const u = this.users.get(m.aad)!; entities.push({ type: 'mention', text: `<at>${u.name}</at>`, mentioned: { id: u.teamsId, name: u.name } }); }
    await this.deliver({ ...this.base_(aad, channel, `${channel};messageid=${root}`), type: 'message', id, text, textFormat: 'xml', entities,
      attachments: [{ contentType: 'text/html', content: text }, ...(o.attachments ?? [])] });
    return id;
  }
  async edit(channel: string, aad: string, id: string, html: string): Promise<void> {
    const m = this.msgs.find((x) => x.id === id)!;
    m.html = html;
    await this.deliver({ ...this.base_(aad, channel, `${channel};messageid=${m.root}`), type: 'messageUpdate', id, text: html, textFormat: 'xml',
      attachments: [{ contentType: 'text/html', content: html }], channelData: { ...this.base_(aad, channel, '').channelData, eventType: 'editMessage' } });
  }
  async remove(channel: string, aad: string, id: string): Promise<void> {
    const m = this.msgs.find((x) => x.id === id)!;
    m.deleted = true;
    await this.deliver({ ...this.base_(aad, channel, `${channel};messageid=${m.root}`), type: 'messageDelete', id, channelData: { ...this.base_(aad, channel, '').channelData, eventType: 'softDeleteMessage' } });
  }
  /** Teams only reports reactions on the bot's own messages. */
  async react(channel: string, aad: string, botMsgId: string, type: string, add = true): Promise<void> {
    const m = this.msgs.find((x) => x.id === botMsgId)!;
    if (!m.fromBot) throw new Error('Teams does not report reactions on user messages to bots');
    await this.deliver({ ...this.base_(aad, channel, `${channel};messageid=${m.root}`), type: 'messageReaction', id: String(++this.seq), replyToId: botMsgId,
      ...(add ? { reactionsAdded: [{ type }] } : { reactionsRemoved: [{ type }] }) });
  }
  /** The app was added to a team: Teams sends conversationUpdate for the General channel. */
  async install(channel: string): Promise<void> {
    await this.deliver({ type: 'conversationUpdate', channelId: 'msteams', serviceUrl: this.serviceUrl, id: String(++this.seq),
      conversation: { id: channel, conversationType: 'channel', tenantId: this.tenant }, recipient: { id: `28:${this.appId}` },
      channelData: { eventType: 'teamMemberAdded', tenant: { id: this.tenant }, team: { id: '19:team@thread.tacv2' }, channel: { id: channel, name: channel.slice(3, channel.indexOf('@')) } },
      membersAdded: [{ id: `28:${this.appId}` }] });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const p = decodeURIComponent(new URL(req.url ?? '/', this.base).pathname);
    const json = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b)); };
    if (p === '/openid') return json(200, { issuer: 'https://api.botframework.com', jwks_uri: `${this.base}/keys`, id_token_signing_alg_values_supported: ['RS256'] });
    if (p === '/keys') return json(200, { keys: [this.jwk] });
    if (req.method === 'POST' && p === `/${this.tenant}/oauth2/v2.0/token`) {
      const f = new URLSearchParams(raw);
      if (f.get('client_id') !== this.appId || f.get('client_secret') !== this.appPassword || f.get('scope') !== 'https://api.botframework.com/.default') return json(401, { error: 'invalid_client' });
      this.tokensIssued++;
      return json(200, { token_type: 'Bearer', expires_in: 3600, access_token: `bf-${randomBytes(8).toString('hex')}` });
    }
    if (!p.startsWith('/svc/v3/')) return json(404, {});
    if (!/^Bearer bf-/.test(String(req.headers.authorization ?? ''))) return json(401, { error: { code: 'Unauthorized' } });
    const body = raw ? JSON.parse(raw) : undefined;
    this.calls.push({ method: req.method!, path: p.slice(4), body });
    let m: RegExpExecArray | null;
    if (req.method === 'POST' && p === '/svc/v3/conversations') {
      const channel = body.channelData.channel.id;
      const id = String(++this.seq);
      this.msgs.push({ id, channel, root: id, fromBot: true, from: 'bot', html: body.activity.text, attachments: body.activity.attachments, entities: body.activity.entities });
      return json(201, { id: `${channel};messageid=${id}`, activityId: id });
    }
    if (req.method === 'POST' && (m = /^\/svc\/v3\/conversations\/([^/]+)\/activities$/.exec(p))) {
      const [channel, rootPart] = m[1].split(';messageid=');
      const id = String(++this.seq);
      this.msgs.push({ id, channel, root: rootPart ?? id, fromBot: true, from: 'bot', html: body.text, attachments: body.attachments, entities: body.entities });
      return json(201, { id });
    }
    if ((m = /^\/svc\/v3\/conversations\/([^/]+)\/activities\/([^/]+)$/.exec(p))) {
      const msg = this.msgs.find((x) => x.id === m![2]);
      if (!msg) return json(404, { error: { code: 'NotFound' } });
      if (!msg.fromBot) return json(403, { error: { code: 'Forbidden', message: 'bots cannot modify user messages' } });
      if (req.method === 'PUT') { msg.html = body.text; msg.entities = body.entities; return json(200, { id: msg.id }); }
      if (req.method === 'DELETE') { msg.deleted = true; return json(200, {}); }
    }
    return json(404, {});
  }
}
