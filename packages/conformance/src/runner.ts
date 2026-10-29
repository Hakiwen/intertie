// The conformance runner: drives an implementation as a peer (to test its home role) and as a
// home (to test its peer role). It uses the reference engine for its own identities and raw
// signed requests for the negative paths. spec/conformance.md.
import { createServer, type Server } from 'node:http';
import {
  importPrivate, IntertieNode, newId, parseInvite, safeFetch, signRequest, validateDiscovery,
  type DiscoveryDoc, type IntertieEvent, type PrivateJwk,
} from '@intertie/core';
import type { TestResult } from './report.ts';

export interface Identity {
  node: IntertieNode;
  key: PrivateJwk;
  /** Request log for this identity's endpoint (method + path), to observe pulls. */
  requests: string[];
}

/** Serve a runner identity, logging the requests the subject makes to it. */
export async function serveIdentity(node: IntertieNode, key: PrivateJwk, port: number, host = '127.0.0.1'): Promise<{ id: Identity; server: Server }> {
  const id: Identity = { node, key, requests: [] };
  const server = createServer((req, res) => { id.requests.push(`${req.method} ${req.url}`); void node.handle(req, res); });
  await new Promise<void>((r) => server.listen(port, host, r));
  node.start();
  return { id, server };
}

interface Raw { status: number; json: any }

async function raw(
  id: Identity | null, method: string, url: string, body: unknown,
  o: { created?: number; nonce?: string; kid?: string; signUrl?: string; tamper?: boolean; noDigest?: boolean; headers?: Record<string, string>; dev?: boolean; bytes?: Buffer } = {},
): Promise<Raw> {
  const bytes = o.bytes ?? (body === undefined ? null : Buffer.from(JSON.stringify(body)));
  let headers: Record<string, string> = { accept: 'application/json' };
  if (bytes) headers['content-type'] = 'application/json';
  if (id) {
    const key = { keyid: `${id.node.org}#${o.kid ?? id.key.kid}`, privateKey: importPrivate(id.key) };
    headers = { ...headers, ...signRequest({ method, url: o.signUrl ?? url, body: o.noDigest ? null : bytes, key, created: o.created, nonce: o.nonce }) };
  }
  Object.assign(headers, o.headers);
  const sent = o.tamper && bytes ? Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from(' }')]) : bytes;
  const r = await safeFetch(url, { method, headers, body: sent ?? undefined, devInsecure: o.dev, timeoutMs: 40_000, maxBytes: 8 * 1024 * 1024 });
  let json: any = null;
  try { json = JSON.parse(r.body.toString('utf8')); } catch { /* not JSON */ }
  return { status: r.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(25); }
  return cond();
}

