// Markdown (GFM-MIMI subset) ⇄ Slack mrkdwn. See spec/slack-mapping.md.
import type { Mention } from '@intertie/core';

const PH = (i: number) => `\u0000${i}\u0000`;
const PH_RE = /\u0000(\d+)\u0000/g;

const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeSlack = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const SAFE_SCHEME = /^(https?:|mailto:)/i;

/**
 * Markdown → Slack mrkdwn, for posting remote messages into Slack.
 * Escaping &, <, > is a security rule: it stops a peer from injecting <!channel> or <@U…>.
 * `slackUserFor` maps an Intertie user id to a Slack user id when that user lives in this workspace.
 */
export function toMrkdwn(md: string, mentions: Mention[] = [], slackUserFor: (id: string) => string | null = () => null): string {
  const saved: string[] = [];
  const keep = (s: string) => { saved.push(s); return PH(saved.length - 1); };
  let s = md.replace(/\u0000/g, '');
  // Code first: contents are escaped but never reformatted.
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) => keep('```' + escapeSlack(code.replace(/\n$/, '')) + '```'));
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep('`' + escapeSlack(code) + '`'));
  // Links: only safe schemes become links; the URL may not contain | or > after escaping.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    if (!SAFE_SCHEME.test(url) || /[|<>]/.test(url)) return m;
    return keep(`<${escapeSlack(url)}|${escapeSlack(label).replace(/\|/g, '¦')}>`);
  });
  // Mentions of users who are in this Slack workspace become real mentions.
  for (const m of mentions) {
    const u = slackUserFor(m.id);
    if (!u) continue;
    const at = `@${m.name}`;
    const i = s.indexOf(at);
    if (i >= 0) s = s.slice(0, i) + keep(`<@${u}>`) + s.slice(i + at.length);
  }
  s = escapeSlack(s);
  s = s.replace(/^(\s*)&gt; ?/gm, '$1> ');
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '\u0001$1\u0001');
  s = s.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '\u0001$1\u0001').replace(/__(?=\S)([^_\n]+?)__/g, '\u0001$1\u0001');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?!\w)/g, '$1_$2_');
  s = s.replace(/~~(?=\S)([^~\n]+?)~~/g, '~$1~');
  s = s.replace(/\u0001/g, '*');
  return s.replace(PH_RE, (_m, i: string) => saved[Number(i)]);
}

export interface FromMrkdwn { text: string; mentions: Mention[] }

/**
 * Slack mrkdwn → Markdown, for sending Slack messages to the channel.
 * `userName` resolves a Slack user id to a display name; `toId` builds the Intertie user id.
 * Channel-wide pings (<!here>, <!channel>) become plain text and are never propagated as pings.
 */
export function fromMrkdwn(text: string, userName: (u: string) => string, toId: (u: string) => string): FromMrkdwn {
  const saved: string[] = [];
  const keep = (s: string) => { saved.push(s); return PH(saved.length - 1); };
  const mentions: Mention[] = [];
  let s = (text ?? '').replace(/\u0000/g, '');
  s = s.replace(/```([\s\S]*?)```/g, (_m, code: string) => keep('```\n' + unescapeSlack(code).replace(/^\n|\n$/g, '') + '\n```'));
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep('`' + unescapeSlack(code) + '`'));
  s = s.replace(/<([^<>\n]+)>/g, (_m, inner: string) => {
    const [target, label] = splitOnce(inner, '|');
    if (target.startsWith('@')) {
      const u = target.slice(1);
      const name = userName(u) || label || u;
      mentions.push({ id: toId(u), name });
      return keep(`@${name}`);
    }
    if (target.startsWith('#')) return keep(`#${label ?? target.slice(1)}`);
    if (target.startsWith('!subteam^')) return keep(label ?? '@team');
    if (target.startsWith('!date^')) return keep(unescapeSlack(label ?? ''));
    if (target.startsWith('!')) return keep(`@${target.slice(1)}`);
    const url = unescapeSlack(target);
    if (!SAFE_SCHEME.test(url)) return keep(unescapeSlack(label ?? target));
    if (!label || unescapeSlack(label) === url) return keep(url);
    return keep(`[${unescapeSlack(label)}](${url})`);
  });
  s = s.replace(/(^|[\s(>])\*(?=\S)([^*\n]+?)\*(?=$|[\s).,!?:;'"])/gm, '$1\u0001$2\u0001');
  s = s.replace(/(^|[\s(>])_(?=\S)([^_\n]+?)_(?=$|[\s).,!?:;'"])/gm, '$1*$2*');
  s = s.replace(/(^|[\s(>])~(?=\S)([^~\n]+?)~(?=$|[\s).,!?:;'"])/gm, '$1~~$2~~');
  s = s.replace(/\u0001/g, '**');
  s = unescapeSlack(s);
  return { text: s.replace(PH_RE, (_m, i: string) => saved[Number(i)]), mentions };
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}
