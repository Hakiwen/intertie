// The Slack adapter: a Slack app that one participant installs in its own workspace.
// To the channel it is an ordinary Intertie org; to Slack it is a bot. spec/slack-mapping.md.
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  derivedId, IntertieError, IntertieNode, type FileRef, type IntertieEvent, type Mention, type NodeOptions, type User,
} from '@intertie/core';
import { fromSlackReaction, toSlackReaction } from './emoji.ts';
import { escapeSlack as esc, fromMrkdwn, toMrkdwn } from './mrkdwn.ts';
import { SlackApi, SlackError } from './slack-api.ts';
import { SocketModeClient, type Envelope } from './socket-mode.ts';

export interface AdapterOptions {
  node: Omit<NodeOptions, 'capabilities'> & { capabilities?: string[] };
  slack: {
    botToken: string;
    /** Socket Mode (xapp-…). If absent, the Events API over HTTP is used and signingSecret is required. */
    appToken?: string;
    signingSecret?: string;
    apiUrl?: string;
    /** Slack user ids allowed to run /intertie. Default: workspace admins and owners. */
    adminUsers?: string[];
  };
  /** Local admin API token (loopback only). Generated when absent. */
  adminToken?: string;
  maxFileBytes?: number;
}

interface SlackUser { name: string; avatar?: string; admin: boolean; team?: string; at: number }

const CAPABILITIES = ['threads', 'reactions', 'files', 'mentions'];
const SCHEMA = `
create table if not exists slack_links(slack_channel text primary key, channel text not null unique);
create table if not exists slack_msgs(channel text not null, event_id text not null, ts text not null,
  primary key(channel, event_id));
create index if not exists slack_msgs_ts on slack_msgs(channel, ts);
create table if not exists slack_reactions(channel text not null, target text not null, name text not null,
  reactor text not null, primary key(channel, target, name, reactor));
`;

export class SlackAdapter {
  readonly node: IntertieNode;
  readonly slack: SlackApi;
  readonly adminToken: string;
  private o: AdapterOptions;
  private bot = { userId: '', botId: '', teamId: '' };
  private users = new Map<string, SlackUser>();
  private socket?: SocketModeClient;
  private server?: Server;
  private adminServer?: Server;
  /** Port of the loopback-only admin API (separate from the public endpoint). */
  adminPort = 0;
  private queues = new Map<string, Promise<void>>();
  private pending = 0;
  private warnedForeign = new Set<string>();

  constructor(o: AdapterOptions) {
    this.o = o;
    this.node = new IntertieNode({ ...o.node, capabilities: o.node.capabilities ?? CAPABILITIES, maxFileBytes: o.maxFileBytes });
    this.node.store.db.exec(SCHEMA);
    this.slack = new SlackApi({ token: o.slack.botToken, baseUrl: o.slack.apiUrl });
    this.adminToken = o.adminToken ?? randomBytes(24).toString('base64url');
    this.node.onEvent((ev, ch) => this.toSlack(ev, ch.id));
    this.node.onRejected((ev, err) => { void this.notifyRejected(ev, err); });
  }

  // ───────────────────────── lifecycle ─────────────────────────

  /** Embedded in a multi-workspace host (SlackHost): no listeners, the host routes requests here. */
  async startEmbedded(): Promise<void> {
    await this.identify();
    this.node.start();
  }

  private async identify(): Promise<void> {
    const me = await this.slack.call<{ user_id: string; bot_id: string; team_id: string }>('auth.test');
    this.bot = { userId: me.user_id, botId: me.bot_id, teamId: me.team_id };
    this.log('info', 'slack connected', { team: me.team_id, bot_user: me.user_id });
  }

