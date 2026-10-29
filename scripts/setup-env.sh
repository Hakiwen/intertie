#!/bin/sh
# Writes .env.a or .env.b with the Slack tokens for one workspace, mode 600, without echoing them.
# Usage: scripts/setup-env.sh a|b
set -eu
side="${1:-}"
case "$side" in a|b) ;; *) echo "usage: $0 a|b" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."
file=".env.$side"
port=8711; [ "$side" = b ] && port=8712

printf 'Workspace %s: paste the Bot User OAuth Token (starts xoxb-), then Enter: ' "$side"
stty -echo 2>/dev/null || true; read -r bot; stty echo 2>/dev/null || true; echo
printf 'Workspace %s: paste the App-Level Token (starts xapp-), then Enter: ' "$side"
stty -echo 2>/dev/null || true; read -r app; stty echo 2>/dev/null || true; echo

case "$bot" in xoxb-*) ;; *) echo "that bot token does not start with xoxb-; nothing written" >&2; exit 1 ;; esac
case "$app" in xapp-*) ;; *) echo "that app token does not start with xapp-; nothing written" >&2; exit 1 ;; esac

umask 077
cat > "$file" <<ENV
SLACK_BOT_TOKEN=$bot
SLACK_APP_TOKEN=$app
INTERTIE_PORT=$port
INTERTIE_DISPLAY_NAME=Workspace $(echo "$side" | tr ab AB)
INTERTIE_STATE_DIR=./state/$side
ENV
chmod 600 "$file"
echo "wrote $file (mode 600, gitignored). Tokens were not printed."
