// A fake Matrix homeserver: the client-server API subset the gateway uses, Application Service
// transaction pushes, /sync long-polling, and the media repo. Enough to keep `make check` hermetic.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface MxEvent { event_id: string; room_id: string; type: string; sender: string; content: Record<string, any>; state_key?: string; redacts?: string; origin_server_ts: number; idx: number; redacted?: boolean }
interface Room { id: string; members: Map<string, 'join' | 'invite' | 'leave'>; events: MxEvent[]; power: Record<string, number>; name: string; encrypted: boolean }
interface UserRec { displayname?: string; avatar_url?: string; token?: string }

export class FakeHomeserver {
  readonly serverName = 'hs.test';
  server!: Server;
  base = '';
  users = new Map<string, UserRec>();
  rooms = new Map<string, Room>();
  media = new Map<string, { bytes: Buffer; type: string }>();
  as?: { asToken: string; hsToken: string; url: string; senderLocalpart: string; prefix: string };
  private txns = new Map<string, string>();
  private idx = 0;
  private pending = 0;
  private waiters = new Set<() => void>();
  requests: string[] = [];

  async start(): Promise<void> {
    this.server = createServer((q, r) => { void this.handle(q, r); });
    await new Promise<void>((res) => this.server.listen(0, '127.0.0.1', res));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async stop(): Promise<void> { for (const w of this.waiters) w(); this.server.closeAllConnections(); await new Promise<void>((r) => this.server.close(() => r())); }
  idle(): boolean { return this.pending === 0; }

  registerAppService(url: string, prefix = 'intertie_', senderLocalpart = 'intertie') {
    this.as = { asToken: `as-${randomBytes(6).toString('hex')}`, hsToken: `hs-${randomBytes(6).toString('hex')}`, url, senderLocalpart, prefix };
    this.users.set(this.botId, {});
    return this.as;
  }
  get botId(): string { return `@${this.as?.senderLocalpart ?? 'intertie'}:${this.serverName}`; }

  addUser(localpart: string, displayname: string, server = this.serverName): { id: string; token: string } {
    const id = `@${localpart}:${server}`;
    const token = `tok-${localpart}-${randomBytes(4).toString('hex')}`;
    this.users.set(id, { displayname, token });
    return { id, token };
  }

  createRoom(creator: string, name: string, o: { encrypted?: boolean } = {}): string {
    const id = `!${randomBytes(6).toString('hex')}:${this.serverName}`;
    this.rooms.set(id, { id, members: new Map([[creator, 'join']]), events: [], power: { [creator]: 100 }, name, encrypted: !!o.encrypted });
    this.emit(id, { type: 'm.room.member', sender: creator, state_key: creator, content: { membership: 'join' } });
    return id;
  }

  // ── what a human does in their Matrix client ──
  send(room: string, sender: string, content: Record<string, any>, type = 'm.room.message'): string {
    return this.emit(room, { type, sender, content }).event_id;
  }
  text(room: string, sender: string, body: string, extra: Record<string, any> = {}): string { return this.send(room, sender, { msgtype: 'm.text', body, ...extra }); }
  edit(room: string, sender: string, target: string, body: string): string {
    return this.send(room, sender, { msgtype: 'm.text', body: `* ${body}`, 'm.new_content': { msgtype: 'm.text', body }, 'm.relates_to': { rel_type: 'm.replace', event_id: target } });
  }
  react(room: string, sender: string, target: string, key: string): string {
    return this.send(room, sender, { 'm.relates_to': { rel_type: 'm.annotation', event_id: target, key } }, 'm.reaction');
  }
  redact(room: string, sender: string, target: string): string {
    const t = this.find(target);
    if (t) t.redacted = true;
    return this.emit(room, { type: 'm.room.redaction', sender, content: { redacts: target }, redacts: target }).event_id;
  }
  invite(room: string, sender: string, user: string): void {
    this.rooms.get(room)!.members.set(user, 'invite');
    this.emit(room, { type: 'm.room.member', sender, state_key: user, content: { membership: 'invite' } });
  }
  upload(bytes: Buffer, type: string): string {
    const id = randomBytes(8).toString('hex');
    this.media.set(id, { bytes, type });
    return `mxc://${this.serverName}/${id}`;
  }

  timeline(room: string): MxEvent[] { return this.rooms.get(room)!.events.filter((e) => !e.redacted); }
  messages(room: string): MxEvent[] { return this.timeline(room).filter((e) => e.type === 'm.room.message' && !e.content['m.relates_to']?.rel_type?.startsWith('m.replace')); }
  find(eventId: string): MxEvent | undefined { for (const r of this.rooms.values()) { const e = r.events.find((x) => x.event_id === eventId); if (e) return e; } return undefined; }

  private isAsUser(u: string): boolean { return !!this.as && (u === this.botId || (u.startsWith(`@${this.as.prefix}`) && u.endsWith(`:${this.serverName}`))); }

  private emit(room: string, e: Omit<MxEvent, 'event_id' | 'room_id' | 'origin_server_ts' | 'idx'>): MxEvent {
    const ev: MxEvent = { ...e, event_id: `$${randomBytes(9).toString('base64url')}`, room_id: room, origin_server_ts: Date.now(), idx: ++this.idx };
    this.rooms.get(room)!.events.push(ev);
    for (const w of [...this.waiters]) w();
    // Push to the AS when one of its users is in (or invited to) the room.
    const r = this.rooms.get(room)!;
    if (this.as && [...r.members.entries()].some(([u, m]) => this.isAsUser(u) && m !== 'leave')) {
      const { idx: _i, redacted: _r, ...wire } = ev;
      this.pending++;
      void fetch(`${this.as.url}/_matrix/app/v1/transactions/${ev.idx}`, { method: 'PUT', headers: { authorization: `Bearer ${this.as.hsToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ events: [wire] }) })
        .catch(() => undefined).finally(() => { this.pending--; });
    }
    return ev;
  }

  private actor(req: IncomingMessage, url: URL): string | null {
    const tok = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!tok) return null;
    if (this.as && tok === this.as.asToken) {
      const u = url.searchParams.get('user_id') ?? this.botId;
      return this.isAsUser(u) ? u : null;
    }
    for (const [id, u] of this.users) if (u.token === tok) return id;
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', this.base);
    const p = decodeURIComponent(url.pathname);
    this.requests.push(`${req.method} ${p}`);
    const json = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b)); };
    const err = (status: number, errcode: string, error = '') => json(status, { errcode, error });
    const me = this.actor(req, url);
    if (!me) return err(401, 'M_UNKNOWN_TOKEN');
    const body = () => (raw.length && String(req.headers['content-type']).includes('json') ? JSON.parse(raw.toString('utf8')) : {});
    const room = (id: string) => this.rooms.get(id);
    const joined = (r: Room, u: string) => r.members.get(u) === 'join';
    let m: RegExpExecArray | null;

    if (p === '/_matrix/client/v3/account/whoami') return json(200, { user_id: me });
    if (req.method === 'POST' && p === '/_matrix/client/v3/register') {
      const id = `@${body().username}:${this.serverName}`;
      if (!this.isAsUser(id)) return err(400, 'M_EXCLUSIVE');
      if (this.users.has(id)) return err(400, 'M_USER_IN_USE');
      this.users.set(id, {});
      return json(200, { user_id: id });
    }
    if (req.method === 'POST' && (m = /^\/_matrix\/client\/v3\/join\/(.+)$/.exec(p))) {
      const r = room(m[1]);
      if (!r) return err(404, 'M_NOT_FOUND');
      if (!joined(r, me)) {
        if (r.members.get(me) !== 'invite') return err(403, 'M_FORBIDDEN', 'not invited');
        r.members.set(me, 'join');
        this.emit(r.id, { type: 'm.room.member', sender: me, state_key: me, content: { membership: 'join', displayname: this.users.get(me)?.displayname } });
      }
      return json(200, { room_id: r.id });
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/(.+)$/.exec(p))) {
      const r = room(m[1]);
      if (!r) return err(404, 'M_NOT_FOUND');
      const rest = m[2];
      let x: RegExpExecArray | null;
      if (req.method === 'POST' && rest === 'invite') {
        if (!joined(r, me)) return err(403, 'M_FORBIDDEN');
        const u = body().user_id;
        if (joined(r, u)) return err(403, 'M_FORBIDDEN', 'already joined');
        this.invite(r.id, me, u);
        return json(200, {});
      }
      if (req.method === 'POST' && rest === 'leave') { r.members.set(me, 'leave'); this.emit(r.id, { type: 'm.room.member', sender: me, state_key: me, content: { membership: 'leave' } }); return json(200, {}); }
      if (req.method === 'PUT' && (x = /^send\/([^/]+)\/([^/]+)$/.exec(rest))) {
        if (!joined(r, me)) return err(403, 'M_FORBIDDEN', `${me} not in room`);
        const key = `${me}|${x[2]}`;
        if (this.txns.has(key)) return json(200, { event_id: this.txns.get(key) });
        const ev = this.emit(r.id, { type: x[1], sender: me, content: body() });
        this.txns.set(key, ev.event_id);
        return json(200, { event_id: ev.event_id });
      }
      if (req.method === 'PUT' && (x = /^redact\/([^/]+)\/([^/]+)$/.exec(rest))) {
        if (!joined(r, me)) return err(403, 'M_FORBIDDEN');
        const t = r.events.find((e) => e.event_id === x![1]);
        if (!t) return err(404, 'M_NOT_FOUND');
        if (t.sender !== me && (r.power[me] ?? 0) < 50) return err(403, 'M_FORBIDDEN', 'cannot redact others');
        const key = `${me}|${x[2]}`;
        if (this.txns.has(key)) return json(200, { event_id: this.txns.get(key) });
        const id = this.redact(r.id, me, t.event_id);
        this.txns.set(key, id);
        return json(200, { event_id: id });
      }
      if (req.method === 'GET' && (x = /^state\/([^/]+)\/?(.*)$/.exec(rest))) {
        if (x[1] === 'm.room.power_levels') return json(200, { users: r.power, users_default: 0 });
        if (x[1] === 'm.room.name') return json(200, { name: r.name });
        if (x[1] === 'm.room.encryption') return r.encrypted ? json(200, { algorithm: 'm.megolm.v1.aes-sha2' }) : err(404, 'M_NOT_FOUND');
        return err(404, 'M_NOT_FOUND');
      }
      return err(404, 'M_UNRECOGNIZED');
    }
    if ((m = /^\/_matrix\/client\/v3\/profile\/([^/]+)(?:\/(displayname|avatar_url))?$/.exec(p))) {
      const u = this.users.get(m[1]) ?? {};
      if (req.method === 'GET') return json(200, { displayname: u.displayname, avatar_url: u.avatar_url });
      if (m[1] !== me) return err(403, 'M_FORBIDDEN');
      Object.assign(u, body());
      this.users.set(m[1], u);
      return json(200, {});
    }
    if (req.method === 'POST' && p === '/_matrix/media/v3/upload') {
      return json(200, { content_uri: this.upload(raw, String(req.headers['content-type'] ?? 'application/octet-stream')) });
    }
    if (req.method === 'GET' && (m = /^\/_matrix\/client\/v1\/media\/download\/([^/]+)\/([^/]+)$/.exec(p))) {
      const f = this.media.get(m[2]);
      if (!f || m[1] !== this.serverName) return err(404, 'M_NOT_FOUND');
      res.writeHead(200, { 'content-type': f.type, 'content-length': String(f.bytes.length) }).end(f.bytes);
      return;
    }
    if (req.method === 'GET' && p === '/_matrix/client/v3/sync') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const timeout = Number(url.searchParams.get('timeout') ?? 0);
      const collect = () => {
        const join: Record<string, unknown> = {}, invite: Record<string, unknown> = {};
        for (const r of this.rooms.values()) {
          const evs = r.events.filter((e) => e.idx > since);
          if (joined(r, me) && evs.length) join[r.id] = { timeline: { events: evs.map(({ idx: _i, redacted: _r, room_id: _ro, ...e }) => e) } };
          const inv = evs.find((e) => e.type === 'm.room.member' && e.state_key === me && e.content.membership === 'invite');
          if (r.members.get(me) === 'invite' && inv) invite[r.id] = { invite_state: { events: [{ type: 'm.room.member', sender: inv.sender, state_key: me, content: { membership: 'invite' } }] } };
        }
        return { join, invite };
      };
      let out = collect();
      if (since && !Object.keys(out.join).length && !Object.keys(out.invite).length && timeout > 0) {
        await new Promise<void>((resolve) => { const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); }; const t = setTimeout(done, Math.min(timeout, 2000)); this.waiters.add(done); });
        out = collect();
      }
      return json(200, { next_batch: String(this.idx), rooms: out });
    }
    return err(404, 'M_UNRECOGNIZED');
  }
}