  /** Entry points for a host that receives Slack traffic for many workspaces. */
  handleSlackEvent(event: Record<string, any>, eventId: string): void { this.enqueueSlackEvent(event, eventId); }
  handleSlashCommand(p: SlashPayload): Promise<void> { return this.onSlashCommand(p); }

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    await this.identify();
    this.server = createServer((req, res) => { void this.route(req, res); });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    // The admin API gets its own loopback listener: behind a same-host reverse proxy every public
    // request also arrives from 127.0.0.1, so a shared port could not tell them apart.
    this.adminServer = createServer((req, res) => { const path = (req.url ?? '/').split('?')[0]; void this.admin(req, res, path); });
    await new Promise<void>((resolve) => this.adminServer!.listen(0, '127.0.0.1', resolve));
    this.adminPort = (this.adminServer.address() as { port: number }).port;
    this.node.start();
    if (this.o.slack.appToken) {
      this.socket = new SocketModeClient({
        appToken: this.o.slack.appToken, baseUrl: this.o.slack.apiUrl,
        onEnvelope: (e) => this.onEnvelope(e), log: (m, d) => this.log('info', m, d),
      });
      await this.socket.start();
    } else if (!this.o.slack.signingSecret) {
      throw new Error('need SLACK_APP_TOKEN (Socket Mode) or SLACK_SIGNING_SECRET (Events API)');
    }
  }

  async stop(): Promise<void> {
    this.socket?.stop();
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>((r) => this.server!.close(() => r())); }
    if (this.adminServer) { this.adminServer.closeAllConnections(); await new Promise<void>((r) => this.adminServer!.close(() => r())); }
    await Promise.all([...this.queues.values()]);
    await this.node.stop();
  }

  isIdle(): boolean { return this.pending === 0 && this.node.isIdle(); }

  // ───────────────────────── admin: share / accept / status ─────────────────────────

  /** Accepts a Slack channel id (C…/G…) or `#name`. */
  async resolveChannel(ref: string): Promise<string> {
    if (!ref.startsWith('#')) return ref;
    let cursor: string | undefined;
    do {
      const r = await this.slack.call<{ channels: { id: string; name: string }[]; response_metadata?: { next_cursor?: string } }>('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, cursor });
      const hit = r.channels.find((c) => c.name === ref.slice(1));
      if (hit) return hit.id;
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    throw new IntertieError('bad_request', `no channel ${ref} visible to the app (for a private channel, /invite the app first)`);
  }

  async share(slackChannelRef: string, name?: string): Promise<{ channel: string; invite: string }> {
    const slackChannel = await this.resolveChannel(slackChannelRef);
    const existing = this.channelFor(slackChannel);
    if (existing) {
      const ch = this.node.channel(existing)!;
      if (ch.role !== 'home') throw new IntertieError('bad_request', 'this Slack channel is linked to a channel homed elsewhere');
      return { channel: existing, invite: this.node.createInvite(existing) };
    }
    const info = await this.slack.call<{ channel: { name: string; is_private?: boolean; topic?: { value?: string } } }>('conversations.info', { channel: slackChannel }).catch(() => null);
    if (info && !info.channel.is_private) await this.slack.call('conversations.join', { channel: slackChannel }).catch(() => undefined);
    const ch = this.node.createChannel({ name: (name ?? info?.channel.name ?? 'shared').slice(0, 80), topic: (info?.channel.topic?.value ?? '').slice(0, 250) });
    this.link(slackChannel, ch.id);
    return { channel: ch.id, invite: this.node.createInvite(ch.id) };
  }

  async accept(invite: string, slackChannelRef: string): Promise<{ channel: string }> {
    const slackChannel = await this.resolveChannel(slackChannelRef);
    if (this.channelFor(slackChannel)) throw new IntertieError('bad_request', 'this Slack channel is already linked');
    const info = await this.slack.call<{ channel: { is_private?: boolean } }>('conversations.info', { channel: slackChannel }).catch(() => null);
    if (info && !info.channel.is_private) await this.slack.call('conversations.join', { channel: slackChannel }).catch(() => undefined);
    const ch = await this.node.accept(invite);
    // Linked in the same tick the channel appears, before any delivery can be applied.
    this.link(slackChannel, ch.id);
    await this.post(slackChannel, `:link: This channel is now shared with *${esc(ch.home)}* over Intertie. Messages here are copied to: ${esc([ch.home, ...ch.participants.map((p) => p.org)].filter((o, i, a) => o !== this.node.org && a.indexOf(o) === i).join(', '))}.`);
    return { channel: ch.id };
  }

  async unshare(slackChannelRef: string): Promise<void> {
    const slackChannel = await this.resolveChannel(slackChannelRef);
    const id = this.channelFor(slackChannel);
    if (!id) throw new IntertieError('bad_request', 'not linked');
    const ch = this.node.channel(id)!;
    if (ch.role === 'home' && ch.state === 'open') this.node.closeChannel(id, 'unshared');
    else if (ch.role === 'peer' && ch.state === 'open') await this.node.leave(id);
  }

  status(): { org: string; links: { slack_channel: string; channel: string; role: string; state: string; participants: string[] }[] } {
    const rows = this.node.store.db.prepare('select * from slack_links').all() as { slack_channel: string; channel: string }[];
    return {
      org: this.node.org,
      links: rows.map((r) => {
        const ch = this.node.channel(r.channel);
        return { slack_channel: r.slack_channel, channel: r.channel, role: ch?.role ?? '?', state: ch?.state ?? '?', participants: ch?.participants.filter((p) => p.state === 'active').map((p) => p.org) ?? [] };
      }),
    };
  }

  // ───────────────────────── Slack → Intertie ─────────────────────────

  private onEnvelope(e: Envelope): Record<string, unknown> | void {
    if (e.type === 'events_api') { this.enqueueSlackEvent(e.payload.event, e.payload.event_id); return; }
    if (e.type === 'slash_commands') { void this.onSlashCommand(e.payload as SlashPayload); return; }
  }

  private enqueueSlackEvent(event: Record<string, any>, eventId: string): void {
    const key = event?.channel ?? event?.item?.channel ?? 'misc';
    this.pending++;
    const next = (this.queues.get(key) ?? Promise.resolve())
      .then(() => this.fromSlack(event, eventId))
      .catch((err) => this.log('warn', 'slack event failed', { type: event?.type, subtype: event?.subtype, err: String(err) }))
      .finally(() => { this.pending--; });
    this.queues.set(key, next);
  }

  private isSelf(m: Record<string, any> | undefined): boolean {
    return !!m && ((m.bot_id && m.bot_id === this.bot.botId) || m.user === this.bot.userId);
  }

  async fromSlack(ev: Record<string, any>, eventId: string): Promise<void> {
    const sent = await this.fromSlackInner(ev, eventId);
    if (sent) this.log('info', 'slack → intertie', { type: sent.type, channel: sent.channel, id: sent.id, ...(sent.seq ? { seq: sent.seq } : {}) });
  }

  private async fromSlackInner(ev: Record<string, any>, eventId: string): Promise<IntertieEvent | void> {
    const slackChannel: string | undefined = ev.channel ?? ev.item?.channel;
    const channel = slackChannel && this.channelFor(slackChannel);
    if (!channel) return; // only explicitly linked channels
    const ch = this.node.channel(channel);
    if (!ch || ch.state !== 'open') return;
    const id = derivedId(this.node.org, eventId || `${ev.type}:${ev.ts ?? ev.event_ts}`);

    if (ev.type === 'message') {
      const sub: string | undefined = ev.subtype;
      if (sub === 'message_changed') {
        const m = ev.message ?? {};
        if (this.isSelf(m) || m.bot_id) return;
        if (!(await this.vouchFor({ user: m.user, user_team: m.user_team ?? m.team }, slackChannel!))) return;
        if (m.text === ev.previous_message?.text) return; // reply-count and unfurl updates
        const target = this.eventForTs(channel, m.ts);
        if (!target) return;
        const conv = await this.convert(m.text ?? '');
        return this.node.send(channel, { id, type: 'message.edit', sender: await this.sender(m.user), body: { target, text: conv.text || '(empty)', ...(conv.mentions.length ? { mentions: conv.mentions } : {}) } });
        return;
      }
      if (sub === 'message_deleted') {
        const target = this.eventForTs(channel, ev.deleted_ts);
        if (!target) return;
        if (ev.previous_message?.bot_id) { this.forgetTs(channel, ev.deleted_ts); return; } // local moderation of a remote message
        this.forgetTs(channel, ev.deleted_ts);
        return this.node.send(channel, { id, type: 'message.delete', body: { target } });
      }
      if (sub && !['thread_broadcast', 'file_share', 'me_message'].includes(sub)) return;
      if (this.isSelf(ev) || ev.bot_id || !ev.user) return;
      if (!(await this.vouchFor(ev, slackChannel!))) return;
      if (this.eventForTs(channel, ev.ts)) return; // already sent (Slack retry)
      const conv = await this.convert(ev.text ?? '');
      let text = sub === 'me_message' ? `*${conv.text}*` : conv.text;
      let thread: string | undefined;
      if (ev.thread_ts && ev.thread_ts !== ev.ts) {
        thread = this.eventForTs(channel, ev.thread_ts) ?? undefined;
        if (!thread) text = `↳ ${text}`;
      }
      const files = await this.filesFromSlack(channel, ev.files);
      if (!text && !files.length) return;
      this.remember(channel, id, ev.ts);
      return this.node.send(channel, {
        id, type: 'message.create', sender: await this.sender(ev.user),
        body: { text, ...(thread ? { thread } : {}), ...(conv.mentions.length ? { mentions: conv.mentions } : {}), ...(files.length ? { files } : {}) },
      });
      return;
    }
    if (ev.type === 'reaction_added' || ev.type === 'reaction_removed') {
      if (ev.user === this.bot.userId || ev.item?.type !== 'message') return;
      if (!(await this.vouchFor(ev, slackChannel!))) return;
      const target = this.eventForTs(channel, ev.item.ts);
      if (!target) return;
      const r = fromSlackReaction(ev.reaction);
      return this.node.send(channel, { id, type: ev.type === 'reaction_added' ? 'reaction.add' : 'reaction.remove', sender: await this.sender(ev.user), body: { target, emoji: r.emoji, name: r.name } });
    }
  }

  /**
   * This org vouches only for its own workspace's users. In a channel that is also a Slack Connect
   * channel, people from other workspaces are not relayed as ours (like Matrix localServers).
   */
  private async vouchFor(ev: Record<string, any>, slackChannel: string): Promise<boolean> {
    const team = ev.user_team ?? ev.team ?? (ev.user ? (await this.slackUser(ev.user).catch(() => null))?.team : undefined);
    if (!team || !this.bot.teamId || team === this.bot.teamId) return true;
    const k = `${slackChannel}|${ev.user}`;
    if (!this.warnedForeign.has(k)) {
      this.warnedForeign.add(k);
      await this.post(slackChannel, `:warning: Messages from <@${ev.user}> are not shared with the other organizations: this app only relays people from this workspace.`);
    }
    return false;
  }

  private async convert(text: string): Promise<{ text: string; mentions: Mention[] }> {
    const ids = [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
    for (const u of ids) await this.slackUser(u).catch(() => undefined);
    return fromMrkdwn(text, (u) => this.users.get(u)?.name ?? '', (u) => `${u}@${this.node.org}`);
  }

  private async filesFromSlack(channel: string, files: Record<string, any>[] | undefined): Promise<FileRef[]> {
    const out: FileRef[] = [];
    const cap = this.o.maxFileBytes ?? 25 * 1024 * 1024;
    for (const f of (files ?? []).slice(0, 10)) {
      if (!f.url_private_download || f.size > cap) continue;
      try {
        const bytes = await this.slack.download(f.url_private_download, cap);
        out.push(this.node.storeFile(channel, bytes, { name: f.name ?? 'file', mime: f.mimetype ?? 'application/octet-stream' }));
      } catch (e) { this.log('warn', 'file download failed', { err: String(e) }); }
    }
    return out;
  }

  // ───────────────────────── Intertie → Slack ─────────────────────────

  private async toSlack(ev: IntertieEvent, channel: string): Promise<void> {
    const slackChannel = this.slackChannelFor(channel);
    if (!slackChannel) return;
    if (ev.origin !== this.node.org || ev.type.startsWith('peer.') || ev.type.startsWith('channel.')) {
      this.log('info', 'intertie → slack', { type: ev.type, seq: ev.seq, origin: ev.origin, id: ev.id });
    }
    const b = ev.body as Record<string, any>;
    if (ev.type.startsWith('peer.') || ev.type.startsWith('channel.')) return this.notice(ev, slackChannel, channel);
    if (ev.origin === this.node.org) return; // our own Slack users' events are already in Slack
    const username = `${ev.sender?.name ?? ev.origin} (${ev.origin})`.slice(0, 80);
    switch (ev.type) {
      case 'message.create': {
        const threadTs = b.thread ? this.tsFor(channel, b.thread) : undefined;
        let text = this.mrkdwn(b.text ?? '', b.mentions);
        if (b.thread && !threadTs) text = `↳ ${text}`;
        if (text || !b.files?.length) {
          const r = await this.slack.call<{ ts: string }>('chat.postMessage', {
            channel: slackChannel, text: text || ' ', username, icon_url: ev.sender?.avatar, thread_ts: threadTs,
            unfurl_links: false, unfurl_media: false, link_names: false, parse: 'none',
          });
          this.remember(channel, ev.id, r.ts);
        }
        for (const f of (b.files ?? []) as FileRef[]) {
          try {
            const bytes = await this.node.fetchFile(ev, f);
            await this.slack.uploadFile({ channel: slackChannel, threadTs, filename: f.name, bytes, initialComment: `↑ from ${esc(username)}` });
          } catch (e) {
            this.log('warn', 'file relay failed', { err: String(e) });
            await this.post(slackChannel, `:warning: ${esc(username)} shared ${esc(f.name)} (${f.size} bytes), but it could not be fetched.`, threadTs);
          }
        }
        return;
      }
      case 'message.edit': {
        const ts = this.tsFor(channel, b.target);
        if (ts) await this.slack.call('chat.update', { channel: slackChannel, ts, text: this.mrkdwn(b.text, b.mentions), link_names: false, parse: 'none' });
        return;
      }
      case 'message.delete': {
        const ts = this.tsFor(channel, b.target);
        if (!ts) return;
        await this.slack.call('chat.delete', { channel: slackChannel, ts }).catch((e: SlackError) => {
          // The home may moderate one of our users' messages; a bot cannot delete a user's message.
          this.log('warn', 'chat.delete failed', { error: e.error });
        });
        this.forgetTs(channel, ts);
        return;
      }
      case 'reaction.add': case 'reaction.remove': {
        const ts = this.tsFor(channel, b.target);
        const name = toSlackReaction(b.emoji, b.name);
        if (!ts || !name || !ev.sender) return;
        const db = this.node.store.db;
        const count = () => (db.prepare('select count(*) n from slack_reactions where channel = ? and target = ? and name = ?').get(channel, b.target, name) as { n: number }).n;
        if (ev.type === 'reaction.add') {
          const before = count();
          db.prepare('insert or ignore into slack_reactions values (?,?,?,?)').run(channel, b.target, name, ev.sender.id);
          if (before === 0 && count() === 1) await this.slack.call('reactions.add', { channel: slackChannel, timestamp: ts, name }).catch((e: SlackError) => { if (e.error !== 'already_reacted') throw e; });
        } else {
          db.prepare('delete from slack_reactions where channel = ? and target = ? and name = ? and reactor = ?').run(channel, b.target, name, ev.sender.id);
          if (count() === 0) await this.slack.call('reactions.remove', { channel: slackChannel, timestamp: ts, name }).catch((e: SlackError) => { if (e.error !== 'no_reaction') throw e; });
        }
        return;
      }
      default:
        return; // unknown or unsupported types are ignored (spec/core.md §5)
    }
  }

  private mrkdwn(text: string, mentions?: Mention[]): string {
    const suffix = `@${this.node.org}`;
    return toMrkdwn(text, mentions ?? [], (id) => (id.endsWith(suffix) ? id.slice(0, -suffix.length) : null));
  }

  private async notice(ev: IntertieEvent, slackChannel: string, channel: string): Promise<void> {
    const b = ev.body as Record<string, any>;
    const self = this.node.org;
    switch (ev.type) {
      case 'peer.join':
        if (b.org !== self) await this.post(slackChannel, `:link: *${esc(String(b.display_name ?? b.org))}* (${esc(b.org)}) joined this shared channel. Messages here are now copied to ${esc(b.org)}.`);
        return;
      case 'peer.leave':
        if (b.org === self) { await this.post(slackChannel, ':broken_chain: This channel is no longer shared.'); this.unlink(slackChannel); }
        else await this.post(slackChannel, `:broken_chain: *${esc(b.org)}* ${b.reason === 'left' ? 'left' : 'was removed from'} this shared channel.`);
        return;
      case 'channel.close':
        await this.post(slackChannel, ':broken_chain: This channel is no longer shared.');
        this.unlink(slackChannel);
        return;
      case 'channel.update':
        if (ev.origin !== self && b.topic !== undefined) await this.post(slackChannel, `:pencil2: Shared channel topic: ${this.mrkdwn(b.topic || '(none)')}`);
        return;
    }
    void channel;
  }

  private async post(slackChannel: string, text: string, threadTs?: string): Promise<void> {
    await this.slack.call('chat.postMessage', { channel: slackChannel, text, thread_ts: threadTs, unfurl_links: false }).catch((e) => this.log('warn', 'notice failed', { err: String(e) }));
  }

  private async notifyRejected(ev: IntertieEvent, err: { code: string; message: string }): Promise<void> {
    const sc = this.slackChannelFor(ev.channel);
    if (sc && ev.type === 'message.create') await this.post(sc, `:warning: A message could not be delivered to the shared channel (${err.code}).`);
  }

  // ───────────────────────── slash command: /intertie ─────────────────────────

  private async onSlashCommand(p: SlashPayload): Promise<void> {
    const reply = (text: string) => this.slack.call('chat.postEphemeral', { channel: p.channel_id, user: p.user_id, text }).catch(() => undefined);
    const [cmd, ...rest] = (p.text ?? '').trim().split(/\s+/);
    try {
      if (!(await this.isAdmin(p.user_id))) return void (await reply('Only workspace admins can manage shared channels.'));
      switch (cmd) {
        case 'share': {
          const r = await this.share(p.channel_id);
          return void (await reply(`Shared. Give this invite to the other org's admin (single use, 7 days):\n\`${r.invite}\``));
        }
        case 'accept': {
          if (!rest[0]) return void (await reply('Usage: `/intertie accept intertie:<org>/<token>`'));
          await this.accept(rest[0], p.channel_id);
          return;
        }
        case 'unshare':
          await this.unshare(p.channel_id);
          return void (await reply('Unsharing…'));
        case 'status': {
          const l = this.status().links.find((x) => x.slack_channel === p.channel_id);
          return void (await reply(l ? `Shared channel \`${l.channel}\` (${l.role}, ${l.state}). Participants: ${esc(l.participants.join(', ')) || 'none yet'}. This org: \`${this.node.org}\`.` : `Not shared. This org: \`${this.node.org}\`.`));
        }
        default:
          return void (await reply('`/intertie share` · `/intertie accept <invite>` · `/intertie status` · `/intertie unshare`'));
      }
    } catch (e) {
      await reply(`:warning: ${e instanceof IntertieError ? `${e.code}: ${e.message}` : String(e)}`);
    }
  }

  private async isAdmin(user: string): Promise<boolean> {
    if (this.o.slack.adminUsers?.length) return this.o.slack.adminUsers.includes(user);
    return (await this.slackUser(user)).admin;
  }

  // ───────────────────────── HTTP: Events API, slash commands, admin, protocol ─────────────────────────

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/slack/events' || path === '/slack/commands') return this.slackHttp(req, res, path);
    return this.node.handle(req, res);
  }

  private async slackHttp(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const body = await readAll(req, 1024 * 1024);
    const secret = this.o.slack.signingSecret;
    const ts = String(req.headers['x-slack-request-timestamp'] ?? '');
    const sig = String(req.headers['x-slack-signature'] ?? '');
    const ok = !!secret && Math.abs(Date.now() / 1000 - Number(ts)) < 300 &&
      safeEqual(sig, 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body.toString('utf8')}`).digest('hex'));
    if (!ok) { res.writeHead(401).end(); return; }
    if (path === '/slack/commands') {
      const p = Object.fromEntries(new URLSearchParams(body.toString('utf8'))) as unknown as SlashPayload;
      res.writeHead(200).end();
      void this.onSlashCommand(p);
      return;
    }
    const j = JSON.parse(body.toString('utf8'));
    if (j.type === 'url_verification') { res.writeHead(200, { 'content-type': 'text/plain' }).end(String(j.challenge)); return; }
    res.writeHead(200).end();
    if (j.type === 'event_callback') this.enqueueSlackEvent(j.event, j.event_id);
  }

  private async admin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const reply = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b)); };
    const remote = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return reply(403, { error: 'loopback only' });
    if (!safeEqual(String(req.headers.authorization ?? ''), `Bearer ${this.adminToken}`)) return reply(401, { error: 'bad admin token' });
    try {
      const body = req.method === 'POST' ? JSON.parse((await readAll(req, 64 * 1024)).toString('utf8') || '{}') : {};
      if (path === '/admin/status') return reply(200, this.status());
      if (path === '/admin/share') return reply(200, await this.share(body.slack_channel, body.name));
      if (path === '/admin/accept') return reply(200, await this.accept(body.invite, body.slack_channel));
      if (path === '/admin/unshare') { await this.unshare(body.slack_channel); return reply(200, { ok: true }); }
      return reply(404, { error: 'not found' });
    } catch (e) {
      return reply(e instanceof IntertieError ? e.status : 500, { error: e instanceof IntertieError ? `${e.code}: ${e.message}` : String(e) });
    }
  }

  // ───────────────────────── state ─────────────────────────

  private link(slackChannel: string, channel: string): void {
    this.node.store.db.prepare('insert or replace into slack_links values (?, ?)').run(slackChannel, channel);
    this.log('audit', 'slack.link', { slack_channel: slackChannel, channel });
  }
  private unlink(slackChannel: string): void {
    this.node.store.db.prepare('delete from slack_links where slack_channel = ?').run(slackChannel);
    this.log('audit', 'slack.unlink', { slack_channel: slackChannel });
  }
  channelFor(slackChannel: string): string | null {
    return (this.node.store.db.prepare('select channel from slack_links where slack_channel = ?').get(slackChannel) as { channel: string } | undefined)?.channel ?? null;
  }
  slackChannelFor(channel: string): string | null {
    return (this.node.store.db.prepare('select slack_channel from slack_links where channel = ?').get(channel) as { slack_channel: string } | undefined)?.slack_channel ?? null;
  }
  private remember(channel: string, eventId: string, ts: string): void {
    this.node.store.db.prepare('insert or ignore into slack_msgs values (?,?,?)').run(channel, eventId, ts);
  }
  private tsFor(channel: string, eventId: string): string | undefined {
    return (this.node.store.db.prepare('select ts from slack_msgs where channel = ? and event_id = ?').get(channel, eventId) as { ts: string } | undefined)?.ts;
  }
  private eventForTs(channel: string, ts: string): string | null {
    return (this.node.store.db.prepare('select event_id from slack_msgs where channel = ? and ts = ?').get(channel, ts) as { event_id: string } | undefined)?.event_id ?? null;
  }
  private forgetTs(channel: string, ts: string): void {
    this.node.store.db.prepare('delete from slack_msgs where channel = ? and ts = ?').run(channel, ts);
  }

  private async slackUser(id: string): Promise<SlackUser> {
    const hit = this.users.get(id);
    if (hit && Date.now() - hit.at < 3600_000) return hit;
    const r = await this.slack.call<{ user: { team_id?: string; name?: string; real_name?: string; is_admin?: boolean; is_owner?: boolean; profile?: { display_name?: string; real_name?: string; image_192?: string } } }>('users.info', { user: id });
    const p = r.user.profile ?? {};
    const u: SlackUser = {
      name: (p.display_name || p.real_name || r.user.real_name || r.user.name || id).slice(0, 80),
      avatar: p.image_192?.startsWith('https://') ? p.image_192 : undefined,
      admin: !!(r.user.is_admin || r.user.is_owner), team: r.user.team_id, at: Date.now(),
    };
    this.users.set(id, u);
    return u;
  }

  private async sender(id: string): Promise<User> {
    const u = await this.slackUser(id).catch(() => ({ name: id, avatar: undefined }));
    return { id: `${id}@${this.node.org}`, name: u.name, ...(u.avatar ? { avatar: u.avatar } : {}) };
  }

  private log(level: 'info' | 'warn' | 'audit', msg: string, data?: Record<string, unknown>): void {
    this.o.node.log?.(level, msg, data);
  }
}

export interface SlashPayload { command: string; text: string; user_id: string; channel_id: string; response_url?: string }

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
