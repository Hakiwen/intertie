// Durable state for a node, on the built-in node:sqlite (no dependencies).
import { DatabaseSync } from 'node:sqlite';
import type { IntertieEvent } from './events.ts';

export type Role = 'home' | 'peer';
export type Delivery = 'push' | 'pull';

export interface ChannelRow {
  id: string; home: string; role: Role; name: string; topic: string;
  /** home: last assigned seq. peer: last applied seq. */
  seq: number;
  delivery: Delivery;
  state: 'open' | 'closed' | 'left';
  created: string;
}

export interface ParticipantRow {
  channel: string; org: string; display_name: string; delivery: Delivery;
  state: 'active' | 'left' | 'dead';
  /** home only: last seq delivered to this peer. */
  cursor: number;
  join_seq: number; leave_seq: number | null; fail_since: number | null;
}

export interface EventRow { channel: string; seq: number; id: string; origin: string; type: string; sender: string | null; target: string | null; thread: string | null; json: string }

const SCHEMA = `
create table if not exists channels(
  id text primary key, home text not null, role text not null, name text not null,
  topic text not null default '', seq integer not null default 0,
  delivery text not null default 'push', state text not null default 'open', created text not null);
create table if not exists participants(
  channel text not null, org text not null, display_name text not null default '',
  delivery text not null default 'push', state text not null default 'active',
  cursor integer not null default 0, join_seq integer not null default 0, leave_seq integer,
  fail_since integer, primary key(channel, org));
create table if not exists events(
  channel text not null, seq integer not null, id text not null, origin text not null,
  type text not null, sender text, target text, thread text, json text not null,
  primary key(channel, seq), unique(channel, id));
create table if not exists invites(
  token_hash text primary key, channel text not null, bound_org text,
  expires integer not null, used_by text);
create table if not exists outbox(
  channel text not null, id text not null, json text not null, created integer not null,
  primary key(channel, id));
create table if not exists files(
  id text primary key, channel text not null, name text not null, mime text not null,
  size integer not null, sha256 text not null, data blob not null);
create table if not exists kv(k text primary key, v text not null);
`;