class Suite {
  results: TestResult[] = [];
  private role: string;
  constructor(role: string) { this.role = role; }
  async t(id: string, level: string, fn: () => Promise<string | void>): Promise<boolean> {
    try {
      const detail = (await fn()) ?? 'ok';
      this.results.push({ id, level, role: this.role, pass: true, detail });
      return true;
    } catch (e) {
      this.results.push({ id, level, role: this.role, pass: false, detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }
  skip(id: string, level: string, why: string): void {
    this.results.push({ id, level, role: this.role, pass: true, skipped: true, detail: `skipped: ${why}` });
  }
}

function expect(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const result0 = (r: Raw) => r.json?.results?.[0] as { status: string; seq?: number; error?: { code: string } } | undefined;
const desc = (r: Raw) => `HTTP ${r.status}${r.json?.error ? ` ${r.json.error.code}` : ''}${result0(r) ? ` ${result0(r)!.status}${result0(r)!.error ? ` ${result0(r)!.error!.code}` : ''}` : ''}`;

function expectStatus(r: Raw, status: number, code?: string): string {
  expect(r.status === status, `expected HTTP ${status}${code ? ` ${code}` : ''}, got ${desc(r)}`);
  if (code) expect(r.json?.error?.code === code, `expected error ${code}, got ${desc(r)}`);
  return desc(r);
}
function expectResult(r: Raw, status: string, codes?: string[]): string {
  expect(r.status === 200, `expected HTTP 200, got ${desc(r)}`);
  const x = result0(r);
  expect(x?.status === status, `expected ${status}, got ${desc(r)}`);
  if (codes) expect(codes.includes(x!.error?.code ?? ''), `expected ${codes.join('|')}, got ${desc(r)}`);
  return desc(r);
}

export interface HomeSuiteOptions {
  invite: string;
  r1: Identity;
  /** A second identity that never joins, for non-participant tests. Optional outside dev mode. */
  r2?: Identity;
  devInsecure?: boolean;
  timeoutMs?: number;
}

/** Test the subject in the `home` role, using an invite it issued. */
export async function runHomeSuite(o: HomeSuiteOptions): Promise<{ results: TestResult[]; subject: DiscoveryDoc }> {
  const s = new Suite('home');
  const dev = o.devInsecure;
  const timeout = o.timeoutMs ?? 10_000;
  const inv = parseInvite(o.invite);
  if (!inv) throw new Error('malformed invite');
  const r1 = o.r1;
  let doc!: DiscoveryDoc;
  await s.t('core.discovery.valid', 'core', async () => {
    const proto = dev && !inv.home.includes('.') ? 'http' : 'https';
    const r = await safeFetch(`${proto}://${inv.home}/.well-known/intertie`, { devInsecure: dev, maxBytes: 64 * 1024 });
    expect(r.status === 200, `HTTP ${r.status}`);
    expect(String(r.headers['content-type'] ?? '').includes('application/json'), 'content-type must be application/json');
    doc = validateDiscovery(JSON.parse(r.body.toString('utf8')), inv.home, dev);
    return `${doc.keys.length} key(s), capabilities [${(doc.capabilities ?? []).join(', ')}]`;
  });
  if (!doc) return { results: s.results, subject: { intertie: '?', org: inv.home, endpoint: '', keys: [] } };
  const ep = doc.endpoint;
  const caps = new Set(doc.capabilities ?? []);
  const seen: IntertieEvent[] = [];
  r1.node.onEvent((e) => { seen.push(e); });

  let ch!: { id: string; seq: number };
  const ok = await s.t('core.accept', 'core', async () => {
    const c = await r1.node.accept(o.invite);
    ch = { id: c.id, seq: c.seq };
    expect(c.id.endsWith(`@${inv.home}`), `channel id ${c.id} is not scoped to the home`);
    return `joined ${c.id} at seq ${c.seq}`;
  });
  if (!ok) return { results: s.results, subject: doc };
  const chUrl = `${ep}/channels/${encodeURIComponent(ch.id)}/events`;
  const me = (local = 'conformance') => ({ id: `${local}@${r1.node.org}`, name: 'Conformance Runner' });
  const ev = (type: string, body: Record<string, unknown>, extra: Partial<IntertieEvent> = {}) => ({
    id: newId(), type, channel: ch.id, origin: r1.node.org, sender: me(), ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), body, ...extra,
  });
  const submit = (e: object | object[], id: Identity = r1, opts = {}) => raw(id, 'POST', `${ep}/events`, { events: Array.isArray(e) ? e : [e] }, { dev, ...opts });

  await s.t('core.push.peer-join', 'core', async () => {
    const got = await until(() => seen.some((e) => e.type === 'peer.join' && (e.body as { org?: string }).org === r1.node.org), timeout);
    expect(got, 'no peer.join for the runner was delivered (push or pull)');
    const j = seen.find((e) => e.type === 'peer.join')!;
    expect(j.seq === ch.seq + 1, `peer.join seq ${j.seq}, expected ${ch.seq + 1}`);
    return `peer.join at seq ${j.seq}`;
  });
  await s.t('core.accept.idempotent', 'core', async () => {
    const r = await raw(r1, 'POST', `${ep}/accept`, { token: inv.token, delivery: 'push' }, { dev });
    expect(r.status === 200 && r.json?.channel?.id === ch.id, `repeat accept: ${desc(r)}`);
    return 'same channel returned';
  });
  if (o.r2) {
    await s.t('core.accept.single-use', 'core', async () => expectStatus(await raw(o.r2!, 'POST', `${ep}/accept`, { token: inv.token }, { dev }), 404, 'invalid_invite'));
  } else s.skip('core.accept.single-use', 'core', 'no second runner identity');

  const msg = ev('message.create', { text: 'Conformance: **hello**' });
  let msgSeq = 0;
  await s.t('core.submit.accepted', 'core', async () => {
    const r = await submit(msg);
    const d = expectResult(r, 'accepted');
    msgSeq = result0(r)!.seq!;
    expect(Number.isInteger(msgSeq) && msgSeq > ch.seq, `bad seq ${msgSeq}`);
    return `${d} seq ${msgSeq}`;
  });
  await s.t('core.submit.duplicate', 'core', async () => {
    const r = await submit(msg);
    const d = expectResult(r, 'duplicate');
    expect(result0(r)!.seq === msgSeq, `duplicate returned seq ${result0(r)!.seq}, expected ${msgSeq}`);
    return d;
  });
  await s.t('core.deliver.own-event', 'core', async () => {
    expect(await until(() => seen.some((e) => e.id === msg.id && e.seq === msgSeq), timeout), 'home did not deliver the runner its own sequenced event');
  });
  await s.t('core.submit.seq-forbidden', 'core', async () => expectResult(await submit(ev('message.create', { text: 'x' }, { seq: 999 })), 'rejected', ['invalid_event']));
  await s.t('core.thread.reply', 'core', async () => expectResult(await submit(ev('message.create', { text: 'reply', thread: msg.id })), 'accepted'));
  await s.t('core.thread.bad-root', 'core', async () => expectResult(await submit(ev('message.create', { text: 'x', thread: newId() })), 'rejected', ['invalid_event']));
  await s.t('core.edit.own', 'core', async () => expectResult(await submit(ev('message.edit', { target: msg.id, text: 'Conformance: edited' })), 'accepted'));
  await s.t('core.edit.other-sender', 'core', async () => expectResult(await submit(ev('message.edit', { target: msg.id, text: 'x' }, { sender: me('someone-else') })), 'rejected', ['not_author']));
  await s.t('core.edit.non-message', 'core', async () => {
    const join = seen.find((e) => e.type === 'peer.join');
    expect(join, 'needs the peer.join event');
    return expectResult(await submit(ev('message.edit', { target: join!.id, text: 'x' })), 'rejected', ['not_author', 'invalid_event']);
  });
  await s.t('core.authz.origin', 'core', async () => {
    const other = 'impostor.example';
    return expectResult(await submit(ev('message.create', { text: 'x' }, { origin: other, sender: { id: `u@${other}`, name: 'X' } })), 'rejected', ['bad_origin']);
  });
  await s.t('core.authz.sender-org', 'core', async () => expectResult(await submit(ev('message.create', { text: 'x' }, { sender: { id: `u@${inv.home}`, name: 'Not mine' } })), 'rejected', ['bad_origin', 'invalid_event']));
  await s.t('core.authz.home-only', 'core', async () => expectResult(await submit(ev('channel.update', { topic: 'hijacked' }, { sender: undefined })), 'rejected', ['not_author']));
  await s.t('core.ext.unknown-type', 'core', async () => expectResult(await submit(ev('conformance.example/ping', { n: 1 })), 'accepted'));
  await s.t('core.limits.text', 'core', async () => expectResult(await submit(ev('message.create', { text: 'x'.repeat(16_001) })), 'rejected', ['too_large', 'invalid_event']));
  await s.t('core.limits.batch', 'core', async () => expectStatus(await submit(Array.from({ length: 101 }, () => ev('message.create', { text: 'x' }))), 400));
  await s.t('core.limits.body', 'core', async () => {
    const r = await raw(r1, 'POST', `${ep}/events`, undefined, { dev, bytes: Buffer.from(JSON.stringify({ events: [ev('message.create', { text: 'y'.repeat(1_100_000) })] })) });
    return expectStatus(r, 413);
  });

  await s.t('core.sig.missing', 'core', async () => expectStatus(await raw(null, 'POST', `${ep}/events`, { events: [ev('message.create', { text: 'x' })] }, { dev }), 401));
  await s.t('core.sig.digest', 'core', async () => expectStatus(await submit(ev('message.create', { text: 'x' }), r1, { tamper: true }), 401, 'bad_digest'));
  await s.t('core.sig.target-uri', 'core', async () => expectStatus(await submit(ev('message.create', { text: 'x' }), r1, { signUrl: `${ep}/other` }), 401, 'bad_signature'));
  await s.t('core.sig.components', 'core', async () => expectStatus(await submit(ev('message.create', { text: 'x' }), r1, { noDigest: true }), 401, 'bad_signature'));
  await s.t('core.sig.stale', 'core', async () => expectStatus(await submit(ev('message.create', { text: 'x' }), r1, { created: Math.floor(Date.now() / 1000) - 600 }), 401, 'stale_signature'));
  await s.t('core.sig.replay', 'core', async () => {
    const e = ev('message.create', { text: 'replay' });
    const nonce = newId();
    const created = Math.floor(Date.now() / 1000);
    const first = await submit(e, r1, { nonce, created });
    expect(first.status === 200, `first request failed: ${desc(first)}`);
    return expectStatus(await submit(e, r1, { nonce, created }), 401, 'replayed');
  });
  await s.t('core.sig.unknown-key', 'core', async () => expectStatus(await submit(ev('message.create', { text: 'x' }), r1, { kid: 'not-published' }), 401, 'unknown_key'));

  await s.t('core.pull.basic', 'core', async () => {
    const r = await raw(r1, 'GET', `${chUrl}?since=${ch.seq}&limit=100`, undefined, { dev });
    expect(r.status === 200, `pull: ${desc(r)}`);
    const evs = r.json.events as IntertieEvent[];
    expect(Array.isArray(evs) && evs.length > 0, 'pull returned no events');
    expect(evs.every((e, i) => i === 0 || e.seq! > evs[i - 1].seq!), 'events are not in ascending seq order');
    expect(evs[0].seq === ch.seq + 1 && evs[0].type === 'peer.join', `first event should be peer.join at ${ch.seq + 1}`);
    expect(evs.some((e) => e.id === msg.id), 'pull is missing the runner message');
    expect(typeof r.json.seq === 'number' && r.json.seq >= evs[evs.length - 1].seq!, 'response seq must be the latest');
    return `${evs.length} events`;
  });
  await s.t('core.pull.limit', 'core', async () => {
    const r = await raw(r1, 'GET', `${chUrl}?since=${ch.seq}&limit=1`, undefined, { dev });
    expect(r.status === 200 && r.json.events.length === 1, `limit=1 returned ${r.json?.events?.length}`);
  });
  await s.t('core.pull.wait', 'core', async () => {
    const t0 = Date.now();
    const r = await raw(r1, 'GET', `${chUrl}?since=${r1.node.channel(ch.id)!.seq + 1000}&wait=1`, undefined, { dev });
    expect(r.status === 200 && Array.isArray(r.json.events), `long-poll: ${desc(r)}`);
    const ms = Date.now() - t0;
    expect(ms < 5000, `long-poll took ${ms} ms for wait=1`);
    return `returned after ${ms} ms`;
  });
  if (o.r2) {
    await s.t('core.authz.non-participant', 'core', async () => expectResult(await submit(ev('message.create', { text: 'x' }, { origin: o.r2!.node.org, sender: { id: `u@${o.r2!.node.org}`, name: 'X' } }), o.r2!), 'rejected', ['not_participant']));
    await s.t('core.authz.non-participant-pull', 'core', async () => expectStatus(await raw(o.r2!, 'GET', `${chUrl}?since=0`, undefined, { dev }), 403, 'not_participant'));
  } else {
    s.skip('core.authz.non-participant', 'core', 'no second runner identity');
    s.skip('core.authz.non-participant-pull', 'core', 'no second runner identity');
  }
  if (caps.has('reactions')) {
    await s.t('reactions.add-remove', 'reactions', async () => {
      expectResult(await submit(ev('reaction.add', { target: msg.id, emoji: '👀', name: 'eyes' })), 'accepted');
      return expectResult(await submit(ev('reaction.remove', { target: msg.id, emoji: '👀', name: 'eyes' })), 'accepted');
    });
  } else s.skip('reactions.add-remove', 'reactions', 'not advertised');
  if (caps.has('files')) {
    await s.t('files.inline', 'files', async () => {
      const f = r1.node.storeFile(ch.id, Buffer.from('conformance'), { name: 'c.txt', mime: 'text/plain' });
      return expectResult(await submit(ev('message.create', { text: '', files: [f] })), 'accepted');
    });
  } else s.skip('files.inline', 'files', 'not advertised');
  await s.t('core.delete.own', 'core', async () => expectResult(await submit(ev('message.delete', { target: msg.id }, { sender: undefined })), 'accepted'));
  await s.t('core.leave', 'core', async () => {
    expectResult(await submit(ev('peer.leave', { org: r1.node.org, reason: 'left' }, { sender: undefined })), 'accepted');
    return expectResult(await submit(ev('message.create', { text: 'after leave' })), 'rejected', ['not_participant']);
  });
  return { results: s.results, subject: doc };
}

export interface PeerSuiteOptions {
  /** The runner's home identity. The suite creates a channel and an invite on it. */
  home: Identity;
  /** A second identity, used to send forged deliveries. */
  r2?: Identity;
  /** Called with the invite; the operator pastes it into the subject. Resolves when that is done. */
  onInvite: (invite: string) => void | Promise<void>;
  devInsecure?: boolean;
  acceptTimeoutMs?: number;
  timeoutMs?: number;
}

/** Test the subject in a peer role: it accepts the runner's invite, then receives deliveries. */
export async function runPeerSuite(o: PeerSuiteOptions): Promise<{ results: TestResult[]; subjectOrg: string | null }> {
  const s = new Suite('peer');
  const dev = o.devInsecure;
  const H = o.home;
  const timeout = o.timeoutMs ?? 10_000;
  const ch = H.node.createChannel({ name: 'intertie-conformance' });
  await o.onInvite(H.node.createInvite(ch.id));
  let subject: string | null = null;
  const accepted = await s.t('core.peer.accept', 'core', async () => {
    const ok = await until(() => H.node.channel(ch.id)!.participants.length > 0, o.acceptTimeoutMs ?? 300_000);
    expect(ok, 'the subject did not accept the invite in time');
    subject = H.node.channel(ch.id)!.participants[0].org;
    return `accepted by ${subject}`;
  });
  if (!accepted || !subject) return { results: s.results, subjectOrg: subject };
  const org: string = subject;
  const doc = await H.node.discovery.get(org);
  const p = () => H.node.store.participant(ch.id, org)!;
  const pull = p().delivery === 'pull';
  const delivered = (seq: number) => until(() => p().cursor >= seq, timeout);
  const pullsSince = (n: number) => H.requests.filter((r) => r.includes(`/channels/`) && r.includes('/events?')).length > n;

  await s.t('core.peer.delivery-mode', 'core', async () => `subject receives by ${pull ? 'pull' : 'push'}`);
  await s.t('core.peer.receives', 'core', async () => {
    const e = await H.node.send(ch.id, { type: 'message.create', sender: { id: `runner@${H.node.org}`, name: 'Runner' }, body: { text: 'Conformance: please ignore' } });
    if (pull) {
      const before = H.requests.length;
      expect(await until(() => H.requests.slice(before).some((r) => r.includes('/events?since=')), timeout), 'pull-mode subject never pulled');
      return 'pulled';
    }
    expect(await delivered(e.seq!), `push of seq ${e.seq} not accepted (cursor ${p().cursor})`);
    return `cursor ${p().cursor}`;
  });
  if (!pull) {
    const last = H.node.store.eventsSince(ch.id, p().cursor - 1, 1)[0];
    await s.t('core.peer.dedupe', 'core', async () => expectResult(await raw(H, 'POST', `${doc.endpoint}/events`, { events: [last] }, { dev }), 'duplicate'));
    await s.t('core.peer.unsigned', 'core', async () => expectStatus(await raw(null, 'POST', `${doc.endpoint}/events`, { events: [last] }, { dev }), 401));
    if (o.r2) {
      await s.t('core.peer.not-home', 'core', async () => {
        const forged = { ...last, id: newId(), seq: last.seq! + 1, origin: o.r2!.node.org, sender: { id: `x@${o.r2!.node.org}`, name: 'Forger' } };
        const r = await raw(o.r2!, 'POST', `${doc.endpoint}/events`, { events: [forged] }, { dev });
        if (r.status === 403) return desc(r);
        return expectResult(r, 'rejected', ['not_home', 'not_participant', 'unknown_channel']);
      });
    } else s.skip('core.peer.not-home', 'core', 'no second runner identity');
    await s.t('core.peer.gap-fill', 'core', async () => {
      // Sequence an event the subject never gets pushed, then push the next one: the subject must pull.
      H.node.store.updateParticipant(ch.id, org, { delivery: 'pull' });
      const hidden = await H.node.send(ch.id, { type: 'message.create', sender: { id: `runner@${H.node.org}`, name: 'Runner' }, body: { text: 'gap (pull me)' } });
      H.node.store.updateParticipant(ch.id, org, { delivery: 'push', cursor: hidden.seq! });
      const before = H.requests.filter((r) => r.includes('/events?')).length;
      const next = await H.node.send(ch.id, { type: 'message.create', sender: { id: `runner@${H.node.org}`, name: 'Runner' }, body: { text: 'after gap' } });
      expect(await delivered(next.seq!), 'push after the gap was not accepted');
      expect(await until(() => pullsSince(before), timeout), 'the subject did not pull to fill the gap');
      return `subject pulled after seq ${next.seq}`;
    });
  } else {
    for (const id of ['core.peer.dedupe', 'core.peer.unsigned', 'core.peer.not-home', 'core.peer.gap-fill']) s.skip(id, 'core', 'subject is pull-only');
  }
  await s.t('core.peer.removed', 'core', async () => {
    H.node.removePeer(ch.id, org);
    const seq = H.node.channel(ch.id)!.seq;
    if (pull) return 'removal sequenced (pull-only subject reads it on its next pull)';
    expect(await delivered(seq), 'removal notice not accepted');
    return 'removal delivered';
  });
  return { results: s.results, subjectOrg: org };
}
