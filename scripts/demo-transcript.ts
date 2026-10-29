// Merges the two demo adapters' JSON logs into one Markdown timeline under docs/demo/.
// Usage: node scripts/demo-transcript.ts [--since ISO] [--out FILE]
// Logs never contain message text or tokens; this script double-checks for token shapes anyway.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { since: { type: 'string' }, out: { type: 'string' } } });
const since = values.since ? Date.parse(values.since) : 0;
type Line = { t: string; level: string; msg: string; side: string; [k: string]: unknown };
const lines: Line[] = [];
for (const side of ['a', 'b', 'm']) {
  const p = `state/${side}/adapter.log`;
  if (!existsSync(p)) continue;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    if (!raw.startsWith('{')) continue;
    try { const j = JSON.parse(raw); if (Date.parse(j.t) >= since) lines.push({ ...j, side: side.toUpperCase() }); } catch { /* not JSON */ }
  }
}
lines.sort((x, y) => x.t.localeCompare(y.t));
const show = lines.filter((l) => l.msg.includes('→') || l.level === 'audit' || l.level === 'warn' || l.msg === 'slack connected' || l.msg === 'socket mode connected' || l.msg === 'matrix gateway started');
const cell = (l: Line) => {
  const { t: _t, level: _l, msg: _m, side: _s, ...rest } = l;
  return Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
};
const md = [
  `# Intertie demo transcript`, '',
  `Generated ${new Date().toISOString()} from \`state/{a,b}/adapter.log\`. Adapter **A** (Slack workspace A, port 8711) is the home; **B** (Slack workspace B, port 8712) and **M** (the Matrix gateway, port 8713) accepted invites.`,
  `Each row is one relay step. Message text is never logged; ids let you match a row on one side to the other.`, '',
  '| time (UTC) | side | step | details |', '|---|---|---|---|',
  ...show.map((l) => `| ${l.t.slice(11, 23)} | ${l.side} | ${l.level === 'audit' ? `audit: ${l.msg}` : l.msg} | ${cell(l).replace(/\|/g, '\\|')} |`),
  '',
].join('\n');
if (/xox[a-z]-|xapp-|syt_/.test(md)) throw new Error('refusing to write: transcript contains a token-like string');
const out = values.out ?? `docs/demo/transcript-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.md`;
writeFileSync(out, md);
console.log(`wrote ${out} (${show.length} rows)`);
