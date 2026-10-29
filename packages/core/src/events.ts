// Event types and structural validation (spec/core.md §5, capabilities.md).
// spec/schemas/event.schema.json is the machine-readable twin; tests keep them in step.
import { IntertieError } from './errors.ts';
import { EVENT_ID_RE, parseScoped } from './ids.ts';

export interface User { id: string; name: string; avatar?: string }
export interface Mention { id: string; name: string }
export interface FileRef {
  id: string; name: string; mime: string; size: number; sha256: string;
  url?: string; data?: string;
}

export interface Bodies {
  'message.create': { text: string; thread?: string; mentions?: Mention[]; files?: FileRef[]; deleted?: true };
  'message.edit': { target: string; text: string; mentions?: Mention[] };
  'message.delete': { target: string };
  'reaction.add': { target: string; emoji: string; name?: string };
  'reaction.remove': { target: string; emoji: string; name?: string };
  'peer.join': { org: string; display_name?: string };
  'peer.leave': { org: string; reason: 'left' | 'removed' | 'unreachable' | 'closed' };
  'channel.update': { name?: string; topic?: string };
  'channel.close': { reason?: string };
  'member.join': { user: User };
  'member.leave': { user: { id: string } };
}

export type EventType = keyof Bodies;

export interface IntertieEvent<T extends string = string> {
  id: string;
  type: T;
  channel: string;
  origin: string;
  sender?: User;
  ts: string;
  seq?: number;
  body: T extends EventType ? Bodies[T] : Record<string, unknown>;
}

export const LIMITS = {
  text: 16_000,
  name: 80,
  topic: 250,
  batch: 100,
  bodyBytes: 1024 * 1024,
  inlineFileBytes: 256 * 1024,
  /** Total inline file bytes in one event, so any single event fits a 1 MiB request. */
  inlineTotalBytes: 512 * 1024,
  files: 10,
  mentions: 50,
};

/** Types only the home may create. */
export const HOME_ONLY = new Set(['peer.join', 'channel.update', 'channel.close']);
/** Types that must name a message `target`. */
export const TARGETED = new Set(['message.edit', 'message.delete', 'reaction.add', 'reaction.remove']);

const fail = (m: string, code = 'invalid_event'): never => { throw new IntertieError(code, m); };
const isStr = (v: unknown): v is string => typeof v === 'string';
const chars = (s: string): number => [...s].length;

function checkUser(u: unknown, origin: string, what: string): void {
  const x = u as User;
  if (!x || typeof x !== 'object' || !isStr(x.id)) fail(`${what}: missing id`);
  const p = parseScoped(x.id);
  if (!p) fail(`${what}: bad id ${x.id}`);
  if (p!.org !== origin) fail(`${what}: ${x.id} does not belong to ${origin}`, 'bad_origin');
}

function checkText(t: unknown, allowEmpty: boolean): void {
  if (!isStr(t)) fail('text must be a string');
  if (!allowEmpty && (t as string).length === 0) fail('text must not be empty');
  if (chars(t as string) > LIMITS.text) fail(`text over ${LIMITS.text} characters`, 'too_large');
}

function checkMentions(m: unknown): void {
  if (m === undefined) return;
  if (!Array.isArray(m) || m.length > LIMITS.mentions) fail('bad mentions');
  for (const x of m as Mention[]) if (!x || !isStr(x.id) || !parseScoped(x.id) || !isStr(x.name)) fail('bad mention');
}

function checkFiles(f: unknown): void {
  if (f === undefined) return;
  if (!Array.isArray(f) || f.length < 1 || f.length > LIMITS.files) fail('files must be 1-10 entries');
  for (const x of f as FileRef[]) {
    if (!x || !isStr(x.id) || !/^[A-Za-z0-9._-]{1,128}$/.test(x.id)) fail('bad file id');
    if (!isStr(x.name) || x.name.length < 1 || x.name.length > 255) fail('bad file name');
    if (!isStr(x.mime) || !Number.isInteger(x.size) || x.size < 0) fail('bad file mime/size');
    if (!isStr(x.sha256) || !/^[A-Za-z0-9_-]{43}$/.test(x.sha256)) fail('bad file sha256');
    if ((x.url === undefined) === (x.data === undefined)) fail('file needs exactly one of url, data');
    if (x.data !== undefined && (!isStr(x.data) || x.size > LIMITS.inlineFileBytes)) fail('inline file too large', 'too_large');
  }
  const inline = (f as FileRef[]).reduce((n, x) => n + (x.data !== undefined ? x.size : 0), 0);
  if (inline > LIMITS.inlineTotalBytes) fail(`inline files over ${LIMITS.inlineTotalBytes} bytes in one event`, 'too_large');
}

