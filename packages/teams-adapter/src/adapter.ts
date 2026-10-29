// The Teams adapter: a Teams app (Azure Bot, single-tenant) that one participant installs in its own
// team. To the channel it is an ordinary Intertie org; to Teams it is a bot. spec/teams-mapping.md.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  derivedId, escapeHtml, htmlToMd, IntertieError, IntertieNode, mdToHtml,
  type FileRef, type IntertieEvent, type Mention, type NodeOptions, type User,
} from '@intertie/core';
import { AuthError, BotFramework, type BotFrameworkOptions } from './botframework.ts';

export interface TeamsAdapterOptions {
  node: Omit<NodeOptions, 'capabilities'> & { capabilities?: string[] };
  teams: Omit<BotFrameworkOptions, 'now'> & {
    /** aadObjectIds allowed to run @Intertie commands in a channel (CLI/admin API work regardless). */
    admins?: string[];
  };
  adminToken?: string;
  maxInlineImageBytes?: number;
}

interface Activity {
  type: string; id?: string; timestamp?: string; serviceUrl: string; channelId?: string;
  from?: { id: string; name?: string; aadObjectId?: string };
  conversation?: { id: string; conversationType?: string; tenantId?: string };
  recipient?: { id: string; name?: string };
  text?: string; textFormat?: string; replyToId?: string;
  attachments?: { contentType: string; content?: any; contentUrl?: string; name?: string }[];
  entities?: { type: string; mentioned?: { id: string; name?: string }; text?: string }[];
  channelData?: { eventType?: string; tenant?: { id: string }; team?: { id: string; name?: string }; channel?: { id: string; name?: string } };
  reactionsAdded?: { type: string }[]; reactionsRemoved?: { type: string }[];
}

const CAPABILITIES = ['threads', 'reactions', 'mentions', 'files'];
const SCHEMA = `
create table if not exists teams_links(conv text primary key, channel text not null unique, service_url text not null, tenant text not null);
create table if not exists teams_msgs(channel text not null, event_id text not null, activity_id text not null, thread_conv text not null,
  primary_ integer not null default 1, html text, primary key(channel, activity_id));
create index if not exists teams_msgs_ev on teams_msgs(channel, event_id);
create table if not exists teams_reactions(channel text not null, target text not null, emoji text not null, reactor text not null,
  primary key(channel, target, emoji, reactor));
create table if not exists teams_users(aad text primary key, teams_id text not null, name text not null);
create table if not exists teams_channels(conv text primary key, name text, team text, service_url text not null, tenant text not null);
`;

// Teams' classic reaction types; newer reactions arrive as hex code points (e.g. "1f440_eyes").
const REACTIONS: Record<string, string> = { like: '👍', heart: '❤️', laugh: '😆', surprised: '😮', sad: '😢', angry: '😠' };
export function teamsReactionToEmoji(type: string): string {
  if (REACTIONS[type]) return REACTIONS[type];
  const m = /^((?:[0-9a-f]{4,6})(?:_[0-9a-f]{4,6})*)(?:_[a-z].*)?$/i.exec(type);
  if (m) { try { return String.fromCodePoint(...m[1].split('_').map((h) => parseInt(h, 16))); } catch { /* fall through */ } }
  return `:${type}:`;
}

export class TeamsAdapter {
  readonly node: IntertieNode;
  readonly bf: BotFramework;
  readonly adminToken: string;
  adminPort = 0;
  private o: TeamsAdapterOptions;
  private servers: Server[] = [];
  private queues = new Map<string, Promise<void>>();
  private pending = 0;

  constructor(o: TeamsAdapterOptions) {
    this.o = o;
    this.node = new IntertieNode({ ...o.node, capabilities: o.node.capabilities ?? CAPABILITIES });
    this.node.store.db.exec(SCHEMA);
    this.bf = new BotFramework(o.teams);
    this.adminToken = o.adminToken ?? randomBytes(24).toString('base64url');
    this.node.onEvent((ev, ch) => this.toTeams(ev, ch.id));
    this.node.onRejected((ev, err) => { void this.rejected(ev, err.code); });
  }

