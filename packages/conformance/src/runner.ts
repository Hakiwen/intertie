// The conformance runner: drives an implementation as a peer (to test its home role) and as a
// home (to test its peer role). It uses the reference engine for its own identities and raw
// signed requests for the negative paths. spec/conformance.md.
import { createServer, type Server } from 'node:http';
import { sign as edSign } from 'node:crypto';
import {
  contentDigest, generateKey, importPrivate, IntertieNode, isDevOrg, newId, parseInvite, PROTOCOL_VERSION, safeFetch, signatureBase,
  signRequest, validateDiscovery, type DiscoveryDoc, type IntertieEvent, type PrivateJwk,
} from '@intertie/core';
import type { TestResult } from './report.ts';

export interface Identity {
  node: IntertieNode;
  key: PrivateJwk;
  /** Request log for this identity's endpoint (method + path), to observe pulls. */
  requests: string[];
  /** Adversarial tests: serve something else at /.well-known/intertie. Return true if handled. */
  wellKnown?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean;
}

/** Serve a runner identity, logging the requests the subject makes to it. */
export async function serveIdentity(node: IntertieNode, key: PrivateJwk, port: number, host = '127.0.0.1'): Promise<{ id: Identity; server: Server }> {
  const id: Identity = { node, key, requests: [] };
  const server = createServer((req, res) => {
    id.requests.push(`${req.method} ${req.url}`);
    if (id.wellKnown && (req.url ?? '').startsWith('/.well-known/intertie') && id.wellKnown(req, res)) return;
    void node.handle(req, res);
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  node.start();
  return { id, server };
}

interface Raw { status: number; json: any }

async function raw(
  id: Identity | null, method: string, url: string, body: unknown,
  o: { created?: number; nonce?: string; kid?: string; keyidOrg?: string; signWith?: PrivateJwk; signUrl?: string; tamper?: boolean; noDigest?: boolean;
    headers?: Record<string, string>; dev?: boolean; bytes?: Buffer; rewriteInput?: (sigInput: string) => string } = {},
): Promise<Raw> {
  const bytes = o.bytes ?? (body === undefined ? null : Buffer.from(JSON.stringify(body)));
  let headers: Record<string, string> = { accept: 'application/json' };
  if (bytes) headers['content-type'] = 'application/json';
  if (id) {
    const key = { keyid: `${o.keyidOrg ?? id.node.org}#${o.kid ?? id.key.kid}`, privateKey: importPrivate(o.signWith ?? id.key) };
    headers = { ...headers, ...signRequest({ method, url: o.signUrl ?? url, body: o.noDigest ? null : bytes, key, created: o.created, nonce: o.nonce }) };
    if (o.rewriteInput) {
      // Re-sign over a modified Signature-Input, so only the profile violation differs.
      const input = o.rewriteInput(headers['signature-input']);
      const params = input.slice(input.indexOf('=') + 1);
      const base = signatureBase(method, o.signUrl ?? url, o.noDigest || !bytes ? null : contentDigest(bytes), params);
      headers['signature-input'] = input;
      headers.signature = `${input.slice(0, input.indexOf('='))}=:${edSign(null, Buffer.from(base), importPrivate(o.signWith ?? id.key)).toString('base64')}:`;
    }
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
  /** Fresh throwaway identities for adversarial discovery tests (each is new to the subject). */
  spawn?: () => Promise<Identity>;
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
    const proto = dev && isDevOrg(inv.home) ? 'http' : 'https';
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
  const submit = (e: object | object[], id: Identity = r1, opts: Parameters<typeof raw>[4] = {}) => raw(id, 'POST', `${ep}/events`, { events: Array.isArray(e) ? e : [e] }, { dev, ...opts });

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
  await s.t('core.pull.no-prejoin-history', 'core', async () => {
    const r = await raw(r1, 'GET', `${chUrl}?since=0&limit=100`, undefined, { dev });
    expect(r.status === 200, `pull: ${desc(r)}`);
    const evs = r.json.events as IntertieEvent[];
    expect(evs.every((e) => e.seq! > ch.seq), `since=0 returned events from before the join (seq ${evs[0]?.seq} <= ${ch.seq})`);
    return `earliest seq ${evs[0]?.seq}`;
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
  // ───────────── security level: adversarial requests a conformant home must refuse ─────────────
  const probe = () => ev('message.create', { text: 'security probe' });
  const now = () => Math.floor(Date.now() / 1000);
  await s.t('security.sig.future-created', 'security', async () => expectStatus(await submit(probe(), r1, { created: now() + 900 }), 401, 'stale_signature'));
  await s.t('security.sig.alg-downgrade', 'security', async () => expectStatus(await submit(probe(), r1, { rewriteInput: (i) => i.replace('alg="ed25519"', 'alg="hmac-sha256"') }), 401, 'bad_signature'));
  await s.t('security.sig.alg-missing', 'security', async () => expectStatus(await submit(probe(), r1, { rewriteInput: (i) => i.replace(';alg="ed25519"', '') }), 401, 'bad_signature'));
  await s.t('security.sig.tag-missing', 'security', async () => expectStatus(await submit(probe(), r1, { rewriteInput: (i) => i.replace(';tag="intertie"', '') }), 401, 'bad_signature'));
  await s.t('security.sig.other-label', 'security', async () => expectStatus(await submit(probe(), r1, { rewriteInput: (i) => i.replace(/^sig1=/, 'sig2=') }), 401, 'bad_signature'));
  await s.t('security.sig.extra-member', 'security', async () => expectStatus(await submit(probe(), r1, { rewriteInput: (i) => `${i}, sig2=("@method");created=${now()};keyid="${r1.node.org}#${r1.key.kid}";alg="ed25519";nonce="${newId()}";tag="intertie"` }), 401, 'bad_signature'));
  await s.t('security.sig.extra-component', 'security', async () => expectStatus(await submit(probe(), r1, { rewriteInput: (i) => i.replace('"content-digest")', '"content-digest" "content-type")') }), 401, 'bad_signature'));
  await s.t('security.sig.short-nonce', 'security', async () => expectStatus(await submit(probe(), r1, { nonce: 'abc' }), 401, 'bad_signature'));
  await s.t('security.sig.forged-key', 'security', async () => expectStatus(await submit(probe(), r1, { signWith: generateKey(r1.key.kid) }), 401, 'bad_signature'));
  await s.t('security.sig.query-tamper', 'security', async () => expectStatus(await raw(r1, 'GET', `${chUrl}?since=0`, undefined, { dev, signUrl: `${chUrl}?since=999999` }), 401, 'bad_signature'));
  await s.t('security.sig.invalid-keyid-org', 'security', async () => {
    const r = await submit(probe(), r1, { keyidOrg: 'evil.example:6379/../x?' });
    expect(r.status === 401, `expected 401, got ${desc(r)}`);
    return desc(r);
  });
  if (o.r2) {
    await s.t('security.sig.cross-org-key', 'security', async () => expectStatus(await submit(probe(), o.r2!, { keyidOrg: r1.node.org, kid: r1.key.kid }), 401, 'bad_signature'));
  } else s.skip('security.sig.cross-org-key', 'security', 'no second runner identity');
  await s.t('security.event.id-conflict', 'security', async () => {
    const join = seen.find((e) => e.type === 'peer.join')!;
    return expectResult(await submit(ev('message.create', { text: 'x' }, { id: join.id })), 'rejected', ['id_conflict']);
  });
  await s.t('security.event.foreign-channel', 'security', async () => expectResult(await submit(ev('message.create', { text: 'x' }, { channel: `c-${newId()}@${inv.home}` })), 'rejected', ['unknown_channel']));
  await s.t('security.body.malformed-json', 'security', async () => {
    const r = await raw(r1, 'POST', `${ep}/events`, undefined, { dev, bytes: Buffer.from('{"events":[' + '['.repeat(20000)) });
    expect(r.status >= 400 && r.status < 500, `expected 4xx, got ${desc(r)}`);
    return desc(r);
  });
  await s.t('security.path.traversal', 'security', async () => {
    const r = await raw(r1, 'GET', `${ep}/channels/..%2F..%2F.well-known%2Fintertie/events?since=0`, undefined, { dev });
    expect(r.status === 403 || r.status === 404, `expected 403/404, got ${desc(r)}`);
    return desc(r);
  });
  await s.t('security.method.unexpected', 'security', async () => {
    const r = await raw(r1, 'DELETE', `${ep}/events`, undefined, { dev });
    expect(r.status >= 400 && r.status < 500, `expected 4xx, got ${desc(r)}`);
    return desc(r);
  });
  if (o.spawn) {
    const fresh = async (wellKnown: Identity['wellKnown']) => { const id = await o.spawn!(); id.wellKnown = wellKnown; return id; };
    await s.t('security.key-rotation', 'security', async () => {
      // A fresh org is known to the subject with one key; it then publishes a second key and signs
      // with it. The subject must refetch on the unknown kid: the request authenticates (and is then
      // refused as not_participant, which proves the new key was accepted).
      const x = await fresh(undefined);
      const asX = (k?: PrivateJwk) => submit(ev('message.create', { text: 'x' }, { origin: x.node.org, sender: { id: `u@${x.node.org}`, name: 'X' } }), x, k ? { signWith: k, kid: k.kid } : {});
      const first = await asX();
      expect(first.status === 200, `first request: ${desc(first)}`);
      const k2 = generateKey(`rot-${newId().slice(0, 8)}`);
      (x.node as unknown as { o: { keys: PrivateJwk[] } }).o.keys.push(k2);
      return expectResult(await asX(k2), 'rejected', ['not_participant']);
    });
    await s.t('security.discovery.no-redirect', 'security', async () => {
      const marker = `followed-${newId().slice(0, 8)}`;
      const x = await fresh((_q, res) => { res.writeHead(302, { location: `http://${r1.node.org}/.well-known/intertie?${marker}` }).end(); return true; });
      const r = await submit(ev('message.create', { text: 'x' }, { origin: x.node.org, sender: { id: `u@${x.node.org}`, name: 'X' } }), x);
      expect(r.status === 401, `a redirecting discovery document must not authenticate (${desc(r)})`);
      expect(!r1.requests.some((q) => q.includes(marker)), 'the subject followed the redirect');
      return desc(r);
    });
    await s.t('security.discovery.oversize', 'security', async () => {
      const x = await fresh((_q, res) => {
        const doc = { ...x.node.discoveryDocument(), padding: 'x'.repeat(70 * 1024) };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(doc));
        return true;
      });
      const r = await submit(ev('message.create', { text: 'x' }, { origin: x.node.org, sender: { id: `u@${x.node.org}`, name: 'X' } }), x);
      expect(r.status === 401, `a >64 KiB discovery document must be refused (${desc(r)})`);
      return desc(r);
    });
    await s.t('security.discovery.wrong-org', 'security', async () => {
      const x = await fresh((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...x.node.discoveryDocument(), org: r1.node.org })); return true; });
      const r = await submit(ev('message.create', { text: 'x' }, { origin: x.node.org, sender: { id: `u@${x.node.org}`, name: 'X' } }), x);
      expect(r.status === 401, `a document whose org field differs must be refused (${desc(r)})`);
      return desc(r);
    });
    await s.t('security.downgrade.version', 'security', async () => {
      const major = Number(PROTOCOL_VERSION.split('.')[0]);
      const x = await fresh((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...x.node.discoveryDocument(), intertie: `${major + 9}.0` })); return true; });
      const r = await submit(ev('message.create', { text: 'x' }, { origin: x.node.org, sender: { id: `u@${x.node.org}`, name: 'X' } }), x);
      expect(r.status === 401, `an incompatible protocol major must be refused (${desc(r)})`);
      return desc(r);
    });
  } else {
    for (const id of ['security.key-rotation', 'security.discovery.no-redirect', 'security.discovery.oversize', 'security.discovery.wrong-org', 'security.downgrade.version']) s.skip(id, 'security', 'needs fresh runner identities (dev mode)');
  }
  if (!dev) {
    await s.t('security.transport.https-only', 'security', async () => {
      const http = ep.replace(/^https:/, 'http:');
      const r = await safeFetch(`${http}/events`, { method: 'POST', devInsecure: true, timeoutMs: 10_000 }).catch((e) => ({ status: 0, err: String(e) }));
      expect(r.status === 0 || (r.status >= 300 && r.status < 400) || r.status === 403 || r.status === 404, `plain HTTP endpoint answered ${r.status}`);
      return `plain http: ${r.status === 0 ? 'refused' : r.status}`;
    });
  } else s.skip('security.transport.https-only', 'security', 'dev mode');

  await s.t('core.delete.own', 'core', async () => expectResult(await submit(ev('message.delete', { target: msg.id }, { sender: undefined })), 'accepted'));
  await s.t('core.leave', 'core', async () => {
    expectResult(await submit(ev('peer.leave', { org: r1.node.org, reason: 'left' }, { sender: undefined })), 'accepted');
    return expectResult(await submit(ev('message.create', { text: 'after leave' })), 'rejected', ['not_participant']);
  });
  await s.t('core.accept.no-reuse-after-leave', 'core', async () => expectStatus(await raw(r1, 'POST', `${ep}/accept`, { token: inv.token }, { dev }), 404, 'invalid_invite'));
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
  if (!pull) {
    const last = H.node.store.eventsSince(ch.id, p().cursor - 1, 1)[0];
    const deliver = (o2: Parameters<typeof raw>[4] = {}, events: unknown[] = [last], id: Identity = H) => raw(id, 'POST', `${doc.endpoint}/events`, { events }, { dev, ...o2 });
    await s.t('security.peer.replay', 'security', async () => {
      const nonce = newId(), created = Math.floor(Date.now() / 1000);
      const first = await deliver({ nonce, created });
      expect(first.status === 200, `first delivery: ${desc(first)}`);
      return expectStatus(await deliver({ nonce, created }), 401, 'replayed');
    });
    await s.t('security.peer.stale', 'security', async () => expectStatus(await deliver({ created: Math.floor(Date.now() / 1000) - 900 }), 401, 'stale_signature'));
    await s.t('security.peer.forged-home-key', 'security', async () => expectStatus(await deliver({ signWith: generateKey(H.key.kid) }), 401, 'bad_signature'));
    await s.t('security.peer.digest', 'security', async () => expectStatus(await deliver({ tamper: true }), 401, 'bad_digest'));
    await s.t('security.peer.unknown-channel', 'security', async () => {
      const r = await deliver({}, [{ ...last, id: newId(), channel: `c-${newId()}@${H.node.org}`, seq: 1 }]);
      if (r.status === 404) return desc(r);
      return expectResult(r, 'rejected', ['unknown_channel']);
    });
    await s.t('security.peer.missing-seq', 'security', async () => {
      const { seq: _drop, ...noSeq } = last;
      return expectResult(await deliver({}, [{ ...noSeq, id: newId() }]), 'rejected', ['invalid_event', 'not_home']);
    });
  } else {
    for (const id of ['security.peer.replay', 'security.peer.stale', 'security.peer.forged-home-key', 'security.peer.digest', 'security.peer.unknown-channel', 'security.peer.missing-seq']) s.skip(id, 'security', 'subject is pull-only');
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
