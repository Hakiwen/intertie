import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMd, mdToHtml, stripReplyFallback } from '@intertie/core';

test('Markdown → Matrix HTML, escaped', () => {
  assert.equal(mdToHtml('**b** *i* ~~s~~ `<c>`').html, '<strong>b</strong> <em>i</em> <del>s</del> <code>&lt;c&gt;</code>');
  assert.equal(mdToHtml('<script>alert(1)</script> & "q"').html, '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
  assert.equal(mdToHtml('[x](javascript:alert(1)) [ok](https://a.example/?a=1&b=2)').html, '[x](javascript:alert(1)) <a href="https://a.example/?a=1&amp;b=2">ok</a>');
  assert.equal(mdToHtml('> quoted\n> two\nafter').html, '<blockquote>quoted<br>two</blockquote>after');
  assert.equal(mdToHtml('```\nif (a<b) {}\n```').html, '<pre><code>if (a&lt;b) {}</code></pre>');
  const m = mdToHtml('hi @Alice', [{ id: 'alice-1@x', name: 'Alice' }], () => '@alice:hs.test');
  assert.equal(m.html, 'hi <a href="https://matrix.to/#/@alice:hs.test">Alice</a>');
  assert.deepEqual(m.userIds, ['@alice:hs.test']);
});

test('Matrix HTML → Markdown', () => {
  const id = (mx: string) => `${mx.slice(1, mx.indexOf(':'))}@org`;
  assert.equal(htmlToMd('<strong>b</strong> <em>i</em> <del>s</del> <code>a&lt;b</code>', id).text, '**b** *i* ~~s~~ `a<b`');
  assert.equal(htmlToMd('<a href="https://x.example">docs</a> <a href="javascript:x">bad</a>', id).text, '[docs](https://x.example) bad');
  const r = htmlToMd('hey <a href="https://matrix.to/#/@bob:hs.test">Bob</a>', id);
  assert.equal(r.text, 'hey @Bob');
  assert.deepEqual(r.mentions, [{ id: 'bob@org', name: 'Bob' }]);
  assert.equal(htmlToMd('<mx-reply><blockquote>old</blockquote></mx-reply>new <img src=x onerror=alert(1)>', id).text, 'new');
  assert.equal(htmlToMd('<blockquote><p>q</p></blockquote><p>a</p><p>b</p>', id).text, '> q\na\n\nb');
  assert.equal(htmlToMd('<pre><code class="language-js">x &amp;&amp; y\n</code></pre>', id).text, '```\nx && y\n```');
});

test('reply fallback is stripped', () => {
  assert.equal(stripReplyFallback('> <@a:hs> earlier\n> more\n\nmy reply'), 'my reply');
  assert.equal(stripReplyFallback('> not a fallback'), '> not a fallback');
});
