// The Matrix gateway: an Intertie peer for a Matrix room. spec/matrix-mapping.md.
//   appservice mode: registered as an Application Service on a homeserver the org runs;
//                    remote users appear as ghost users with their own names and avatars.
//   bot mode:        a single account on any homeserver, receiving via /sync; remote users'
//                    names are carried in the message (and a per-message profile).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  derivedId, IntertieError, IntertieNode, safeFetch,
  type FileRef, type IntertieEvent, type Mention, type NodeOptions, type User,
} from '@intertie/core';
import { htmlToMd, mdToHtml, stripReplyFallback } from './format.ts';
import { MatrixApi, MatrixError } from './matrix-api.ts';

export interface GatewayOptions {
  node: Omit<NodeOptions, 'capabilities'> & { capabilities?: string[] };
  matrix: {
    homeserver: string;
    mode: 'appservice' | 'bot';
    /** appservice: tokens from the registration file. */
    asToken?: string;
    hsToken?: string;
    /** appservice: the homeserver's server_name (the part after ':' in user ids). */
    serverName?: string;
    botLocalpart?: string;
    ghostPrefix?: string;
    /** bot: the bot account's access token. */
    accessToken?: string;
    /** Matrix servers whose users this org vouches for. Default: the gateway's own server. */
    localServers?: string[];
    /** Users allowed to run !intertie commands. Default: room power level >= 50. */
    admins?: string[];
  };
  adminToken?: string;
  maxFileBytes?: number;
}

const CAPABILITIES = ['threads', 'reactions', 'files', 'mentions'];
const SCHEMA = `
create table if not exists mx_links(room text primary key, channel text not null unique);
create table if not exists mx_msgs(channel text not null, event_id text not null, mx text not null, primary_ integer not null default 1,
  primary key(channel, mx));
create index if not exists mx_msgs_ev on mx_msgs(channel, event_id);
create table if not exists mx_reactions(channel text not null, target text not null, emoji text not null, reactor text not null, mx text,
  primary key(channel, target, emoji, reactor));
create table if not exists mx_ghosts(user_id text primary key, mxid text not null, displayname text, avatar_src text);
create table if not exists mx_ghost_rooms(mxid text not null, room text not null, primary key(mxid, room));
`;
const FILE_TYPES = new Set(['m.file', 'm.image', 'm.video', 'm.audio']);

export class MatrixGateway {
  readonly node: IntertieNode;
  readonly adminToken: string;
  private o: GatewayOptions;
  private api: MatrixApi;
  private botMxid = '';
  private serverName = '';
  private server?: Server;
  private adminServer?: Server;
  /** Port of the loopback-only admin API (separate from the public endpoint). */
  adminPort = 0;
  private queues = new Map<string, Promise<void>>();
  private pending = 0;
  private seenTxns = new Set<string>();
  private stopped = false;
  private syncAbort?: AbortController;
  private warned = new Set<string>();

  constructor(o: GatewayOptions) {
    this.o = o;
    if (o.matrix.mode === 'appservice' && (!o.matrix.asToken || !o.matrix.hsToken || !o.matrix.serverName)) throw new Error('appservice mode needs asToken, hsToken and serverName');
    if (o.matrix.mode === 'bot' && !o.matrix.accessToken) throw new Error('bot mode needs accessToken');
    this.node = new IntertieNode({ ...o.node, capabilities: o.node.capabilities ?? CAPABILITIES, maxFileBytes: o.maxFileBytes });
    this.node.store.db.exec(SCHEMA);
    this.api = new MatrixApi({ homeserver: o.matrix.homeserver, token: o.matrix.mode === 'appservice' ? o.matrix.asToken! : o.matrix.accessToken! });
    this.adminToken = o.adminToken ?? randomBytes(24).toString('base64url');
    this.node.onEvent((ev, ch) => this.toMatrix(ev, ch.id));
    this.node.onRejected((ev, err) => { void this.rejected(ev, err.code); });
  }

  get mode(): 'appservice' | 'bot' { return this.o.matrix.mode; }

