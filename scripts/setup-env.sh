#!/bin/sh
# Writes the demo env files, mode 600, never echoing secrets.
#   scripts/setup-env.sh a|b           Slack workspace A or B: prompts for the two tokens (hidden input)
#   scripts/setup-env.sh matrix        Matrix room: OAuth device login (approve in a browser), no token to copy
#   scripts/setup-env.sh matrix-token  Matrix, for homeservers without OAuth login: prompts for an access token (hidden)
set -eu
side="${1:-}"
case "$side" in a|b|matrix|matrix-token) ;; *) sed -n '2,6p' "$0" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."

if [ "$side" = matrix ] || [ "$side" = matrix-token ]; then
  printf 'Your OWN Matrix user id: the person who will talk in the demo room (e.g. @ben:matrix.org): '
  read -r me
  case "$me" in @*:*) ;; *) echo "that is not a Matrix user id (@name:server); nothing written" >&2; exit 1 ;; esac
  printf 'Homeserver [matrix.org]: '
  read -r hs; hs="${hs:-matrix.org}"
  umask 077
  cat > .env.matrix <<ENV
MATRIX_MODE=bot
MATRIX_ALLOWED_USERS=$me
MATRIX_ADMINS=$me
INTERTIE_PORT=8713
INTERTIE_DISPLAY_NAME=Matrix demo room
INTERTIE_STATE_DIR=./state/m
ENV
  if [ "$side" = matrix-token ]; then
    printf 'Homeserver client URL (e.g. https://matrix.example.org): '
    read -r url
    printf "Paste the BOT account's access token, then Enter: "
    stty -echo 2>/dev/null || true; read -r tok; stty echo 2>/dev/null || true; echo
    [ -n "$tok" ] || { echo "empty token; nothing written" >&2; rm -f .env.matrix; exit 1; }
    printf 'MATRIX_HOMESERVER=%s\nMATRIX_ACCESS_TOKEN=%s\n' "$url" "$tok" >> .env.matrix
    chmod 600 .env.matrix
    echo "wrote .env.matrix (mode 600, gitignored). The token was not printed."
    exit 0
  fi
  chmod 600 .env.matrix
  mkdir -p state/m; chmod 700 state/m
  echo "wrote .env.matrix (mode 600). Now log the gateway in as the BOT account:"
  exec node packages/matrix-gateway/src/cli.ts login --homeserver "$hs" --env .env.matrix --dev-insecure
fi
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
