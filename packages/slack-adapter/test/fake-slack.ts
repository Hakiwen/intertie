// A fake Slack (Web API + Events API delivery) so CI needs no real workspace.
// It echoes the app's own posts back as events, as real Slack does, to exercise loop prevention.
import { createHash, createHmac } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeMsg {
  ts: string; text: string; user?: string; bot_id?: string; username?: string; icon_url?: string;
  thread_ts?: string; files?: FakeFile[]; reactions: Map<string, Set<string>>; deleted?: boolean;
}
export interface FakeFile { id: string; name: string; mimetype: string; bytes: Buffer }
export interface Team {
  id: string; token: string; botUserId: string; botId: string; signingSecret: string; eventsUrl?: string;
  users: Record<string, { name: string; admin?: boolean; team?: string }>;
  /** Socket Mode: events go over a WebSocket instead of HTTP. */
  appToken?: string;
  socket?: Duplex;
  channels: Map<string, FakeMsg[]>;
  ephemeral: { channel: string; user: string; text: string }[];
}
export interface Call { team: string; method: string; params: Record<string, string> }

export class FakeSlack {
  server!: Server;
  base = '';
  teams = new Map<string, Team>();
  calls: Call[] = [];
  private pending = 0;
  private seq = 0;
  private uploads = new Map<string, { team: string; name: string; bytes?: Buffer }>();
  private files = new Map<string, FakeFile>();
  private acks = new Map<string, () => void>();