  /**
   * Three listeners: the Intertie endpoint (`port`), the Bot Framework messaging endpoint
   * (`teamsPort`, the only one that needs to be public), and the loopback admin API.
   */
  async start(port: number, teamsPort: number, host = '127.0.0.1'): Promise<void> {
    const listen = async (handler: (q: IncomingMessage, r: ServerResponse) => void, p: number, h: string) => {
      const s = createServer(handler);
      await new Promise<void>((res) => s.listen(p, h, res));
      this.servers.push(s);
      return s;
    };
    await listen((q, r) => { void this.node.handle(q, r); }, port, host);
    await listen((q, r) => { void this.messages(q, r); }, teamsPort, host);
    const admin = await listen((q, r) => { void this.admin(q, r, (q.url ?? '/').split('?')[0]); }, 0, '127.0.0.1');
    this.adminPort = (admin.address() as { port: number }).port;
    this.node.start();
  }

  async stop(): Promise<void> {
    for (const s of this.servers) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
    await Promise.all([...this.queues.values()]);
    await this.node.stop();
  }

  isIdle(): boolean { return this.pending === 0 && this.node.isIdle(); }

  // ───────────────────────── admin ─────────────────────────

  /** A channel reference: the channel's conversation id (19:…@thread.tacv2) or its name. */
  resolveChannel(ref: string): { conv: string; serviceUrl: string; tenant: string } {
    const db = this.node.store.db;
    const row = (ref.startsWith('19:')
      ? db.prepare('select * from teams_channels where conv = ?').get(ref)
      : db.prepare('select * from teams_channels where name = ? or name = ?').get(ref.replace(/^#/, ''), ref)) as { conv: string; service_url: string; tenant: string } | undefined;
    if (!row) throw new IntertieError('bad_request', `unknown Teams channel ${ref}: install the app in the team and post once in the channel`);
    return { conv: row.conv, serviceUrl: row.service_url, tenant: row.tenant };
  }

  async share(ref: string, name?: string): Promise<{ channel: string; invite: string }> {
    const c = this.resolveChannel(ref);
    const existing = this.channelFor(c.conv);
    if (existing) {
      if (this.node.channel(existing)!.role !== 'home') throw new IntertieError('bad_request', 'this channel is linked to a channel homed elsewhere');
      return { channel: existing, invite: this.node.createInvite(existing) };
    }
    const chName = name ?? ((this.node.store.db.prepare('select name from teams_channels where conv = ?').get(c.conv) as { name?: string } | undefined)?.name) ?? 'shared';
    const ch = this.node.createChannel({ name: chName.slice(0, 80) });
    this.link(c, ch.id);
    return { channel: ch.id, invite: this.node.createInvite(ch.id) };
  }

  async accept(invite: string, ref: string): Promise<{ channel: string }> {
    const c = this.resolveChannel(ref);
    if (this.channelFor(c.conv)) throw new IntertieError('bad_request', 'this channel is already linked');
    const ch = await this.node.accept(invite);
    this.link(c, ch.id);
    await this.notice(ch.id, `🔗 This channel is now shared with <b>${escapeHtml(ch.home)}</b> over Intertie. Messages here are copied to the participating organizations.`);
    return { channel: ch.id };
  }

  async unshare(ref: string): Promise<void> {
    const c = this.resolveChannel(ref);
    const id = this.channelFor(c.conv);
    if (!id) throw new IntertieError('bad_request', 'not linked');
    const ch = this.node.channel(id)!;
    if (ch.role === 'home' && ch.state === 'open') this.node.closeChannel(id, 'unshared');
    else if (ch.role === 'peer' && ch.state === 'open') await this.node.leave(id);
  }

  status(): { org: string; links: { conv: string; channel: string; role: string; state: string; participants: string[] }[]; channels: { conv: string; name: string | null }[] } {
    const db = this.node.store.db;
    const links = db.prepare('select * from teams_links').all() as { conv: string; channel: string }[];
    return {
      org: this.node.org,
      links: links.map((l) => {
        const ch = this.node.channel(l.channel);
        return { conv: l.conv, channel: l.channel, role: ch?.role ?? '?', state: ch?.state ?? '?', participants: ch?.participants.filter((p) => p.state === 'active').map((p) => p.org) ?? [] };
      }),
      channels: db.prepare('select conv, name from teams_channels').all() as { conv: string; name: string | null }[],
    };
  }

  // ───────────────────────── Teams → Intertie ─────────────────────────

  /** POST /api/messages: the Bot Framework messaging endpoint. Verify, acknowledge, then process in order. */
  private async messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/api/messages') { res.writeHead(404).end(); return; }
    let activity: Activity;
    try {
      activity = JSON.parse((await readAll(req, 512 * 1024)).toString('utf8'));
      await this.bf.verifyInbound(req.headers.authorization, activity);
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 400;
      this.log('audit', 'teams.reject', { status, reason: String((e as Error).message) });
      res.writeHead(status).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    const key = (activity.conversation?.id ?? 'misc').split(';')[0];
    this.pending++;
    const next = (this.queues.get(key) ?? Promise.resolve())
      .then(() => this.fromTeams(activity))
      .catch((err) => this.log('warn', 'teams activity failed', { type: activity.type, err: String(err) }))
      .finally(() => { this.pending--; });
    this.queues.set(key, next);
  }

  async fromTeams(a: Activity): Promise<void> {
    const sent = await this.fromTeamsInner(a);
    if (sent) this.log('info', 'teams → intertie', { type: sent.type, channel: sent.channel, id: sent.id, ...(sent.seq ? { seq: sent.seq } : {}) });
  }

  private async fromTeamsInner(a: Activity): Promise<IntertieEvent | void> {
    const convFull = a.conversation?.id ?? '';
    const conv = convFull.split(';')[0];
    const tenant = a.channelData?.tenant?.id ?? a.conversation?.tenantId ?? '';
    if (tenant && tenant !== this.o.teams.tenantId) return void this.log('warn', 'activity from another tenant ignored', {});
    if (a.conversation?.conversationType === 'channel' || conv.endsWith('@thread.tacv2') || conv.endsWith('@thread.skype')) {
      this.rememberChannel(conv, a.channelData?.channel?.name ?? null, a.channelData?.team?.id ?? null, a.serviceUrl, tenant || this.o.teams.tenantId);
    }
    if (a.type === 'conversationUpdate') return;
    if (a.from?.aadObjectId && a.from.id) this.rememberUser(a.from.aadObjectId, a.from.id, a.from.name ?? '');
    if (a.from?.id === a.recipient?.id) return; // our own bot (Teams does not deliver these anyway)

    const textOf = (): { text: string; mentions: Mention[] } => this.toMarkdown(a);
    if (a.type === 'message') {
      const plain = textOf().text.trim();
      const cmd = /^(?:@\S+\s+)?(share|accept|status|unshare)\b\s*(\S*)/i.exec(plain);
      const botMentioned = (a.entities ?? []).some((e) => e.type === 'mention' && e.mentioned?.id === a.recipient?.id);
      if (cmd && botMentioned) return void (await this.command(conv, a, cmd[1].toLowerCase(), cmd[2]));
    }
    const channel = this.channelFor(conv);
    if (!channel) return;
    const ch = this.node.channel(channel);
    if (!ch || ch.state !== 'open') return;
    const sender = (): User => ({ id: `${a.from?.aadObjectId ?? a.from?.id}@${this.node.org}`, name: (a.from?.name || 'Teams user').slice(0, 80) });
    const id = derivedId(this.node.org, a.type, a.id ?? '', a.timestamp ?? '');

    switch (a.type) {
      case 'message': {
        if (!a.id || this.eventFor(channel, a.id)) return;
        const root = /;messageid=(\d+)/.exec(convFull)?.[1];
        let thread: string | undefined;
        let prefix = '';
        if (root && root !== a.id) {
          thread = this.eventFor(channel, root) ?? undefined;
          if (!thread) prefix = '↳ ';
        }
        const conv2 = textOf();
        const files = this.fileLinks(a);
        const text = prefix + conv2.text + (files ? `${conv2.text ? '\n' : ''}${files}` : '');
        if (!text.trim()) return;
        this.remember(channel, id, a.id, root && root !== a.id ? `${conv};messageid=${root}` : `${conv};messageid=${a.id}`, null);
        return this.node.send(channel, { id, type: 'message.create', sender: sender(), body: { text, ...(thread ? { thread } : {}), ...(conv2.mentions.length ? { mentions: conv2.mentions } : {}) } });
      }
      case 'messageUpdate': {
        if (a.channelData?.eventType !== 'editMessage' || !a.id) return;
        const target = this.eventFor(channel, a.id);
        if (!target) return;
        const conv2 = textOf();
        return this.node.send(channel, { id, type: 'message.edit', sender: sender(), body: { target, text: conv2.text || '(empty)', ...(conv2.mentions.length ? { mentions: conv2.mentions } : {}) } });
      }
      case 'messageDelete': {
        if (a.channelData?.eventType !== 'softDeleteMessage' || !a.id) return;
        const target = this.eventFor(channel, a.id);
        if (!target) return;
        if (this.isRemote(channel, a.id)) return; // moderation of a remote message in Teams: local only
        this.forget(channel, target);
        return this.node.send(channel, { id, type: 'message.delete', body: { target } });
      }
      case 'messageReaction': {
        // Teams only reports reactions on the bot's own posts, i.e. on remote messages.
        const target = a.replyToId ? this.eventFor(channel, a.replyToId) : null;
        if (!target) return;
        let last: IntertieEvent | void = undefined;
        for (const [list, type] of [[a.reactionsAdded, 'reaction.add'], [a.reactionsRemoved, 'reaction.remove']] as const) {
          for (const r of list ?? []) {
            last = await this.node.send(channel, { id: derivedId(id, type, r.type), type, sender: sender(), body: { target, emoji: teamsReactionToEmoji(r.type), name: r.type } });
          }
        }
        return last;
      }
    }
  }

  /** Teams HTML (or text) → Markdown, with <at> mentions mapped to Intertie ids. The bot's own mention is dropped. */
  private toMarkdown(a: Activity): { text: string; mentions: Mention[] } {
    const html = (a.attachments ?? []).find((x) => x.contentType === 'text/html')?.content ?? a.text ?? '';
    const ents = (a.entities ?? []).filter((e) => e.type === 'mention' && e.mentioned);
    const mentions: Mention[] = [];
    let s = String(html);
    let i = 0;
    s = s.replace(/<at[^>]*>([\s\S]*?)<\/at>/gi, (_m, name: string) => {
      const e = ents[i++];
      if (!e || e.mentioned!.id === a.recipient?.id) return '';
      const aad = (this.node.store.db.prepare('select aad from teams_users where teams_id = ?').get(e.mentioned!.id) as { aad?: string } | undefined)?.aad;
      const clean = name.replace(/<[^>]+>/g, '');
      if (aad) mentions.push({ id: `${aad}@${this.node.org}`, name: clean });
      else if (e.mentioned!.id.includes('@')) mentions.push({ id: e.mentioned!.id, name: clean }); // a remote user we mentioned
      return `@${clean}`;
    });
    const md = /<[a-z][\s\S]*>/i.test(s) ? htmlToMd(s, (x) => x, () => null).text : s;
    return { text: md.replace(/^\s+/, ''), mentions };
  }

  /** Channel attachments are SharePoint references; we pass name and link (tenant-gated) along. */
  private fileLinks(a: Activity): string {
    return (a.attachments ?? []).filter((x) => x.contentType === 'reference' && x.contentUrl && x.name)
      .map((x) => `📎 [${x.name}](${x.contentUrl}) (a file in ${this.node.org}'s Teams; opening it needs access there)`).join('\n');
  }

  // ───────────────────────── Intertie → Teams ─────────────────────────

  private async toTeams(ev: IntertieEvent, channel: string): Promise<void> {
    const link = this.linkFor(channel);
    if (!link) return;
    const b = ev.body as Record<string, any>;
    if (ev.type.startsWith('peer.') || ev.type.startsWith('channel.')) return this.controlNotice(ev, channel);
    if (ev.origin === this.node.org) return;
    this.log('info', 'intertie → teams', { type: ev.type, seq: ev.seq, origin: ev.origin, id: ev.id });
    switch (ev.type) {
      case 'message.create': {
        const rootActivity = b.thread ? this.activityFor(channel, b.thread) : undefined;
        const prefix = b.thread && !rootActivity ? '↳ ' : '';
        const files = (b.files ?? []) as FileRef[];
        const { html, entities, attachments } = await this.render(ev, prefix + (b.text ?? ''), b.mentions, files);
        const activity = { type: 'message', text: html, textFormat: 'xml', ...(entities.length ? { entities } : {}), ...(attachments.length ? { attachments } : {}) };
        let activityId: string, threadConv: string;
        if (rootActivity) {
          threadConv = rootActivity.thread_conv;
          activityId = (await this.bf.connector<{ id: string }>(link.serviceUrl, 'POST', `/v3/conversations/${encodeURIComponent(threadConv)}/activities`, activity)).id;
        } else {
          const r = await this.bf.connector<{ id: string; activityId: string }>(link.serviceUrl, 'POST', '/v3/conversations', {
            isGroup: true, channelData: { channel: { id: link.conv }, tenant: { id: link.tenant } }, activity, tenantId: link.tenant,
          });
          activityId = r.activityId;
          threadConv = r.id.includes(';messageid=') ? r.id : `${link.conv};messageid=${r.activityId}`;
        }
        this.remember(channel, ev.id, activityId, threadConv, html);
        return;
      }
      case 'message.edit': {
        const t = this.activityFor(channel, b.target);
        if (!t || t.html === null) return;
        const { html, entities } = await this.render(ev, b.text, b.mentions, []);
        const full = html + this.reactionFooter(channel, b.target);
        await this.bf.connector(link.serviceUrl, 'PUT', `/v3/conversations/${encodeURIComponent(t.thread_conv)}/activities/${encodeURIComponent(t.activity_id)}`, { type: 'message', id: t.activity_id, text: full, textFormat: 'xml', ...(entities.length ? { entities } : {}) });
        this.node.store.db.prepare('update teams_msgs set html = ? where channel = ? and activity_id = ?').run(html, channel, t.activity_id);
        return;
      }
      case 'message.delete': {
        const t = this.activityFor(channel, b.target);
        if (!t) return;
        if (t.html === null) return void this.log('warn', 'a remote delete of a Teams user message cannot be applied (bots cannot delete user messages)', { target: b.target });
        await this.bf.connector(link.serviceUrl, 'DELETE', `/v3/conversations/${encodeURIComponent(t.thread_conv)}/activities/${encodeURIComponent(t.activity_id)}`);
        this.forget(channel, b.target);
        return;
      }
      case 'reaction.add': case 'reaction.remove': {
        // Bots cannot react in Teams. Remote reactions on remote messages (our own posts) are shown as a
        // footer line we keep up to date; reactions on Teams users' messages cannot be shown.
        const t = this.activityFor(channel, b.target);
        if (!t || t.html === null || !ev.sender) return;
        const db = this.node.store.db;
        if (ev.type === 'reaction.add') db.prepare('insert or ignore into teams_reactions values (?,?,?,?)').run(channel, b.target, b.emoji, ev.sender.id);
        else db.prepare('delete from teams_reactions where channel = ? and target = ? and emoji = ? and reactor = ?').run(channel, b.target, b.emoji, ev.sender.id);
        await this.bf.connector(link.serviceUrl, 'PUT', `/v3/conversations/${encodeURIComponent(t.thread_conv)}/activities/${encodeURIComponent(t.activity_id)}`, { type: 'message', id: t.activity_id, text: t.html + this.reactionFooter(channel, b.target), textFormat: 'xml' });
        return;
      }
      default:
        return;
    }
  }

  /** The byline + body Teams shows for a remote message (a bot cannot post as another person). */
  private async render(ev: IntertieEvent, text: string, mentions: Mention[] | undefined, files: FileRef[]) {
    const entities: { type: 'mention'; text: string; mentioned: { id: string; name: string } }[] = [];
    const suffix = `@${this.node.org}`;
    const body = mdToHtml(text, mentions ?? [], (id) => {
      if (!id.endsWith(suffix)) return null;
      return (this.node.store.db.prepare('select teams_id from teams_users where aad = ?').get(id.slice(0, -suffix.length)) as { teams_id?: string } | undefined)?.teams_id ?? null;
    }, (teamsId, name) => {
      entities.push({ type: 'mention', text: `<at>${escapeHtml(name)}</at>`, mentioned: { id: teamsId, name } });
      return `<at>${escapeHtml(name)}</at>`;
    }).html;
    const byline = `<b>${escapeHtml(ev.sender?.name ?? ev.origin)}</b> <i>(${escapeHtml(ev.origin)})</i>`;
    const attachments: { contentType: string; contentUrl: string; name: string }[] = [];
    const notes: string[] = [];
    for (const f of files) {
      if (/^image\/(png|jpeg|gif)$/.test(f.mime) && f.size <= (this.o.maxInlineImageBytes ?? 1024 * 1024)) {
        try {
          const bytes = await this.node.fetchFile(ev, f);
          attachments.push({ contentType: f.mime, contentUrl: `data:${f.mime};base64,${bytes.toString('base64')}`, name: f.name });
          continue;
        } catch { /* fall through to a note */ }
      }
      notes.push(`📎 ${escapeHtml(f.name)} (${f.size} bytes): files from other organizations are not copied into Teams yet`);
    }
    const html = `${byline}<br>${body}${notes.length ? `<br>${notes.join('<br>')}` : ''}`;
    return { html, entities, attachments };
  }

  private reactionFooter(channel: string, target: string): string {
    const rows = this.node.store.db.prepare('select emoji, count(*) n from teams_reactions where channel = ? and target = ? group by emoji order by min(rowid)').all(channel, target) as { emoji: string; n: number }[];
    return rows.length ? `<br><i>${rows.map((r) => `${escapeHtml(r.emoji)} ${r.n}`).join(' · ')}</i>` : '';
  }

  private async controlNotice(ev: IntertieEvent, channel: string): Promise<void> {
    const b = ev.body as Record<string, any>;
    const self = this.node.org;
    if (ev.type === 'peer.join' && b.org !== self) await this.notice(channel, `🔗 <b>${escapeHtml(String(b.display_name ?? b.org))}</b> (${escapeHtml(b.org)}) joined this shared channel. Messages here are now copied to ${escapeHtml(b.org)}.`);
    if (ev.type === 'peer.leave') {
      if (b.org === self) { await this.notice(channel, '⛓️‍💥 This channel is no longer shared.'); this.unlink(channel); }
      else await this.notice(channel, `⛓️‍💥 <b>${escapeHtml(b.org)}</b> ${b.reason === 'left' ? 'left' : 'was removed from'} this shared channel.`);
    }
    if (ev.type === 'channel.close') { await this.notice(channel, '⛓️‍💥 This channel is no longer shared.'); this.unlink(channel); }
  }

  private async notice(channel: string, html: string, threadConv?: string): Promise<void> {
    const link = this.linkFor(channel);
    if (!link) return;
    const activity = { type: 'message', text: html, textFormat: 'xml' };
    await (threadConv
      ? this.bf.connector(link.serviceUrl, 'POST', `/v3/conversations/${encodeURIComponent(threadConv)}/activities`, activity)
      : this.bf.connector(link.serviceUrl, 'POST', '/v3/conversations', { isGroup: true, channelData: { channel: { id: link.conv }, tenant: { id: link.tenant } }, activity, tenantId: link.tenant })
    ).catch((e) => this.log('warn', 'notice failed', { err: String(e) }));
  }

  private async rejected(ev: IntertieEvent, code: string): Promise<void> {
    if (ev.type === 'message.create') await this.notice(ev.channel, `⚠️ A message could not be delivered to the shared channel (${escapeHtml(code)}).`);
  }

  // ───────────────────────── @Intertie commands ─────────────────────────

  private async command(conv: string, a: Activity, cmd: string, arg: string): Promise<void> {
    const reply = (html: string) => this.bf.connector(a.serviceUrl, 'POST', `/v3/conversations/${encodeURIComponent(a.conversation!.id)}/activities`, { type: 'message', text: html, textFormat: 'xml', replyToId: a.id })
      .catch((e) => this.log('warn', 'reply failed', { err: String(e) }));
    const admins = this.o.teams.admins ?? [];
    if (!a.from?.aadObjectId || !admins.includes(a.from.aadObjectId)) {
      return void (await reply('Only configured admins can manage sharing from Teams (TEAMS_ADMINS); the operator can also use the intertie-teams CLI.'));
    }
    try {
      if (cmd === 'share') {
        const r = await this.share(conv);
        return void (await reply(`Shared. Give this invite to the other organization's admin (single use, 7 days): <code>${escapeHtml(r.invite)}</code>`));
      }
      if (cmd === 'accept' && arg) { await this.accept(arg, conv); return; }
      if (cmd === 'unshare') { await this.unshare(conv); return; }
      const l = this.status().links.find((x) => x.conv === conv);
      return void (await reply(l ? `Shared channel <code>${escapeHtml(l.channel)}</code> (${l.role}, ${l.state}). Participants: ${escapeHtml(l.participants.join(', ') || 'none yet')}.` : `Not shared. This org: ${escapeHtml(this.node.org)}.`));
    } catch (e) {
      await reply(`⚠️ ${escapeHtml(e instanceof IntertieError ? `${e.code}: ${e.message}` : String(e))}`);
    }
  }

  // ───────────────────────── admin API (loopback) ─────────────────────────

  private async admin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const reply = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b)); };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return reply(403, { error: 'loopback only' });
    if (!safeEqual(String(req.headers.authorization ?? ''), `Bearer ${this.adminToken}`)) return reply(401, { error: 'bad admin token' });
    try {
      const body = req.method === 'POST' ? JSON.parse((await readAll(req, 64 * 1024)).toString('utf8') || '{}') : {};
      if (path === '/admin/status') return reply(200, this.status());
      if (path === '/admin/share') return reply(200, await this.share(body.teams_channel, body.name));
      if (path === '/admin/accept') return reply(200, await this.accept(body.invite, body.teams_channel));
      if (path === '/admin/unshare') { await this.unshare(body.teams_channel); return reply(200, { ok: true }); }
      return reply(404, { error: 'not found' });
    } catch (e) {
      return reply(e instanceof IntertieError ? e.status : 500, { error: e instanceof IntertieError ? `${e.code}: ${e.message}` : String(e) });
    }
  }

  // ───────────────────────── state ─────────────────────────

  private rememberChannel(conv: string, name: string | null, team: string | null, serviceUrl: string, tenant: string): void {
    this.node.store.db.prepare(`insert into teams_channels(conv, name, team, service_url, tenant) values (?,?,?,?,?)
      on conflict(conv) do update set name = coalesce(excluded.name, teams_channels.name), team = coalesce(excluded.team, teams_channels.team),
      service_url = excluded.service_url`).run(conv, name, team, serviceUrl, tenant);
  }
  private rememberUser(aad: string, teamsId: string, name: string): void {
    this.node.store.db.prepare('insert into teams_users values (?,?,?) on conflict(aad) do update set teams_id = excluded.teams_id, name = excluded.name').run(aad, teamsId, name);
  }
  private link(c: { conv: string; serviceUrl: string; tenant: string }, channel: string): void {
    this.node.store.db.prepare('insert or replace into teams_links values (?,?,?,?)').run(c.conv, channel, c.serviceUrl, c.tenant);
    this.log('audit', 'teams.link', { conv: c.conv, channel });
  }
  private unlink(channel: string): void {
    this.node.store.db.prepare('delete from teams_links where channel = ?').run(channel);
    this.log('audit', 'teams.unlink', { channel });
  }
  channelFor(conv: string): string | null {
    return (this.node.store.db.prepare('select channel from teams_links where conv = ?').get(conv) as { channel: string } | undefined)?.channel ?? null;
  }
  private linkFor(channel: string): { conv: string; serviceUrl: string; tenant: string } | null {
    const r = this.node.store.db.prepare('select * from teams_links where channel = ?').get(channel) as { conv: string; service_url: string; tenant: string } | undefined;
    return r ? { conv: r.conv, serviceUrl: r.service_url, tenant: r.tenant } : null;
  }
  private remember(channel: string, eventId: string, activityId: string, threadConv: string, html: string | null): void {
    this.node.store.db.prepare('insert or ignore into teams_msgs(channel, event_id, activity_id, thread_conv, primary_, html) values (?,?,?,?,1,?)').run(channel, eventId, activityId, threadConv, html);
  }
  private activityFor(channel: string, eventId: string): { activity_id: string; thread_conv: string; html: string | null } | undefined {
    return this.node.store.db.prepare('select activity_id, thread_conv, html from teams_msgs where channel = ? and event_id = ?').get(channel, eventId) as never;
  }
  private eventFor(channel: string, activityId: string): string | null {
    return (this.node.store.db.prepare('select event_id from teams_msgs where channel = ? and activity_id = ?').get(channel, activityId) as { event_id: string } | undefined)?.event_id ?? null;
  }
  private isRemote(channel: string, activityId: string): boolean {
    return (this.node.store.db.prepare('select html from teams_msgs where channel = ? and activity_id = ?').get(channel, activityId) as { html: string | null } | undefined)?.html != null;
  }
  private forget(channel: string, eventId: string): void {
    this.node.store.db.prepare('delete from teams_msgs where channel = ? and event_id = ?').run(channel, eventId);
  }
  private log(level: 'info' | 'warn' | 'audit', msg: string, data?: Record<string, unknown>): void { this.o.node.log?.(level, msg, data); }
}

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
