// The Intertie protocol engine: one org, acting as home for the channels it shares and as
// peer for the channels it joined. Transport and rules follow spec/core.md section by section.
import { createHash, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DiscoveryClient, PROTOCOL_VERSION, WELL_KNOWN_PATH, type DiscoveryDoc } from './discovery.ts';
import { IntertieError } from './errors.ts';
import { HOME_ONLY, LIMITS, TARGETED, validateEvent, type FileRef, type IntertieEvent, type User } from './events.ts';
import { formatInvite, isOrgName, newId, parseInvite } from './ids.ts';
import { safeFetch } from './net.ts';
import { importPrivate, NonceCache, publicJwk, signRequest, verifyRequest, type PrivateJwk } from './signing.ts';
import { Store, type ChannelRow, type Delivery, type ParticipantRow } from './store.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'audit';
export type Logger = (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;

export interface NodeOptions {
  /** This org's name, e.g. `acme.com` (or `localhost:8701` in dev mode). */
  org: string;
  /** External endpoint URL, e.g. `https://connect.acme.com/intertie`. */
  endpoint: string;
  /** Private keys. The first one signs; all are published. */
  keys: PrivateJwk[];
  displayName?: string;
  capabilities?: string[];
  /** How this org wants to receive events as a peer (spec/core.md §7.3). */
  delivery?: Delivery;
  contact?: string;
  maxFileBytes?: number;
  store?: Store | string;
  devInsecure?: boolean;
  discovery?: DiscoveryClient;
  log?: Logger;
  now?: () => number;
  /** Retry tuning, for tests. */
  retryBaseMs?: number;
  retryCapMs?: number;
  deadAfterMs?: number;
  pullWaitS?: number;
}

export interface Channel extends ChannelRow { participants: ParticipantRow[] }

export interface EventResult { id: string; status: 'accepted' | 'duplicate' | 'rejected'; seq?: number; error?: { code: string; message: string } }

export type EventListener = (ev: IntertieEvent, channel: ChannelRow) => void | Promise<void>;
export type RejectListener = (ev: IntertieEvent, error: { code: string; message: string }) => void;

export interface SendDraft {
  type: string;
  body: Record<string, unknown>;
  sender?: User;
  id?: string;
  ts?: string;
}

interface Retry { attempt: number; timer?: NodeJS.Timeout }

const RETRYABLE = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;
const enc = encodeURIComponent;

export class IntertieNode {
  readonly org: string;
  readonly endpoint: string;
  readonly store: Store;
  readonly discovery: DiscoveryClient;
  private o: NodeOptions;
  private signingKey: { keyid: string; privateKey: KeyObject };
  private nonces = new NonceCache();
  private listeners: EventListener[] = [];
  private rejectListeners: RejectListener[] = [];
  private emitChains = new Map<string, Promise<void>>();
  private pendingEmits = 0;
  private busy = new Set<string>();
  private rekick = new Set<string>();
  private retries = new Map<string, Retry>();
  private buffers = new Map<string, Map<number, IntertieEvent>>();
  private waiters = new Map<string, Set<() => void>>();
  private buckets = new Map<string, { tokens: number; last: number }>();
  private aborts = new Set<AbortController>();
  private server?: Server;
  private tick?: NodeJS.Timeout;
  private stopped = false;
  private endpointPath: string;
  private endpointOrigin: string;

  constructor(o: NodeOptions) {
    if (!isOrgName(o.org, o.devInsecure)) throw new Error(`invalid org name ${o.org}`);
    if (!o.keys.length) throw new Error('at least one key required');
    const ep = new URL(o.endpoint);
    if (ep.protocol !== 'https:' && !(o.devInsecure && ep.protocol === 'http:')) throw new Error('endpoint must be https (or use dev mode)');
    this.o = o;
    this.org = o.org;
    this.endpoint = o.endpoint.replace(/\/+$/, '');
    this.endpointPath = ep.pathname.replace(/\/+$/, '');
    this.endpointOrigin = ep.origin;
    this.store = o.store instanceof Store ? o.store : new Store(o.store);
    this.discovery = o.discovery ?? new DiscoveryClient({ devInsecure: o.devInsecure });
    this.signingKey = { keyid: `${o.org}#${o.keys[0].kid}`, privateKey: importPrivate(o.keys[0]) };
  }

  // ───────────────────────── public API ─────────────────────────

  discoveryDocument(): DiscoveryDoc {
    return {
      intertie: PROTOCOL_VERSION,
      org: this.org,
      display_name: this.o.displayName ?? this.org,
      endpoint: this.endpoint,
      keys: this.o.keys.map(publicJwk),
      delivery: this.o.delivery ?? 'push',
      capabilities: this.o.capabilities ?? [],
      limits: { max_body_bytes: LIMITS.bodyBytes, max_file_bytes: this.o.maxFileBytes ?? 25 * 1024 * 1024 },
      ...(this.o.contact ? { contact: this.o.contact } : {}),
    };
  }

  onEvent(fn: EventListener): void { this.listeners.push(fn); }
  onRejected(fn: RejectListener): void { this.rejectListeners.push(fn); }

  channel(id: string): Channel | undefined {
    const c = this.store.channel(id);
    return c && { ...c, participants: this.store.participants(id) };
  }
  channels(): Channel[] { return this.store.channels().map((c) => ({ ...c, participants: this.store.participants(c.id) })); }
  event(channel: string, id: string): IntertieEvent | undefined {
    const r = this.store.eventById(channel, id);
    return r && JSON.parse(r.json);
  }

  /** Share a new channel, homed here. */
  createChannel(o: { name: string; topic?: string; id?: string }): Channel {
    const id = o.id ?? `c-${newId()}@${this.org}`;
    this.store.insertChannel({ id, home: this.org, role: 'home', name: o.name, topic: o.topic ?? '', seq: 0, delivery: 'push', state: 'open', created: this.iso() });
    this.audit('channel.create', { channel: id });
    return this.channel(id)!;
  }

  /** Create an invite string for a channel homed here (spec/core.md §6). */
  createInvite(channelId: string, o: { boundOrg?: string; ttlS?: number } = {}): string {
    const ch = this.mustChannel(channelId);
    if (ch.role !== 'home') throw new IntertieError('not_home', 'only the home can invite');
    const token = randomBytes(16).toString('base64url');
    this.store.insertInvite(sha(token), channelId, o.boundOrg ?? null, this.now() + (o.ttlS ?? 7 * 86400) * 1000);
    this.audit('invite.create', { channel: channelId, bound_org: o.boundOrg ?? null });
    return formatInvite(this.org, token);
  }

  /** Accept an invite from another org's home. */
  async accept(invite: string, o: { delivery?: Delivery } = {}): Promise<Channel> {
    const inv = parseInvite(invite);
    if (!inv) throw new IntertieError('invalid_invite', 'malformed invite string');
    if (inv.home === this.org) throw new IntertieError('invalid_invite', 'cannot accept own invite');
    const delivery = o.delivery ?? this.o.delivery ?? 'push';
    const doc = await this.discovery.get(inv.home);
    const r = await this.call('POST', `${doc.endpoint}/accept`, { token: inv.token, delivery });
    if (r.status !== 200) throw errorFrom(r);
    const c = (r.json as { channel: { id: string; name: string; topic?: string; home: string; seq: number; peers: { org: string; display_name?: string }[] } }).channel;
    if (c.home !== inv.home || !c.id.endsWith(`@${inv.home}`)) throw new IntertieError('invalid_invite', 'home returned a channel it does not own');
    if (!this.store.channel(c.id)) {
      this.store.tx(() => {
        this.store.insertChannel({ id: c.id, home: c.home, role: 'peer', name: c.name, topic: c.topic ?? '', seq: c.seq, delivery, state: 'open', created: this.iso() });
        this.store.upsertParticipant({ channel: c.id, org: c.home, display_name: doc.display_name ?? c.home, delivery: 'push', state: 'active', cursor: 0, join_seq: 0 });
        for (const p of c.peers) {
          this.store.upsertParticipant({ channel: c.id, org: p.org, display_name: p.display_name ?? p.org, delivery: 'push', state: 'active', cursor: 0, join_seq: 0 });
        }
      });
    }
    this.audit('invite.accept', { channel: c.id, home: c.home });
    this.kickPull(c.id); // catch the peer.join that may have been pushed before we knew the channel
    return this.channel(c.id)!;
  }

  /** Post an event as this org. At home it is sequenced at once; at a peer it is submitted. */
  async send(channelId: string, d: SendDraft): Promise<IntertieEvent> {
    const ch = this.mustChannel(channelId);
    const ev = validateEvent({
      id: d.id ?? newId(), type: d.type, channel: channelId, origin: this.org,
      ...(d.sender ? { sender: d.sender } : {}), ts: d.ts ?? this.iso(), body: d.body,
    });
    if (ch.role === 'home') {
      const r = this.sequenceAtHome(ev, this.org);
      return { ...ev, seq: r.seq };
    }
    if (ch.state !== 'open') throw new IntertieError('channel_closed');
    this.store.outboxAdd(ev, this.now());
    this.kickOutbox(channelId);
    return ev;
  }

  async leave(channelId: string): Promise<void> {
    const ch = this.mustChannel(channelId);
    if (ch.role === 'home') throw new IntertieError('bad_request', 'the home closes, it does not leave');
    await this.send(channelId, { type: 'peer.leave', body: { org: this.org, reason: 'left' } });
  }

  removePeer(channelId: string, org: string): void {
    this.sequenceAtHome(this.draft(channelId, 'peer.leave', { org, reason: 'removed' }), this.org);
  }

  closeChannel(channelId: string, reason?: string): void {
    this.sequenceAtHome(this.draft(channelId, 'channel.close', reason ? { reason } : {}), this.org);
  }

  updateChannel(channelId: string, f: { name?: string; topic?: string }): void {
    this.sequenceAtHome(this.draft(channelId, 'channel.update', f), this.org);
  }

  /** Make a file reference for a message (capabilities.md § files). */
  storeFile(channelId: string, data: Uint8Array, o: { name: string; mime: string }): FileRef {
    const sha256 = createHash('sha256').update(data).digest('base64url');
    const id = `f-${newId()}`;
    const ref: FileRef = { id, name: o.name.slice(0, 255) || 'file', mime: o.mime || 'application/octet-stream', size: data.length, sha256 };
    if (data.length <= LIMITS.inlineFileBytes) return { ...ref, data: Buffer.from(data).toString('base64') };
    this.store.insertFile({ id, channel: channelId, name: ref.name, mime: ref.mime, size: ref.size, sha256, data });
    return { ...ref, url: `${this.endpoint}/files/${id}` };
  }

  /** Fetch a file referenced by an event, with origin and integrity checks. */
  async fetchFile(ev: IntertieEvent, ref: FileRef, maxBytes = this.o.maxFileBytes ?? 25 * 1024 * 1024): Promise<Buffer> {
    if (ref.size > maxBytes) throw new IntertieError('too_large', `file ${ref.size} bytes over cap`);
    let bytes: Buffer;
    if (ref.data !== undefined) {
      bytes = Buffer.from(ref.data, 'base64');
    } else {
      const doc = await this.discovery.get(ev.origin);
      if (!ref.url || !ref.url.startsWith(`${doc.endpoint}/files/`)) throw new IntertieError('invalid_event', 'file URL is not under the origin endpoint');
      const r = await this.call('GET', ref.url, undefined, { maxBytes: maxBytes + 1 });
      if (r.status !== 200) throw errorFrom(r);
      bytes = r.raw;
    }
    if (bytes.length !== ref.size || createHash('sha256').update(bytes).digest('base64url') !== ref.sha256) {
      throw new IntertieError('invalid_event', 'file size or sha256 mismatch');
    }
    return bytes;
  }

  /** Begin background delivery, retries and pull loops. */
  start(): void {
    this.stopped = false;
    const sweep = () => {
      for (const c of this.store.channels()) {
        if (c.role === 'home') for (const p of this.store.participants(c.id)) this.kickPeer(c.id, p.org);
        else if (c.delivery === 'pull' && c.state === 'open') this.kickPull(c.id);
      }
      for (const c of this.store.outboxChannels()) this.kickOutbox(c);
    };
    sweep();
    this.tick = setInterval(sweep, 30_000);
    this.tick.unref();
  }

  async listen(port: number, host = '127.0.0.1'): Promise<Server> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    return this.server;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    for (const r of this.retries.values()) if (r.timer) clearTimeout(r.timer);
    this.retries.clear();
    for (const a of this.aborts) a.abort();
    for (const set of this.waiters.values()) for (const w of set) w();
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    await Promise.all([...this.emitChains.values()]);
  }

  /** True when nothing is queued, in flight, or buffered. */
  isIdle(): boolean {
    if (this.pendingEmits > 0 || this.busy.size > 0) return false;
    if (this.store.outboxChannels().length > 0) return false;
    for (const b of this.buffers.values()) if (b.size > 0) return false;
    for (const c of this.store.channels()) {
      if (c.role !== 'home') continue;
      for (const p of this.store.participants(c.id)) {
        if (p.delivery !== 'push' || p.state === 'dead') continue;
        const upTo = p.state === 'left' ? (p.leave_seq ?? 0) : c.seq;
        if (p.cursor < upTo) return false;
      }
    }
    return true;
  }

  // ───────────────────────── home: sequencing ─────────────────────────

  private draft(channel: string, type: string, body: Record<string, unknown>): IntertieEvent {
    return validateEvent({ id: newId(), type, channel, origin: this.org, ts: this.iso(), body });
  }

  /** spec/core.md §7.1 "At the home". Throws IntertieError on rejection. */
  private sequenceAtHome(ev: IntertieEvent, authOrg: string): { status: 'accepted' | 'duplicate'; seq: number } {
    const local = authOrg === this.org;
    const out = this.store.tx(() => {
      const ch = this.store.channel(ev.channel);
      if (!ch || ch.role !== 'home') throw new IntertieError('unknown_channel');
      if (!local) {
        const p = this.store.participant(ev.channel, authOrg);
        if (!p || p.state !== 'active') throw new IntertieError('not_participant');
      }
      if (ev.origin !== authOrg) throw new IntertieError('bad_origin', `origin ${ev.origin} is not ${authOrg}`);
      const dup = this.store.eventById(ev.channel, ev.id);
      if (dup) {
        if (dup.origin === ev.origin) return { status: 'duplicate' as const, seq: dup.seq, ch, fresh: false };
        throw new IntertieError('id_conflict');
      }
      if (ch.state !== 'open') throw new IntertieError('channel_closed');
      if (!local && HOME_ONLY.has(ev.type)) throw new IntertieError('not_author', `${ev.type} is home-only`);
      const b = ev.body as Record<string, unknown>;
      if (ev.type === 'peer.leave' && !local && b.org !== authOrg) throw new IntertieError('not_author', 'a peer may only remove itself');
      if (ev.type === 'peer.leave' && local && b.org === this.org) throw new IntertieError('bad_request', 'the home closes, it does not leave');
      if (TARGETED.has(ev.type)) {
        const t = this.store.eventById(ev.channel, b.target as string);
        if (!t || t.type !== 'message.create') throw new IntertieError('invalid_event', 'unknown target message');
        if (ev.type === 'message.edit' && (t.origin !== ev.origin || t.sender !== ev.sender?.id)) throw new IntertieError('not_author');
        if (ev.type === 'message.delete' && t.origin !== ev.origin && ev.origin !== ch.home) throw new IntertieError('not_author');
      }
      if (ev.type === 'message.create' && b.thread !== undefined) {
        const root = this.store.eventById(ev.channel, b.thread as string);
        if (!root || root.type !== 'message.create' || root.thread) throw new IntertieError('invalid_event', 'thread root must be a top-level message');
      }
      const seq = ch.seq + 1;
      const sequenced = { ...ev, seq };
      this.store.insertEvent(sequenced);
      this.store.updateChannel(ch.id, { seq });
      if (ev.type === 'peer.leave') this.store.updateParticipant(ch.id, b.org as string, { state: 'left', leave_seq: seq });
      if (ev.type === 'channel.close') this.store.updateChannel(ch.id, { state: 'closed' });
      if (ev.type === 'channel.update') this.store.updateChannel(ch.id, { ...(b.name ? { name: b.name as string } : {}), ...(b.topic !== undefined ? { topic: b.topic as string } : {}) });
      return { status: 'accepted' as const, seq, ch, fresh: true, sequenced };
    });
    if (out.fresh) {
      const ch = this.store.channel(ev.channel)!;
      if (ev.type.startsWith('peer.') || ev.type.startsWith('channel.')) this.audit(ev.type, { channel: ev.channel, seq: out.seq, ...(ev.body as object) });
      this.emit((out as { sequenced: IntertieEvent }).sequenced, ch);
      this.notify(ev.channel);
      for (const p of this.store.participants(ev.channel)) this.kickPeer(ev.channel, p.org);
    }
    return { status: out.status, seq: out.seq };
  }

  // ───────────────────────── home → peer delivery ─────────────────────────

  /** Run one loop per key; a kick while it runs makes it run again afterwards. */
  private run(k: string, loop: () => Promise<void>, again: () => void): void {
    if (this.stopped || this.retries.get(k)?.timer) return;
    if (this.busy.has(k)) { this.rekick.add(k); return; }
    this.busy.add(k);
    loop().catch((e) => this.log('warn', 'loop crashed', { k, err: String(e) })).finally(() => {
      this.busy.delete(k);
      if (this.rekick.delete(k)) again();
    });
  }

  private kickPeer(channel: string, org: string): void {
    const k = `push|${channel}|${org}`;
    this.run(k, () => this.pushPeer(channel, org, k), () => this.kickPeer(channel, org));
  }

  private async pushPeer(channel: string, org: string, k: string): Promise<void> {
    while (!this.stopped) {
      const ch = this.store.channel(channel);
      const p = this.store.participant(channel, org);
      if (!ch || !p || p.delivery !== 'push' || p.state === 'dead') return;
      const upTo = p.state === 'left' ? (p.leave_seq ?? 0) : ch.seq;
      if (p.cursor >= upTo) return;
      const batch = this.store.eventsSince(channel, p.cursor, LIMITS.batch, upTo);
      if (!batch.length) { this.store.updateParticipant(channel, org, { cursor: upTo }); return; }
      try {
        const doc = await this.discovery.get(org);
        const r = await this.call('POST', `${doc.endpoint}/events`, { events: batch });
        if (r.status !== 200) throw Object.assign(errorFrom(r), { retryAfter: Number(r.headers['retry-after']) || 0 });
        this.store.updateParticipant(channel, org, { cursor: batch[batch.length - 1].seq!, fail_since: null });
        this.retries.delete(k);
      } catch (e) {
        const failSince = p.fail_since ?? this.now();
        this.store.updateParticipant(channel, org, { fail_since: failSince });
        if (this.now() - failSince > (this.o.deadAfterMs ?? 72 * 3600_000)) {
          this.store.updateParticipant(channel, org, { state: 'dead' });
          this.log('warn', 'peer unreachable for too long; removing', { channel, org });
          if (ch.state === 'open' && p.state === 'active') {
            this.sequenceAtHome(this.draft(channel, 'peer.leave', { org, reason: 'unreachable' }), this.org);
          }
          return;
        }
        this.log('debug', 'push failed; will retry', { channel, org, err: String((e as Error).message) });
        this.scheduleRetry(k, (e as { retryAfter?: number }).retryAfter ?? 0, () => this.kickPeer(channel, org));
        return;
      }
    }
  }

  private scheduleRetry(k: string, retryAfterS: number, fn: () => void): void {
    if (this.stopped) return;
    const r = this.retries.get(k) ?? { attempt: 0 };
    const base = this.o.retryBaseMs ?? 1000;
    const cap = this.o.retryCapMs ?? 300_000;
    const delay = Math.max(retryAfterS * 1000, Math.min(cap, base * 2 ** r.attempt) * (0.5 + Math.random() / 2));
    r.attempt++;
    r.timer = setTimeout(() => { r.timer = undefined; fn(); }, delay);
    r.timer.unref();
    this.retries.set(k, r);
  }

  // ───────────────────────── peer: submissions ─────────────────────────

  private kickOutbox(channel: string): void {
    const k = `out|${channel}`;
    this.run(k, () => this.pumpOutbox(channel, k), () => this.kickOutbox(channel));
  }

  private async pumpOutbox(channel: string, k: string): Promise<void> {
    while (!this.stopped) {
      const batch = this.store.outbox(channel, LIMITS.batch);
      if (!batch.length) return;
      const ch = this.store.channel(channel);
      if (!ch || ch.state !== 'open') {
        for (const ev of batch) { this.store.outboxRemove(channel, ev.id); this.rejected(ev, { code: 'channel_closed', message: 'channel is not open' }); }
        continue;
      }
      let r;
      try {
        const doc = await this.discovery.get(ch.home);
        r = await this.call('POST', `${doc.endpoint}/events`, { events: batch });
      } catch (e) {
        this.scheduleRetry(k, 0, () => this.kickOutbox(channel));
        return;
      }
      if (r.status === 200) {
        this.retries.delete(k);
        const results = (r.json as { results?: EventResult[] })?.results ?? [];
        for (const ev of batch) {
          const res = results.find((x) => x.id === ev.id);
          this.store.outboxRemove(channel, ev.id);
          if (res?.status === 'rejected') this.rejected(ev, res.error ?? { code: 'rejected', message: '' });
        }
        continue;
      }
      if (RETRYABLE(r.status)) {
        this.scheduleRetry(k, Number(r.headers['retry-after']) || 0, () => this.kickOutbox(channel));
        return;
      }
      const err = errorFrom(r);
      for (const ev of batch) { this.store.outboxRemove(channel, ev.id); this.rejected(ev, { code: String(err.code), message: err.message }); }
    }
  }

  private rejected(ev: IntertieEvent, error: { code: string; message: string }): void {
    this.log('warn', 'submission rejected', { channel: ev.channel, id: ev.id, type: ev.type, code: error.code });
    for (const fn of this.rejectListeners) { try { fn(ev, error); } catch { /* listener bug */ } }
  }

  // ───────────────────────── peer: receiving and pull ─────────────────────────

  /** Apply sequenced events from the home, in order, buffering gaps (spec/core.md §7.1 "At a peer"). */
  private applyFromHome(channel: string, events: IntertieEvent[]): Map<IntertieEvent, EventResult> {
    const results = new Map<IntertieEvent, EventResult>();
    let gap = false;
    const buf = this.buffers.get(channel) ?? new Map<number, IntertieEvent>();
    this.buffers.set(channel, buf);
    for (const ev of [...events].sort((a, b) => a.seq! - b.seq!)) {
      const ch = this.store.channel(channel)!;
      if (ev.seq! <= ch.seq) { results.set(ev, { id: ev.id, status: 'duplicate', seq: ev.seq }); continue; }
      if (ev.seq! > ch.seq + 1) { buf.set(ev.seq!, ev); gap = true; results.set(ev, { id: ev.id, status: 'accepted', seq: ev.seq }); continue; }
      this.applyOne(ev);
      results.set(ev, { id: ev.id, status: 'accepted', seq: ev.seq });
      for (let next = this.store.channel(channel)!.seq + 1; buf.has(next); next++) {
        const b = buf.get(next)!; buf.delete(next); this.applyOne(b);
      }
    }
    if (gap || buf.size) this.kickPull(channel);
    return results;
  }

  private applyOne(ev: IntertieEvent): void {
    const b = ev.body as Record<string, unknown>;
    this.store.tx(() => {
      if (!this.store.eventById(ev.channel, ev.id)) this.store.insertEvent(ev);
      this.store.updateChannel(ev.channel, { seq: ev.seq! });
      if (ev.origin === this.org) this.store.outboxRemove(ev.channel, ev.id);
      switch (ev.type) {
        case 'peer.join':
          this.store.upsertParticipant({ channel: ev.channel, org: b.org as string, display_name: (b.display_name as string) ?? (b.org as string), delivery: 'push', state: 'active', cursor: 0, join_seq: ev.seq! });
          break;
        case 'peer.leave':
          this.store.updateParticipant(ev.channel, b.org as string, { state: 'left', leave_seq: ev.seq! });
          if (b.org === this.org) this.store.updateChannel(ev.channel, { state: 'left' });
          break;
        case 'channel.update':
          this.store.updateChannel(ev.channel, { ...(b.name ? { name: b.name as string } : {}), ...(b.topic !== undefined ? { topic: b.topic as string } : {}) });
          break;
        case 'channel.close':
          this.store.updateChannel(ev.channel, { state: 'closed' });
          break;
      }
    });
    if (ev.type.startsWith('peer.') || ev.type.startsWith('channel.')) this.audit(`recv.${ev.type}`, { channel: ev.channel, seq: ev.seq, ...b });
    this.emit(ev, this.store.channel(ev.channel)!);
  }

  private kickPull(channel: string): void {
    const k = `pull|${channel}`;
    this.run(k, () => this.pullLoop(channel, k), () => this.kickPull(channel));
  }

  private async pullLoop(channel: string, k: string): Promise<void> {
    while (!this.stopped) {
      const ch = this.store.channel(channel);
      if (!ch || ch.role !== 'peer') return;
      const continuous = ch.delivery === 'pull' && ch.state === 'open';
      const buf = this.buffers.get(channel);
      if (!continuous && ch.state !== 'open' && !buf?.size) return;
      const wait = continuous ? (this.o.pullWaitS ?? 25) : 0;
      const ac = new AbortController();
      this.aborts.add(ac);
      let r;
      try {
        const doc = await this.discovery.get(ch.home);
        r = await this.call('GET', `${doc.endpoint}/channels/${enc(channel)}/events?since=${ch.seq}&limit=${LIMITS.batch}&wait=${wait}`, undefined, { timeoutMs: (wait + 15) * 1000, signal: ac.signal });
      } catch {
        this.aborts.delete(ac);
        if (this.stopped) return;
        this.scheduleRetry(k, 0, () => this.kickPull(channel));
        return;
      } finally { this.aborts.delete(ac); }
      if (r.status !== 200) {
        if (r.status === 403 || r.status === 404) { this.log('warn', 'pull refused', { channel, status: r.status }); return; }
        this.scheduleRetry(k, Number(r.headers['retry-after']) || 0, () => this.kickPull(channel));
        return;
      }
      this.retries.delete(k);
      const events = ((r.json as { events?: unknown[] })?.events ?? []).map((e) => validateEvent(e));
      if (events.some((e) => e.channel !== channel || e.seq === undefined)) { this.log('warn', 'pull returned foreign events', { channel }); return; }
      if (events.length) this.applyFromHome(channel, events);
      const after = this.store.channel(channel)!;
      const latest = Number((r.json as { seq?: number }).seq ?? after.seq);
      if (!continuous && after.seq >= latest && !this.buffers.get(channel)?.size) return;
      if (!continuous && !events.length) return;
    }
  }

  // ───────────────────────── HTTP server ─────────────────────────

  /** Node http request handler. Serves the well-known document and the endpoint. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', this.endpointOrigin);
      if (req.method === 'GET' && url.pathname === WELL_KNOWN_PATH) {
        return send(res, 200, this.discoveryDocument(), { 'cache-control': 'max-age=300' });
      }
      if (!url.pathname.startsWith(`${this.endpointPath}/`)) throw new IntertieError('not_found');
      const route = url.pathname.slice(this.endpointPath.length);
      const body = await readBody(req, LIMITS.bodyBytes);
      const auth = await verifyRequest({
        method: req.method ?? 'GET', url: this.endpointOrigin + (req.url ?? '/'), headers: req.headers, body,
        resolveKey: (org, kid, refresh) => this.discovery.key(org, kid, refresh), nonces: this.nonces,
        nowS: Math.floor(this.now() / 1000),
      }).catch((e) => { this.audit('auth.reject', { code: e.code, route }); throw e; });
      this.rateLimit(auth.org);
      const json = body.length ? parseJson(body) : undefined;
      let m: RegExpExecArray | null;
      if (req.method === 'POST' && route === '/events') return send(res, 200, this.handleEvents(auth.org, json));
      if (req.method === 'POST' && route === '/accept') return send(res, 200, await this.handleAccept(auth.org, json));
      if (req.method === 'GET' && (m = /^\/channels\/([^/]+)\/events$/.exec(route))) {
        return send(res, 200, await this.handlePull(auth.org, decodeURIComponent(m[1]), url.searchParams));
      }
      if (req.method === 'GET' && (m = /^\/files\/([A-Za-z0-9._-]+)$/.exec(route))) return this.handleFile(auth.org, m[1], res);
      throw new IntertieError('not_found');
    } catch (e) {
      const err = e instanceof IntertieError ? e : new IntertieError('internal', 'internal error');
      if (!(e instanceof IntertieError)) this.log('warn', 'handler error', { err: String(e) });
      const h: Record<string, string> = err.code === 'rate_limited' ? { 'retry-after': '1' } : {};
      if (!res.headersSent) send(res, err.status, err.toJSON(), h);
    }
  }

  private handleEvents(authOrg: string, json: unknown): { results: EventResult[] } {
    const events = (json as { events?: unknown })?.events;
    if (!Array.isArray(events) || events.length < 1 || events.length > LIMITS.batch) throw new IntertieError('bad_request', 'events must be an array of 1-100');
    const results: (EventResult | undefined)[] = new Array(events.length);
    const peerSide = new Map<string, { idx: number; ev: IntertieEvent }[]>();
    events.forEach((raw, idx) => {
      const id = (raw as { id?: string })?.id ?? '';
      try {
        const ev = validateEvent(raw);
        const ch = this.store.channel(ev.channel);
        if (!ch) throw new IntertieError('unknown_channel');
        if (ch.role === 'home') {
          if (ev.seq !== undefined) throw new IntertieError('invalid_event', 'submissions must not carry seq');
          const r = this.sequenceAtHome(ev, authOrg);
          results[idx] = { id, status: r.status, seq: r.seq };
        } else {
          if (authOrg !== ch.home) throw new IntertieError('not_home');
          if (ev.seq === undefined) throw new IntertieError('invalid_event', 'deliveries must carry seq');
          if (ch.state === 'left') throw new IntertieError('not_participant');
          const list = peerSide.get(ev.channel) ?? [];
          list.push({ idx, ev });
          peerSide.set(ev.channel, list);
        }
      } catch (e) {
        const err = e instanceof IntertieError ? e : new IntertieError('invalid_event', String(e));
        results[idx] = { id, status: 'rejected', error: { code: String(err.code), message: err.message } };
      }
    });
    for (const [channel, list] of peerSide) {
      const r = this.applyFromHome(channel, list.map((x) => x.ev));
      for (const { idx, ev } of list) results[idx] = r.get(ev);
    }
    return { results: results as EventResult[] };
  }

  private async handleAccept(authOrg: string, json: unknown): Promise<unknown> {
    const { token, delivery } = (json ?? {}) as { token?: string; delivery?: string };
    if (typeof token !== 'string') throw new IntertieError('bad_request', 'token required');
    const inv = this.store.invite(sha(token));
    if (!inv || inv.expires < this.now()) throw new IntertieError('invalid_invite');
    const ch = this.store.channel(inv.channel);
    if (!ch || ch.role !== 'home' || ch.state !== 'open') throw new IntertieError('invalid_invite');
    const existing = this.store.participant(ch.id, authOrg);
    const describe = (seq: number) => ({
      channel: {
        id: ch.id, name: this.store.channel(ch.id)!.name, topic: this.store.channel(ch.id)!.topic, home: this.org, seq,
        peers: this.store.participants(ch.id).filter((p) => p.state === 'active').map((p) => ({ org: p.org, display_name: p.display_name })),
      },
    });
    if (existing?.state === 'active') return describe(existing.join_seq - 1);
    if (inv.used_by && inv.used_by !== authOrg) throw new IntertieError('invalid_invite');
    if (inv.bound_org && inv.bound_org !== authOrg) throw new IntertieError('invalid_invite');
    if (authOrg === this.org) throw new IntertieError('invalid_invite');
    const doc = await this.discovery.get(authOrg);
    const mode: Delivery = delivery === 'pull' || delivery === 'push' ? delivery : (doc.delivery ?? 'push');
    const seqBefore = this.store.channel(ch.id)!.seq;
    this.store.tx(() => {
      this.store.useInvite(inv.token_hash, authOrg);
      this.store.upsertParticipant({ channel: ch.id, org: authOrg, display_name: (doc.display_name ?? authOrg).slice(0, 80), delivery: mode, state: 'active', cursor: seqBefore, join_seq: seqBefore + 1 });
    });
    this.sequenceAtHome(this.draft(ch.id, 'peer.join', { org: authOrg, display_name: (doc.display_name ?? authOrg).slice(0, 80) }), this.org);
    return describe(seqBefore);
  }

  private async handlePull(authOrg: string, channel: string, q: URLSearchParams): Promise<unknown> {
    const ch = this.store.channel(channel);
    if (!ch || ch.role !== 'home') throw new IntertieError('unknown_channel');
    const p = this.store.participant(channel, authOrg);
    if (!p) throw new IntertieError('not_participant');
    const upTo = p.state === 'active' ? Number.MAX_SAFE_INTEGER : (p.leave_seq ?? 0);
    const since = Math.max(0, Number(q.get('since') ?? 0) || 0);
    const limit = Math.min(LIMITS.batch, Math.max(1, Number(q.get('limit') ?? LIMITS.batch) || LIMITS.batch));
    const wait = Math.min(30, Math.max(0, Number(q.get('wait') ?? 0) || 0));
    let events = this.store.eventsSince(channel, since, limit, upTo);
    if (!events.length && wait > 0 && p.state === 'active' && ch.state === 'open') {
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(channel) ?? new Set();
        const done = () => { clearTimeout(t); set.delete(done); resolve(); };
        const t = setTimeout(done, wait * 1000);
        set.add(done);
        this.waiters.set(channel, set);
      });
      events = this.store.eventsSince(channel, since, limit, upTo);
    }
    return { events, seq: this.store.channel(channel)!.seq };
  }

  private handleFile(authOrg: string, id: string, res: ServerResponse): void {
    const f = this.store.file(id);
    if (!f) throw new IntertieError('not_found');
    const ch = this.store.channel(f.channel);
    if (!ch || (ch.home !== authOrg && !this.store.participant(f.channel, authOrg))) throw new IntertieError('not_participant');
    res.writeHead(200, {
      'content-type': 'application/octet-stream', 'content-length': String(f.size),
      'content-disposition': `attachment; filename*=UTF-8''${enc(f.name)}`, 'x-content-type-options': 'nosniff',
    });
    res.end(Buffer.from(f.data));
  }

  // ───────────────────────── helpers ─────────────────────────

  private async call(method: string, url: string, body?: unknown, o: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}) {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = signRequest({ method, url, body: bytes, key: this.signingKey, created: Math.floor(this.now() / 1000) });
    if (bytes) headers['content-type'] = 'application/json';
    headers.accept = 'application/json';
    const r = await safeFetch(url, { method, headers, body: bytes ?? undefined, devInsecure: this.o.devInsecure, timeoutMs: o.timeoutMs ?? 30_000, maxBytes: o.maxBytes ?? 4 * 1024 * 1024, signal: o.signal });
    let json: unknown = null;
    if (String(r.headers['content-type'] ?? '').includes('json')) { try { json = JSON.parse(r.body.toString('utf8')); } catch { /* not JSON */ } }
    return { status: r.status, json, headers: r.headers, raw: r.body };
  }

  private emit(ev: IntertieEvent, ch: ChannelRow): void {
    if (!this.listeners.length) return;
    this.pendingEmits++;
    const prev = this.emitChains.get(ch.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (const fn of this.listeners) {
        try { await fn(ev, ch); } catch (e) { this.log('warn', 'event listener failed', { id: ev.id, type: ev.type, err: String(e) }); }
      }
    }).finally(() => { this.pendingEmits--; });
    this.emitChains.set(ch.id, next);
  }

  private notify(channel: string): void {
    const set = this.waiters.get(channel);
    if (set) for (const w of [...set]) w();
  }

  private rateLimit(org: string): void {
    const now = this.now();
    const b = this.buckets.get(org) ?? { tokens: 200, last: now };
    b.tokens = Math.min(200, b.tokens + ((now - b.last) / 1000) * 50);
    b.last = now;
    if (b.tokens < 1) { this.buckets.set(org, b); throw new IntertieError('rate_limited'); }
    b.tokens -= 1;
    this.buckets.set(org, b);
  }

  private mustChannel(id: string): ChannelRow {
    const c = this.store.channel(id);
    if (!c) throw new IntertieError('unknown_channel', id);
    return c;
  }

  private now(): number { return this.o.now ? this.o.now() : Date.now(); }
  private iso(): string { return new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void { this.o.log?.(level, msg, data); }
  private audit(action: string, data: Record<string, unknown>): void { this.log('audit', action, data); }
}

function sha(s: string): string { return createHash('sha256').update(s).digest('base64url'); }

function errorFrom(r: { status: number; json: unknown }): IntertieError {
  const e = (r.json as { error?: { code?: string; message?: string } })?.error;
  return new IntertieError(e?.code ?? 'unreachable', e?.message ?? `HTTP ${r.status}`, r.status);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(s)), ...headers });
  res.end(s);
}

function parseJson(b: Buffer): unknown {
  try { return JSON.parse(b.toString('utf8')); } catch { throw new IntertieError('bad_request', 'body is not JSON'); }
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > max) { req.resume(); return reject(new IntertieError('too_large')); }
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) { req.removeAllListeners('data'); req.resume(); reject(new IntertieError('too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
