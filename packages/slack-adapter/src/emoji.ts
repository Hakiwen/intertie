// Slack shortcode ⇄ Unicode emoji for reactions. Unknown names travel as `:name:` plus `name`.
const TABLE: Record<string, string> = {
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', eyes: '👀', white_check_mark: '✅', heavy_check_mark: '✔️',
  ballot_box_with_check: '☑️', x: '❌', heart: '❤️', tada: '🎉', joy: '😂', pray: '🙏', fire: '🔥', rocket: '🚀',
  '100': '💯', raised_hands: '🙌', clap: '👏', smile: '😄', smiley: '😃', grinning: '😀', slightly_smiling_face: '🙂',
  thinking_face: '🤔', ok_hand: '👌', wave: '👋', warning: '⚠️', point_up: '☝️', point_right: '👉', sob: '😭',
  cry: '😢', rotating_light: '🚨', star: '⭐', sparkles: '✨', zap: '⚡', bug: '🐛', wrench: '🔧', hammer: '🔨',
  memo: '📝', bulb: '💡', mag: '🔍', lock: '🔒', key: '🔑', bell: '🔔', calendar: '📅', hourglass: '⌛',
  hourglass_flowing_sand: '⏳', stopwatch: '⏱️', question: '❓', exclamation: '❗', heavy_plus_sign: '➕',
  heavy_minus_sign: '➖', arrow_up: '⬆️', arrow_down: '⬇️', arrow_right: '➡️', arrow_left: '⬅️', repeat: '🔁',
  muscle: '💪', handshake: '🤝', saluting_face: '🫡', melting_face: '🫠', face_with_rolling_eyes: '🙄',
  sweat_smile: '😅', laughing: '😆', wink: '😉', blush: '😊', heart_eyes: '😍', sunglasses: '😎', confused: '😕',
  disappointed: '😞', scream: '😱', grimacing: '😬', relieved: '😌', partying_face: '🥳', star_struck: '🤩',
  upside_down_face: '🙃', facepalm: '🤦', shrug: '🤷', see_no_evil: '🙈', skull: '💀', ghost: '👻', robot_face: '🤖',
  coffee: '☕', beer: '🍺', pizza: '🍕', cake: '🍰', gift: '🎁', trophy: '🏆', medal: '🏅', dart: '🎯',
  chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉', moneybag: '💰', package: '📦', link: '🔗',
  paperclip: '📎', pushpin: '📌', round_pushpin: '📍', email: '📧', phone: '📞', computer: '💻', fax: '📠',
  green_heart: '💚', blue_heart: '💙', purple_heart: '💜', yellow_heart: '💛', broken_heart: '💔',
  large_green_circle: '🟢', large_yellow_circle: '🟡', red_circle: '🔴', large_blue_circle: '🔵',
  white_circle: '⚪', black_circle: '⚫', no_entry: '⛔', no_entry_sign: '🚫', construction: '🚧', ship: '🚢',
  boom: '💥', dizzy: '💫', sun_with_face: '🌞', rainbow: '🌈', snowflake: '❄️', umbrella: '☔', seedling: '🌱',
  hugging_face: '🤗', nerd_face: '🤓', zipper_mouth_face: '🤐', sleeping: '😴', mask: '😷', money_mouth_face: '🤑',
};
const REVERSE = new Map<string, string>();
for (const [name, e] of Object.entries(TABLE)) if (!REVERSE.has(e)) REVERSE.set(e, name);

const TONES = ['🏻', '🏼', '🏽', '🏾', '🏿'];

/** Slack reaction name (may carry ::skin-tone-N) → { emoji, name }. */
export function fromSlackReaction(reaction: string): { emoji: string; name: string } {
  const [base, tone] = reaction.split('::skin-tone-');
  const e = TABLE[base];
  if (!e) return { emoji: `:${base}:`, name: reaction };
  const t = tone ? TONES[Number(tone) - 2] : undefined;
  return { emoji: t ? e.replace(/️$/, '') + t : e, name: reaction };
}

/** Intertie reaction → Slack reaction name, or null if it cannot be shown. */
export function toSlackReaction(emoji: string, name?: string): string | null {
  if (name && /^[a-z0-9_+'-]+(::skin-tone-[2-6])?$/.test(name)) return name;
  const m = /^:([a-z0-9_+'-]+):$/.exec(emoji);
  if (m) return m[1];
  const tone = TONES.findIndex((t) => emoji.endsWith(t));
  const bare = tone >= 0 ? emoji.slice(0, -TONES[tone].length) : emoji;
  const n = REVERSE.get(bare) ?? REVERSE.get(bare + '️') ?? REVERSE.get(bare.replace(/️$/, ''));
  if (!n) return null;
  return tone >= 0 ? `${n}::skin-tone-${tone + 2}` : n;
}