/**
 * Structural validation of an event, independent of channel state.
 * Unknown types pass (receivers ignore them, spec/core.md §5).
 */
export function validateEvent(e: unknown): IntertieEvent {
  const ev = e as IntertieEvent;
  if (!ev || typeof ev !== 'object') fail('event must be an object');
  if (!isStr(ev.id) || !EVENT_ID_RE.test(ev.id)) fail('bad event id');
  if (!isStr(ev.type) || ev.type.length === 0 || ev.type.length > 128) fail('bad type');
  if (!isStr(ev.channel) || !parseScoped(ev.channel)) fail('bad channel id');
  if (!isStr(ev.origin) || ev.origin.length === 0) fail('bad origin');
  if (!isStr(ev.ts) || Number.isNaN(Date.parse(ev.ts))) fail('bad ts');
  if (ev.seq !== undefined && (!Number.isInteger(ev.seq) || ev.seq < 1)) fail('bad seq');
  if (!ev.body || typeof ev.body !== 'object' || Array.isArray(ev.body)) fail('body must be an object');
  if (ev.sender !== undefined) {
    checkUser(ev.sender, ev.origin, 'sender');
    if (!isStr(ev.sender.name) || ev.sender.name.length < 1) fail('bad sender name');
    if (chars(ev.sender.name) > LIMITS.name) fail(`sender name over ${LIMITS.name} characters`, 'too_large');
    if (ev.sender.avatar !== undefined && (!isStr(ev.sender.avatar) || !ev.sender.avatar.startsWith('https://') || ev.sender.avatar.length > 2048)) {
      fail('avatar must be an https URL');
    }
  }
  const b = ev.body as Record<string, unknown>;
  const needSender = () => { if (!ev.sender) fail(`${ev.type} needs a sender`); };
  const target = () => { if (!isStr(b.target) || !EVENT_ID_RE.test(b.target)) fail('bad target'); };
  switch (ev.type) {
    case 'message.create':
      needSender();
      checkText(b.text, b.files !== undefined || b.deleted === true);
      if (b.thread !== undefined && (!isStr(b.thread) || !EVENT_ID_RE.test(b.thread))) fail('bad thread');
      checkMentions(b.mentions);
      checkFiles(b.files);
      break;
    case 'message.edit':
      needSender(); target(); checkText(b.text, false); checkMentions(b.mentions);
      break;
    case 'message.delete':
      target();
      break;
    case 'reaction.add': case 'reaction.remove':
      needSender(); target();
      if (!isStr(b.emoji) || b.emoji.length < 1 || Buffer.byteLength(b.emoji) > 64) fail('bad emoji');
      if (b.name !== undefined && (!isStr(b.name) || b.name.length > 100)) fail('bad emoji name');
      break;
    case 'peer.join':
      if (!isStr(b.org)) fail('peer.join needs org');
      break;
    case 'peer.leave':
      if (!isStr(b.org)) fail('peer.leave needs org');
      if (!['left', 'removed', 'unreachable', 'closed'].includes(b.reason as string)) fail('bad reason');
      break;
    case 'channel.update':
      if (b.name !== undefined && (!isStr(b.name) || b.name.length < 1 || chars(b.name) > LIMITS.name)) fail('bad name');
      if (b.topic !== undefined && (!isStr(b.topic) || chars(b.topic) > LIMITS.topic)) fail('bad topic');
      break;
    case 'channel.close':
      break;
    case 'member.join':
      checkUser(b.user, ev.origin, 'member');
      break;
    case 'member.leave':
      checkUser(b.user, ev.origin, 'member');
      break;
    default:
      break; // unknown or extension type: accepted, ignored by receivers that don't know it
  }
  return ev;
}