/** Thin typed wrapper over SQLite. Every method is synchronous, which makes sequencing atomic. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('begin immediate');
    try { const r = fn(); this.db.exec('commit'); return r; } catch (e) { this.db.exec('rollback'); throw e; }
  }

  channel(id: string): ChannelRow | undefined {
    return this.db.prepare('select * from channels where id = ?').get(id) as ChannelRow | undefined;
  }
  channels(): ChannelRow[] {
    return this.db.prepare('select * from channels order by created').all() as unknown as ChannelRow[];
  }
  insertChannel(c: ChannelRow): void {
    this.db.prepare('insert into channels(id, home, role, name, topic, seq, delivery, state, created) values (?,?,?,?,?,?,?,?,?)')
      .run(c.id, c.home, c.role, c.name, c.topic, c.seq, c.delivery, c.state, c.created);
  }
  updateChannel(id: string, f: Partial<Pick<ChannelRow, 'name' | 'topic' | 'seq' | 'state'>>): void {
    for (const [k, v] of Object.entries(f)) this.db.prepare(`update channels set ${k} = ? where id = ?`).run(v as never, id);
  }

  participant(channel: string, org: string): ParticipantRow | undefined {
    return this.db.prepare('select * from participants where channel = ? and org = ?').get(channel, org) as ParticipantRow | undefined;
  }
  participants(channel: string): ParticipantRow[] {
    return this.db.prepare('select * from participants where channel = ? order by join_seq').all(channel) as unknown as ParticipantRow[];
  }
  upsertParticipant(p: Omit<ParticipantRow, 'fail_since' | 'leave_seq'> & { leave_seq?: number | null }): void {
    this.db.prepare(`insert into participants(channel, org, display_name, delivery, state, cursor, join_seq, leave_seq)
      values (?,?,?,?,?,?,?,?) on conflict(channel, org) do update set display_name = excluded.display_name,
      delivery = excluded.delivery, state = excluded.state, cursor = excluded.cursor, join_seq = excluded.join_seq,
      leave_seq = excluded.leave_seq, fail_since = null`)
      .run(p.channel, p.org, p.display_name, p.delivery, p.state, p.cursor, p.join_seq, p.leave_seq ?? null);
  }
  updateParticipant(channel: string, org: string, f: Partial<Pick<ParticipantRow, 'state' | 'cursor' | 'leave_seq' | 'fail_since' | 'delivery'>>): void {
    for (const [k, v] of Object.entries(f)) this.db.prepare(`update participants set ${k} = ? where channel = ? and org = ?`).run(v as never, channel, org);
  }

  insertEvent(e: IntertieEvent): void {
    const b = e.body as { target?: string; thread?: string };
    this.db.prepare('insert into events(channel, seq, id, origin, type, sender, target, thread, json) values (?,?,?,?,?,?,?,?,?)')
      .run(e.channel, e.seq!, e.id, e.origin, e.type, e.sender?.id ?? null, b.target ?? null, b.thread ?? null, JSON.stringify(e));
  }
  eventById(channel: string, id: string): EventRow | undefined {
    return this.db.prepare('select * from events where channel = ? and id = ?').get(channel, id) as EventRow | undefined;
  }
  eventsSince(channel: string, since: number, limit: number, upTo = Number.MAX_SAFE_INTEGER): IntertieEvent[] {
    const rows = this.db.prepare('select json from events where channel = ? and seq > ? and seq <= ? order by seq limit ?')
      .all(channel, since, upTo, limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json));
  }
  /** Drop events older than the retention horizon, never the newest one per channel. */
  pruneEvents(beforeIso: string): void {
    this.db.prepare(`delete from events where json ->> '$.ts' < ? and seq < (select max(seq) from events e2 where e2.channel = events.channel)`).run(beforeIso);
  }

  insertInvite(hash: string, channel: string, boundOrg: string | null, expires: number): void {
    this.db.prepare('insert into invites(token_hash, channel, bound_org, expires) values (?,?,?,?)').run(hash, channel, boundOrg, expires);
  }
  invite(hash: string): { token_hash: string; channel: string; bound_org: string | null; expires: number; used_by: string | null } | undefined {
    return this.db.prepare('select * from invites where token_hash = ?').get(hash) as never;
  }
  useInvite(hash: string, org: string): void {
    this.db.prepare('update invites set used_by = ? where token_hash = ?').run(org, hash);
  }

  outboxAdd(e: IntertieEvent, now: number): void {
    this.db.prepare('insert or ignore into outbox(channel, id, json, created) values (?,?,?,?)').run(e.channel, e.id, JSON.stringify(e), now);
  }
  outbox(channel: string, limit: number): IntertieEvent[] {
    return (this.db.prepare('select json from outbox where channel = ? order by created, rowid limit ?').all(channel, limit) as { json: string }[])
      .map((r) => JSON.parse(r.json));
  }
  outboxChannels(): string[] {
    return (this.db.prepare('select distinct channel from outbox').all() as { channel: string }[]).map((r) => r.channel);
  }
  outboxRemove(channel: string, id: string): void {
    this.db.prepare('delete from outbox where channel = ? and id = ?').run(channel, id);
  }

  insertFile(f: { id: string; channel: string; name: string; mime: string; size: number; sha256: string; data: Uint8Array }): void {
    this.db.prepare('insert or replace into files(id, channel, name, mime, size, sha256, data) values (?,?,?,?,?,?,?)')
      .run(f.id, f.channel, f.name, f.mime, f.size, f.sha256, f.data);
  }
  file(id: string): { id: string; channel: string; name: string; mime: string; size: number; sha256: string; data: Uint8Array } | undefined {
    return this.db.prepare('select * from files where id = ?').get(id) as never;
  }

  kvGet(k: string): string | undefined {
    return (this.db.prepare('select v from kv where k = ?').get(k) as { v: string } | undefined)?.v;
  }
  kvSet(k: string, v: string): void {
    this.db.prepare('insert into kv(k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(k, v);
  }
  kvDel(k: string): void {
    this.db.prepare('delete from kv where k = ?').run(k);
  }

  close(): void { this.db.close(); }
}
