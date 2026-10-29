// Builds the Teams app package (manifest.json + two PNG icons, zipped) with no dependencies.
// Upload it in Teams: Apps → Manage your apps → Upload an app. See docs/teams-setup.md.
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

export interface ManifestOptions {
  appId: string;            // the Azure Bot's Microsoft App ID (single-tenant)
  host: string;             // public host of the messaging endpoint, for validDomains
  name?: string;
  version?: string;
  manifestVersion?: string; // default 1.25
  developer?: { name: string; websiteUrl: string; privacyUrl: string; termsOfUseUrl: string };
}

export function manifest(o: ManifestOptions): Record<string, unknown> {
  const mv = o.manifestVersion ?? '1.25';
  const dev = o.developer ?? { name: 'Intertie', websiteUrl: 'https://intertie.dev', privacyUrl: 'https://github.com/Hakiwen/intertie/blob/main/SECURITY.md', termsOfUseUrl: 'https://github.com/Hakiwen/intertie/blob/main/LICENSE' };
  return {
    $schema: `https://developer.microsoft.com/en-us/json-schemas/teams/v${mv}/MicrosoftTeams.schema.json`,
    manifestVersion: mv,
    version: o.version ?? '0.2.0',
    id: o.appId,
    developer: dev,
    name: { short: (o.name ?? 'Intertie').slice(0, 30), full: 'Intertie shared channels' },
    description: {
      short: 'Share a channel with another organization, directly.',
      full: 'Links a channel in this team to a shared channel with another organization over the open Intertie protocol. '
        + 'The app is run by your organization (or by the organization you share with). It reads messages only in channels '
        + 'a team owner explicitly shares, and copies them only to the participating organizations. Commands: '
        + '@Intertie share, @Intertie accept <invite>, @Intertie status, @Intertie unshare.',
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#1F3A5F',
    bots: [{
      botId: o.appId,
      scopes: ['team'],
      supportsFiles: false,
      isNotificationOnly: false,
      commandLists: [{ scopes: ['team'], commands: [
        { title: 'share', description: 'Share this channel with another organization' },
        { title: 'accept', description: 'accept <invite>: join a channel another organization shared' },
        { title: 'status', description: 'Show whether this channel is shared, and with whom' },
        { title: 'unshare', description: 'Stop sharing this channel' },
      ] }],
    }],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: [o.host],
    webApplicationInfo: { id: o.appId, resource: 'https://RscBasedStoreApp' },
    authorization: { permissions: { resourceSpecific: [
      { name: 'ChannelMessage.Read.Group', type: 'Application' },   // receive all channel messages, not only @mentions
      { name: 'ChannelSettings.Read.Group', type: 'Application' },  // channel names
      { name: 'TeamMember.Read.Group', type: 'Application' },       // roster (owners may manage sharing)
    ] } },
  };
}

/** A minimal RGBA PNG encoder. */
export function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The Intertie mark: two nodes joined by a direct line (no hub in between). */
function mark(x: number, y: number, s: number): boolean {
  const u = (x + 0.5) / s, v = (y + 0.5) / s;
  const node = (cx: number) => (u - cx) ** 2 + (v - 0.5) ** 2 < 0.13 ** 2;
  const line = u > 0.27 && u < 0.73 && Math.abs(v - 0.5) < 0.035;
  return node(0.27) || node(0.73) || line;
}

export function icons(): { color: Buffer; outline: Buffer } {
  const color = png(192, 192, (x, y) => (mark(x, y, 192) ? [255, 255, 255, 255] : [0x1f, 0x3a, 0x5f, 255]));
  const outline = png(32, 32, (x, y) => (mark(x, y, 32) ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  return { color, outline };
}

/** A minimal ZIP writer (deflate), enough for a Teams app package. */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const comp = deflateRawSync(f.data);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function appPackage(o: ManifestOptions): Buffer {
  const { color, outline } = icons();
  return zip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest(o), null, 2)) },
    { name: 'color.png', data: color },
    { name: 'outline.png', data: outline },
  ]);
}
