// Keeps the hand-written validator and spec/schemas/event.schema.json in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { validateEvent, validateDiscovery, generateKey, publicJwk } from '../src/index.ts';

const load = (f: string) => JSON.parse(readFileSync(new URL(`../../../spec/schemas/${f}`, import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const eventSchema = ajv.compile(load('event.schema.json'));
const discoverySchema = ajv.compile(load('discovery.schema.json'));

const base = { id: '01JBDXQ4M6V2S9K3Y8T7R5N0PA', channel: 'c-1@acme.com', origin: 'globex.com', ts: '2026-10-29T19:03:00Z' };
const sender = { id: 'u-1@globex.com', name: 'Gail' };
const sha = 'A'.repeat(43);
const valid = [
  { ...base, type: 'message.create', sender, body: { text: 'hi' } },
  { ...base, type: 'message.create', sender, seq: 4, body: { text: 'reply', thread: '01JBDXQ4M6V2S9K3Y8T7R5N0PB', mentions: [{ id: 'ana@acme.com', name: 'Ana' }] } },
  { ...base, type: 'message.create', sender, body: { text: '', files: [{ id: 'f1', name: 'a.txt', mime: 'text/plain', size: 1, sha256: sha, data: 'YQ==' }] } },
  { ...base, type: 'message.edit', sender, body: { target: '01JBDXQ4M6V2S9K3Y8T7R5N0PB', text: 'x' } },
  { ...base, type: 'message.delete', body: { target: '01JBDXQ4M6V2S9K3Y8T7R5N0PB' } },
  { ...base, type: 'reaction.add', sender, body: { target: '01JBDXQ4M6V2S9K3Y8T7R5N0PB', emoji: '👀', name: 'eyes' } },
  { ...base, type: 'peer.leave', body: { org: 'globex.com', reason: 'left' } },
  { ...base, type: 'channel.update', body: { topic: 'support' } },
  { ...base, type: 'member.join', body: { user: { id: 'u-2@globex.com', name: 'Gus' } } },
  { ...base, type: 'acme.com/priority', body: { level: 3 } },
];
const invalid = [
  { ...base, type: 'message.create', body: { text: 'no sender' } },
  { ...base, type: 'message.create', sender, body: {} },
  { ...base, type: 'message.create', sender, body: { text: 'x'.repeat(16001) } },
  { ...base, id: 'short', type: 'message.delete', body: { target: '01JBDXQ4M6V2S9K3Y8T7R5N0PB' } },
  { ...base, type: 'message.edit', sender, body: { text: 'no target' } },
  { ...base, type: 'reaction.add', sender, body: { target: '01JBDXQ4M6V2S9K3Y8T7R5N0PB' } },
  { ...base, type: 'peer.leave', body: { org: 'globex.com', reason: 'bored' } },
  { ...base, type: 'message.create', sender: { id: 'u-1@globex.com', name: 'G', avatar: 'http://x' }, body: { text: 'x' } },
  { ...base, type: 'message.create', sender, body: { text: 'x', files: [{ id: 'f1', name: 'a', mime: 'x', size: 1, sha256: sha }] } },
  { ...base, seq: 0, type: 'message.delete', body: { target: '01JBDXQ4M6V2S9K3Y8T7R5N0PB' } },
];

test('validator and JSON Schema agree on valid events', () => {
  for (const e of valid) {
    assert.doesNotThrow(() => validateEvent(e), JSON.stringify(e));
    assert.ok(eventSchema(e), `${JSON.stringify(e)}: ${JSON.stringify(eventSchema.errors)}`);
  }
});

test('validator and JSON Schema agree on invalid events', () => {
  for (const e of invalid) {
    assert.throws(() => validateEvent(e), Error, JSON.stringify(e));
    assert.ok(!eventSchema(e), `schema accepted ${JSON.stringify(e)}`);
  }
});

test('the validator also enforces sender-belongs-to-origin (not expressible in the schema)', () => {
  assert.throws(() => validateEvent({ ...base, type: 'message.create', sender: { id: 'ana@acme.com', name: 'A' }, body: { text: 'x' } }), { code: 'bad_origin' });
});

test('discovery: schema and validator agree', () => {
  const doc = { intertie: '0.1', org: 'acme.com', endpoint: 'https://connect.acme.com/intertie', keys: [publicJwk(generateKey('k1'))], capabilities: ['threads'] };
  assert.ok(discoverySchema(doc));
  assert.doesNotThrow(() => validateDiscovery(doc, 'acme.com'));
  assert.throws(() => validateDiscovery(doc, 'evil.com'), /org field/);
  assert.throws(() => validateDiscovery({ ...doc, endpoint: 'http://connect.acme.com/x' }, 'acme.com'), /https/);
  assert.throws(() => validateDiscovery({ ...doc, endpoint: 'https://connect.acme.com/x?y=1' }, 'acme.com'), /query/);
  assert.throws(() => validateDiscovery({ ...doc, intertie: '1.0' }, 'acme.com'), /major/);
  assert.throws(() => validateDiscovery({ ...doc, keys: [] }, 'acme.com'), /no keys/);
});