  // ───────────────────────── lifecycle ─────────────────────────

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    if (this.mode === 'appservice') {
      this.serverName = this.o.matrix.serverName!;
      this.botMxid = `@${this.o.matrix.botLocalpart ?? 'intertie'}:${this.serverName}`;
    } else {
      this.botMxid = (await this.api.whoami()).user_id;
      this.serverName = this.botMxid.slice(this.botMxid.indexOf(':') + 1);
    }
    this.server = createServer((req, res) => { void this.route(req, res); });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    // The admin API gets its own loopback listener: behind a same-host reverse proxy every public
    // request also arrives from 127.0.0.1, so a shared port could not tell them apart.
    this.adminServer = createServer((req, res) => { const path = (req.url ?? '/').split('?')[0]; void this.admin(req, res, path); });
    await new Promise<void>((resolve) => this.adminServer!.listen(0, '127.0.0.1', resolve));
    this.adminPort = (this.adminServer.address() as { port: number }).port;
    this.node.start();
    if (this.mode === 'bot') void this.syncLoop();
    this.log('info', 'matrix gateway started', { mode: this.mode, bot: this.botMxid });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.syncAbort?.abort();
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>((r) => this.server!.close(() => r())); }
    if (this.adminServer) { this.adminServer.closeAllConnections(); await new Promise<void>((r) => this.adminServer!.close(() => r())); }
    await Promise.all([...this.queues.values()]);
    await this.node.stop();
  }

  isIdle(): boolean { return this.pending === 0 && this.node.isIdle(); }

  // ───────────────────────── admin ─────────────────────────

  async share(room: string, name?: string): Promise<{ channel: string; invite: string }> {
    const existing = this.channelFor(room);
    if (existing) {
      if (this.node.channel(existing)!.role !== 'home') throw new IntertieError('bad_request', 'this room is linked to a channel homed elsewhere');
      return { channel: existing, invite: this.node.createInvite(existing) };
    }
    await this.ensureJoined(room);
    const roomName = name ?? (await this.api.state<{ name?: string }>(room, 'm.room.name').then((s) => s.name, () => undefined)) ?? 'shared';
    const ch = this.node.createChannel({ name: roomName.slice(0, 80) });
    this.link(room, ch.id);
    return { channel: ch.id, invite: this.node.createInvite(ch.id) };
  }

  async accept(invite: string, room: string): Promise<{ channel: string }> {
    if (this.channelFor(room)) throw new IntertieError('bad_request', 'this room is already linked');
    await this.ensureJoined(room);
    const ch = await this.node.accept(invite);
    this.link(room, ch.id);
    await this.notice(room, `🔗 This room is now shared with ${ch.home} over Intertie. Messages here are copied to the participating organizations.`);
    return { channel: ch.id };
  }

  async unshare(room: string): Promise<void> {
    const id = this.channelFor(room);
    if (!id) throw new IntertieError('bad_request', 'not linked');
    const ch = this.node.channel(id)!;
    if (ch.role === 'home' && ch.state === 'open') this.node.closeChannel(id, 'unshared');
    else if (ch.role === 'peer' && ch.state === 'open') await this.node.leave(id);
  }

  status(): { org: string; mode: string; bot: string; links: { room: string; channel: string; role: string; state: string; participants: string[] }[] } {
    const rows = this.node.store.db.prepare('select * from mx_links').all() as { room: string; channel: string }[];
    return {
      org: this.node.org, mode: this.mode, bot: this.botMxid,
      links: rows.map((r) => {
        const ch = this.node.channel(r.channel);
        return { room: r.room, channel: r.channel, role: ch?.role ?? '?', state: ch?.state ?? '?', participants: ch?.participants.filter((p) => p.state === 'active').map((p) => p.org) ?? [] };
      }),
    };
  }

  private async ensureJoined(room: string): Promise<void> {
    await this.api.join(room).catch((e: MatrixError) => { throw new IntertieError('bad_request', `the gateway cannot join ${room}: ${e.message} (invite ${this.botMxid} first)`); });
    const enc = await this.api.state(room, 'm.room.encryption').then(() => true, () => false);
    if (enc) throw new IntertieError('bad_request', 'this room is end-to-end encrypted; the gateway can only share unencrypted rooms');
  }

  // ───────────────────────── Matrix → Intertie ─────────────────────────

  private enqueue(ev: Record<string, any>): void {
    const key = ev.room_id ?? 'misc';
    this.pending++;
    const next = (this.queues.get(key) ?? Promise.resolve())
      .then(() => this.fromMatrix(ev))
      .catch((err) => this.log('warn', 'matrix event failed', { type: ev?.type, err: String(err) }))
      .finally(() => { this.pending--; });
    this.queues.set(key, next);
  }

  private isOurs(mxid: string): boolean {
    if (mxid === this.botMxid) return true;
    return this.mode === 'appservice' && mxid.startsWith(`@${this.o.matrix.ghostPrefix ?? 'intertie_'}`) && mxid.endsWith(`:${this.serverName}`);
  }
  private isLocal(mxid: string): boolean {
    const server = mxid.slice(mxid.indexOf(':') + 1);
    return (this.o.matrix.localServers ?? [this.serverName]).includes(server);
  }

  async fromMatrix(ev: Record<string, any>): Promise<void> {
    const sent = await this.fromMatrixInner(ev);
    if (sent) this.log('info', 'matrix → intertie', { type: sent.type, channel: sent.channel, id: sent.id, ...(sent.seq ? { seq: sent.seq } : {}) });
  }

  private async fromMatrixInner(ev: Record<string, any>): Promise<IntertieEvent | void> {
    const room: string = ev.room_id;
    const c = ev.content ?? {};
    if (ev.type === 'm.room.member' && ev.state_key === this.botMxid && c.membership === 'invite') {
      if (this.isLocal(ev.sender)) await this.api.join(room).catch((e) => this.log('warn', 'auto-join failed', { err: String(e) }));
      return;
    }
    if (!ev.sender || this.isOurs(ev.sender)) return; // loop prevention
    if (ev.type === 'm.room.message' && typeof c.body === 'string' && c.body.startsWith('!intertie')) return void (await this.command(room, ev.sender, c.body));
    const channel = this.channelFor(room);
    if (!channel) return;
    const ch = this.node.channel(channel);
    if (!ch || ch.state !== 'open') return;
    if (ev.type === 'm.room.encrypted') return void (await this.warnOnce(room, 'encrypted', '⚠️ An encrypted message was sent here. The gateway cannot read encrypted messages, so it was not shared.'));
    if (!this.isLocal(ev.sender)) {
      return void (await this.warnOnce(room, `fed:${ev.sender}`, `⚠️ Messages from ${ev.sender} are not shared: this organization only vouches for users on ${(this.o.matrix.localServers ?? [this.serverName]).join(', ')}.`));
    }
    if (this.eventFor(channel, ev.event_id)) return; // already relayed
    const id = derivedId(this.node.org, ev.event_id);
    const rel = c['m.relates_to'] ?? {};

    if (ev.type === 'm.room.message') {
      if (rel.rel_type === 'm.replace') {
        const target = this.eventFor(channel, rel.event_id);
        if (!target) return;
        const conv = this.convert(c['m.new_content'] ?? c, false);
        return this.node.send(channel, { id, type: 'message.edit', sender: await this.sender(ev.sender), body: { target, text: conv.text || '(empty)', ...(conv.mentions.length ? { mentions: conv.mentions } : {}) } });
      }
      let thread: string | undefined;
      let prefix = '';
      if (rel.rel_type === 'm.thread') {
        thread = this.eventFor(channel, rel.event_id) ?? undefined;
        if (!thread) prefix = '↳ ';
      }
      const isFile = FILE_TYPES.has(c.msgtype) && typeof c.url === 'string';
      const files: FileRef[] = [];
      let caption = '';
      if (isFile) {
        const f = await this.fileFromMatrix(channel, c);
        if (f) files.push(f);
        if (c.filename && c.body !== c.filename) caption = c.body; // Matrix 1.10 media captions
      }
      const conv = isFile ? { text: caption, mentions: [] as Mention[] } : this.convert(c, !!rel['m.in_reply_to']);
      let text = prefix + (c.msgtype === 'm.emote' ? `*${conv.text}*` : conv.text);
      if (!text.trim() && !files.length) return;
      if (!text.trim()) text = '';
      this.remember(channel, id, ev.event_id);
      return this.node.send(channel, {
        id, type: 'message.create', sender: await this.sender(ev.sender),
        body: { text, ...(thread ? { thread } : {}), ...(conv.mentions.length ? { mentions: conv.mentions } : {}), ...(files.length ? { files } : {}) },
      });
    }
    if (ev.type === 'm.reaction' && rel.rel_type === 'm.annotation') {
      const target = this.eventFor(channel, rel.event_id);
      if (!target || typeof rel.key !== 'string' || Buffer.byteLength(rel.key) > 64) return;
      const sender = await this.sender(ev.sender);
      this.node.store.db.prepare('insert or replace into mx_reactions values (?,?,?,?,?)').run(channel, target, rel.key, sender.id, ev.event_id);
      return this.node.send(channel, { id, type: 'reaction.add', sender, body: { target, emoji: rel.key } });
    }
    if (ev.type === 'm.room.redaction') {
      const redacted: string | undefined = ev.redacts ?? c.redacts;
      if (!redacted) return;
      const target = this.eventFor(channel, redacted);
      if (target) {
        this.forget(channel, target);
        return this.node.send(channel, { id, type: 'message.delete', body: { target } });
      }
      const r = this.node.store.db.prepare('select * from mx_reactions where channel = ? and mx = ?').get(channel, redacted) as { target: string; emoji: string; reactor: string } | undefined;
      if (r && r.reactor.endsWith(`@${this.node.org}`)) {
        this.node.store.db.prepare('delete from mx_reactions where channel = ? and mx = ?').run(channel, redacted);
        return this.node.send(channel, { id, type: 'reaction.remove', sender: await this.sender(ev.sender), body: { target: r.target, emoji: r.emoji } });
      }
    }
  }

  private convert(c: Record<string, any>, isReply: boolean): { text: string; mentions: Mention[] } {
    if (c.format === 'org.matrix.custom.html' && typeof c.formatted_body === 'string') {
      const r = htmlToMd(c.formatted_body, (mx) => this.userId(mx));
      return r;
    }
    const body = String(c.body ?? '');
    return { text: isReply ? stripReplyFallback(body) : body, mentions: [] };
  }

  private async fileFromMatrix(channel: string, c: Record<string, any>): Promise<FileRef | null> {
    const cap = this.o.maxFileBytes ?? 25 * 1024 * 1024;
    if (typeof c.info?.size === 'number' && c.info.size > cap) return null;
    try {
      const { bytes, contentType } = await this.api.download(c.url, cap);
      return this.node.storeFile(channel, bytes, { name: String(c.filename ?? c.body ?? 'file'), mime: c.info?.mimetype ?? contentType });
    } catch (e) { this.log('warn', 'media download failed', { err: String(e) }); return null; }
  }

  /** Intertie user id for a Matrix user: readable, unique, within [A-Za-z0-9._-]. */
  userId(mxid: string): string {
    // A ghost stands for a remote user: map it back to that user's own Intertie id.
    const ghost = this.node.store.db.prepare('select user_id from mx_ghosts where mxid = ?').get(mxid) as { user_id: string } | undefined;
    if (ghost) return ghost.user_id;
    const id = this.userIdOf(mxid);
    if (!this.isOurs(mxid)) this.node.store.kvSet(`mx-user:${id}`, mxid); // reverse map, for pills
    return id;
  }

  private userIdOf(mxid: string): string {
    const local = mxid.slice(1, mxid.indexOf(':') > 0 ? mxid.indexOf(':') : undefined).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'user';
    return `${local}-${createHash('sha256').update(mxid).digest('hex').slice(0, 8)}@${this.node.org}`;
  }

  private async sender(mxid: string): Promise<User> {
    const p = await this.api.profile(mxid).catch(() => ({} as { displayname?: string }));
    return { id: this.userId(mxid), name: (p.displayname || mxid).slice(0, 80) };
  }

  // ───────────────────────── Intertie → Matrix ─────────────────────────

  private async toMatrix(ev: IntertieEvent, channel: string): Promise<void> {
    const room = this.roomFor(channel);
    if (!room) return;
    const b = ev.body as Record<string, any>;
    if (ev.type.startsWith('peer.') || ev.type.startsWith('channel.')) return this.controlNotice(ev, room);
    if (ev.origin === this.node.org) return;
    this.log('info', 'intertie → matrix', { type: ev.type, seq: ev.seq, origin: ev.origin, id: ev.id });
    const label = `${ev.sender?.name ?? ev.origin} (${ev.origin})`;
    const actor = ev.sender ? await this.actorFor(ev.sender, ev.origin, room) : this.api;
    const ghost = this.mode === 'appservice';
    const content = (text: string, mentions?: Mention[]) => {
      const { html, userIds } = mdToHtml(text, mentions ?? [], (id) => this.mxidFor(id));
      const c: Record<string, unknown> = {
        msgtype: 'm.text', body: ghost ? text : `${label}: ${text}`, format: 'org.matrix.custom.html',
        formatted_body: ghost ? html : `<strong>${escape(label)}</strong>: ${html}`, 'm.mentions': { user_ids: userIds },
      };
      if (!ghost && ev.sender) c['com.beeper.per_message_profile'] = { id: ev.sender.id, displayname: label };
      return c;
    };
    switch (ev.type) {
      case 'message.create': {
        const rootMx = b.thread ? this.mxFor(channel, b.thread) : undefined;
        const relates = rootMx ? { 'm.relates_to': { rel_type: 'm.thread', event_id: rootMx, is_falling_back: true, 'm.in_reply_to': { event_id: rootMx } } } : {};
        const text = (b.thread && !rootMx ? '↳ ' : '') + (b.text ?? '');
        let primary = true;
        if (text || !b.files?.length) {
          const r = await actor.send(room, 'm.room.message', `it-${ev.id}`, { ...content(text || ' ', b.mentions), ...relates });
          this.remember(channel, ev.id, r.event_id, primary);
          primary = false;
        }
        for (const [i, f] of ((b.files ?? []) as FileRef[]).entries()) {
          try {
            const bytes = await this.node.fetchFile(ev, f);
            const up = await actor.upload(bytes, f.name, f.mime);
            const msgtype = f.mime.startsWith('image/') ? 'm.image' : f.mime.startsWith('video/') ? 'm.video' : f.mime.startsWith('audio/') ? 'm.audio' : 'm.file';
            const r = await actor.send(room, 'm.room.message', `it-${ev.id}-f${i}`, { msgtype, body: f.name, filename: f.name, url: up.content_uri, info: { mimetype: f.mime, size: f.size }, ...relates });
            this.remember(channel, ev.id, r.event_id, primary);
            primary = false;
          } catch (e) {
            this.log('warn', 'file relay failed', { err: String(e) });
            await this.notice(room, `⚠️ ${label} shared ${f.name} (${f.size} bytes), but it could not be fetched.`);
          }
        }
        return;
      }
      case 'message.edit': {
        const mx = this.mxFor(channel, b.target);
        if (!mx) return;
        const c = content(b.text, b.mentions);
        await actor.send(room, 'm.room.message', `it-${ev.id}`, {
          msgtype: 'm.text', body: `* ${c.body}`, format: c.format, formatted_body: `* ${c.formatted_body}`,
          'm.new_content': { msgtype: 'm.text', body: c.body, format: c.format, formatted_body: c.formatted_body, 'm.mentions': c['m.mentions'] },
          'm.mentions': c['m.mentions'], 'm.relates_to': { rel_type: 'm.replace', event_id: mx },
        });
        return;
      }
      case 'message.delete': {
        const all = this.node.store.db.prepare('select mx from mx_msgs where channel = ? and event_id = ?').all(channel, b.target) as { mx: string }[];
        // Deletes carry no sender: redact as whoever posted the original (its ghost), else the bot.
        const orig = this.node.event(channel, b.target);
        const author = orig?.sender && orig.origin !== this.node.org ? await this.actorFor(orig.sender, orig.origin, room) : actor;
        for (const [i, { mx }] of all.entries()) {
          // A ghost can redact its own events; the home's moderation deletes of local users' messages need the bot's power level.
          await author.redact(room, mx, `it-${ev.id}-${i}`).catch(() => this.api.redact(room, mx, `it-${ev.id}-${i}b`)).catch((e) => this.log('warn', 'redact failed', { err: String(e) }));
        }
        this.forget(channel, b.target);
        return;
      }
      case 'reaction.add': case 'reaction.remove': {
        const mx = this.mxFor(channel, b.target);
        if (!mx || !ev.sender) return;
        const db = this.node.store.db;
        if (ghost) {
          // Each remote user is a ghost, so each reaction is a real Matrix reaction by that person.
          if (ev.type === 'reaction.add') {
            if (db.prepare('select 1 from mx_reactions where channel = ? and target = ? and emoji = ? and reactor = ?').get(channel, b.target, b.emoji, ev.sender.id)) return;
            const r = await actor.send(room, 'm.reaction', `it-${ev.id}`, { 'm.relates_to': { rel_type: 'm.annotation', event_id: mx, key: b.emoji } });
            db.prepare('insert or replace into mx_reactions values (?,?,?,?,?)').run(channel, b.target, b.emoji, ev.sender.id, r.event_id);
          } else {
            const row = db.prepare('select mx from mx_reactions where channel = ? and target = ? and emoji = ? and reactor = ?').get(channel, b.target, b.emoji, ev.sender.id) as { mx: string } | undefined;
            if (row?.mx) await actor.redact(room, row.mx, `it-${ev.id}`);
            db.prepare('delete from mx_reactions where channel = ? and target = ? and emoji = ? and reactor = ?').run(channel, b.target, b.emoji, ev.sender.id);
          }
          return;
        }
        // Bot mode: one bot reaction per emoji, reference-counted across remote reactors.
        const key = `bot:${b.emoji}`;
        const count = () => (db.prepare("select count(*) n from mx_reactions where channel = ? and target = ? and emoji = ? and reactor != ?").get(channel, b.target, b.emoji, key) as { n: number }).n;
        if (ev.type === 'reaction.add') {
          const before = count();
          db.prepare('insert or ignore into mx_reactions values (?,?,?,?,null)').run(channel, b.target, b.emoji, ev.sender.id);
          if (before === 0 && count() === 1) {
            const r = await this.api.send(room, 'm.reaction', `it-${ev.id}`, { 'm.relates_to': { rel_type: 'm.annotation', event_id: mx, key: b.emoji } });
            db.prepare('insert or replace into mx_reactions values (?,?,?,?,?)').run(channel, b.target, b.emoji, key, r.event_id);
          }
        } else {
          db.prepare('delete from mx_reactions where channel = ? and target = ? and emoji = ? and reactor = ?').run(channel, b.target, b.emoji, ev.sender.id);
          if (count() === 0) {
            const row = db.prepare('select mx from mx_reactions where channel = ? and target = ? and emoji = ? and reactor = ?').get(channel, b.target, b.emoji, key) as { mx: string } | undefined;
            if (row?.mx) await this.api.redact(room, row.mx, `it-${ev.id}`);
            db.prepare('delete from mx_reactions where channel = ? and target = ? and emoji = ? and reactor = ?').run(channel, b.target, b.emoji, key);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /** The Matrix client that speaks for a remote user: their ghost (appservice) or the bot. */
  private async actorFor(u: User, origin: string, room: string): Promise<MatrixApi> {
    if (this.mode !== 'appservice') return this.api;
    const db = this.node.store.db;
    const localpart = `${this.o.matrix.ghostPrefix ?? 'intertie_'}${createHash('sha256').update(u.id).digest('hex').slice(0, 20)}`;
    const mxid = `@${localpart}:${this.serverName}`;
    const g = db.prepare('select * from mx_ghosts where user_id = ?').get(u.id) as { displayname: string | null; avatar_src: string | null } | undefined;
    const ghost = this.api.as(mxid);
    if (!g) {
      await this.api.registerGhost(localpart);
      db.prepare('insert into mx_ghosts(user_id, mxid) values (?, ?)').run(u.id, mxid);
    }
    const display = `${u.name} (${origin})`.slice(0, 100);
    if (g?.displayname !== display) {
      await ghost.setDisplayName(mxid, display).catch((e) => this.log('warn', 'ghost displayname failed', { err: String(e) }));
      db.prepare('update mx_ghosts set displayname = ? where user_id = ?').run(display, u.id);
    }
    if (u.avatar && g?.avatar_src !== u.avatar) {
      try {
        // Avatar URLs come from peers: fetched with the SSRF-safe client, size- and type-capped.
        const r = await safeFetch(u.avatar, { maxBytes: 1024 * 1024, timeoutMs: 10_000, devInsecure: false });
        const type = String(r.headers['content-type'] ?? '');
        if (r.status === 200 && /^image\/(png|jpeg|gif|webp)$/.test(type)) {
          const up = await ghost.upload(r.body, 'avatar', type);
          await ghost.setAvatar(mxid, up.content_uri);
        }
      } catch (e) { this.log('warn', 'ghost avatar failed', { err: String(e) }); }
      db.prepare('update mx_ghosts set avatar_src = ? where user_id = ?').run(u.avatar, u.id);
    }
    if (!db.prepare('select 1 from mx_ghost_rooms where mxid = ? and room = ?').get(mxid, room)) {
      await this.api.invite(room, mxid).catch(() => undefined); // may already be invited or joined
      await ghost.join(room);
      db.prepare('insert or ignore into mx_ghost_rooms values (?, ?)').run(mxid, room);
    }
    return ghost;
  }

  /** Matrix user id for an Intertie user, when that user is one of ours (for pills). */
  private mxidFor(intertieId: string): string | null {
    if (!intertieId.endsWith(`@${this.node.org}`)) {
      const g = this.node.store.db.prepare('select mxid from mx_ghosts where user_id = ?').get(intertieId) as { mxid: string } | undefined;
      return g?.mxid ?? null;
    }
    return (this.node.store.kvGet(`mx-user:${intertieId}`)) ?? null;
  }

  private async controlNotice(ev: IntertieEvent, room: string): Promise<void> {
    const b = ev.body as Record<string, any>;
    const self = this.node.org;
    if (ev.type === 'peer.join' && b.org !== self) await this.notice(room, `🔗 ${b.display_name ?? b.org} (${b.org}) joined this shared room. Messages here are now copied to ${b.org}.`);
    if (ev.type === 'peer.leave') {
      if (b.org === self) { await this.notice(room, '⛓️‍💥 This room is no longer shared.'); this.unlink(room); }
      else await this.notice(room, `⛓️‍💥 ${b.org} ${b.reason === 'left' ? 'left' : 'was removed from'} this shared room.`);
    }
    if (ev.type === 'channel.close') { await this.notice(room, '⛓️‍💥 This room is no longer shared.'); this.unlink(room); }
  }

  private async notice(room: string, text: string): Promise<void> {
    await this.api.send(room, 'm.room.message', `n-${randomBytes(9).toString('base64url')}`, { msgtype: 'm.notice', body: text })
      .catch((e) => this.log('warn', 'notice failed', { err: String(e) }));
  }
  private async warnOnce(room: string, key: string, text: string): Promise<void> {
    if (this.warned.has(`${room}|${key}`)) return;
    this.warned.add(`${room}|${key}`);
    await this.notice(room, text);
  }
  private async rejected(ev: IntertieEvent, code: string): Promise<void> {
    const room = this.roomFor(ev.channel);
    if (room && ev.type === 'message.create') await this.notice(room, `⚠️ A message could not be delivered to the shared room (${code}).`);
  }

  // ───────────────────────── !intertie commands ─────────────────────────

  private async command(room: string, sender: string, body: string): Promise<void> {
    const [, cmd, arg] = body.trim().split(/\s+/);
    if (!(await this.isAdmin(room, sender))) return this.notice(room, 'Only room moderators (power level 50+) can manage sharing.');
    try {
      if (cmd === 'share') {
        const r = await this.share(room);
        return this.notice(room, `Shared. Give this invite to the other organization's admin (single use, 7 days):\n${r.invite}`);
      }
      if (cmd === 'accept' && arg) { await this.accept(arg, room); return; }
      if (cmd === 'unshare') { await this.unshare(room); return; }
      if (cmd === 'status') {
        const l = this.status().links.find((x) => x.room === room);
        return this.notice(room, l ? `Shared channel ${l.channel} (${l.role}, ${l.state}). Participants: ${l.participants.join(', ') || 'none yet'}. This org: ${this.node.org}.` : `Not shared. This org: ${this.node.org}.`);
      }
      return this.notice(room, '!intertie share · !intertie accept <invite> · !intertie status · !intertie unshare');
    } catch (e) {
      return this.notice(room, `⚠️ ${e instanceof IntertieError ? `${e.code}: ${e.message}` : String(e)}`);
    }
  }

  private async isAdmin(room: string, sender: string): Promise<boolean> {
    if (!this.isLocal(sender)) return false;
    if (this.o.matrix.admins?.length) return this.o.matrix.admins.includes(sender);
    const pl = await this.api.state<{ users?: Record<string, number>; users_default?: number }>(room, 'm.room.power_levels').catch(() => null);
    if (!pl) return false;
    return (pl.users?.[sender] ?? pl.users_default ?? 0) >= 50;
  }

  // ───────────────────────── bot mode: /sync ─────────────────────────

  private async syncLoop(): Promise<void> {
    let since = this.node.store.kvGet('mx-sync-since');
    const filter = { room: { timeline: { limit: since ? 50 : 0 }, state: { lazy_load_members: true } }, presence: { types: [] }, account_data: { types: [] } };
    let attempt = 0;
    while (!this.stopped) {
      try {
        const r = await this.api.sync(since, since ? 30_000 : 0, filter);
        attempt = 0;
        if (since) {
          for (const [room, data] of Object.entries<any>(r.rooms?.invite ?? {})) {
            const inv = (data.invite_state?.events ?? []).find((e: any) => e.type === 'm.room.member' && e.state_key === this.botMxid);
            if (inv && this.isLocal(inv.sender)) await this.api.join(room).catch(() => undefined);
          }
          for (const [room, data] of Object.entries<any>(r.rooms?.join ?? {})) {
            for (const e of data.timeline?.events ?? []) this.enqueue({ ...e, room_id: room });
          }
        }
        since = r.next_batch;
        this.node.store.kvSet('mx-sync-since', since!);
      } catch (e) {
        if (this.stopped) return;
        this.log('warn', 'sync failed', { err: String(e) });
        await new Promise((res) => setTimeout(res, Math.min(30_000, 500 * 2 ** attempt++)));
      }
    }
  }

  // ───────────────────────── HTTP ─────────────────────────

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (path.startsWith('/_matrix/app/')) return this.appservice(req, res, path);
    return this.node.handle(req, res);
  }

  /** Application Service API: the homeserver pushes transactions here. */
  private async appservice(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const json = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b)); };
    if (this.mode !== 'appservice') return json(404, { errcode: 'M_UNRECOGNIZED' });
    const url = new URL(req.url ?? '/', 'http://x');
    const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? url.searchParams.get('access_token') ?? '';
    if (!safeEqual(token, this.o.matrix.hsToken!)) return json(403, { errcode: 'M_FORBIDDEN' });
    const body = await readAll(req, 10 * 1024 * 1024);
    let m: RegExpExecArray | null;
    if (req.method === 'PUT' && (m = /^\/_matrix\/app\/v1\/transactions\/([^/]+)$/.exec(path))) {
      const txn = decodeURIComponent(m[1]);
      if (!this.seenTxns.has(txn)) {
        this.seenTxns.add(txn);
        if (this.seenTxns.size > 10_000) this.seenTxns.delete(this.seenTxns.values().next().value!);
        const j = JSON.parse(body.toString('utf8') || '{}') as { events?: Record<string, any>[] };
        for (const ev of j.events ?? []) this.enqueue(ev);
      }
      return json(200, {});
    }
    if (req.method === 'POST' && path === '/_matrix/app/v1/ping') return json(200, {});
    return json(404, { errcode: 'M_NOT_FOUND' }); // user and room-alias queries: we create ghosts ourselves
  }

  private async admin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const reply = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b)); };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return reply(403, { error: 'loopback only' });
    if (!safeEqual(String(req.headers.authorization ?? ''), `Bearer ${this.adminToken}`)) return reply(401, { error: 'bad admin token' });
    try {
      const body = req.method === 'POST' ? JSON.parse((await readAll(req, 64 * 1024)).toString('utf8') || '{}') : {};
      if (path === '/admin/status') return reply(200, this.status());
      if (path === '/admin/share') return reply(200, await this.share(body.room, body.name));
      if (path === '/admin/accept') return reply(200, await this.accept(body.invite, body.room));
      if (path === '/admin/unshare') { await this.unshare(body.room); return reply(200, { ok: true }); }
      return reply(404, { error: 'not found' });
    } catch (e) {
      return reply(e instanceof IntertieError ? e.status : 500, { error: e instanceof IntertieError ? `${e.code}: ${e.message}` : String(e) });
    }
  }

  // ───────────────────────── state ─────────────────────────

  private link(room: string, channel: string): void {
    this.node.store.db.prepare('insert or replace into mx_links values (?, ?)').run(room, channel);
    this.log('audit', 'matrix.link', { room, channel });
  }
  private unlink(room: string): void {
    this.node.store.db.prepare('delete from mx_links where room = ?').run(room);
    this.log('audit', 'matrix.unlink', { room });
  }
  channelFor(room: string): string | null {
    return (this.node.store.db.prepare('select channel from mx_links where room = ?').get(room) as { channel: string } | undefined)?.channel ?? null;
  }
  roomFor(channel: string): string | null {
    return (this.node.store.db.prepare('select room from mx_links where channel = ?').get(channel) as { room: string } | undefined)?.room ?? null;
  }
  private remember(channel: string, eventId: string, mx: string, primary = true): void {
    this.node.store.db.prepare('insert or ignore into mx_msgs values (?,?,?,?)').run(channel, eventId, mx, primary ? 1 : 0);
  }
  private mxFor(channel: string, eventId: string): string | undefined {
    return (this.node.store.db.prepare('select mx from mx_msgs where channel = ? and event_id = ? order by primary_ desc limit 1').get(channel, eventId) as { mx: string } | undefined)?.mx;
  }
  private eventFor(channel: string, mx: string): string | null {
    return (this.node.store.db.prepare('select event_id from mx_msgs where channel = ? and mx = ?').get(channel, mx) as { event_id: string } | undefined)?.event_id ?? null;
  }
  private forget(channel: string, eventId: string): void {
    this.node.store.db.prepare('delete from mx_msgs where channel = ? and event_id = ?').run(channel, eventId);
  }

  private log(level: 'info' | 'warn' | 'audit', msg: string, data?: Record<string, unknown>): void { this.o.node.log?.(level, msg, data); }
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readAll(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > max) { req.destroy(); reject(new Error('too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