  async start(): Promise<void> {
    this.server = createServer((q, r) => { void this.handle(q, r); });
    this.server.on('upgrade', (req, sock) => this.upgrade(req, sock));
    await new Promise<void>((res) => this.server.listen(0, '127.0.0.1', res));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async stop(): Promise<void> { this.server.closeAllConnections(); await new Promise<void>((r) => this.server.close(() => r())); }
  get apiUrl(): string { return `${this.base}/api`; }
  idle(): boolean { return this.pending === 0; }

  addTeam(id: string, users: Team['users'], channels: string[]): Team {
    const t: Team = {
      id, token: `xoxb-fake-${id}`, botUserId: `UBOT${id}`, botId: `B${id}`, signingSecret: `secret-${id}`,
      users, channels: new Map(channels.map((c) => [c, []])), ephemeral: [],
    };
    this.teams.set(t.token, t);
    return t;
  }

  messages(t: Team, channel: string): FakeMsg[] { return (t.channels.get(channel) ?? []).filter((m) => !m.deleted); }
  callsFor(t: Team, method: string): Call[] { return this.calls.filter((c) => c.team === t.id && c.method === method); }

  // ── user actions (what a human does in the Slack client) ──
  userPost(t: Team, channel: string, user: string, text: string, o: { thread_ts?: string; files?: Omit<FakeFile, 'id'>[] } = {}): string {
    const files = (o.files ?? []).map((f) => { const ff = { ...f, id: `F${++this.seq}` }; this.files.set(ff.id, ff); return ff; });
    const m: FakeMsg = { ts: this.ts(), text, user, thread_ts: o.thread_ts, files: files.length ? files : undefined, reactions: new Map() };
    t.channels.get(channel)!.push(m);
    this.emit(t, {
      type: 'message', ...(files.length ? { subtype: 'file_share' } : {}), channel, user, text, ts: m.ts,
      ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}),
      ...(files.length ? { files: files.map((f) => ({ id: f.id, name: f.name, mimetype: f.mimetype, size: f.bytes.length, url_private_download: `${this.base}/files-pri/${t.id}/${f.id}` })) } : {}),
    });
    return m.ts;
  }
  userEdit(t: Team, channel: string, ts: string, text: string): void {
    const m = this.find(t, channel, ts)!;
    const prev = { ...m };
    m.text = text;
    this.emit(t, { type: 'message', subtype: 'message_changed', channel, hidden: true, message: { type: 'message', user: m.user, text, ts }, previous_message: { type: 'message', user: prev.user, text: prev.text, ts } });
  }
  userDelete(t: Team, channel: string, ts: string): void {
    const m = this.find(t, channel, ts)!;
    m.deleted = true;
    this.emit(t, { type: 'message', subtype: 'message_deleted', channel, hidden: true, deleted_ts: ts, previous_message: { type: 'message', user: m.user, bot_id: m.bot_id, text: m.text, ts } });
  }
  userReact(t: Team, channel: string, ts: string, user: string, name: string, add = true): void {
    const m = this.find(t, channel, ts)!;
    const set = m.reactions.get(name) ?? new Set();
    if (add) set.add(user); else set.delete(user);
    m.reactions.set(name, set);
    this.emit(t, { type: add ? 'reaction_added' : 'reaction_removed', user, reaction: name, item: { type: 'message', channel, ts }, event_ts: this.ts() });
  }
  /** Simulates Slack's "edited" echo when a thread reply changes the parent's metadata. */
  parentMetadataChanged(t: Team, channel: string, ts: string): void {
    const m = this.find(t, channel, ts)!;
    this.emit(t, { type: 'message', subtype: 'message_changed', channel, hidden: true, message: { user: m.user, bot_id: m.bot_id, text: m.text, ts, reply_count: 1 }, previous_message: { user: m.user, bot_id: m.bot_id, text: m.text, ts } });
  }

  private find(t: Team, channel: string, ts: string): FakeMsg | undefined { return t.channels.get(channel)?.find((m) => m.ts === ts); }
  private ts(): string { return `${1761764580 + ++this.seq}.${String(this.seq).padStart(6, '0')}`; }

  /** Deliver an event to the team's adapter: Socket Mode if connected, else the Events API, signed like Slack. */
  private emit(t: Team, event: Record<string, unknown>): void {
    if (t.appToken) { this.envelope(t, 'events_api', { team_id: t.id, event, event_id: `Ev${++this.seq}` }); return; }
    if (!t.eventsUrl) return;
    const body = JSON.stringify({ type: 'event_callback', team_id: t.id, event, event_id: `Ev${++this.seq}` });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = 'v0=' + createHmac('sha256', t.signingSecret).update(`v0:${ts}:${body}`).digest('hex');
    this.pending++;
    void fetch(t.eventsUrl, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig } })
      .catch(() => undefined).finally(() => { this.pending--; });
  }

  /** Socket Mode: send an envelope and count it pending until the client acks it. */
  envelope(t: Team, type: string, payload: Record<string, unknown>): void {
    if (!t.socket) return;
    const id = `env-${++this.seq}`;
    this.pending++;
    this.acks.set(id, () => { this.pending--; });
    t.socket.write(wsFrame(JSON.stringify({ envelope_id: id, type, payload, accepts_response_payload: type === 'slash_commands' })));
  }
  slash(t: Team, channel: string, user: string, text: string): void {
    this.envelope(t, 'slash_commands', { command: '/intertie', text, user_id: user, channel_id: channel, team_id: t.id });
  }
  /** Ask the client to reconnect, as Slack does periodically. */
  disconnect(t: Team): void {
    t.socket?.write(wsFrame(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' })));
  }

  private upgrade(req: IncomingMessage, sock: Duplex): void {
    const t = [...this.teams.values()].find((x) => req.url === `/ws/${x.id}`);
    if (!t) { sock.destroy(); return; }
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const old = t.socket;
    t.socket = sock;
    if (old) setTimeout(() => old.end(wsFrame('', 0x8)), 50);
    sock.write(wsFrame(JSON.stringify({ type: 'hello' })));
    let buf = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const f = readFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.used);
        if (f.opcode === 0x8) { sock.end(); return; }
        if (f.opcode !== 0x1) continue;
        const m = JSON.parse(f.payload.toString('utf8')) as { envelope_id?: string };
        if (m.envelope_id) { this.acks.get(m.envelope_id)?.(); this.acks.delete(m.envelope_id); }
      }
    });
    sock.on('error', () => undefined);
    sock.on('close', () => { if (t.socket === sock) t.socket = undefined; });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', this.base);
    const json = (b: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b)); };
    if (url.pathname.startsWith('/upload/')) {
      const u = this.uploads.get(url.pathname.slice(8));
      if (!u) return json({ ok: false }, 404);
      u.bytes = raw;
      res.writeHead(200).end('OK');
      return;
    }
    if (url.pathname === '/api/apps.connections.open') {
      const t = [...this.teams.values()].find((x) => x.appToken && req.headers.authorization === `Bearer ${x.appToken}`);
      return t ? json({ ok: true, url: `${this.base.replace('http', 'ws')}/ws/${t.id}` }) : json({ ok: false, error: 'invalid_auth' });
    }
    const team = [...this.teams.values()].find((t) => req.headers.authorization === `Bearer ${t.token}`);
    if (url.pathname.startsWith('/files-pri/')) {
      const [, , tid, fid] = url.pathname.split('/');
      const f = this.files.get(fid);
      if (!team || team.id !== tid || !f) return json({ ok: false }, 403);
      res.writeHead(200, { 'content-type': f.mimetype, 'content-length': String(f.bytes.length) }).end(f.bytes);
      return;
    }
    if (!url.pathname.startsWith('/api/')) return json({ ok: false, error: 'not_found' }, 404);
    if (!team) return json({ ok: false, error: 'invalid_auth' });
    const method = url.pathname.slice(5);
    const p = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
    this.calls.push({ team: team.id, method, params: p });
    const t = team;
    const ch = (id: string) => t.channels.get(id);
    switch (method) {
      case 'auth.test': return json({ ok: true, user_id: t.botUserId, bot_id: t.botId, team_id: t.id });
      case 'users.info': {
        const u = t.users[p.user];
        if (!u) return json({ ok: false, error: 'user_not_found' });
        return json({ ok: true, user: { id: p.user, team_id: u.team ?? t.id, name: u.name.toLowerCase(), is_admin: !!u.admin, profile: { display_name: u.name, real_name: u.name, image_192: `https://avatars.example/${p.user}.png` } } });
      }
      case 'conversations.info': return ch(p.channel) ? json({ ok: true, channel: { id: p.channel, name: p.channel.toLowerCase(), is_private: false, topic: { value: '' } } }) : json({ ok: false, error: 'channel_not_found' });
      case 'conversations.join': return json({ ok: true });
      case 'conversations.list': return json({ ok: true, channels: [...t.channels.keys()].map((id) => ({ id, name: id.toLowerCase() })), response_metadata: { next_cursor: '' } });
      case 'chat.postEphemeral': t.ephemeral.push({ channel: p.channel, user: p.user, text: p.text }); return json({ ok: true });
      case 'chat.postMessage': {
        if (!ch(p.channel)) return json({ ok: false, error: 'channel_not_found' });
        const m: FakeMsg = { ts: this.ts(), text: p.text, bot_id: t.botId, user: t.botUserId, username: p.username, icon_url: p.icon_url, thread_ts: p.thread_ts, reactions: new Map() };
        ch(p.channel)!.push(m);
        this.emit(t, { type: 'message', subtype: 'bot_message', channel: p.channel, bot_id: t.botId, username: p.username, text: p.text, ts: m.ts, ...(p.thread_ts ? { thread_ts: p.thread_ts } : {}) });
        return json({ ok: true, channel: p.channel, ts: m.ts });
      }
      case 'chat.update': {
        const m = this.find(t, p.channel, p.ts);
        if (!m) return json({ ok: false, error: 'message_not_found' });
        if (m.bot_id !== t.botId) return json({ ok: false, error: 'cant_update_message' });
        const prev = m.text;
        m.text = p.text;
        this.emit(t, { type: 'message', subtype: 'message_changed', channel: p.channel, message: { bot_id: t.botId, text: p.text, ts: m.ts }, previous_message: { bot_id: t.botId, text: prev, ts: m.ts } });
        return json({ ok: true });
      }
      case 'chat.delete': {
        const m = this.find(t, p.channel, p.ts);
        if (!m || m.deleted) return json({ ok: false, error: 'message_not_found' });
        if (m.bot_id !== t.botId) return json({ ok: false, error: 'cant_delete_message' });
        m.deleted = true;
        this.emit(t, { type: 'message', subtype: 'message_deleted', channel: p.channel, deleted_ts: m.ts, previous_message: { bot_id: t.botId, text: m.text, ts: m.ts } });
        return json({ ok: true });
      }
      case 'reactions.add': case 'reactions.remove': {
        const m = this.find(t, p.channel, p.timestamp);
        if (!m) return json({ ok: false, error: 'message_not_found' });
        const set = m.reactions.get(p.name) ?? new Set();
        const add = method === 'reactions.add';
        if (add && set.has(t.botUserId)) return json({ ok: false, error: 'already_reacted' });
        if (!add && !set.has(t.botUserId)) return json({ ok: false, error: 'no_reaction' });
        if (add) set.add(t.botUserId); else set.delete(t.botUserId);
        m.reactions.set(p.name, set);
        this.emit(t, { type: add ? 'reaction_added' : 'reaction_removed', user: t.botUserId, reaction: p.name, item: { type: 'message', channel: p.channel, ts: p.timestamp } });
        return json({ ok: true });
      }
      case 'files.getUploadURLExternal': {
        const id = `F${++this.seq}`;
        this.uploads.set(id, { team: t.id, name: p.filename });
        return json({ ok: true, upload_url: `${this.base}/upload/${id}`, file_id: id });
      }
      case 'files.completeUploadExternal': {
        const list = JSON.parse(p.files) as { id: string; title?: string }[];
        const files = list.map((f) => { const u = this.uploads.get(f.id)!; return { id: f.id, name: u.name, mimetype: 'application/octet-stream', bytes: u.bytes ?? Buffer.alloc(0) }; });
        const m: FakeMsg = { ts: this.ts(), text: p.initial_comment ?? '', bot_id: t.botId, user: t.botUserId, thread_ts: p.thread_ts, files, reactions: new Map() };
        ch(p.channel_id)!.push(m);
        this.emit(t, { type: 'message', subtype: 'file_share', channel: p.channel_id, bot_id: t.botId, user: t.botUserId, text: m.text, ts: m.ts, files: files.map((f) => ({ id: f.id, name: f.name, size: f.bytes.length })) });
        return json({ ok: true });
      }
      default: return json({ ok: false, error: 'unknown_method' });
    }
  }
}

function wsFrame(text: string, opcode = 0x1): Buffer {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x80 | opcode, p.length])
    : p.length < 65536 ? Buffer.from([0x80 | opcode, 126, p.length >> 8, p.length & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(p.length)); return b; })()]);
  return Buffer.concat([head, p]);
}

function readFrame(b: Buffer): { opcode: number; payload: Buffer; used: number } | null {
  if (b.length < 2) return null;
  const opcode = b[0] & 0x0f;
  const masked = (b[1] & 0x80) !== 0;
  let len = b[1] & 0x7f, off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  const mask = masked ? b.subarray(off, off + 4) : null;
  if (masked) off += 4;
  if (b.length < off + len) return null;
  const payload = Buffer.from(b.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { opcode, payload, used: off + len };
}
