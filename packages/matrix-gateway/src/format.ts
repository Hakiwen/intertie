// Markdown (GFM-MIMI subset) ⇄ Matrix `org.matrix.custom.html`. See spec/matrix-mapping.md.
// Outbound HTML is built from escaped text only, so a peer can never inject markup.
import type { Mention } from '@intertie/core';

const PH = (i: number) => `\u0000${i}\u0000`;
const PH_RE = /\u0000(\d+)\u0000/g;
const SAFE_SCHEME = /^(https?:|mailto:)/i;

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Markdown → Matrix HTML. `pillFor` maps an Intertie user id to a Matrix user id on this side. */
export function mdToHtml(md: string, mentions: Mention[] = [], pillFor: (id: string) => string | null = () => null): { html: string; userIds: string[] } {
  const saved: string[] = [];
  const keep = (s: string) => { saved.push(s); return PH(saved.length - 1); };
  const userIds: string[] = [];
  let s = md.replace(/\u0000/g, '');
  s = s.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_m, _lang: string, code: string) => keep(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) =>
    SAFE_SCHEME.test(url) ? keep(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`) : m);
  for (const m of mentions) {
    const mx = pillFor(m.id);
    if (!mx) continue;
    const at = `@${m.name}`;
    const i = s.indexOf(at);
    if (i < 0) continue;
    s = s.slice(0, i) + keep(`<a href="https://matrix.to/#/${escapeHtml(encodeURI(mx))}">${escapeHtml(m.name)}</a>`) + s.slice(i + at.length);
    userIds.push(mx);
  }
  s = escapeHtml(s);
  s = s.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/__(?=\S)([^_\n]+?)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^\w])_(?=\S)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([^~\n]+?)~~/g, '<del>$1</del>');
  // Block quotes: consecutive "&gt; " lines.
  s = s.replace(/(?:^&gt; ?.*(?:\n|$))+/gm, (block) => `<blockquote>${block.replace(/^&gt; ?/gm, '').replace(/\n$/, '').replace(/\n/g, '<br>')}</blockquote>`);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');
  s = s.replace(/\n/g, '<br>');
  return { html: s.replace(PH_RE, (_m, i: string) => saved[Number(i)]), userIds };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Matrix HTML → Markdown. Only the tags we understand are translated; every other tag is
 * dropped (its text kept). Pills become `@Name` plus a mention via `idFor`.
 */
export function htmlToMd(html: string, idFor: (mxid: string) => string): { text: string; mentions: Mention[] } {
  const mentions: Mention[] = [];
  let s = html.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, '');
  const saved: string[] = [];
  const keep = (x: string) => { saved.push(x); return PH(saved.length - 1); };
  s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, c: string) => keep('```\n' + decodeEntities(c.replace(/<[^>]+>/g, '')).replace(/\n$/, '') + '\n```'));
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c: string) => keep('`' + decodeEntities(c.replace(/<[^>]+>/g, '')) + '`'));
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const url = decodeEntities(href);
    const text = decodeEntities(label.replace(/<[^>]+>/g, ''));
    const pill = /^https:\/\/matrix\.to\/#\/(@[^/?]+)/.exec(url);
    if (pill) {
      const mxid = decodeURIComponent(pill[1]);
      const name = text.replace(/^@/, '');
      mentions.push({ id: idFor(mxid), name });
      return keep(`@${name}`);
    }
    if (!SAFE_SCHEME.test(url)) return keep(text);
    return keep(text === url ? url : `[${text}](${url})`);
  });
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*').replace(/<(del|s|strike)>([\s\S]*?)<\/\1>/gi, '~~$2~~');
  s = s.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_m, q: string) => q.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?p>/gi, '\n').trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n');
  s = s.replace(/<li>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p>/gi, '\n\n').replace(/<\/?(p|ul|ol|li|div|span|h[1-6]|font)[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/\n{3,}/g, '\n\n').trim();
  return { text: s.replace(PH_RE, (_m, i: string) => saved[Number(i)]), mentions };
}

/** Remove the legacy plain-text reply fallback ("> <@user> quoted" lines) from a body. */
export function stripReplyFallback(body: string): string {
  if (!body.startsWith('> <')) return body;
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('> ')) i++;
  if (lines[i] === '') i++;
  return lines.slice(i).join('\n');
}
