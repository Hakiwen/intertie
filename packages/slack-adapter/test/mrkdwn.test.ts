import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromMrkdwn, toMrkdwn } from '../src/mrkdwn.ts';
import { fromSlackReaction, toSlackReaction } from '../src/emoji.ts';

const names: Record<string, string> = { U1: 'Ana', U2: 'Bo' };
const from = (s: string) => fromMrkdwn(s, (u) => names[u] ?? '', (u) => `${u}@a.example`);

test('Slack → Markdown', () => {
  assert.equal(from('*bold* _it_ ~gone~ `*code*`').text, '**bold** *it* ~~gone~~ `*code*`');
  assert.equal(from('see <https://x.example/a?b=1&amp;c=2|the docs> or <https://y.example>').text, 'see [the docs](https://x.example/a?b=1&c=2) or https://y.example');
  const m = from('hey <@U1>, ping <!here> in <#C9|general>');
  assert.equal(m.text, 'hey @Ana, ping @here in #general');
  assert.deepEqual(m.mentions, [{ id: 'U1@a.example', name: 'Ana' }]);
  assert.equal(from('1 &lt; 2 &amp;&amp; 3 &gt; 2').text, '1 < 2 && 3 > 2');
  assert.equal(from('```\nconst a = b &amp;&amp; c;\n```').text, '```\nconst a = b && c;\n```');
  assert.equal(from('> quoted *text*').text, '> quoted **text**');
  assert.equal(from('snake_case_name and 2*3*4').text, 'snake_case_name and 2*3*4', 'no false emphasis');
  assert.equal(from('<javascript:alert(1)|click>').text, 'click', 'unsafe scheme loses its link');
});

test('Markdown → Slack, with escaping', () => {
  assert.equal(toMrkdwn('**bold** *it* _it2_ ~~gone~~ `**code**`'), '*bold* _it_ _it2_ ~gone~ `**code**`');
  assert.equal(toMrkdwn('[docs](https://x.example/?a=1&b=2)'), '<https://x.example/?a=1&amp;b=2|docs>');
  assert.equal(toMrkdwn('[bad](javascript:alert(1))'), '[bad](javascript:alert(1))');
  assert.equal(toMrkdwn('<!channel> <@U1> & <script>'), '&lt;!channel&gt; &lt;@U1&gt; &amp; &lt;script&gt;', 'injection is inert');
  assert.equal(toMrkdwn('> quote\nnot > quote'), '> quote\nnot &gt; quote');
  assert.equal(toMrkdwn('```js\nif (a < b) {}\n```'), '```if (a &lt; b) {}```');
  assert.equal(toMrkdwn('## Heading'), '*Heading*');
  const ment = toMrkdwn('thanks @Ana and @Gail', [{ id: 'U1@a.example', name: 'Ana' }, { id: 'g@b.example', name: 'Gail' }], (id) => (id.endsWith('@a.example') ? id.split('@')[0] : null));
  assert.equal(ment, 'thanks <@U1> and @Gail');
});

test('round trip keeps formatting', () => {
  for (const s of ['*bold* and _it_', 'a <https://x.example|link>', '~strike~ `code`']) {
    assert.equal(toMrkdwn(from(s).text), s);
  }
});

test('reactions map both ways', () => {
  assert.deepEqual(fromSlackReaction('eyes'), { emoji: '👀', name: 'eyes' });
  assert.deepEqual(fromSlackReaction('partyparrot'), { emoji: ':partyparrot:', name: 'partyparrot' });
  assert.equal(fromSlackReaction('+1::skin-tone-3').emoji, '👍🏼');
  assert.equal(toSlackReaction('👀'), 'eyes');
  assert.equal(toSlackReaction('🎉', 'tada'), 'tada');
  assert.equal(toSlackReaction(':partyparrot:', 'partyparrot'), 'partyparrot');
  assert.equal(toSlackReaction('👍🏼'), '+1::skin-tone-3');
  assert.equal(toSlackReaction('🦜'), null);
});
